// DeepSeek 官方语音提供方单测：WAV 解析/合并、请求形态、错误映射、TTSService 落盘
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEEPSEEK_DEFAULT_VOICE,
  DeepseekProvider,
  buildWav16,
  parseWav,
  wavDuration,
} from '../lib/providers/deepseek.js';
import { TTSService } from '../lib/tts.service.js';
import { AudioStore } from '../lib/audio-store.js';
import { resolveProviderKind } from '../lib/config.js';

const SR = 24000;

/** 造一段 0.5 秒 16-bit 单声道 WAV（静音）。 */
function wav(seconds = 0.5) {
  const frames = Math.round(SR * seconds);
  return buildWav16(Buffer.alloc(frames * 2), SR, 1);
}

/** 假 fetch：记录请求并按需返回 WAV 或错误。 */
function fakeFetch(handler = () => wav()) {
  const calls = [];
  const impl = async (url, init) => {
    const call = { url: String(url), headers: init?.headers ?? {}, body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(call);
    const r = handler(call, calls.length);
    if (r instanceof Response) return r;
    return new Response(r, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  };
  impl.calls = calls;
  return impl;
}

const cfg = (patch = {}) => ({ deepseekApiKey: 'sk-test', timeout: 30000, ...patch });

test('parseWav / buildWav16：RIFF 头、采样参数与时长换算', () => {
  const bytes = wav(1);
  const p = parseWav(bytes);
  assert.ok(p);
  assert.equal(p.sampleRate, SR);
  assert.equal(p.channels, 1);
  assert.equal(p.bits, 16);
  assert.equal(p.data.length, SR * 2);
  assert.ok(Math.abs(wavDuration(p) - 1) < 0.001);
  assert.equal(parseWav(Buffer.from('not a wav')), null);
  // 非 44 字节对齐的脏数据不应抛错
  assert.equal(parseWav(Buffer.alloc(10)), null);
});

test('DeepseekProvider.stream：单段请求 → 16-bit PCM 块 + 结束元数据；请求带鉴权与 voice_id', async () => {
  const fetchImpl = fakeFetch();
  const dp = new DeepseekProvider({ getConfig: cfg, fetchImpl, env: {} });
  const chunks = [];
  for await (const c of dp.stream('你好，世界', 'tide')) chunks.push(c);

  assert.equal(chunks.length, 2, 'PCM 块 + meta 块');
  assert.equal(chunks[0].mime, 'audio/pcm-s16');
  assert.equal(chunks[0].sampleRate, SR);
  assert.equal(chunks[0].data.length, SR, '0.5 秒 × 24 kHz × 2 字节');
  assert.equal(chunks[1].mime, 'audio/meta');
  assert.ok(chunks[1].totalDuration > 0.49 && chunks[1].totalDuration < 0.51);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/v1/tools/tts');
  assert.equal(call.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.body.voice_id, 'tide');
  assert.equal(call.body.format, 'wav');
  assert.equal(call.body.filter_markdown, false);
  assert.equal(call.body.text, '你好，世界');
});

test('DeepseekProvider.stream：长文本按 2000 字切分，逐块吐 PCM、总时长累加', async () => {
  const fetchImpl = fakeFetch();
  const dp = new DeepseekProvider({ getConfig: cfg, fetchImpl, env: {} });
  const text = '啊'.repeat(4500);
  const chunks = [];
  for await (const c of dp.stream(text, 'stella')) chunks.push(c);

  assert.equal(fetchImpl.calls.length, 3, '4500 字应切成 2000+2000+500');
  const pcm = chunks.filter((c) => c.mime === 'audio/pcm-s16');
  const meta = chunks.find((c) => c.mime === 'audio/meta');
  assert.equal(pcm.length, 3, '每个请求一块 PCM');
  assert.ok(meta, '必须给出总时长');
  // 每个分片 0.5 秒 → 合计 1.5 秒
  assert.ok(Math.abs(meta.totalDuration - 1.5) < 0.01);
  assert.equal(pcm.reduce((n, c) => n + c.data.length, 0), SR * 2 * 1.5);
});

test('DeepseekProvider.stream：未配置 Key → 明确报错；health 同步为不可用', async () => {
  const dp = new DeepseekProvider({ getConfig: () => ({ deepseekApiKey: '', timeout: 30000 }), fetchImpl: fakeFetch(), env: {} });
  await assert.rejects(async () => {
    for await (const _ of dp.stream('你好', 'stella')) { /* consume */ }
  }, /未找到 DeepSeek 凭据/);
  const h = await dp.health();
  assert.equal(h.available, false);
  assert.match(String(h.message), /未找到 DeepSeek 凭据/);
});

test('DeepseekProvider：Key 回退环境变量 DEEPSEEK_API_KEY', async () => {
  const fetchImpl = fakeFetch();
  const dp = new DeepseekProvider({
    getConfig: () => ({ deepseekApiKey: '  ', deepseekApiKeyEnv: 'DEEPSEEK_API_KEY', timeout: 30000 }),
    fetchImpl,
    env: { DEEPSEEK_API_KEY: 'sk-env' },
  });
  for await (const _ of dp.stream('你好', 'stella')) { /* consume */ }
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer sk-env');
});

test('DeepseekProvider：非法音色 id 回退 stella（切模式残留学名不炸）', async () => {
  const fetchImpl = fakeFetch();
  const dp = new DeepseekProvider({ getConfig: cfg, fetchImpl, env: {} });
  for await (const _ of dp.stream('你好', '拉菲')) { /* consume */ }
  assert.equal(fetchImpl.calls[0].body.voice_id, DEEPSEEK_DEFAULT_VOICE);
});

test('DeepseekProvider：401 映射为"Key 无效"提示，保留官方细节', async () => {
  const dp = new DeepseekProvider({
    getConfig: cfg,
    env: {},
    fetchImpl: async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
  });
  await assert.rejects(async () => {
    for await (const _ of dp.stream('你好', 'stella')) { /* consume */ }
  }, (e) => /401/.test(e.message) && /Key/.test(e.message) && /invalid api key/.test(e.message));
});

test('health：用 GET /models 免费探活（不合成音频、不花钱）', async () => {
  const calls = [];
  const dp = new DeepseekProvider({
    getConfig: cfg,
    env: {},
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization });
      return new Response('{"data":[]}', { status: 200 });
    },
  });
  const h = await dp.health();
  assert.equal(h.available, true);
  assert.equal(calls.length, 1, '只应有一次探活请求');
  assert.ok(calls[0].url.endsWith('/models'), '走 /models 而不是 TTS');
  assert.equal(calls[0].auth, 'Bearer sk-test');
});

