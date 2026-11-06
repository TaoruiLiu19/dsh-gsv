import test from 'node:test';
import assert from 'node:assert/strict';
import { wavHeader, float32ToInt16 } from '../lib/wav-stream.js';

test('wavHeader：流式未知长度头', () => {
  const h = wavHeader(32000);
  assert.equal(h.length, 44);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.toString('ascii', 8, 12), 'WAVE');
  assert.equal(h.toString('ascii', 12, 16), 'fmt ');
  assert.equal(h.readUInt16LE(20), 1);
  assert.equal(h.readUInt16LE(22), 1);
  assert.equal(h.readUInt32LE(24), 32000);
  assert.equal(h.readUInt32LE(28), 64000);
  assert.equal(h.readUInt16LE(34), 16);
  assert.equal(h.toString('ascii', 36, 40), 'data');
  assert.equal(h.readUInt32LE(4), 0xffffffff);
  assert.equal(h.readUInt32LE(40), 0xffffffff);
});

test('float32ToInt16：限幅与量化', () => {
  const input = Buffer.alloc(6 * 4);
  [0, 0.5, -0.5, 1, -1, 2].forEach((v, i) => input.writeFloatLE(v, i * 4));
  const out = float32ToInt16(input);
  assert.equal(out.length, 12);
  assert.equal(out.readInt16LE(0), 0);
  assert.equal(out.readInt16LE(2), 16384);
  assert.equal(out.readInt16LE(4), -16384);
  assert.equal(out.readInt16LE(6), 32767);
  assert.equal(out.readInt16LE(8), -32768);
  assert.equal(out.readInt16LE(10), 32767);
});
