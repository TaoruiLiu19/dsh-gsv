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

  add(voice: VoicePreset): void {
    this.voices.set(voice.name, voice);
  }

  remove(name: string): boolean {
    return this.voices.delete(name);
  }

  has(name: string): boolean {
    return this.voices.has(name);
  }

  get defaultName(): string {
    return this.defaultVoice;
  }
}
