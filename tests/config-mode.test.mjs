import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEngineMode, snapshotConfig } from '../lib/config.js';

test('engineMode：显式 always / eco 优先', () => {
  assert.equal(resolveEngineMode({ engineMode: 'always' }), 'always');
  assert.equal(resolveEngineMode({ engineMode: 'eco' }), 'eco');
});

test('engineMode：缺省为节能（与旧版一致）', () => {
  assert.equal(resolveEngineMode({}), 'eco');
  assert.equal(snapshotConfig({}).engineMode, 'eco');
});

test('engineMode：兼容 5.1.0 开发期的 autoStart', () => {
  assert.equal(resolveEngineMode({ autoStart: true }), 'always');
  assert.equal(resolveEngineMode({ autoStart: false }), 'eco');
  assert.equal(resolveEngineMode({ autoStart: true, engineMode: 'eco' }), 'eco');
});
