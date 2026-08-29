/** 单次合成（tts_speak 工具 / 短文本）的清洗后长度上限。 */
export const MAX_TEXT_LENGTH = 6000;
/** 分段合成（朗读按钮 / 自动朗读）的清洗后长度上限（分段本身按句切分）。 */
export const MAX_SEGMENTED_TEXT_LENGTH = 30000;
/** 单段最大字符数（超过则按句打包时硬切）。 */
export const SEGMENT_MAX_CHARS = 800;

export class TextCleaner {
  static clean(text: string): string {
    return text
      // 先处理 markdown 链接，再删裸 URL —— 顺序不能反，否则 URL 被吃掉后
      // 链接正则匹配不到 `)`，会残留 "[文本](" 残片
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      // 代码块 / 行内代码
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '')
      // markdown 结构标记：标题、引用、无序/有序列表
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      // 表格：先删数据行（| a | b |），再兜底删分隔行（|---|:--|）——
      // 顺序不能反：分隔行也会被数据行正则命中，反过来会漏掉无前导竖线的分隔行
      .replace(/^\s*\|.*\|\s*$/gm, '')
      .replace(/^\s*\|?[\s\-|:]+\|?\s*$/gm, '')
      // 强调 / 删除线（TTS 会把星号读成 "星号"）
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
      // 表情符号：用 Unicode 属性转义覆盖全部（含 🤖✨🎉、旗帜、ZWJ 组合等）
      .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu, '')
      // 折叠空白
      .replace(/\s+/g, ' ')
      .trim();
  }
}
