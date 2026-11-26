import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './http.js';
import type { ProviderKind } from './types.js';

type Event = 'firstAudio' | 'cancel' | 'failure' | 'finish' | 'cacheHit';
const countCharacters = (text: string) => [...text].reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0);
const today = () => new Date().toLocaleDateString('sv');
const oldest = () => new Date(Date.now() - 31 * 86400000).toLocaleDateString('sv');

/** One ledger per DSH home, shared by profiles, workspaces and running instances. */
export function usageLedgerPath(dshHomePath: ((...segments: string[]) => string) | undefined, fallback: string): string {
  if (dshHomePath) return dshHomePath('gsv-tts', 'speech-usage.sqlite');
  return join(process.env.DSH_HOME ? resolve(process.env.DSH_HOME, 'gsv-tts') : fallback, 'speech-usage.sqlite');
}

export class SpeechStats {
  private readonly db: DatabaseSync;
  private readonly samples: { provider: ProviderKind; event: Event; ms: number }[] = [];

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 2500;
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, chars INTEGER NOT NULL, automatic INTEGER NOT NULL);
    `);
  }

  /** Conservative local accounting: reserve characters before the request leaves the host. */
  reserveDeepseek(text: string, automatic: boolean, dailyLimit: number | null): void {
    const day = today();
    const chars = countCharacters(text);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT automatic FROM usage WHERE day=?').get(day);
      if (automatic && dailyLimit !== null && Number(current?.automatic ?? 0) + chars > dailyLimit) {
        throw new HttpError(429, '今日 DeepSeek 自动朗读字符已达上限');
      }
      this.db.prepare(`
        INSERT INTO usage VALUES (?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET chars=chars+excluded.chars, automatic=automatic+excluded.automatic
      `).run(day, chars, automatic ? chars : 0);
      this.db.prepare('DELETE FROM usage WHERE day < ?').run(oldest());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  checkAutomaticBudget(text: string, dailyLimit: number | null): void {
    if (dailyLimit === null) return;
    const current = this.db.prepare('SELECT automatic FROM usage WHERE day=?').get(today());
    if (Number(current?.automatic ?? 0) + countCharacters(text) > dailyLimit) {
      throw new HttpError(429, '今日 DeepSeek 自动朗读字符已达上限');
    }
  }

  record(provider: ProviderKind, event: Event, ms = 0): void {
    this.samples.push({ provider, event, ms });
    if (this.samples.length > 600) this.samples.shift();
  }

  snapshot() {
    const day = today();
    const row = this.db.prepare('SELECT chars, automatic FROM usage WHERE day=?').get(day);
    return {
      day,
      deepseekCharacters: Number(row?.chars ?? 0),
      deepseekAutomaticCharacters: Number(row?.automatic ?? 0),
      providers: (['edge', 'deepseek', 'gsv', 'custom'] as const).map(provider => {
        const events = this.samples.filter(item => item.provider === provider);
        const count = (kind: Event) => events.filter(item => item.event === kind).length;
        const percentile = (kind: Event, p: number) => {
          const values = events.filter(item => item.event === kind).map(item => item.ms).sort((a, b) => a - b);
          return values.length ? Math.round(values[Math.ceil(values.length * p) - 1]) : null;
        };
        const completed = count('finish');
        const cancelled = count('cancel');
        const failed = count('failure');
        const total = completed + cancelled + failed;
        return { provider, played: count('firstAudio'), completed, cancelled,
          failed, cancellationRate: total ? cancelled / total : null, cacheHits: count('cacheHit'), firstAudioP50: percentile('firstAudio', .5),
          firstAudioP95: percentile('firstAudio', .95), cancelP95: percentile('cancel', .95) };
      }),
    };
  }

  dispose(): void { this.db.close(); }
}
