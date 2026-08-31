// 4.0.0 迁移守卫单测：老用户(无 provider)→gsv；全新安装→edge；schema 无默认值防污染
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Schema from '@deepseek-ai/schemastery';
import { resolveProvider } from '../lib/migration.js';

test('迁移：user 层不存在（settings.yaml 无 dsh-gsv-tts 段，全新安装）→ edge', () => {
  assert.equal(resolveProvider(undefined), 'edge');
});

test('迁移：user 层存在但无 provider（老用户）→ gsv，声音不变', () => {
  assert.equal(resolveProvider({ autoPlay: false }), 'gsv');
  assert.equal(resolveProvider({ voices: [] }), 'gsv');
});

test('迁移：user.provider 已设置 → 沿用', () => {
  assert.equal(resolveProvider({ provider: 'edge' }), 'edge');
  assert.equal(resolveProvider({ provider: 'gsv' }), 'gsv');
});

test('迁移：非法 provider → gsv 兜底', () => {
  assert.equal(resolveProvider({ provider: 'weird' }), 'gsv');
});

test('schema：provider 无默认值（缺省即省略，供 user 层判定）；quotaDaily 缺省为 undefined（代码按 null 处理）', () => {
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
