/**
 * 长文本按句切分（渐进分段播放的基础）。
 *
 * 规则：
 * - 中文按句末标点（。！？…；;、）切分，标点保留在本段末尾（保证合成语调自然）；
 * - 英文按 `.!?;` 后跟空白/行尾切分（避免误拆小数如 3.14）；
 * - 单段不超过 maxChars：先按句拆成"原子"，再打包；单句超长时硬切。
 */

const SENT = '\u0000';

/** 句末标点（CJK 与半角）后插入切分哨兵。 */
function markSentenceBoundaries(text: string): string {
  return text
    .replace(/([。！？…；;!?])/g, '$1' + SENT)
    .replace(/([.])(?=\s|$)/g, '$1' + SENT)
    .replace(/(、)/g, '$1' + SENT);
}

export function splitIntoSegments(text: string, maxChars = 800): string[] {
  const t = (text ?? '').trim();
  if (!t) return [];

  const atoms = markSentenceBoundaries(t)
    .split(SENT)
    .map((s) => s.trim())
    .filter(Boolean);

  const segments: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf) {
      segments.push(buf);
      buf = '';
    }
  };

  for (const atom of atoms) {
    if (atom.length > maxChars) {
      // 单句超长：先吐掉缓冲，再把这一句硬切
      flush();
      for (let i = 0; i < atom.length; i += maxChars) {
        segments.push(atom.slice(i, i + maxChars));
      }
      continue;
    }
    if (buf && buf.length + atom.length > maxChars) {
      flush();
    }
    buf += atom;
  }
  flush();
  return segments;
}
