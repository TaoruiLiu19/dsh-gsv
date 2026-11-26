import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AudioStore } from '../lib/audio-store.js';
import { snapshotConfig } from '../lib/config.js';
import { LiveSpeechQueue } from '../lib/live-speech.js';
import { verifyModelManifest } from '../lib/model-manifest.js';
import { CustomSpeechProvider } from '../lib/providers/custom.js';
import { DeepseekProvider } from '../lib/providers/deepseek.js';
import { SpeechStats, usageLedgerPath } from '../lib/speech-stats.js';
import { TTSService } from '../lib/tts.service.js';

test('实时朗读先发完整正文句，忽略推理和代码，重试撤销旧音频', () => {
  const config = snapshotConfig({ autoPlay: true, liveReply: true });
  const queue = new LiveSpeechQueue();
  queue.accept({ type: 'start', attemptId: 'first' }, config);
  const chunk = (text, type = 'text-delta', attemptId = 'first') =>
    queue.accept({ type: 'chunk', attemptId, chunk: { type, text } }, config);
  chunk('隐藏推理。', 'reasoning-delta');
  chunk('第一句话');
  assert.equal(queue.items.length, 0);
  chunk('。\n```js\n内部代码。');
  assert.deepEqual(queue.items.map(item => item.text.trim()), ['第一句话。']);
  const first = queue.items[0];
  chunk('\n```\n后半句');
  queue.accept({ type: 'end', attemptId: 'first', outcome: { kind: 'abandoned' } }, config);
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(queue.cancelled, ['first']);
  assert.equal(queue.items.length, 0);

  queue.accept({ type: 'start', attemptId: 'second' }, config);
  chunk('新回复。最后一句', 'text-delta', 'second');
  queue.commit('message', '新回复。最后一句', true);
  queue.accept({ type: 'end', attemptId: 'second', outcome: { kind: 'committed', eventType: 'assistant/message' } }, config);
  assert.deepEqual(queue.items.map(item => item.text.trim()), ['新回复。', '最后一句']);
  assert.ok(queue.items[0].seq > first.seq);
});

test('兼容接口沿用 PCM 解码，使用独立的模型、指令和凭据', async () => {
  const config = snapshotConfig({ provider: 'custom', customBaseUrl: 'http://127.0.0.1:8880/v1',
    customInstructions: '温和', customModel: 'kokoro', customKeyRef: 'TEST_SPEECH' });
  const seen = [];
  const provider = new CustomSpeechProvider(() => config, () => ({
    async resolve(name) { assert.equal(name, 'TEST_SPEECH'); return { value: 'fixture-token' }; },
  }), async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  const chunks = await Array.fromAsync(provider.stream('试播', 'af_sarah'));
  assert.equal(seen[0].url, 'http://127.0.0.1:8880/v1/audio/speech');
  assert.equal(seen[0].headers.Authorization, 'Bearer fixture-token');
  assert.deepEqual(seen[0].body, { model: 'kokoro', voice: 'af_sarah', input: '试播',
    response_format: 'pcm', instructions: '温和' });
  assert.equal(chunks[0].sampleRate, 24000);
});

test('完整流式播放生成可复用下载，预算只在新 DeepSeek 请求前扣记', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gsv-feature-'));
  const stats = new SpeechStats(join(root, 'usage.sqlite'));
  const audio = new AudioStore(undefined, 'cache-budget', root);
  t.after(async () => { stats.dispose(); audio.dispose(); await rm(root, { recursive: true, force: true }); });
  const config = snapshotConfig({ provider: 'deepseek', deepseekApiKey: 'test-key', deepseekAutoCharsPerDay: 4 });
  let requested = 0;
  const deepseek = new DeepseekProvider({ getConfig: () => config,
    async fetchImpl() {
      requested++;
      return new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'application/octet-stream' } });
    },
  });
  const service = new TTSService(() => config, audio, { deepseek, stats });
  const job = { ...service.prepareJob('你好'), automatic: true };
  const signal = new AbortController().signal;
  const live = await Array.fromAsync(service.liveWav(job, signal));
  assert.equal(live.length, 2);
  assert.ok((await service.complete(job, signal)).audioUrl.endsWith('.wav'));
  assert.equal(requested, 1);
  await assert.rejects(service.complete({ ...service.prepareJob('超额'), automatic: true }), /已达上限/);
  assert.equal(requested, 1);
  await service.complete(service.prepareJob('手动'));
  assert.equal(requested, 2);
  assert.equal(stats.snapshot().deepseekCharacters, 8);
  assert.equal(stats.snapshot().deepseekAutomaticCharacters, 4);
});

