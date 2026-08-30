// 音色注册表核心单测（3.0.0 契约 G）：
// 清单校验 / 信任边界（bundled+trusted 免确认，远端必确认且不下载）/ 两阶段 / 原子写 /
// 卸载护栏（user 拒删、defaultVoice 清理、路径限定）/ 大小与后缀白名单
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateManifest, VoiceRegistryManager, MAX_FILE_BYTES } from '../lib/voice-registry.js';
import { VoiceManager } from '../lib/voice-manager.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const speakerData = Buffer.from('fake-speaker-wav-bytes-0123456789');
const promptData = Buffer.from('fake-prompt-ogg-bytes-0123456789');

const makePkg = (over = {}) => ({
  id: 'test-voice',
  name: 'Test Voice',
  author: 'tester',
  license: 'MIT',
  speaker: 'https://example.com/s.wav',
  prompt: 'https://example.com/p.ogg',
  promptText: 'hello',
  sizeBytes: speakerData.length + promptData.length,
  sha256: { speaker: sha(speakerData), prompt: sha(promptData) },
  ...over,
});

const makeManifest = (voices, over = {}) => ({ schema: 1, version: '1.0.0', trusted: true, voices, ...over });

function makeBaseConfig(installDir) {
  return {
    apiUrl: 'http://localhost:9880',
    voices: [],
    defaultVoice: '',
    autoPlay: false,
    interruptOnNew: true,
    timeout: 30000,
    installDir,
    voiceRegistryUrl: '',
  };
}

function makeManager({ config, fetchers, writeLog }) {
  return new VoiceRegistryManager({
    getConfig: () => config,
    writeConfig: async (patch) => { writeLog.push(patch); Object.assign(config, patch); },
    fetchers,
  });
}

let tmpRoot;
function freshInstallDir() {
  if (!tmpRoot) {
    tmpRoot = join(tmpdir(), 'dsh-gsv-registry-test-' + Math.random().toString(36).slice(2));
    mkdirSync(tmpRoot, { recursive: true });
  }
  return join(tmpRoot, 'install-' + Math.random().toString(36).slice(2));
}

test.after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── 清单校验 ───
test('validateManifest：合法清单通过', () => {
  const m = makeManifest([makePkg()]);
  assert.equal(validateManifest(m).schema, 1);
});

test('validateManifest：id 白名单（斜杠/大写/空）拒绝', () => {
  for (const bad of ['../evil', 'a/b', 'HasUpper', 'a b', '']) {
    assert.throws(() => validateManifest(makeManifest([makePkg({ id: bad })])), new RegExp('id'));
  }
});

test('validateManifest：id/name 唯一性', () => {
  assert.throws(() => validateManifest(makeManifest([makePkg(), makePkg()])), /id 重复/);
  assert.throws(
    () => validateManifest(makeManifest([makePkg({ id: 'a' }), makePkg({ id: 'b', name: 'Test Voice' })])),
    /name 重复/,
  );
});

test('validateManifest：非 https 直链 / 非法 sha256 拒绝', () => {
  assert.throws(() => validateManifest(makeManifest([makePkg({ speaker: 'http://x.com/s.wav' })])), /https/);
  assert.throws(() => validateManifest(makeManifest([makePkg({ prompt: 'ftp://x' })])), /https/);
  assert.throws(() => validateManifest(makeManifest([makePkg({ sha256: { speaker: 'xyz', prompt: sha(promptData) } })])), /sha256/);
  assert.throws(() => validateManifest(makeManifest([makePkg({ sha256: { speaker: sha(speakerData), prompt: 'nope' } })])), /sha256/);
});

// ─── 信任边界 ───
test('信任：远端清单（即使自报 trusted:true）阶段1 必返回 needsConfirm 且不下载', async () => {
  const config = makeBaseConfig(freshInstallDir());
  config.voiceRegistryUrl = 'https://example.com/registry.json'; // 安装/卸载只认配置源
  let binaryCalls = 0;
  const mgr = makeManager({
    config,
    fetchers: {
      fetchText: async () => JSON.stringify(makeManifest([makePkg()], { trusted: true })),
      fetchBinary: async () => { binaryCalls++; return speakerData; },
    },
    writeLog: [],
  });
  const r = await mgr.install('test-voice', false);
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm, true);
  assert.equal(binaryCalls, 0, '信任边界外不得下载任何字节');
  assert.deepEqual(config.voices, []);
});

