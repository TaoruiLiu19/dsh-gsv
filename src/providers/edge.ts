import { Communicate, listVoices as libListVoices } from 'edge-tts-universal';
import type { ProviderChunk, ProviderHealth, TTSProvider, VoiceInfo } from '../types.js';

/** 注入的库依赖（单测用假实现替换）。 */
export interface EdgeLib {
  Communicate: typeof Communicate;
  listVoices: typeof libListVoices;
}

/** 精选音色（优先序）：中文全系 + 主流英文。按此序过滤 listVoices，稳定且 20+。 */
const CURATED = [
  'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyeNeural',
  'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunxiaNeural',
  'zh-CN-XiaochenNeural', 'zh-CN-YunyangNeural', 'zh-CN-YunfengNeural',
  'zh-CN-YunhaoNeural', 'zh-CN-YunjieNeural', 'zh-CN-YunzeNeural',
  'zh-CN-XiaohanNeural', 'zh-CN-XiaomengNeural', 'zh-CN-XiaomoNeural',
  'zh-CN-XiaoqiuNeural', 'zh-CN-XiaoruiNeural', 'zh-CN-XiaoshuangNeural',
  'zh-CN-XiaoxiaoDialectsNeural', 'zh-CN-XiaoyouNeural',
  'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'en-US-AriaNeural', 'en-US-GuyNeural', 'en-US-EmmaMultilingualNeural', 'en-GB-SoniaNeural',
];

/** 微软 Azure 神经声音的官方中文名（无映射时回退库的 FriendlyName）。 */
const ZH_NAMES: Record<string, string> = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunyeNeural': '云野',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-XiaochenNeural': '晓辰',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-YunfengNeural': '云枫',
  'zh-CN-YunhaoNeural': '云皓',
  'zh-CN-YunjieNeural': '云杰',
  'zh-CN-YunzeNeural': '云泽',
  'zh-CN-XiaohanNeural': '晓涵',
  'zh-CN-XiaomengNeural': '晓梦',
  'zh-CN-XiaomoNeural': '晓墨',
  'zh-CN-XiaoqiuNeural': '晓秋',
  'zh-CN-XiaoruiNeural': '晓睿',
  'zh-CN-XiaoshuangNeural': '晓双',
  'zh-CN-XiaoxiaoDialectsNeural': '晓晓（方言）',
  'zh-CN-XiaoyouNeural': '晓悠',
  'zh-CN-liaoning-XiaobeiNeural': '晓北（辽宁）',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮（陕西）',
};

/** 主流英文音色的简写名（FriendlyName 太长，下拉/工具里直接用人名）。 */
const EN_NAMES: Record<string, string> = {
  'en-US-AriaNeural': 'Aria',
  'en-US-GuyNeural': 'Guy',
  'en-US-EmmaMultilingualNeural': 'Emma',
  'en-GB-SoniaNeural': 'Sonia',
};

/** 显示名：中文/英文映射优先；其余从 FriendlyName 截短（去 "Microsoft … Online" 前缀）。 */
function displayName(v: { ShortName: string; FriendlyName?: string }): string {
  const mapped = ZH_NAMES[v.ShortName] ?? EN_NAMES[v.ShortName];
  if (mapped) return mapped;
  const fn = v.FriendlyName ?? '';
  const m = fn.match(/^Microsoft\s+(.+?)(?:\s+Online\b.*)?$/i);
  if (m) return m[1].trim();
  return v.ShortName;
}

const HEALTH_VOICE = 'zh-CN-XiaoxiaoNeural';
const HEALTH_TEXT = '你好';
const HEALTH_TIMEOUT_MS = 8000;

/**
 * 微软 Edge 云端 TTS（简单模式）提供方。
 * 底层 edge-tts-universal：原生流式、token 自动刷新、错误恢复、代理（第 1 层）；
 * 我方 health() = 试合成 + 缓存退避（第 2 层）。
 */
export class EdgeProvider implements TTSProvider {
  readonly kind = 'edge' as const;
  private lib: EdgeLib;
  private healthCache = { at: Number.NEGATIVE_INFINITY, backoff: 30000, ok: true, rateLimited: false, message: '' };

  constructor(lib?: Partial<EdgeLib>, private clock: () => number = () => Date.now()) {
    this.lib = {
      Communicate: lib?.Communicate ?? Communicate,
      listVoices: lib?.listVoices ?? libListVoices,
    };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const all = await this.lib.listVoices();
    const byId = new Map<string, VoiceInfo>();
    for (const v of all) {
      byId.set(v.ShortName, {
        id: v.ShortName,
        name: displayName(v),
        gender: v.Gender ?? '',
        locale: v.Locale ?? '',
      });
    }
    const out: VoiceInfo[] = [];
    const seen = new Set<string>();
    const push = (id: string) => {
      const v = byId.get(id);
      if (v && !seen.has(id)) { seen.add(id); out.push(v); }
    };
    for (const id of CURATED) push(id);
    for (const v of byId.values()) {
      if (!seen.has(v.id) && (v.locale.startsWith('zh-CN') || v.locale === 'en-US' || v.locale === 'en-GB')) push(v.id);
    }
    return out;
  }

  async *stream(text: string, voice: string, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    const c = new this.lib.Communicate(text, { voice });
    const it = c.stream();
    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await it.next();
        if (done) break;
        if (value.type === 'audio' && value.data && value.data.length > 0) {
          yield { mime: 'audio/mpeg', data: value.data };
        }
      }
    } finally {
      try { await it.return?.(); } catch { /* 忽略 */ }
    }
  }

  async health(): Promise<ProviderHealth> {
    const now = this.clock();
    if (now - this.healthCache.at < this.healthCache.backoff) {
      return {
        available: this.healthCache.ok,
        ...(this.healthCache.rateLimited ? { rateLimited: true } : {}),
        ...(this.healthCache.message ? { message: this.healthCache.message } : {}),
      };
    }
    this.healthCache.at = now;
    try {
      await this.testSynthesis();
      this.healthCache.ok = true;
      this.healthCache.backoff = 30000; // 成功重置
      this.healthCache.rateLimited = false;
      this.healthCache.message = '';
      return { available: true };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const rateLimited = /429|rate\s*limit|throttl/i.test(msg);
      this.healthCache.ok = false;
      this.healthCache.rateLimited = rateLimited;
      this.healthCache.message = msg.slice(0, 200);
      this.healthCache.backoff = Math.min(this.healthCache.backoff * 2, 120000); // 30→60→120
      return { available: false, ...(rateLimited ? { rateLimited: true } : {}), message: this.healthCache.message };
    }
  }

  /** 试合成 1 秒"你好"：消费到首块音频即视为可用；限时兜底（定时器必清理，防进程挂起）。 */
  private async testSynthesis(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const task = (async () => {
        let got = false;
        for await (const chunk of this.stream(HEALTH_TEXT, HEALTH_VOICE)) {
          if (chunk.data && chunk.data.length > 0) { got = true; break; }
        }
        if (!got) throw new Error('试合成未产出音频');
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('试合成超时')), HEALTH_TIMEOUT_MS);
      });
      await Promise.race([task, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
