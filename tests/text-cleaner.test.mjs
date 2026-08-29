// TextCleaner 单测（P0-1）：表格/分隔行过滤、代码块、emoji、双链、空文本口径
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextCleaner, MAX_TEXT_LENGTH, MAX_SEGMENTED_TEXT_LENGTH, SEGMENT_MAX_CHARS } from '../lib/text-cleaner.js';

test('表格数据行与分隔行被删除，正文保留', () => {
  const input = [
    '下面是音色对比：',
    '| 音色 | 特点 |',
    '| --- | --- |',
    '| 拉菲 | 温柔 |',
    '| 大凤 | 活泼 |',
    '请根据需求选择。',
  ].join('\n');
  const out = TextCleaner.clean(input);
  assert.equal(out, '下面是音色对比： 请根据需求选择。');
});

test('无前导竖线的分隔行也能删除', () => {
  const input = ['| a | b |', '--- | ---', '正文内容'].join('\n');
  const out = TextCleaner.clean(input);
  assert.equal(out, '正文内容');
});

test('只有表格时结果为空白', () => {
  const input = '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |';
  assert.equal(TextCleaner.clean(input), '');
});

test('代码块被删除', () => {
  const input = '说明：\n```js\nconst x = 1;\n```\n完。';
  assert.equal(TextCleaner.clean(input), '说明： 完。');
});

test('行内代码被删除', () => {
  assert.equal(TextCleaner.clean('调用 `npm run build` 即可。'), '调用 即可。');
});

test('emoji 被删除', () => {
  const out = TextCleaner.clean('你好 🤖✨ 世界 🚀');
  assert.equal(out, '你好 世界');
});

test('双链保留 label', () => {
  assert.equal(TextCleaner.clean('见 [安装指南](https://example.com/guide) 一节。'), '见 安装指南 一节。');
});

test('裸链接被删除', () => {
  assert.equal(TextCleaner.clean('主页 https://example.com/a?b=1 在此。'), '主页 在此。');
});

test('只有代码块/链接的回复清洗后为空（与朗读按钮口径一致）', () => {
  const input = '```\nsudo rm -rf /\n```\n\nhttps://example.com';
  assert.equal(TextCleaner.clean(input), '');
});

test('长度常量存在且顺序合理', () => {
  assert.equal(typeof MAX_TEXT_LENGTH, 'number');
  assert.equal(typeof MAX_SEGMENTED_TEXT_LENGTH, 'number');
  assert.equal(typeof SEGMENT_MAX_CHARS, 'number');
  assert.ok(MAX_SEGMENTED_TEXT_LENGTH > MAX_TEXT_LENGTH);
});
