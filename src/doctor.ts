import type { ProviderKind } from './types.js';
import type { ProviderDescriptor } from './catalog.js';

/**
 * tts_doctor 的诊断核心：纯函数，只吃事实、只吐结论与建议。
 *
 * 目标是回答「为什么没声音」，而不是只回一个 available:false：
 * 凭据从哪来、引擎在不在、模型缺不缺、最近一次失败是什么、音频目录里有多少文件。
 */

export type CredentialSource = 'config' | 'credentials' | 'env' | 'none';

export interface CredentialFacts {
  configured: boolean;
  source: CredentialSource;
}

export interface EngineModelFacts {
  file: string;
  label: string;
  required: boolean;
  present: boolean;
}

export interface EngineFacts {
  running: boolean;
  apiUrl: string;
  /** 启动脚本是否存在（引擎是否装过） */
  startScriptExists: boolean;
  models: EngineModelFacts[];
}

export interface LastFailure {
  at: number;
  provider: string;
  message: string;
}

export interface ProbeFacts {
  checked: boolean;
  ok: boolean;
  message?: string;
}

export interface SetupFacts {
  pythonInstalled: boolean;
  pythonVersion: string;
  pipPackageInstalled: boolean;
  repoCloned: boolean;
}

export interface DoctorInput {
  provider: ProviderKind;
  descriptor?: ProviderDescriptor;
  credential: CredentialFacts;
  engine?: EngineFacts;
  /** 深度探活结果（仅 deep 模式提供；免费 /models，不产生合成费用） */
  probe?: ProbeFacts;
  /** 本地引擎前置条件（Python / pip 包 / 仓库） */
  setup?: SetupFacts;
  /** 引擎日志末尾若干行（脱敏后） */
  engineLog?: string[];
  audio: { directory: string; fileCount: number };
  lexiconRules: number;
  lastFailure: LastFailure | null;
  now?: number;
}

export type DoctorVerdict = 'ok' | 'degraded' | 'broken';

export interface DoctorReport {
  provider: ProviderKind;
  mode: string;
  verdict: DoctorVerdict;
  credential: CredentialFacts;
  engine: EngineFacts | null;
  probe: ProbeFacts | null;
  setup: SetupFacts | null;
  engineLog: string[];
  audio: { directory: string; fileCount: number };
  lexiconRules: number;
  lastFailure: { at: number; provider: string; message: string; agoSeconds: number } | null;
  hints: string[];
}

const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const now = input.now ?? Date.now();
  const caps = input.descriptor?.capabilities;
  const hints: string[] = [];
  let broken = false;

  if (caps?.needsKey && !input.credential.configured) {
    broken = true;
    hints.push(
      input.provider === 'deepseek'
        ? '未找到 DeepSeek 凭据：在 Harness 设置里保存 DEEPSEEK_API_KEY（模型设置页），或在本插件设置里手填 Key'
        : '该模式需要 API Key：请在设置里填写，或让 Harness 保存对应凭据',
    );
  }

  const engine = input.engine ?? null;
  if (caps?.needsEngine) {
    if (!engine) {
      broken = true;
      hints.push('本地引擎状态不可用：请检查插件是否加载了引擎管理');
    } else {
      if (!engine.startScriptExists) {
        broken = true;
        hints.push('未安装 GSV-TTS-Lite 引擎：让 agent 调用 tts_setup_engine，或按 README 手动安装');
      }
      if (engine.startScriptExists && !engine.running) {
        broken = true;
        hints.push('引擎未运行：到 设置 → 声音设置 打开引擎开关，或调用 tts_setup_engine 后启动');
      }
      const missing = engine.models.filter((m) => m.required && !m.present);
      if (missing.length > 0) {
        broken = true;
        hints.push(`模型缺失：${missing.map((m) => m.file).join('、')}（放到引擎的 models 目录后重启引擎）`);
      }
    }
  }

  if (input.probe?.checked && !input.probe.ok) {
    broken = true;
    hints.push(`凭据探活失败：${input.probe.message ?? '未知原因'}（免费 GET /models 验证，不产生合成费用）`);
  }

  const setup = input.setup ?? null;
  if (caps?.needsEngine && setup && !(engine && engine.running)) {
    if (!setup.pythonInstalled) {
      broken = true;
      hints.push('未检测到 Python 3.10+：安装 Python 后重新运行 tts_setup_engine');
    }
    if (!setup.repoCloned) {
      broken = true;
      hints.push('未找到 GSV-TTS-Lite 仓库：运行 tts_setup_engine（或按 README 手动 clone）');
    } else if (!setup.pipPackageInstalled) {
      broken = true;
      hints.push('未安装 gsv-tts-lite 包：运行 tts_setup_engine，或 pip install gsv-tts-lite');
    }
  }

  const failure = input.lastFailure;
  const recent = failure && now - failure.at <= FAILURE_WINDOW_MS ? failure : null;
  if (recent) hints.push(`最近一次合成失败（${Math.round((now - recent.at) / 1000)} 秒前）：${recent.message}`);

  const verdict: DoctorVerdict = broken ? 'broken' : recent ? 'degraded' : 'ok';
  if (verdict === 'ok' && caps?.needsEngine) hints.push('本地链路正常；首次合成仍需等待模型加载（约 15~90 秒）');

  return {
    provider: input.provider,
    mode: input.descriptor?.label ?? input.provider,
    verdict,
    credential: input.credential,
    engine,
    probe: input.probe ?? null,
    setup,
    engineLog: input.engineLog ?? [],
    audio: input.audio,
    lexiconRules: input.lexiconRules,
    lastFailure: recent ? { ...recent, agoSeconds: Math.round((now - recent.at) / 1000) } : null,
    hints,
  };
}

/** 人类可读的凭据来源。 */
export function describeCredentialSource(source: CredentialSource): string {
  switch (source) {
    case 'config':
      return '插件设置里手填的 Key';
    case 'credentials':
      return 'Harness 凭据服务';
    case 'env':
      return '环境变量';
    default:
      return '未配置';
  }
}
