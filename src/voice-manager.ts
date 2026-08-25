import type { VoicePreset, Config } from './types.js';

export class VoiceManager {
  private voices: Map<string, VoicePreset> = new Map();
  private defaultVoice: string;

  constructor(config: Config) {
    this.defaultVoice = config.defaultVoice;
    for (const v of config.voices) {
      this.voices.set(v.name, v);
    }
  }

  list(): VoicePreset[] {
    return Array.from(this.voices.values());
  }

  get(name?: string): VoicePreset | undefined {
    if (name && this.voices.has(name)) {
      return this.voices.get(name);
    }
    if (this.defaultVoice && this.voices.has(this.defaultVoice)) {
      return this.voices.get(this.defaultVoice);
    }
    return this.voices.values().next().value;
  }

  get defaultName(): string {
    return this.defaultVoice;
  }
}
