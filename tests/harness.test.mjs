import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';

const entry = process.env.DSH_GSV_TEST_HARNESS;
const tarball = process.env.DSH_GSV_TEST_TARBALL;
const api = '/api/dsh-gsv-tts';

async function localServer(handler) {
  const server = createServer(handler);
  server.listen({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  return server;
}

test('真实 DSH Web 使用认证路由传输 WAV，隔离运行且不调用模型', { skip: !entry, timeout: tarball ? 240_000 : 75_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gsv-host-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 2 }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/_KEY$|_TOKEN$|^DSH_HOME$/i.test(key)) delete env[key];
  env.DSH_HOME = join(root, 'home');
  if (tarball) {
    const install = promisify(execFile);
    try {
      await install(process.execPath, [resolve(entry), 'plugin', '--profile', 'web', 'add', resolve(tarball)],
        { cwd: root, env, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true });
    } catch (error) {
      throw new Error(`DSH package install failed: ${error.stdout}\n${error.stderr}`, { cause: error });
    }
  }
  const upstreamClosed = Promise.withResolvers();
  const providerRequests = new Map();
  const provider = await localServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { text } = JSON.parse(body);
    providerRequests.set(text, (providerRequests.get(text) ?? 0) + 1);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.write(Buffer.from([1, 2]));
    if (text === 'cancel fixture') {
      res.once('close', () => upstreamClosed.resolve());
      return;
    }
    res.end(Buffer.from([3, 4]));
  });
  const reservation = await localServer();
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const patch = join(root, 'tts.patch.yml');
  const eventFixture = join(root, 'speech-events.mjs');
  await writeFile(eventFixture, `
    export const inject = ['connection', 'sessions'];
    export function apply(ctx) {
      const session = ctx.sessions.create('speech-fixture');
      ctx.connection.fetch.register({ path: '/api/gsv-test/assistant', methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          const frame = await request.json();
          ctx.emit('agent/assistant-stream', { agent: { session }, frame });
          return Response.json({ ok: true });
        }
      });
    }
  `);
  const config = { provider: 'deepseek', defaultVoice: 'stella', deepseekApiKey: 'fake-key-for-isolated-test', autoPlay: true, liveReply: true };
  const events = { id: 'speech-events', name: eventFixture.replaceAll('\\', '/') };
  if (tarball) {
    await writeFile(join(env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'),
      JSON.stringify([{ id: 'dsh-gsv-tts', config }]));
  }
  await writeFile(patch, JSON.stringify(tarball
    ? [{ insert: [events] }]
    : [{ insert: [{ id: 'dsh-gsv-tts', name: resolve(import.meta.dirname, '../lib/index.js').replaceAll('\\', '/'), config }, events] }]));
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${provider.address().port}`;
  const child = spawn(process.execPath, [resolve(entry), 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-18000); });
  child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-18000); });
  try {
    let login;
    for (let attempts = 0; attempts < 80; attempts++) {
      const match = output.match(/dsh web: (http:\/\/[^\s]+)/);
      if (match) { login = new URL(match[1]); break; }
      if (child.exitCode !== null) break;
      await delay(500);
    }
    assert.ok(login, output.replace(/([?&]token=)[^\s"'<>]+/g, '$1[REDACTED]'));
    assert.equal(login.origin, origin);
    const redirect = await fetch(login, { redirect: 'manual' });
    const cookie = redirect.headers.get('set-cookie')?.split(';', 1)[0];
    assert.equal(redirect.status, 303);
    assert.ok(cookie);
    const fetchRoute = (path, options = {}) => fetch(origin + path, { signal: AbortSignal.timeout(5000), ...options });
    if (tarball) {
      const page = await (await fetchRoute('/', { headers: { cookie } })).text();
      const boot = page.match(/globalThis\["__DSH_BOOT__"\] = (\{[^<]+\})<\/script>/);
      assert.ok(boot, 'DSH should serve a boot manifest for its installed client modules');
      const graph = JSON.parse(boot[1]);
      const browserPlugin = graph.entries.find(item => item.id === 'dsh-gsv-tts');
      assert.ok(browserPlugin, 'DSH should register the package client in its boot manifest');
      const asset = await fetch(new URL(browserPlugin.url, origin), { headers: { cookie }, signal: AbortSignal.timeout(5000) });
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /id: "dsh-gsv-tts"/);
    }
    const json = (path, body, headers = {}) => fetchRoute(api + path, {
      method: 'POST', headers: { cookie, Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    assert.equal((await fetchRoute(api + '/engine/status')).status, 401);
    assert.equal((await fetchRoute(api + '/audio?file=missing.wav')).status, 401);
    const catalog = await json('/provider/catalog', {});
    assert.equal(catalog.status, 200, await catalog.clone().text());
    assert.equal((await catalog.json()).current, 'deepseek');
    if (tarball) {
      const voice = async (provider, voice) => {
        const selected = await json('/settings/voice', { provider, voice });
        assert.equal(selected.status, 200, await selected.clone().text());
        return selected.json();
      };
      assert.equal((await voice('edge', 'en-US-JennyNeural')).defaultVoice, 'en-US-JennyNeural');
      assert.equal((await voice('deepseek', 'tide')).defaultVoice, 'tide');
      assert.equal((await voice('edge')).defaultVoice, 'en-US-JennyNeural');
      const official = await voice('deepseek');
      assert.equal(official.defaultVoice, 'tide');
      assert.equal(official.voiceByProvider.edge, 'en-US-JennyNeural');
      await voice('deepseek', 'stella');
      assert.equal((await json('/settings/voice', { provider: 'deepseek', voice: 'en-US-JennyNeural' })).status, 400);
    }
    await access(join(env.DSH_HOME, 'gsv-tts', 'speech-usage.sqlite'));
    const publish = (frame) => fetchRoute('/api/gsv-test/assistant', {
      method: 'POST', headers: { cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(frame),
    });
    const attemptId = 'speech-fixture:1';
    assert.equal((await publish({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 })).status, 200);
    assert.equal((await publish({ type: 'chunk', attemptId, revision: 2, index: 0, time: Date.now(),
      chunk: { type: 'block-start', index: 0, blockType: 'text' } })).status, 200);
    assert.equal((await publish({ type: 'chunk', attemptId, revision: 3, index: 1, time: Date.now(),
      chunk: { type: 'text-delta', index: 0, text: '首句已经可以播了。' } })).status, 200);
    const liveReply = await (await json('/autoplay/poll', { sessionId: 'speech-fixture', sinceSeq: 0 })).json();
    assert.equal(liveReply.attemptId, attemptId, JSON.stringify(liveReply));
    const liveSpeech = await json('/autoplay/speak', { sessionId: 'speech-fixture',
      seq: liveReply.seq, messageId: liveReply.messageId }, { Accept: 'application/x-ndjson' });
    assert.equal(liveSpeech.status, 200);
    assert.match(await liveSpeech.text(), /首句已经可以播了/);
    assert.equal((await publish({ type: 'end', attemptId, revision: 4, index: 2, outcome: { kind: 'abandoned' } })).status, 200);
    const withdrawn = await (await json('/autoplay/poll', { sessionId: 'speech-fixture', sinceSeq: 0 })).json();
    assert.deepEqual(withdrawn.cancelled, [attemptId]);
    assert.equal(withdrawn.messageId, undefined);
    assert.equal((await json('/speak', { sessionId: 'missing', messageId: 'missing' })).status, 404);
    const prepared = await json('/speak', { text: 'isolated fixture' }, { Accept: 'audio/wav' });
    assert.equal(prepared.status, 200, await prepared.clone().text());
    const { streamUrl } = await prepared.json();
    const wav = Buffer.from(await (await fetchRoute(streamUrl, { headers: { cookie } })).arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
    const complete = await (await json('/speak/full', { text: 'isolated fixture' })).json();
    assert.ok(complete.audioUrl);
    assert.equal(providerRequests.get('isolated fixture'), 1);
    const audio = await fetch(complete.audioUrl, { headers: { cookie, Range: 'bytes=44-47' } });
    assert.equal(audio.status, 206);
    assert.deepEqual([...new Uint8Array(await audio.arrayBuffer())], [1, 2, 3, 4]);

    const cancellable = await json('/speak', { text: 'cancel fixture' }, { Accept: 'audio/wav' });
    const cancellableUrl = (await cancellable.json()).streamUrl;
    const controller = new AbortController();
    const stream = await fetchRoute(cancellableUrl, { headers: { cookie }, signal: controller.signal });
    const reader = stream.body.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await reader.cancel().catch(() => {});
    await Promise.race([upstreamClosed.promise, delay(3000, null, { ref: false }).then(() => {
      throw new Error('上游在客户端取消后未关闭');
    })]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    provider.closeAllConnections();
    await new Promise(done => provider.close(done));
  }
});
