// 4.0.0 Provider 单测：EdgeProvider（MP3 透传/精选音色/分层健康退避）+ TTSService 分发（.mp3/.wav 落盘）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EdgeProvider } from '../lib/providers/edge.js';
import { TTSService } from '../lib/tts.service.js';
import { AudioStore } from '../lib/audio-store.js';

const FAKE_VOICES = [
  { ShortName: 'zh-CN-XiaoxiaoNeural', FriendlyName: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', Gender: 'Female', Locale: 'zh-CN' },
  { ShortName: 'en-US-AriaNeural', FriendlyName: 'Microsoft Aria Online (Natural) - English (United States)', Gender: 'Female', Locale: 'en-US' },
  { ShortName: 'ja-JP-NanamiNeural', FriendlyName: 'Microsoft Nanami Online (Natural) - Japanese', Gender: 'Female', Locale: 'ja-JP' },
  { ShortName: 'zh-CN-shaanxi-XiaoniNeural', FriendlyName: 'Xiaoni', Gender: 'Female', Locale: 'zh-CN-shaanxi' },
];

function okCommunicate() {
  return class {
    stream() {
      return (async function* () {
        yield { type: 'audio', data: Buffer.from('MP3DATA') };
        yield { type: 'WordBoundary', offset: 1n, duration: 1n, text: 'hi' };
      })();
    }
  };
}

test('EdgeProvider.stream：MP3 块透传 + MIME audio/mpeg，WordBoundary 忽略', async () => {
  const ep = new EdgeProvider({ Communicate: okCommunicate(), listVoices: async () => [] });
  const chunks = [];
  for await (const c of ep.stream('你好', 'zh-CN-XiaoxiaoNeural')) chunks.push(c);
  assert.equal(chunks.length, 1, '只透传 audio 块');
  assert.equal(chunks[0].mime, 'audio/mpeg');
  assert.equal(Buffer.from(chunks[0].data).toString(), 'MP3DATA');
});

test('EdgeProvider.listVoices：精选序优先 + zh-CN/en 兜底，日/韩等小众被过滤；中文音色显示官方中文名', async () => {
  const ep = new EdgeProvider({ Communicate: okCommunicate(), listVoices: async () => FAKE_VOICES });
  const voices = await ep.listVoices();
  const ids = voices.map((v) => v.id);
  assert.equal(ids[0], 'zh-CN-XiaoxiaoNeural', '精选序优先');
  assert.ok(ids.includes('en-US-AriaNeural'));
  assert.ok(ids.includes('zh-CN-shaanxi-XiaoniNeural'), 'zh-CN 方言兜底保留');
  assert.ok(!ids.includes('ja-JP-NanamiNeural'), '日/韩应被过滤');
  assert.equal(voices.find((v) => v.id === 'zh-CN-XiaoxiaoNeural').name, '晓晓', '中文音色应显示中文名');
  assert.equal(voices.find((v) => v.id === 'en-US-AriaNeural').name, 'Aria', '英文音色应显示简写名');
  // 未映射的英文音色：从 FriendlyName 截短（去 "Microsoft … Online" 前缀）
  const ep2 = new EdgeProvider({
    Communicate: okCommunicate(),
    listVoices: async () => [{ ShortName: 'en-GB-RyanNeural', FriendlyName: 'Microsoft Ryan Online (Natural) - English (United Kingdom)', Gender: 'Male', Locale: 'en-GB' }],
  });
  assert.equal((await ep2.listVoices())[0].name, 'Ryan');
});

test('EdgeProvider.health：失败→rateLimited 标记 + 退避期内不重复试合成', async () => {
  let constructed = 0;
  const FailCom = class { constructor() { constructed++; } stream() { return (async function* () { throw new Error('HTTP 429 rate limit exceeded'); })(); } };
  let now = 0;
  const ep = new EdgeProvider({ Communicate: FailCom, listVoices: async () => [] }, () => now);
  const h1 = await ep.health();
  assert.equal(h1.available, false);
  assert.equal(h1.rateLimited, true);
  assert.equal(constructed, 1);
  const h2 = await ep.health(); // 退避期内：缓存，不重试
  assert.equal(constructed, 1);
  assert.equal(h2.available, false);
});

test('EdgeProvider.health：连续失败退避 60s → 120s（行为验证）', async () => {
  let constructed = 0;
  const FailCom = class { constructor() { constructed++; } stream() { return (async function* () { throw new Error('boom'); })(); } };
  let now = 0;
  const ep = new EdgeProvider({ Communicate: FailCom, listVoices: async () => [] }, () => now);
  await ep.health(); // 第 1 次失败 → backoff 60s
  assert.equal(constructed, 1);
  now += 59000;
  await ep.health(); // 60s 内 → 缓存
  assert.equal(constructed, 1);
  now += 2000; // 共 61s → 超时 → 重试
  await ep.health(); // 第 2 次失败 → backoff 120s
  assert.equal(constructed, 2);
  now += 119000;
  await ep.health(); // 120s 内 → 缓存
  assert.equal(constructed, 2);
  now += 2000; // 共 121s → 重试
  await ep.health(); // 第 3 次失败
  assert.equal(constructed, 3);
});

test('EdgeProvider.health：成功→available + 重置退避', async () => {
  let constructed = 0;
  const OkCom = class { constructor() { constructed++; } stream() { return (async function* () { yield { type: 'audio', data: Buffer.from('x') }; })(); } };
  let now = 0;
  const ep = new EdgeProvider({ Communicate: OkCom, listVoices: async () => [] }, () => now);
  const h = await ep.health();
  assert.equal(h.available, true);
  assert.equal(h.rateLimited, undefined);
  const h2 = await ep.health(); // 缓存
  assert.equal(constructed, 1);
});

// ─── TTSService 分发：edge → .mp3（MIME 透传）；gsv → .wav（PCM 装配） ───
const baseConfig = {
  apiUrl: 'http://localhost:9880',
  voices: [],
  defaultVoice: '',
  autoPlay: false,
  interruptOnNew: true,
  timeout: 30000,
  installDir: './x',
  voiceRegistryUrl: '',
  schemaVersion: 1,
  provider: 'gsv',
  quotaDaily: null,
};

test('TTSService：edge provider 合成保存 .mp3，audioLen=0（时长由浏览器解码）', async () => {
  const store = new AudioStore('http://host');
  const FakeEdge = {
    kind: 'edge',
    listVoices: async () => [{ id: 'v1', name: 'V1', gender: 'F', locale: 'zh-CN' }],
    stream: async function* () { yield { mime: 'audio/mpeg', data: Buffer.from('MP3BYTES') }; },
    health: async () => ({ available: true }),
  };
  const tts = new TTSService({ ...baseConfig, provider: 'edge', defaultVoice: 'v1' }, store, { edge: FakeEdge });
  const r = await tts.synthesize('你好');
  assert.ok(r.filename.endsWith('.mp3'));
  assert.equal(r.audioLen, 0);
  assert.ok(r.audioUrl.includes(r.filename));
});

test('TTSService：gsv provider 合成保存 .wav 并携带总时长', async () => {
  const store = new AudioStore('http://host');
  const FakeGsv = {
    kind: 'gsv',
    streamWithPreset: async function* () {
      yield { mime: 'audio/pcm-f32', data: Buffer.from([1, 2, 3, 4]), sampleRate: 32000 };
      yield { mime: 'audio/meta', data: new Uint8Array(0), totalDuration: 3.5 };
    },
    listVoices: async () => [],
    health: async () => ({ available: true }),
  };
  const tts = new TTSService(baseConfig, store, { gsv: FakeGsv });
  const r = await tts.synthesize('你好', { name: 'v', speakerAudioPath: 'a', promptAudioPath: 'b', promptText: '' });
  assert.ok(r.filename.endsWith('.wav'));
  assert.equal(r.audioLen, 3.5);
});

test('TTSService：edge 模式拒绝本地预设对象（清晰报错）', async () => {
  const store = new AudioStore('http://host');
  const tts = new TTSService({ ...baseConfig, provider: 'edge' }, store, { edge: { kind: 'edge', listVoices: async () => [], stream: async function* () {}, health: async () => ({ available: true }) } });
  await assert.rejects(
    () => tts.synthesize('你好', { name: 'v', speakerAudioPath: 'a', promptAudioPath: 'b', promptText: '' }),
    /Edge（云端简单）模式不支持本地音色预设/,
  );
});
