import { defaultVoiceFor, isValidVoiceId } from './catalog.js';
import { HttpError } from './http.js';
import type { Config, ProviderKind } from './types.js';

type Selection = Pick<Config, 'provider' | 'defaultVoice' | 'voiceByProvider'>;

function valid(config: Config, provider: ProviderKind, voice: string): boolean {
  return !voice || (voice.length <= 256 && (provider === 'gsv'
    ? config.voices.some(preset => preset.name === voice)
    : isValidVoiceId(provider, voice)));
}

export function selectVoice(config: Config, provider: ProviderKind, requested?: string): Selection {
  const voiceByProvider = { ...config.voiceByProvider };
  if (valid(config, config.provider, config.defaultVoice)) {
    voiceByProvider[config.provider] = config.defaultVoice;
  }
  const defaultVoice = requested?.trim() ?? voiceByProvider[provider] ?? defaultVoiceFor(provider);
  if (requested !== undefined && !valid(config, provider, defaultVoice)) {
    throw new HttpError(400, '音色不适用于当前语音提供方');
  }
  voiceByProvider[provider] = valid(config, provider, defaultVoice) ? defaultVoice : defaultVoiceFor(provider);
  return { provider, defaultVoice: voiceByProvider[provider], voiceByProvider };
}
