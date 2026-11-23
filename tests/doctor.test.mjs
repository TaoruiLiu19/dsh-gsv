// tts_doctor 诊断核心：结论分级与建议是否对得上事实
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDoctorReport, describeCredentialSource } from '../lib/doctor.js';
import { getProviderDescriptor } from '../lib/catalog.js';

const audio = { directory: '/tmp/x', fileCount: 3 };

function base(patch = {}) {
  return {
    provider: 'gsv',
    descriptor: getProviderDescriptor('gsv'),
    credential: { configured: false, source: 'none' },
    engine: {
      running: true,
      apiUrl: 'http://localhost:9880',
      startScriptExists: true,
      models: [
        { file: 's1v3.ckpt', label: 'GPT', required: true, present: true },
        { file: 's2Gv2ProPlus.pth', label: 'SoVITS', required: true, present: true },
      ],
    },
    audio,
    lexiconRules: 2,
    lastFailure: null,
    now: 1_000_000,
    ...patch,
  };
}

test('doctor：本地链路齐全 → ok', () => {
  const report = buildDoctorReport(base());
  assert.equal(report.verdict, 'ok');
  assert.equal(report.mode.includes('GSV'), true);
  assert.equal(report.hints.length, 1, 'ok 时给出一次加载提示');
});

test('doctor：引擎未装 / 未运行 / 缺模型 → broken 且建议具体', () => {
  const notInstalled = buildDoctorReport(base({ engine: { ...base().engine, startScriptExists: false, running: false } }));
  assert.equal(notInstalled.verdict, 'broken');
  assert.match(notInstalled.hints.join('\n'), /tts_setup_engine/);

  const notRunning = buildDoctorReport(base({ engine: { ...base().engine, running: false } }));
  assert.equal(notRunning.verdict, 'broken');
  assert.match(notRunning.hints.join('\n'), /引擎未运行/);

  const missing = buildDoctorReport(
    base({
      engine: {
        ...base().engine,
        models: [
          { file: 's1v3.ckpt', label: 'GPT', required: true, present: false },
          { file: 's2Gv2ProPlus.pth', label: 'SoVITS', required: true, present: true },
        ],
      },
    }),
  );
  assert.equal(missing.verdict, 'broken');
  assert.match(missing.hints.join('\n'), /s1v3\.ckpt/);
});

test('doctor：官方语音缺凭据 → broken；有凭据并最近失败 → degraded', () => {
  const noKey = buildDoctorReport({
    ...base(),
    provider: 'deepseek',
    descriptor: getProviderDescriptor('deepseek'),
    engine: undefined,
    credential: { configured: false, source: 'none' },
  });
  assert.equal(noKey.verdict, 'broken');
  assert.match(noKey.hints.join('\n'), /DEEPSEEK_API_KEY/);

  const degraded = buildDoctorReport({
    ...base(),
    provider: 'deepseek',
    descriptor: getProviderDescriptor('deepseek'),
    engine: undefined,
    credential: { configured: true, source: 'credentials' },
    lastFailure: { at: 990_000, provider: 'deepseek', message: 'HTTP 401' },
  });
  assert.equal(degraded.verdict, 'degraded');
  assert.equal(degraded.lastFailure.agoSeconds, 10);
  assert.match(degraded.hints.join('\n'), /HTTP 401/);

  const old = buildDoctorReport({
    ...base(),
    provider: 'deepseek',
    descriptor: getProviderDescriptor('deepseek'),
    engine: undefined,
    credential: { configured: true, source: 'env' },
    lastFailure: { at: 0, provider: 'deepseek', message: '旧错误' },
  });
  assert.equal(old.verdict, 'ok', '超过 10 分钟的旧失败不算当前问题');
  assert.equal(old.lastFailure, null);
});

test('doctor：凭据来源文案', () => {
  assert.equal(describeCredentialSource('credentials'), 'Harness 凭据服务');
  assert.equal(describeCredentialSource('env'), '环境变量');
  assert.equal(describeCredentialSource('none'), '未配置');
  assert.equal(describeCredentialSource('config'), '插件设置里手填的 Key');
});

test('doctor：deep 探活失败 → broken；通过不改变结论', () => {
  const failed = buildDoctorReport({
    ...base(),
    provider: 'deepseek',
    descriptor: getProviderDescriptor('deepseek'),
    engine: undefined,
    credential: { configured: true, source: 'credentials' },
    probe: { checked: true, ok: false, message: 'HTTP 401' },
  });
  assert.equal(failed.verdict, 'broken');
  assert.match(failed.hints.join('\n'), /探活失败/);

  const passed = buildDoctorReport({
    ...base(),
    provider: 'deepseek',
    descriptor: getProviderDescriptor('deepseek'),
    engine: undefined,
    credential: { configured: true, source: 'credentials' },
    probe: { checked: true, ok: true },
  });
  assert.equal(passed.verdict, 'ok');
  assert.equal(passed.probe.ok, true);
});

test('doctor：引擎未运行且前置条件缺失 → broken 并给出安装建议', () => {
  const report = buildDoctorReport(
    base({
      engine: { ...base().engine, running: false },
      setup: { pythonInstalled: false, pythonVersion: '', pipPackageInstalled: false, repoCloned: false },
      engineLog: ['Traceback ... ModuleNotFoundError: gsv_tts'],
    }),
  );
  assert.equal(report.verdict, 'broken');
  const hints = report.hints.join('\n');
  assert.match(hints, /Python/);
  assert.match(hints, /tts_setup_engine/);
  assert.deepEqual(report.engineLog, ['Traceback ... ModuleNotFoundError: gsv_tts']);
});