test('health：401 → 不可用并提示 Key 无效；网关缺 /models（404）不误报', async () => {
  const bad = new DeepseekProvider({
    getConfig: cfg,
    env: {},
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });
  const h = await bad.health();
  assert.equal(h.available, false);
  assert.match(String(h.message), /无效|401/);

  const gateway = new DeepseekProvider({
    getConfig: cfg,
    env: {},
    fetchImpl: async () => new Response('not found', { status: 404 }),
  });
  const h2 = await gateway.health();
  assert.equal(h2.available, true, '网关没有 /models 但凭据存在，应视为可用');
});
test('DeepseekProvider.listVoices：两个官方音色，id 稳定', async () => {
  const dp = new DeepseekProvider({ getConfig: cfg, env: {} });
  const voices = await dp.listVoices();
  assert.deepEqual(voices.map((v) => v.id).sort(), ['stella', 'tide']);
});

// ─── TTSService 分发 ───
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
  deepseekApiKey: '',
  deepseekApiKeyEnv: 'DEEPSEEK_API_KEY',
  quotaDaily: null,
};

test('TTSService：deepseek 合成保存合法 16-bit WAV 且带真实时长（可显示进度）', async () => {
  const store = new AudioStore('http://host');
  const dp = new DeepseekProvider({ getConfig: cfg, fetchImpl: fakeFetch(), env: {} });
  const tts = new TTSService(
    () => ({ ...baseConfig, provider: 'deepseek', deepseekApiKey: 'sk-test' }),
    store,
    { deepseek: dp },
  );
  const r = await tts.synthesize('你好');
  assert.ok(r.filename.endsWith('.wav'));
  assert.ok(Math.abs(r.audioLen - 0.5) < 0.01);
  assert.ok(r.audioUrl.includes(r.filename));
  const saved = readFileSync(join(store.directory, r.filename));
  const parsed = parseWav(saved);
  assert.ok(parsed, '落盘文件必须是可解析 WAV');
  assert.equal(parsed.bits, 16);
  assert.equal(parsed.sampleRate, SR);
  assert.equal(saved.readUInt32LE(4), saved.length - 8, 'RIFF 长度必须回填正确');
});

test('TTSService：deepseek 模式拒绝本地音色预设（提示改用官方音色）', async () => {
  const store = new AudioStore('http://host');
  const tts = new TTSService(() => ({ ...baseConfig, provider: 'deepseek', deepseekApiKey: 'sk-test' }), store, {
    deepseek: new DeepseekProvider({ getConfig: cfg, fetchImpl: fakeFetch(), env: {} }),
  });
  await assert.rejects(
    () => tts.synthesize('你好', { name: 'v', speakerAudioPath: 'a', promptAudioPath: 'b', promptText: '' }),
    /官方语音模式不支持本地音色预设/,
  );
});

