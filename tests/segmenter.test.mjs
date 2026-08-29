// splitIntoSegments 单测（P1-1）：中文按句切分、标点保留、英文不拆小数、单段上限、硬切
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoSegments } from '../lib/segmenter.js';

test('短文本（≤上限）不切分', () => {
  assert.deepEqual(splitIntoSegments('第一句。第二句！第三句？'), ['第一句。第二句！第三句？']);
});

test('长中文文本按句末标点切分，标点保留在段尾', () => {
  const sentence = '这是用于测试分段播放的第';
  const text = Array.from({ length: 40 }, (_, i) => `${sentence}${i + 1}句，内容足够长。`).join('');
  const segs = splitIntoSegments(text, 200);
  assert.ok(segs.length >= 3, `应拆成多段（实际 ${segs.length}）`);
  assert.equal(segs.join(''), text);
  for (const s of segs) {
    assert.ok(s.length <= 200, `段长 ${s.length} 超上限`);
    assert.ok(/[。！？…]$/.test(s), `段应以句末标点结尾：${s.slice(-5)}`);
  }
});

test('英文句号不拆小数（3.14 保持完整）', () => {
  const sentence = 'This value is 3.14 and it matters a lot here. ';
  const text = sentence.repeat(25); // > 800 字符，必须切分
  const segs = splitIntoSegments(text, 800);
  assert.ok(segs.length > 1);
  // 句间空格被折叠（句点已提供停顿），句内空格保留
  assert.equal(segs.join(''), text.replace(/\. /g, '.'));
  // 小数不会被切开：段尾不能是残缺的 "3."，段首不能是残缺的 "14"
  for (const s of segs) {
    assert.ok(!/3\.$/.test(s), `段尾不应是残缺的 3.：${s.slice(-6)}`);
    assert.ok(!/^14/.test(s), `段首不应是残缺的 14：${s.slice(0, 6)}`);
  }
});

test('顿号是候选切分点（配合上限生效）', () => {
  const segs = splitIntoSegments('选项：苹果、香蕉、梨。完毕', 6);
  assert.deepEqual(segs, ['选项：苹果、', '香蕉、梨。', '完毕']);
});

test('单段不超过上限：多句打包', () => {
  const text = Array.from({ length: 40 }, (_, i) => `这是第${i + 1}句，内容比较长。`).join('');
  const segs = splitIntoSegments(text, 100);
  assert.ok(segs.length >= 2, '应被拆成多段');
  for (const s of segs) assert.ok(s.length <= 100, `段长 ${s.length} 超上限`);
  assert.equal(segs.join(''), text);
});

test('单句超长时硬切', () => {
  const long = '啊'.repeat(2500) + '。';
  const segs = splitIntoSegments(long, 800);
  assert.ok(segs.length >= 4);
  assert.ok(segs.every((s) => s.length <= 800));
  assert.equal(segs.join(''), long);
});

test('无标点长文本按上限硬切', () => {
  const text = 'x'.repeat(1700);
  const segs = splitIntoSegments(text, 800);
  assert.deepEqual(segs, ['x'.repeat(800), 'x'.repeat(800), 'x'.repeat(100)]);
});

test('空输入返回空数组', () => {
  assert.deepEqual(splitIntoSegments(''), []);
  assert.deepEqual(splitIntoSegments('   \n\t '), []);
  assert.deepEqual(splitIntoSegments(null), []);
});

test('默认上限为 800', () => {
  const text = '啊'.repeat(2000);
  const segs = splitIntoSegments(text);
  assert.ok(segs.every((s) => s.length <= 800));
});
