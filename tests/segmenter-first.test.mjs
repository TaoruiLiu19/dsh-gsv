import test from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoSegments } from '../lib/segmenter.js';

test('首段短切：firstMaxChars 生效且内容不丢', () => {
  const text = '第一句很短。第二句稍微长一点点，包含逗号。第三句结束。';
  const segs = splitIntoSegments(text, 150, 20);
  assert.ok(segs.length > 1, '应切成多段');
  assert.ok(segs[0].length <= 20, '首段应不超过 20 字：' + segs[0]);
  assert.equal(segs.join(''), text, '拼接后应与原文一致');
});

test('首段优先在逗号处切', () => {
  const text = '今天天气真不错，我们出去走走吧。';
  const segs = splitIntoSegments(text, 150, 12);
  assert.equal(segs[0], '今天天气真不错，');
});

test('firstMaxChars=0 保持旧行为', () => {
  const text = '第一句。第二句！第三句？';
  assert.deepEqual(splitIntoSegments(text, 800, 0), ['第一句。第二句！第三句？']);
});