test('信任：远端清单 confirm 后完成安装并写回 id/source', async () => {
  const config = makeBaseConfig(freshInstallDir());
  config.voiceRegistryUrl = 'https://example.com/registry.json';
  const writeLog = [];
  const mgr = makeManager({
    config,
    fetchers: {
      fetchText: async () => JSON.stringify(makeManifest([makePkg()])),
      fetchBinary: async (url) => (url.endsWith('s.wav') ? speakerData : promptData),
    },
    writeLog,
  });
  const r = await mgr.install('test-voice', true);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.voice.id, 'test-voice');
  assert.equal(r.voice.source, 'registry');
  assert.equal(writeLog.length, 1);
  assert.equal(config.voices.length, 1);
  assert.equal(config.voices[0].source, 'registry');
  // 文件确实落盘
  assert.ok(existsSync(config.voices[0].speakerAudioPath), 'speaker 文件应存在');
  assert.ok(existsSync(config.voices[0].promptAudioPath), 'prompt 文件应存在');
  // VoiceManager 立即可用
  const vm = new VoiceManager(config);
  assert.equal(vm.get('Test Voice').name, 'Test Voice');
  assert.equal(vm.get('Test Voice').source, 'registry');
});

test('信任：包内离线清单（真实 docs/voices.json, trusted）免确认直落', async () => {
  const config = makeBaseConfig(freshInstallDir());
  const writeLog = [];
  // 从真实清单取第一个条目，注入与它 sha256 不一致的假数据 → 应走到下载阶段（免确认），
  // 在 sha256 校验处失败——以此证明没有 needsConfirm 分支
  const manifest = JSON.parse(readFileSync(new URL('../docs/voices.json', import.meta.url), 'utf8'));
  assert.equal(manifest.trusted, true);
  const mgr = makeManager({
    config,
    fetchers: {
      fetchBinary: async () => speakerData, // 与真实 sha256 不匹配
    },
    writeLog,
  });
  const r = await mgr.install(manifest.voices[0].id, false);
  assert.equal(r.needsConfirm, undefined, '包内可信清单不应需要确认');
  assert.equal(r.ok, false);
  assert.match(r.message, /sha256/);
  assert.deepEqual(config.voices, []);
  assert.equal(writeLog.length, 0);
});

test('list：标注已安装状态，来源 bundled', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../docs/voices.json', import.meta.url), 'utf8'));
  const firstId = manifest.voices[0].id;
  const config = makeBaseConfig(freshInstallDir());
  config.voices = [{ name: 'x', speakerAudioPath: 'a', promptAudioPath: 'b', promptText: '', id: firstId, source: 'registry' }];
  const mgr = makeManager({ config, fetchers: {}, writeLog: [] });
  const r = await mgr.list();
  assert.equal(r.source, 'bundled');
  assert.equal(r.trusted, true);
  assert.ok(r.voices.length >= 1);
  const entry = r.voices.find((v) => v.id === firstId);
  assert.equal(entry.installed, true);
});

// ─── 失败路径：不写配置、不落盘 ───
test('安装失败：sha256 不匹配 → 不写配置', async () => {
  const config = makeBaseConfig(freshInstallDir());
  config.voiceRegistryUrl = 'https://example.com/registry.json';
  const writeLog = [];
  const mgr = makeManager({
    config,
    fetchers: {
      fetchText: async () => JSON.stringify(makeManifest([makePkg()])),
      fetchBinary: async () => Buffer.from('tampered-bytes'),
    },
    writeLog,
  });
  const r = await mgr.install('test-voice', true);
  assert.equal(r.ok, false);
  assert.match(r.message, /sha256/);
  assert.equal(writeLog.length, 0);
  assert.deepEqual(config.voices, []);
  assert.ok(!existsSync(join(config.installDir, 'voices', 'test-voice')), '校验失败不得落盘');
});

