import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { TTSService } from '../lib/tts.service.js';
import { AudioStore } from '../lib/audio-store.js';

const voice = {
  name: 'test',
  speakerAudioPath: 'D:\\test\\speaker.wav',
  promptAudioPath: 'D:\\test\\prompt.wav',
  promptText: 'test',
};

test('synthesizeFullWav：流式 PCM 写成一个完整 WAV', async () => {
  const fakeGsv = {
    async *streamWithPreset() {
      // 32 kHz、1 秒静音（float32 → 16-bit PCM）
      yield { mime: 'audio/pcm', sampleRate: 32000, data: Buffer.alloc(32000 * 4) };
    },
  };
  const store = new AudioStore(() => undefined);
  const service = new TTSService(
    () => ({ provider: 'gsv', apiUrl: 'http://127.0.0.1:9880', timeout: 30000, defaultVoice: 'test', voices: [voice] }),
    store,
    { gsv: fakeGsv },
  );
  const r = await service.synthesizeFullWav('测试整段 WAV', voice);
  assert.equal(r.parts, 1);
  assert.ok(Math.abs(r.duration - 1) < 0.01, `duration ${r.duration}`);
  assert.equal(r.bytes, 44 + 32000 * 2);
  const file = join(store.directory, r.audioUrl.split('/').pop());
  const buf = readFileSync(file);
  assert.equal(buf.length, r.bytes);
  assert.equal(buf.readUInt32LE(4), 36 + 32000 * 2);
  assert.equal(buf.readUInt32LE(40), 32000 * 2);
  assert.equal(buf.readUInt32LE(24), 32000);
  try { unlinkSync(file); } catch { /* 其他测试可能清理了临时目录 */ }
});