test('逐句播放和对应的整段下载复用同一批音频，字幕时间与音频长度一致', async t => {
  const audio = new AudioStore();
  t.after(() => audio.dispose());
  const config = snapshotConfig({ provider: 'deepseek', deepseekApiKey: 'test-key' });
  const calls = [];
  const deepseek = {
    async *stream(text) {
      calls.push(text);
      yield { mime: 'audio/pcm-s16', sampleRate: 24000, data: Buffer.alloc(48000) };
    },
  };
  const tts = new TTSService(() => config, audio, { deepseek });
  const job = { ...tts.prepareJob('第一句。第二句。'), followText: true };
  const segments = await Array.fromAsync(tts.streamSegments(job));
  assert.deepEqual(segments.map(segment => [segment.text, segment.duration]), [['第一句。', 1], ['第二句。', 1]]);
  const whole = await tts.complete(job);
  assert.equal(whole.duration, 2);
  assert.equal(whole.bytes, 96044);
  assert.deepEqual(calls, ['第一句。', '第二句。']);
});

test('同时播放与下载共用同一个上游，取消一端不会中断另一端', async t => {
  const audio = new AudioStore();
  t.after(() => audio.dispose());
  const config = snapshotConfig({ provider: 'deepseek' });
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let calls = 0;
  const deepseek = {
    async *stream(_text, _voice, signal) {
      calls++;
      started.resolve(signal);
      yield { mime: 'audio/pcm-s16', sampleRate: 24000, data: Buffer.from([1, 2]) };
      await finish.promise;
      signal.throwIfAborted();
      yield { mime: 'audio/pcm-s16', sampleRate: 24000, data: Buffer.from([3, 4]) };
    },
  };
  const tts = new TTSService(() => config, audio, { deepseek });
  const job = tts.prepareJob('concurrent reply');
  const cancelled = new AbortController();
  const stream = tts.liveWav(job, cancelled.signal);
  assert.equal(Buffer.from((await stream.next()).value).toString('ascii', 0, 4), 'RIFF');
  const upstream = await started.promise;
  const late = tts.liveWav(job, new AbortController().signal);
  const downloads = [tts.complete(job), tts.complete(job)];
  const collected = Array.fromAsync(late);
  cancelled.abort();
  await assert.rejects(stream.next(), { name: 'AbortError' });
  assert.equal(upstream.aborted, false);
  finish.resolve();
  const [first, second] = await Promise.all(downloads);
  assert.deepEqual(first, second);
  assert.equal(first.bytes, 48);
  assert.deepEqual([...Buffer.concat(await collected).subarray(44)], [1, 2, 3, 4]);
  assert.equal(calls, 1);
});

test('最后一个取消者中止合成，删除临时文件，之后可重试', async t => {
  const audio = new AudioStore();
  t.after(() => audio.dispose());
  const config = snapshotConfig({ provider: 'deepseek' });
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  let calls = 0;
  const deepseek = {
    async *stream(_text, _voice, signal) {
      if (++calls === 1) {
        started.resolve(signal);
        try {
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        } finally { stopped.resolve(); }
      }
      yield { mime: 'audio/pcm-s16', sampleRate: 24000, data: Buffer.from([1, 2]) };
    },
  };
  const tts = new TTSService(() => config, audio, { deepseek });
  const job = tts.prepareJob('retry the same reply');
  const a = new AbortController();
  const b = new AbortController();
  const first = assert.rejects(tts.complete(job, a.signal), { name: 'AbortError' });
  const second = assert.rejects(tts.complete(job, b.signal), { name: 'AbortError' });
  const upstream = await started.promise;
  a.abort();
  await first;
  assert.equal(upstream.aborted, false);
  b.abort();
  await Promise.all([second, stopped.promise]);
  assert.equal(upstream.aborted, true);
  assert.equal((await tts.complete(job)).bytes, 46);
  assert.equal(calls, 2);
  assert.ok((await readdir(audio.directory)).every(name => name.endsWith('.wav')));
});

test('同一 DSH home 的多个实例共用预算，另一个 home 独立计数', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gsv-budget-'));
  const path = (home, workspace) => usageLedgerPath((...parts) => join(root, home, ...parts), join(root, workspace));
  const first = new SpeechStats(path('one', 'project-1'));
  const same = new SpeechStats(path('one', 'project-2'));
  const other = new SpeechStats(path('two', 'project-1'));
  t.after(async () => {
    [first, same, other].forEach(ledger => ledger.dispose());
    await rm(root, { recursive: true, force: true });
  });
  first.reserveDeepseek('你', true, 2);
  assert.throws(() => same.reserveDeepseek('好', true, 2), { status: 429 });
  other.reserveDeepseek('好', true, 2);
  assert.equal(same.snapshot().deepseekAutomaticCharacters, 2);
  assert.equal(other.snapshot().deepseekAutomaticCharacters, 2);
});

test('GSV 版本清单验证原文件，权重变化后拒绝启动准备', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gsv-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('fixture weights');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const models = { 's1v3.ckpt': digest, 's2Gv2ProPlus.pth': digest };
  for (const name of Object.keys(models)) await writeFile(join(root, name), bytes);
  const manifest = join(root, 'model-lock.json');
  await writeFile(manifest, JSON.stringify({ version: 'test', files: models }));
  assert.deepEqual(await verifyModelManifest(root, manifest), { verified: true, version: 'test', checked: 2 });
  await writeFile(join(root, 's1v3.ckpt'), 'changed');
  await assert.rejects(verifyModelManifest(root, manifest), /SHA-256 不匹配/);
});
