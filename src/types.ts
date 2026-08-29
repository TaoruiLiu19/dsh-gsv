export interface VoicePreset {
  name: string;
  speakerAudioPath: string;
  promptAudioPath: string;
  promptText: string;
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
