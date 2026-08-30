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
  /** 音色市场远端清单地址；留空（''）使用包内 docs/voices.json（离线） */
  voiceRegistryUrl: string;
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
