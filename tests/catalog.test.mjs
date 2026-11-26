// 提供方 / 引擎目录：描述符完整性，以及能力与实现的一致性
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_CATALOG,
  GSV_ENGINE,
  getProviderDescriptor,
  providerIds,
  isCloudProvider,
  usesLocalVoices,
  defaultVoiceFor,
  isValidVoiceId,
} from '../lib/catalog.js';

test('目录：四个 provider，id 唯一且可查', () => {
  assert.deepEqual(providerIds(), ['edge', 'deepseek', 'custom', 'gsv']);
  assert.equal(getProviderDescriptor('deepseek').label.includes('DeepSeek'), true);
  assert.equal(getProviderDescriptor('nope'), undefined);
});

test('目录：能力决定 UI 分支（引擎/凭据/音色来源）', () => {
  const edge = getProviderDescriptor('edge');
  const deepseek = getProviderDescriptor('deepseek');
  const gsv = getProviderDescriptor('gsv');

  assert.equal(edge.capabilities.needsEngine, false);
  assert.equal(edge.capabilities.needsKey, false);
  assert.equal(edge.capabilities.billed, false);
  assert.equal(edge.capabilities.voiceSource, 'remote');

  assert.equal(deepseek.capabilities.needsKey, true);
  assert.equal(deepseek.capabilities.billed, true);
  assert.equal(deepseek.capabilities.streaming, true);
  assert.equal(deepseek.capabilities.voiceSource, 'builtin');
  assert.equal(deepseek.defaultVoice, 'stella', '官方默认音色来自目录');

  assert.equal(gsv.capabilities.needsEngine, true);
  assert.equal(gsv.capabilities.cloning, true);
  assert.equal(gsv.capabilities.voiceSource, 'presets');

  assert.equal(isCloudProvider('edge'), true);
  assert.equal(isCloudProvider('deepseek'), true);
  assert.equal(isCloudProvider('gsv'), false);
  assert.equal(usesLocalVoices('gsv'), true);
  assert.equal(usesLocalVoices('edge'), false);
});

test('目录：音色校验与默认音色由描述符决定', () => {
  assert.equal(isValidVoiceId('edge', 'zh-CN-XiaoxiaoNeural'), true);
  assert.equal(isValidVoiceId('edge', '拉菲'), false);
  assert.equal(isValidVoiceId('deepseek', 'stella'), true);
  assert.equal(isValidVoiceId('deepseek', 'tide'), true);
  assert.equal(isValidVoiceId('deepseek', '海星'), false);
  assert.equal(isValidVoiceId('gsv', '任意预设名'), true, '本地预设名不做格式限制');
  assert.equal(isValidVoiceId('deepseek', ''), false);
  assert.equal(defaultVoiceFor('deepseek'), 'stella');
  assert.equal(defaultVoiceFor('edge'), '');
});

test('目录：引擎模型清单是事实源（doctor/setup 共用）', () => {
  assert.equal(GSV_ENGINE.id, 'gsv');
  assert.equal(GSV_ENGINE.startScript, 'scripts/dsh_stream_api.py');
  const files = GSV_ENGINE.models.map((m) => m.file);
  assert.deepEqual(files, ['s1v3.ckpt', 's2Gv2ProPlus.pth']);
  assert.ok(GSV_ENGINE.models.every((m) => m.required));
});
