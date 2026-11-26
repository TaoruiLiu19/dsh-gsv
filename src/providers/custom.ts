import { defaultVoiceFor } from '../catalog.js';
import { splitIntoSegments } from '../segmenter.js';
import type { Config, ProviderChunk, ProviderHealth, TTSProvider, VoiceInfo } from '../types.js';
import { readSpeechAudio, type DeepseekProviderOptions } from './deepseek.js';

export class CustomSpeechProvider implements TTSProvider {
  readonly kind = 'custom';

  constructor(
    private readonly config: () => Config,
    private readonly credentials?: DeepseekProviderOptions['credentials'],
    private readonly fetchAudio = fetch,
  ) {}

  private endpoint(config: Config): URL {
    const url = new URL(config.customBaseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
      throw new Error('自定义 TTS 地址需为 HTTPS 或本机 HTTP，且不含凭据、查询或片段');
    }
    if (!url.pathname.endsWith('/audio/speech')) {
      url.pathname = url.pathname.replace(/\/+$/, '') + '/audio/speech';
    }
    return url;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const id = this.config().defaultVoice || defaultVoiceFor('custom');
    return [{ id, name: id, gender: '', locale: '' }];
  }

  async health(): Promise<ProviderHealth> {
    try {
      this.endpoint(this.config());
      return { available: true, message: '地址已配置；用试听验证语音服务' };
    } catch {
      return { available: false, message: '请填写兼容语音服务的 Base URL' };
    }
  }

  async *stream(text: string, voice: string, signal?: AbortSignal, config = this.config()): AsyncGenerator<ProviderChunk> {
    const endpoint = this.endpoint(config);
    const ref = config.customKeyRef.trim();
    const credentials = ref ? await this.credentials?.()?.resolve(ref) : undefined;
    const key = ref ? credentials?.value || process.env[ref] : undefined;
    if (ref && !key) throw new Error('找不到自定义 TTS 的凭据引用');
    for (const input of splitIntoSegments(text, 2000, 0)) {
      const timeout = AbortSignal.timeout(Math.ceil(config.timeout));
      const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await this.fetchAudio(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        signal: active,
        redirect: 'error',
        body: JSON.stringify({
          model: config.customModel.trim() || 'kokoro',
          voice: voice || defaultVoiceFor('custom'),
          input,
          response_format: config.customFormat,
          ...(config.customInstructions.trim() ? { instructions: config.customInstructions.trim() } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`自定义 TTS 服务返回 HTTP ${response.status}`);
      }
      yield* readSpeechAudio(response, active, config.customFormat);
    }
  }
}
