// 发音词典：解析、最长匹配、单次替换、不区分大小写，以及 TTSService 全路径接入
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLexicon, parseLexicon, lexiconSummary, previewLexicon } from '../lib/lexicon.js';
import { TTSService } from '../lib/tts.service.js';
import { AudioStore } from '../lib/audio-store.js';

test('parseLexicon：注释/空行/两种分隔符/重复覆盖/坏行跳过', () => {
  const entries = parseLexicon(`
# 注释
// 另一种注释
DSH=DeepSeek
GSV=>G S V
blank
=没有原词
相同=相同
DSH=DeepSeek 官方
  `);
  assert.deepEqual(
    entries.map((e) => [e.from, e.to]),
    [
      ['DSH', 'DeepSeek'],
      ['GSV', 'G S V'],
      ['DSH', 'DeepSeek 官方'],
    ],
  );
});

test('applyLexicon：长词优先、单次替换不链式、英文忽略大小写、$ 安全', () => {
  const entries = parseLexicon('GSV=G S V\nGSV-TTS=GSV TTS\nA=B\nB=C');
  assert.equal(applyLexicon('GSV-TTS 和 GSV', entries), 'GSV TTS 和 G S V');
  // A→B 只做一次，不会继续把 B 变成 C
  assert.equal(applyLexicon('A', entries), 'B');
  assert.equal(applyLexicon('gsv', entries), 'G S V');
  assert.equal(applyLexicon('价格 $& 不变', parseLexicon('不变=$1')), '价格 $& $1');
  assert.equal(lexiconSummary(entries), '4 条规则');
  assert.equal(lexiconSummary([]), '未配置');
});

const baseConfig = {
  apiUrl: 'http://localhost:9880',
  voices: [],
  defaultVoice: '',
  autoPlay: false,
  engineMode: 'eco',
  interruptOnNew: true,
  timeout: 30000,
  installDir: './x',
  voiceRegistryUrl: '',
  schemaVersion: 1,
  provider: 'deepseek',
  deepseekApiKey: '',
  deepseekApiKeyEnv: 'DEEPSEEK_API_KEY',
  lexicon: '',
  quotaDaily: null,
};

test('TTSService：词典在清洗之后、分段/合成之前生效（所有 provider 共用）', async () => {
  const store = new AudioStore('http://host');
  const captured = [];
  const fake = {
    kind: 'deepseek',
    listVoices: async () => [],
    stream: async function* (text) {
      captured.push(text);
      yield { mime: 'audio/pcm-s16', data: Buffer.alloc(4), sampleRate: 24000 };
    },
    health: async () => ({ available: true }),
  };
  const tts = new TTSService(
    () => ({ ...baseConfig, lexicon: 'GSV=G S V\nDSH=DeepSeek' }),
    store,
    { deepseek: fake },
  );
  const segments = tts.planSegments('GSV 比 DSH 更本地。');
  assert.ok(segments.length > 0);
  assert.match(segments.join(''), /G S V 比 DeepSeek 更本地/);
  await tts.synthesize('GSV 很好');
  assert.equal(captured[0].includes('GSV'), false, '合成前必须已经替换');
  assert.match(captured[0], /G S V/);
});

test('parseLexicon：分节作用域（[deepseek]/[gsv]/[edge]），未知分节忽略', () => {
  const entries = parseLexicon(`
DSH=DeepSeek
[deepseek]
API=A P I
[gsv]
API=啊屁艾
[nope]
X=Y
`);
  assert.deepEqual(
    entries.map((e) => [e.from, e.to, e.scope]),
    [
      ['DSH', 'DeepSeek', 'all'],
      ['API', 'A P I', 'deepseek'],
      ['API', '啊屁艾', 'gsv'],
    ],
  );
});

test('applyLexicon：按 provider 过滤，provider 覆盖全局，同长度后者优先', () => {
  const entries = parseLexicon('API=全局读法\n[deepseek]\nAPI=官方读法\n[edge]\nX=1\n');
  assert.equal(applyLexicon('API', entries, 'deepseek'), '官方读法');
  assert.equal(applyLexicon('API', entries, 'gsv'), '全局读法');
  assert.equal(applyLexicon('API', entries), '全局读法', '不传 provider 时只用全局');
  assert.equal(applyLexicon('API X', entries, 'edge'), '全局读法 1');

  const sameLength = parseLexicon('AB=第一\n[deepseek]\nAB=第二');
  assert.equal(applyLexicon('AB', sameLength, 'deepseek'), '第二');
});

test('previewLexicon：只返回替换结果与命中规则，不合成', () => {
  const entries = parseLexicon('DSH=DeepSeek\n[gsv]\nGSV=G S V');
  const preview = previewLexicon('DSH 和 GSV', entries, 'gsv');
  assert.equal(preview.before, 'DSH 和 GSV');
  assert.equal(preview.after, 'DeepSeek 和 G S V');
  assert.deepEqual(preview.hits.map((h) => [h.from, h.scope]), [['DSH', 'all'], ['GSV', 'gsv']]);
});