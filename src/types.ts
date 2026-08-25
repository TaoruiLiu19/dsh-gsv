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
