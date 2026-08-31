import type { Config, ProviderChunk, ProviderHealth, TTSProvider, VoiceInfo, VoicePreset } from '../types.js';
import type { VoiceManager } from '../voice-manager.js';

/**
 * 本地 GSV-TTS-Lite 提供方（克隆/离线专业模式）。
 * 流式产出 PCM 块（mime audio/pcm-f32 + sampleRate），由上层 AudioStore 装配 WAV。
 */
export class GsvProvider implements TTSProvider {
  readonly kind = 'gsv' as const;

  constructor(
    private opts: {
      getConfig: () => Config;
      voiceManager?: VoiceManager;
      /** 引擎状态探测（index.ts 接入 engineManager.status） */
      health?: () => Promise<ProviderHealth>;
    },
  ) {}

  listVoices(): Promise<VoiceInfo[]> {
    const vm = this.opts.voiceManager;
    if (!vm) return Promise.resolve([]);
    return Promise.resolve(vm.list().map((v) => ({ id: v.name, name: v.name, gender: '', locale: 'local' })));
  }

  async health(): Promise<ProviderHealth> {
    if (this.opts.health) return this.opts.health();
    return { available: true };
  }

  async *stream(text: string, voice: string, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    if (!this.opts.voiceManager) throw new Error('GSV 提供方未配置音色管理器');
    const preset = this.opts.voiceManager.get(voice);
    if (!preset) throw new Error(`未找到音色 "${voice}"`);
    yield* this.streamWithPreset(text, preset, signal);
  }

  /** 直接以预设流式合成（朗读/自动朗读/试听的临时预设都走这里）。 */
  async *streamWithPreset(text: string, voice: VoicePreset, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    if (!voice.speakerAudioPath) throw new Error(`音色 "${voice.name}" 缺少 speakerAudioPath（参考音频路径）`);
    if (!voice.promptAudioPath) throw new Error(`音色 "${voice.name}" 缺少 promptAudioPath（提示音频路径）`);
    // promptText 留空时交给服务端：引擎支持 ASR 则自动转写，否则返回明确错误

    const cfg = this.opts.getConfig();
    const body = {
      text,
      speaker_audio: voice.speakerAudioPath,
      prompt_audio: voice.promptAudioPath,
      prompt_text: voice.promptText,
      speed: 1.0,
      stream_chunk: 25,
    };

    // 合并调用方取消信号与超时信号
    const timeoutSignal = AbortSignal.timeout(cfg.timeout);
    const ac = new AbortController();
    const forward = () => ac.abort(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', forward, { once: true });
    timeoutSignal.addEventListener('abort', forward, { once: true });

    let resp: Response;
    try {
      resp = await fetch(`${cfg.apiUrl}/tts/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      signal?.removeEventListener('abort', forward);
      timeoutSignal.removeEventListener('abort', forward);
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`TTS API 失败: ${resp.status} ${resp.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
    }
    if (!resp.body) throw new Error('TTS API 未返回响应体');

    let currentEvent = '';
    let buffer = '';
    let totalDuration = 0;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue; // 忽略残缺行
            }
            if (currentEvent === 'audio') {
              const audio = data.audio;
              if (typeof audio === 'string' && audio) {
                const sampleRate = typeof data.sample_rate === 'number' ? data.sample_rate : 32000;
                yield {
                  mime: 'audio/pcm-f32',
                  data: Buffer.from(audio, 'base64'),
                  sampleRate,
                };
              }
            } else if (currentEvent === 'done') {
              totalDuration = Number(data.total_duration) || 0;
            } else if (currentEvent === 'error') {
              throw new Error('API 错误: ' + String(data.error ?? '未知错误'));
            }
          }
        }
      }
    } catch (e) {
      if (ac.signal.aborted && !(e instanceof Error && e.message.startsWith('API 错误'))) {
        throw new Error('TTS 请求被取消或超时（' + cfg.timeout + 'ms）');
      }
      throw e;
    }

    // 携带总时长收尾
    yield { mime: 'audio/meta', data: new Uint8Array(0), totalDuration };
  }
}