test('安装失败：文件超硬上限 → 拒绝', async () => {
  const config = makeBaseConfig(freshInstallDir());
  config.voiceRegistryUrl = 'https://example.com/registry.json';
  const writeLog = [];
  const mgr = makeManager({
    config,
    fetchers: {
      fetchText: async () => JSON.stringify(makeManifest([makePkg()])),
      fetchBinary: async () => Buffer.alloc(MAX_FILE_BYTES + 1),
    },
    writeLog,
  });
  const r = await mgr.install('test-voice', true);
  assert.equal(r.ok, false);
  assert.match(r.message, /超限|上限/);
  assert.equal(writeLog.length, 0);
});

test('安装失败：后缀不在白名单 → 不下载', async () => {
  const config = makeBaseConfig(freshInstallDir());
  config.voiceRegistryUrl = 'https://example.com/registry.json';
  let binaryCalls = 0;
  const mgr = makeManager({
    config,
    fetchers: {
      fetchText: async () => JSON.stringify(makeManifest([makePkg({ speaker: 'https://example.com/s.exe' })])),
      fetchBinary: async () => { binaryCalls++; return speakerData; },
    },
    writeLog: [],
  });
  const r = await mgr.install('test-voice', true);
  assert.equal(r.ok, false);
  assert.match(r.message, /后缀/);
  assert.equal(binaryCalls, 0);
});

// ─── 卸载 ───
test('卸载：source=user 拒绝删（即使 id 命中）', async () => {
  const config = makeBaseConfig(freshInstallDir());
  config.voices = [{ name: 'my', speakerAudioPath: 'a', promptAudioPath: 'b', promptText: '', id: 'my-voice', source: 'user' }];
  const writeLog = [];
  const mgr = makeManager({ config, fetchers: {}, writeLog });
  const r = await mgr.remove('my-voice', true);
  assert.equal(r.ok, false);
  assert.match(r.message, /自定义/);
  assert.equal(writeLog.length, 0);
});

test('卸载：registry 音色按 id 删 + defaultVoice 一并清空 + deleteFiles 可控', async () => {
  const config = makeBaseConfig(freshInstallDir());
  const voiceDir = join(config.installDir, 'voices', 'test-voice');
  mkdirSync(voiceDir, { recursive: true });
  config.voices = [
    { name: 'Test Voice', speakerAudioPath: join(voiceDir, 'speaker.wav'), promptAudioPath: join(voiceDir, 'prompt.ogg'), promptText: '', id: 'test-voice', source: 'registry' },
    { name: 'keep', speakerAudioPath: 'k', promptAudioPath: 'k', promptText: '', id: '', source: 'user' },
  ];
  config.defaultVoice = 'Test Voice';
  const writeLog = [];
  const mgr = makeManager({ config, fetchers: {}, writeLog });

  // deleteFiles=false：保留文件
  let r = await mgr.remove('test-voice', false);
  assert.equal(r.ok, true);
  assert.ok(existsSync(voiceDir), 'deleteFiles=false 应保留文件');
  assert.equal(config.defaultVoice, '', 'defaultVoice 应清空');
  assert.deepEqual(config.voices.map((v) => v.name), ['keep']);

  // 重新装回再删，deleteFiles=true：文件删除
  config.voices = [{ name: 'Test Voice', speakerAudioPath: join(voiceDir, 'speaker.wav'), promptAudioPath: join(voiceDir, 'prompt.ogg'), promptText: '', id: 'test-voice', source: 'registry' }];
  r = await mgr.remove('test-voice', true);
  assert.equal(r.ok, true);
  assert.ok(!existsSync(voiceDir), 'deleteFiles=true 应删除目录');
});

test('卸载：未知 id 返回 ok:false（不抛异常）', async () => {
  const config = makeBaseConfig(freshInstallDir());
  const mgr = makeManager({ config, fetchers: {}, writeLog: [] });
  const r = await mgr.remove('no-such-id', true);
  assert.equal(r.ok, false);
  assert.match(r.message, /未安装/);
});
