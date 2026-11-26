import type { ProviderKind } from './types.js';

/**
 * 提供方与引擎的「目录」（catalog）。
 *
 * 设计目标：UI、工具、迁移、健康检查都从这份描述符读取能力，而不是到处写
 * `provider === 'edge'` 之类的硬编码分支。新增一个提供方 = 往目录里加一条，
 * 客户端按 `capabilities` 决定显示哪些字段，工具按 `label` 渲染说明。
 *
 * 注意：这里只描述「能力」与「展示」，不含密钥、不含计费金额。
 */

export type ProviderBadge = 'local' | 'cloud' | 'official';

/** 音色来源：本地预设（可克隆）/ 内置固定 / 远端列表。 */
export type VoiceSource = 'presets' | 'builtin' | 'remote';

export interface ProviderCapabilities {
  /** 引擎侧真流式（边合成边吐 PCM）；false 表示按段合成后整段落盘 */
  streaming: boolean;
  /** 可用本地音色预设（参考音频克隆） */
  cloning: boolean;
  /** 支持自定义/注册表音色（音色市场） */
  customVoices: boolean;
  /** 需要联网 */
  network: boolean;
  /** 需要 API 凭据 */
  needsKey: boolean;
  /** 需要本地引擎进程 */
  needsEngine: boolean;
  /** 按量计费 */
  billed: boolean;
  /** 输出编码 */
  formats: string[];
  /** 音色列表来源 */
  voiceSource: VoiceSource;
}

export interface ProviderDescriptor {
  id: ProviderKind;
  /** 中文展示名（Tab 文案） */
  label: string;
  /** 客户端 i18n 键；缺省时退回 label */
  i18nKey?: string;
  description: string;
  badge: ProviderBadge;
  /** 默认音色；'' 表示「第一个预设 / 服务端回落」 */
  defaultVoice: string;
  /** 合法音色 id 的正则（字符串形式，便于随目录序列化）；缺省表示任意非空名称（本地预设） */
  voiceIdPattern?: string;
  capabilities: ProviderCapabilities;
}

export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  {
    id: 'edge',
    label: '快速体验（Edge）',
    i18nKey: 'mode.quick',
    description: '微软 Edge 云端声音，免安装免配置，需要联网',
    badge: 'cloud',
    defaultVoice: '',
    voiceIdPattern: '^[a-z]{2,3}-[A-Za-z0-9-]+Neural$',
    capabilities: {
      streaming: false,
      cloning: false,
      customVoices: false,
      network: true,
      needsKey: false,
      needsEngine: false,
      billed: false,
      formats: ['mp3'],
      voiceSource: 'remote',
    },
  },
  {
    id: 'deepseek',
    label: '官方语音（DeepSeek）',
    i18nKey: 'mode.official',
    description: 'DeepSeek 官方 TTS（海星/暗潮），复用 Harness 凭据，按字符计费',
    badge: 'official',
    defaultVoice: 'stella',
    voiceIdPattern: '^(stella|tide)$',
    capabilities: {
      streaming: true,
      cloning: false,
      customVoices: false,
      network: true,
      needsKey: true,
      needsEngine: false,
      billed: true,
      formats: ['wav'],
      voiceSource: 'builtin',
    },
  },
  {
    id: 'custom',
    label: '自定义 TTS',
    i18nKey: 'mode.custom',
    description: '连接现有 OpenAI-compatible 语音服务',
    badge: 'cloud',
    defaultVoice: 'af_sarah',
    capabilities: {
      streaming: true, cloning: false, customVoices: false, network: true, needsKey: false,
      needsEngine: false, billed: false, formats: ['wav'], voiceSource: 'builtin',
    },
  },
  {
    id: 'gsv',
    label: '本地克隆（GSV）',
    i18nKey: 'mode.pro',
    description: '本地 GSV-TTS-Lite，离线 / 隐私 / 音色克隆',
    badge: 'local',
    defaultVoice: '',
    capabilities: {
      streaming: true,
      cloning: true,
      customVoices: true,
      network: false,
      needsKey: false,
      needsEngine: true,
      billed: false,
      formats: ['wav'],
      voiceSource: 'presets',
    },
  },
] as const;

/** 默认音色（目录为准；没有则空串）。 */
export function defaultVoiceFor(id: ProviderKind): string {
  return getProviderDescriptor(id)?.defaultVoice ?? '';
}

/** 校验音色 id：描述符声明了 pattern 就按 pattern，否则只要是任意非空名称即可（本地预设）。 */
export function isValidVoiceId(id: ProviderKind, voice: unknown): boolean {
  const value = typeof voice === 'string' ? voice.trim() : '';
  if (!value) return false;
  const pattern = getProviderDescriptor(id)?.voiceIdPattern;
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}
/** 按 id 取描述符；未知 id 返回 undefined（调用方决定回退）。 */
export function getProviderDescriptor(id: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/** 所有 provider id（用于设置面板校验与迁移）。 */
export function providerIds(): ProviderKind[] {
  return PROVIDER_CATALOG.map((p) => p.id);
}

/** 该 provider 是否需要「本地音色预设」那一套 UI/工具。 */
export function usesLocalVoices(id: ProviderKind): boolean {
  return getProviderDescriptor(id)?.capabilities.voiceSource === 'presets';
}

/** 该 provider 是否为云端（需要网络且不需要本地引擎）。 */
export function isCloudProvider(id: ProviderKind): boolean {
  const caps = getProviderDescriptor(id)?.capabilities;
  return !!caps && caps.network && !caps.needsEngine;
}

// ─── 本地引擎 / 模型目录 ───────────────────────────────────────────────

export interface EngineModelSpec {
  /** 相对 models 目录的文件名 */
  file: string;
  label: string;
  required: boolean;
}

export interface EngineDescriptor {
  id: string;
  label: string;
  apiUrl: string;
  repoUrl: string;
  /** 启动脚本相对插件包根目录的路径 */
  startScript: string;
  models: EngineModelSpec[];
}

export const GSV_ENGINE: EngineDescriptor = {
  id: 'gsv',
  label: 'GSV-TTS-Lite',
  apiUrl: 'http://localhost:9880',
  repoUrl: 'https://github.com/chinokikiss/GSV-TTS-Lite',
  startScript: 'scripts/dsh_stream_api.py',
  models: [
    { file: 's1v3.ckpt', label: 'GPT 权重 s1v3.ckpt', required: true },
    { file: 's2Gv2ProPlus.pth', label: 'SoVITS 权重 s2Gv2ProPlus.pth', required: true },
  ],
};

/** 引擎模型目录（目前只有 GSV 一个本地引擎）。 */
export const ENGINE_CATALOG: readonly EngineDescriptor[] = [GSV_ENGINE];
