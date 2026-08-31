export interface VoicePreset {
  name: string;
  speakerAudioPath: string;
  promptAudioPath: string;
  promptText: string;
  /** 注册表来源 id（source === 'registry' 时必填），卸载/更新按它精确匹配 */
  id?: string;
  /** 音色来源：用户自建（全量编辑）或注册表安装（只读托管，仅可卸载） */
  source?: 'user' | 'registry';
}

export interface Config {
  apiUrl: string;
  voices: VoicePreset[];
  defaultVoice: string;
  autoPlay: boolean;
  /** 新回复到来时是否打断当前朗读（false = 正在朗读时跳过新回复，避免叠音） */
  interruptOnNew: boolean;
  timeout: number;
  installDir: string;
  /** 音色市场远端清单地址；默认指向在线试听站点，留空（''）则仅用包内 docs/voices.json（离线） */
  voiceRegistryUrl: string;
  /** 配置结构版本（迁移守卫的落点标记） */
  schemaVersion: number;
  /** TTS 引擎：gsv（本地 GSV-TTS-Lite，克隆/离线）| edge（微软 Edge 云端简单模式） */
  provider: ProviderKind;
  /** 云端简单模式的每日配额（null = 不限量）；仅引导文案用，服务端硬计数留待 4.x */
  quotaDaily: number | null;
}

/** TTS 提供方类型。 */
export type ProviderKind = 'gsv' | 'edge';

/** 提供方音色信息（edge = 微软官方声音；gsv = 本地预设）。 */
export interface VoiceInfo {
  id: string;
  name: string;
  gender: string;
  locale: string;
}

/** 提供方健康状态。 */
export interface ProviderHealth {
  available: boolean;
  /** 微软限流 / 429 */
  rateLimited?: boolean;
  message?: string;
}

/** 提供方流式产出块：gsv 产出 PCM（sampleRate 必填，走 WAV 装配）；
 *  edge 产出 MP3 字节（audio/mpeg，零转码直接落盘）。 */
export interface ProviderChunk {
  mime: string;
  data: Uint8Array;
  sampleRate?: number;
  /** gsv 流结束时的总时长（秒），随最后一个块携带 */
  totalDuration?: number;
}

/** TTS 提供方统一接口（4.0.0 双 Provider 抽象）。 */
export interface TTSProvider {
  readonly kind: ProviderKind;
  listVoices(): Promise<VoiceInfo[]>;
  stream(text: string, voice: string, signal?: AbortSignal): AsyncIterable<ProviderChunk>;
  health(): Promise<ProviderHealth>;
}

/** 注册表单个音色条目（清单中的原始形态，URL 为远端直链）。 */
export interface VoiceRegistryPkg {
  id: string;
  name: string;
  author?: string;
  license: string;
  speaker: string;
  prompt: string;
  promptText: string;
  sizeBytes: number;
  sha256: { speaker: string; prompt: string };
}

/** 音色市场清单。 */
export interface VoiceRegistry {
  schema: number;
  version: string;
  /** 信任标志：仅对包内离线清单生效；远端清单一律不可自证信任 */
  trusted?: boolean;
  voices: VoiceRegistryPkg[];
}

export interface TTSStreamRequest {
  text: string;
  speaker_audio: string;
  prompt_audio: string;
  prompt_text?: string;
  speed?: number;
  stream_chunk?: number;
}

export interface SynthesizeResult {
  audioUrl: string;
  audioLen: number;
  filename: string;
}

/** 渐进分段播放中的一段音频。 */
export interface TTSAudioSegment {
  url: string;
  duration: number;
}

export interface SynthesizeSegmentsResult {
  /** 已成功合成的段（可能为空）。 */
  segments: TTSAudioSegment[];
  /** 各段时长之和（秒）。 */
  totalLen: number;
  /** 中途某段失败时给出说明；全部成功则无此字段。 */
  error?: string;
}

/** 自动朗读通知状态（服务端只负责"有新回复"通知，合成由客户端按需触发）。 */
export interface AutoPlayState {
  seq: number;
  text: string | null;
}

export interface HealthCheckResult {
  apiRunning: boolean;
  pythonInstalled: boolean;
  pythonVersion: string;
  pipPackageInstalled: boolean;
  repoCloned: boolean;
  repoPath: string;
  apiUrl: string;
}

export interface SetupStep {
  step: string;
  status: 'success' | 'failed' | 'skipped';
  message: string;
}

export interface SetupResult {
  success: boolean;
  steps: SetupStep[];
  apiUrl: string;
  message: string;
}
