import assert from 'node:assert/strict';
import { access, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AudioStore } from '../lib/audio-store.js';
import { snapshotConfig } from '../lib/config.js';
import { apply } from '../lib/index.js';
import { registerPlaybackRoutes } from '../lib/playback-routes.js';
import { DeepseekProvider } from '../lib/providers/deepseek.js';
import { TTSService } from '../lib/tts.service.js';

test('安装工具收到明确授权前不写入安装目录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gsv-approval-test-'));
  const installDir = join(root, 'pending install');
  const tools = new Map();
  const disposers = [];
  const requests = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose?.();
    await rm(root, { recursive: true, force: true });
  });
  apply({
    get(service) {
      if (service === 'approval') return {
        async request(decision) { requests.push(decision); return 'rejected'; },
      };
    },
    tools: { register: tool => tools.set(tool.name, tool) },
    connection: { fetch: { register() {} } },
    effect: callback => disposers.push(callback()),
    on() {},
  }, { provider: 'edge', installDir });
  const call = { agent: {}, callId: 'setup-test', signal: new AbortController().signal };
  await assert.rejects(() => tools.get('tts_setup_engine').execute({}, call), /未授权/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].callId, call.callId);
  assert.ok(requests[0].reason.includes(installDir));
  await assert.rejects(access(installDir), { code: 'ENOENT' });
});

test('分段应用一次词典，设置热更新仅影响下一条朗读', async t => {
  let config = snapshotConfig({ provider: 'edge', defaultVoice: 'zh-CN-YunxiNeural', lexicon: 'DSH=BETA\nBETA=GAMMA' });
  const calls = [];
  const store = new AudioStore();
  t.after(() => store.dispose());
  const service = new TTSService(() => config, store, {
    edge: {
      async *stream(text, voice) {
        calls.push({ text, voice });
        config = { ...config, provider: 'deepseek', defaultVoice: 'stella', lexicon: 'DSH=changed' };
        yield { mime: 'audio/mpeg', data: Buffer.from('mp3') };
      },
    },
    deepseek: { async *stream() { assert.fail('已有任务不能换到另一提供方'); } },
  });
  const segments = await service.synthesizeSegments('DSH in the first sentence. DSH in the second sentence.');
  assert.equal(segments.segments.length, 2);
  assert.deepEqual(calls, [
    { text: 'BETA in the first sentence.', voice: 'zh-CN-YunxiNeural' },
    { text: 'BETA in the second sentence.', voice: 'zh-CN-YunxiNeural' },
  ]);
  assert.equal(service.prepareJob('DSH').voice, 'stella');
  assert.equal(service.prepareJob('DSH').text, 'changed');
});

test('缓存隔离、原子发布、Range 与 TTL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gsv-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = new AudioStore('http://host', 'same profile', root);
  const first = a.saveRaw('first.wav', Buffer.from([0, 1, 2, 3]));
  const b = new AudioStore('http://host', 'same profile', root);
  assert.notEqual(a.directory, b.directory);
  assert.equal(b.serve(new Request(first.url)).status, 404);
  const range = a.serve(new Request(first.url, { headers: { range: 'bytes=1-2' } }));
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 1-2/4');
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), new Uint8Array([1, 2]));
  assert.equal(a.serve(new Request(first.url, { method: 'HEAD' })).body, null);
  assert.equal(a.serve(new Request(first.url, { headers: { range: 'bytes=8-' } })).status, 416);
  await utimes(join(a.directory, first.name), new Date(0), new Date(0));
  assert.equal(a.stats().fileCount, 0);
  assert.equal(a.serve(new Request(first.url)).status, 404);
});

test('DeepSeek 在响应结束前产出 PCM，跨包样本完整，取消传到上游', async () => {
  let writer;
  let cancelled = false;
  const source = new ReadableStream({
    start(controller) { writer = controller; controller.enqueue(Uint8Array.of(7)); },
    cancel() { cancelled = true; },
  });
  const abort = new AbortController();
  const provider = new DeepseekProvider({
    getConfig: () => snapshotConfig({ provider: 'deepseek', deepseekApiKey: 'test-key' }),
    fetchImpl: async () => new Response(source, { headers: { 'Content-Type': 'application/octet-stream' } }),
  });
  const stream = provider.stream('test', 'stella', abort.signal);
  const first = stream.next();
  writer.enqueue(Uint8Array.of(8, 9));
  assert.deepEqual(Array.from((await first).value.data), [7, 8]);
  const blocked = stream.next();
  abort.abort();
  await assert.rejects(blocked, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('朗读消息仅在所属会话解析，自动朗读按消息 ID 排队且不返回正文', async t => {
  const routes = new Map();
  const cleanups = [];
  const makeSession = id => ({ id, events: [], snapshotEvents() { return this.events; } });
  const a = makeSession('a');
  const b = makeSession('b');
  const sessions = new Map([[a.id, a], [b.id, b]]);
  let observe;
  const ctx = {
    sessions,
    effect(register) { cleanups.push(register()); },
    on(name, callback) { if (name === 'session/event') observe = callback; },
    connection: { fetch: { register(route) { routes.set(route.path, route); } } },
  };
  t.after(() => { for (const cleanup of cleanups) cleanup?.(); });
  const config = snapshotConfig({ provider: 'edge', autoPlay: true, interruptOnNew: false });
  const store = new AudioStore();
  t.after(() => store.dispose());
  const seen = [];
  const tts = new TTSService(() => config, store, {
    edge: { async *stream(text) { seen.push(text); yield { mime: 'audio/mpeg', data: Buffer.from('mp3') }; } },
  });
  registerPlaybackRoutes(ctx, { config: () => config, tts, audio: store });
  const append = (session, id, text) => {
    const event = { type: 'assistant/message', data: { message: { id, content: [
      { type: 'thinking', text: 'private reasoning' }, { type: 'text', text },
    ] } } };
    session.events.push(event);
    observe(session, event);
  };
  const post = (path, body) => {
    const route = routes.get('/api/dsh-gsv-tts' + path);
    return route.fetch(new Request('http://localhost' + route.path, { method: 'POST', body: JSON.stringify(body) }));
  };
  append(a, 'a1', 'same text');
  append(a, 'a2', 'same text');
  append(b, 'b1', 'other session');
  assert.equal((await post('/speak', { sessionId: 'b', messageId: 'a1', text: 'ignored' })).status, 404);
  assert.deepEqual(await (await post('/autoplay/poll', { sessionId: 'a', sinceSeq: 0 })).json(), { seq: 1, messageId: 'a1' });
  assert.deepEqual(await (await post('/autoplay/poll', { sessionId: 'a', sinceSeq: 1 })).json(), { seq: 2, messageId: 'a2' });
  assert.equal((await post('/autoplay/speak', { sessionId: 'b', messageId: 'a1', seq: 1 })).status, 404);
  assert.equal((await post('/speak', { sessionId: 'a', messageId: 'a1' })).status, 200);
  assert.deepEqual(seen, ['same text']);
  config.interruptOnNew = true;
  assert.deepEqual(await (await post('/autoplay/poll', { sessionId: 'a', sinceSeq: 0 })).json(), { seq: 2, messageId: 'a2' });
});
