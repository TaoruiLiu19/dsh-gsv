/**
 * 长文本按句切分（渐进分段播放的基础）。
 *
 * 规则：
 * - 中文按句末标点（。！？…；;、）切分，标点保留在本段末尾（保证合成语调自然）；
 * - 英文按 `.!?;` 后跟空白/行尾切分（避免误拆小数如 3.14）；
 * - 单段不超过 maxChars：先按句拆成"原子"，再打包；单句超长时硬切。
 */

const SENT = '\u0000';
/** 缩写句点的暂存占位：分句时忽略这些句点，避免把 e.g. / Mr. 拆散。 */
const DOT_HOLD = '\u0001';
/** 常见英文缩写：其后紧跟空白/标点时，句点不作为句末边界。 */
const ABBR = /\b(?:e\.g|i\.e|Mr|Mrs|Ms|Dr|St|Mt|Sr|Jr|vs|etc|approx|Fig|No|Dept|Jan|Feb|Mar|Apr|Aug|Sept|Sep|Oct|Nov|Dec)\.(?=[\s,;:)])/g;

/** 句末标点（CJK 与半角）后插入切分哨兵。 */
function markSentenceBoundaries(text: string): string {
  return text
    .replace(/([。！？…；;!?])/g, '$1' + SENT)
    .replace(/([.])(?=\s|$)/g, '$1' + SENT)
    .replace(/(、)/g, '$1' + SENT);
}

export function splitIntoSegments(text: string, maxChars = 800, firstMaxChars = 0): string[] {
  const t = (text ?? '').trim();
  if (!t) return [];

  // 先保护缩写句点（不参与分句），分句完成后再还原
  const held = t.replace(ABBR, (m) => m.replace(/\.$/, DOT_HOLD));
  const atoms = markSentenceBoundaries(held)
    .split(SENT)
    .map((s) => s.replace(new RegExp(DOT_HOLD, 'g'), '.').trim())
    .filter(Boolean);

  const segments: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf) {
      segments.push(buf);
      buf = '';
    }
  };

  // 首段单独处理：更短、尽量落在逗号/分号等自然停顿处，降低首次出声延迟。
  if (firstMaxChars > 0 && atoms.length > 0) {
    let head = atoms.shift()!;
    if (head.length > firstMaxChars) {
      const cut = findNaturalCut(head, firstMaxChars);
      const rest = head.slice(cut).trim();
      head = head.slice(0, cut).trim();
      if (rest) atoms.unshift(rest);
    } else {
      while (atoms.length > 0 && head.length + atoms[0].length <= firstMaxChars) {
        head += atoms.shift()!;
      }
    }
    if (head) segments.push(head);
  }

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

/** 在 limit 内找最靠后的自然停顿（逗号/分号等）；找不到或太靠前则硬切。 */
function findNaturalCut(text: string, limit: number): number {
  const window = text.slice(0, limit);
  let cut = -1;
  for (const ch of ['。', '！', '？', '…', '；', ';', '!', '?', '，', ',', '、']) {
    const index = window.lastIndexOf(ch);
    if (index >= 0) cut = Math.max(cut, index + 1);
  }
  return cut >= 8 ? cut : Math.min(limit, text.length);
}