test('TTSService.synthesizeLongWav：允许超过 6000 字（/speak/full 用），仍受 30000 字上限约束', async () => {
  const store = new AudioStore('http://host');
  const fetchImpl = fakeFetch();
  const tts = new TTSService(() => ({ ...baseConfig, provider: 'deepseek', deepseekApiKey: 'sk-test' }), store, {
    deepseek: new DeepseekProvider({ getConfig: cfg, fetchImpl, env: {} }),
  });
  const longText = '啊'.repeat(8000); // 超过单次 6000，但允许
  const r = await tts.synthesizeLongWav(longText);
  assert.equal(fetchImpl.calls.length, 4, '8000 字切成 4 个 2000 字请求');
  assert.ok(r.duration > 0);
  assert.ok(r.bytes > 44);
  const file = join(store.directory, String(r.audioUrl).split('/').pop());
  const saved = readFileSync(file);
  assert.equal(saved.length, r.bytes);
  assert.equal(saved.toString('ascii', 0, 4), 'RIFF');
  assert.equal(saved.readUInt32LE(4), saved.length - 8, 'RIFF 长度已回填');
  assert.equal(saved.readUInt32LE(40), saved.length - 44, 'data 长度已回填');
  await assert.rejects(() => tts.synthesizeLongWav('啊'.repeat(30001)), /文本过长/);
});

test('凭据复用：默认从 Harness 凭据服务解析 DEEPSEEK_API_KEY（与模型鉴权同一份，无需再填）', async () => {
  const fetchImpl = fakeFetch();
  const calls = [];
  const dp = new DeepseekProvider({
    getConfig: () => ({ deepseekApiKey: '', deepseekApiKeyEnv: 'DEEPSEEK_API_KEY', timeout: 30000 }),
    fetchImpl,
    env: {},
    credentials: () => ({
      resolve: async (ref) => { calls.push(ref); return ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-from-harness' } : undefined; },
    }),
  });
  for await (const _ of dp.stream('你好', 'stella')) { /* consume */ }
  assert.deepEqual(calls, ['DEEPSEEK_API_KEY']);
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer sk-from-harness');
});

test('凭据复用：手填 Key 优先于凭据服务（可用独立额度）', async () => {
  const fetchImpl = fakeFetch();
  let resolved = 0;
  const dp = new DeepseekProvider({
    getConfig: () => ({ deepseekApiKey: 'sk-manual', deepseekApiKeyEnv: 'DEEPSEEK_API_KEY', timeout: 30000 }),
    fetchImpl,
    env: {},
    credentials: () => ({ resolve: async () => { resolved++; return { value: 'sk-from-harness' }; } }),
  });
  for await (const _ of dp.stream('你好', 'stella')) { /* consume */ }
  assert.equal(resolved, 0, '有手填 Key 时不应再查凭据服务');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer sk-manual');
});

test('凭据复用：凭据服务异常时回退同名环境变量', async () => {
  const fetchImpl = fakeFetch();
  const dp = new DeepseekProvider({
    getConfig: () => ({ deepseekApiKey: '', deepseekApiKeyEnv: 'DEEPSEEK_API_KEY', timeout: 30000 }),
    fetchImpl,
    env: { DEEPSEEK_API_KEY: 'sk-env-fallback' },
    credentials: () => ({ resolve: async () => { throw new Error('store unreadable'); } }),
  });
  for await (const _ of dp.stream('你好', 'stella')) { /* consume */ }
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer sk-env-fallback');
});

test('凭据复用：引用名留空则完全不查凭据，也不读环境变量', async () => {
  const fetchImpl = fakeFetch();
  let resolved = 0;
  const dp = new DeepseekProvider({
    getConfig: () => ({ deepseekApiKey: '', deepseekApiKeyEnv: '', timeout: 30000 }),
    fetchImpl,
    env: { DEEPSEEK_API_KEY: 'sk-env' },
    credentials: () => ({ resolve: async () => { resolved++; return { value: 'x' }; } }),
  });
  await assert.rejects(async () => {
    for await (const _ of dp.stream('你好', 'stella')) { /* consume */ }
  }, /未找到 DeepSeek 凭据/);
  assert.equal(resolved, 0);
});
test('resolveProviderKind：显式 deepseek 不被迁移守卫改写', () => {
  assert.equal(resolveProviderKind('deepseek', []), 'deepseek');
  assert.equal(resolveProviderKind('deepseek', [{ name: 'x', speakerAudioPath: 'a', promptAudioPath: 'b', promptText: '' }]), 'deepseek');
  assert.equal(resolveProviderKind(undefined, []), 'edge');
});
