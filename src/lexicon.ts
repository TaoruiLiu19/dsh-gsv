import type { ProviderKind } from './types.js';

/**
 * 发音词典（lexicon）：在文本清洗之后、分段合成之前，把用户指定的词替换成
 * 期望读法。按 provider 分作用域，对所有模式生效。
 *
 * 配置格式（多行文本，便于设置面板编辑）：
 *
 *   # 注释行以 # 或 // 开头；未分节的规则对所有模式生效
 *   DSH=DeepSeek
 *
 *   [deepseek]
 *   API=A P I
 *
 *   [gsv]
 *   GSV=G S V
 *
 * 规则来自 VoiceStudio 的词典设计（只借鉴行为，不复制代码）：
 * - Unicode 大小写不敏感的字面匹配（不做正则）；
 * - 长词优先于短词的重叠匹配；
 * - 同长度时，后写的条目优先；
 * - 一次扫描完成替换，替换结果不会被再次替换（不会 A→B→C）。
 * - 更具体的作用域优先：`[deepseek]` 覆盖全局的同名条目。
 */

export type LexiconScope = 'all' | ProviderKind;

export interface LexiconEntry {
  from: string;
  to: string;
  scope: LexiconScope;
}

const SCOPES = new Set<string>(['all', 'edge', 'deepseek', 'gsv', 'custom']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 解析多行词典配置；未知分节与语法错误的行会被跳过，不影响其他条目。 */
export function parseLexicon(raw: string | null | undefined): LexiconEntry[] {
  if (!raw) return [];
  const out: LexiconEntry[] = [];
  // null 表示当前处于未知分节：其后的规则一律跳过，避免被错误地套用到别的模式
  let scope: LexiconScope | null = 'all';

  for (const line of String(raw).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    const section = trimmed.match(/^\[([A-Za-z-]+)\]$/);
    if (section) {
      const name = section[1].toLowerCase();
      scope = SCOPES.has(name) ? (name as LexiconScope) : null;
      continue;
    }

    const m = trimmed.match(/^(.+?)\s*(?:=>|=)\s*(.+)$/);
    if (!m) continue;
    const from = m[1].trim();
    const to = m[2].trim();
    if (!from || from === to || scope === null) continue;
    out.push({ from, to, scope });
  }
  return out;
}

/** 某个 provider 实际生效的条目：全局 + 该 provider；同名时 provider 覆盖全局。 */
export function entriesForProvider(entries: readonly LexiconEntry[], provider?: ProviderKind): LexiconEntry[] {
  const byTerm = new Map<string, LexiconEntry>();
  for (const entry of entries) {
    if (entry.scope !== 'all' && provider && entry.scope !== provider) continue;
    if (entry.scope !== 'all' && !provider) continue;
    const key = entry.from.toLowerCase();
    // 全局先写入，provider 后写入覆盖；同一作用域内后写覆盖先写
    byTerm.set(key, entry);
  }
  return [...byTerm.values()];
}

/** 应用词典：单次扫描、长词优先、同长度后者优先、Unicode 简单大小写折叠。 */
export function applyLexicon(text: string, entries: readonly LexiconEntry[], provider?: ProviderKind): string {
  if (!text) return text;
  const active = entriesForProvider(entries, provider).filter((e) => e.from);
  if (active.length === 0) return text;

  const ordered = active
    .map((entry, index) => ({ entry, index }))
    // 长词优先；同长度时后写的排前面（正则交替先匹配者生效）
    .sort((a, b) => b.entry.from.length - a.entry.from.length || b.index - a.index)
    .map(({ entry }) => entry);

  const map = new Map(ordered.map((e) => [e.from.toLowerCase(), e.to]));
  const pattern = new RegExp(ordered.map((e) => escapeRegExp(e.from)).join('|'), 'giu');
  return text.replace(pattern, (matched) => map.get(matched.toLowerCase()) ?? matched);
}

/** 命中的规则（预览用）：返回实际会改写的条目，按输入顺序。 */
export function matchedEntries(text: string, entries: readonly LexiconEntry[], provider?: ProviderKind): LexiconEntry[] {
  const hits: LexiconEntry[] = [];
  for (const entry of entriesForProvider(entries, provider)) {
    try {
      if (new RegExp(escapeRegExp(entry.from), 'iu').test(text)) hits.push(entry);
    } catch {
      // 忽略非法条目
    }
  }
  return hits;
}

/** 预览：只做文本替换，不合成、不产生费用。 */
export function previewLexicon(
  text: string,
  entries: readonly LexiconEntry[],
  provider?: ProviderKind,
): { before: string; after: string; hits: LexiconEntry[] } {
  return {
    before: text,
    after: applyLexicon(text, entries, provider),
    hits: matchedEntries(text, entries, provider),
  };
}

/** 词典摘要（给 doctor / 工具展示用，不包含具体规则）。 */
export function lexiconSummary(entries: readonly LexiconEntry[], provider?: ProviderKind): string {
  const count = entriesForProvider(entries, provider).length;
  return count === 0 ? '未配置' : `${count} 条规则`;
}
