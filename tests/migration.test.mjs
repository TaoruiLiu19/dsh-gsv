// 5.0.0 迁移 + 配置归一单测：
// - provider 迁移守卫：显式沿用 / 老用户（有音色）→ gsv / 全新安装 → edge
// - snapshotConfig：普通对象与 DSH 0.2+ volatile 引用都能归一，且引用就地更新后立即读到新值
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Schema from '@deepseek-ai/schemastery';
import { resolveProvider } from '../lib/migration.js';
import { DEFAULT_API_URL, DEFAULT_INSTALL_DIR, snapshotConfig, storedProvider } from '../lib/config.js';

const VOICE = { name: 'a', speakerAudioPath: 'p', promptAudioPath: 'q', promptText: '' };

test('迁移：未显式设置 provider + 已有音色（老用户）→ gsv，声音不变', () => {
  assert.equal(resolveProvider(undefined, [VOICE]), 'gsv');
  assert.equal(resolveProvider(undefined, [{ ...VOICE }, { ...VOICE, name: 'b' }]), 'gsv');
});

test('迁移：未显式设置 provider + 无音色（全新安装）→ edge', () => {
  assert.equal(resolveProvider(undefined, []), 'edge');
  assert.equal(resolveProvider(null, []), 'edge');
});

test('迁移：user.provider 已设置 → 沿用', () => {
  assert.equal(resolveProvider('edge', [VOICE]), 'edge');
  assert.equal(resolveProvider('gsv', []), 'gsv');
});

test('迁移：非法 provider → 按未设置处理（有音色 gsv / 无音色 edge）', () => {
  assert.equal(resolveProvider('weird', [VOICE]), 'gsv');
  assert.equal(resolveProvider('weird', []), 'edge');
});

test('schema：provider 无默认值（缺省即省略，供迁移判定）；quotaDaily 缺省为 undefined（代码按 null 处理）', () => {
  const s = Schema.object({
    provider: Schema.union([Schema.const('gsv'), Schema.const('edge')]),
    quotaDaily: Schema.union([Schema.number().min(0), Schema.const(null)]).default(null),
  });
  const out = s({});
  assert.equal(out.provider, undefined, 'provider 不应有默认值');
  assert.equal(out.quotaDaily, undefined, 'schemastery union 对缺省键不给默认值（代码用 ?? null 兜底）');
  assert.equal(s({ provider: 'edge', quotaDaily: 100 }).provider, 'edge');
  assert.throws(() => s({ provider: 'bad' }));
});

test('snapshotConfig：普通对象 + 缺省值兜底', () => {
  const snap = snapshotConfig({ provider: 'edge', defaultVoice: 'v1' });
  assert.equal(snap.provider, 'edge');
  assert.equal(snap.defaultVoice, 'v1');
  assert.equal(snap.apiUrl, DEFAULT_API_URL);
  assert.equal(snap.installDir, DEFAULT_INSTALL_DIR);
  assert.equal(snap.interruptOnNew, true);
  assert.equal(snap.quotaDaily, null);
  assert.deepEqual(snap.voices, []);
});

test('snapshotConfig：DSH 0.2+ volatile 引用（Schema.volatile()）解引用为普通值', () => {
  const schema = Schema.object({
    apiUrl: Schema.string().default('http://localhost:9880').volatile(),
    voices: Schema.array(Schema.object({
      name: Schema.string(),
      speakerAudioPath: Schema.string(),
      promptAudioPath: Schema.string(),
      promptText: Schema.string().default(''),
    })).default([]).volatile(),
    defaultVoice: Schema.string().default('').volatile(),
    autoPlay: Schema.boolean().default(false).volatile(),
    timeout: Schema.number().default(30000).volatile(),
    provider: Schema.union([Schema.const('gsv'), Schema.const('edge')]).volatile(),
  });
  const live = schema({ voices: [VOICE], provider: 'edge' });
  const snap = snapshotConfig(live);
  assert.equal(snap.provider, 'edge');
  assert.equal(snap.voices.length, 1);
  assert.equal(snap.voices[0].name, 'a');
  assert.equal(snap.apiUrl, 'http://localhost:9880');
  assert.equal(snap.autoPlay, false);
  assert.equal(storedProvider(live.provider), 'edge');
});

test('snapshotConfig：volatile 引用就地更新后立即读到新值（设置面板热生效的语义）', () => {
  let provider = 'edge';
  let voices = [];
  const config = {
    provider: { get: () => provider },
    voices: { get: () => voices },
  };
  assert.equal(snapshotConfig(config).provider, 'edge');
  // 宿主保存设置后只更新引用内部的值，不重建插件
  provider = 'gsv';
  voices = [VOICE];
  const next = snapshotConfig(config);
  assert.equal(next.provider, 'gsv');
  assert.equal(next.voices.length, 1);
});
