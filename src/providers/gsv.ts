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
      headers?: (apiUrl: string) => Record<string, string>;
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

  /** 预热指定音色：让引擎缓存 speaker/prompt 特征并跑一次短推理。 */
  async warmup(preset: VoicePreset, timeoutMs = 120000): Promise<boolean> {
    if (!preset.speakerAudioPath || !preset.promptAudioPath) return false;
    const cfg = this.opts.getConfig();
    try {
      const resp = await fetch(`${cfg.apiUrl.replace(/\/$/, '')}/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.opts.headers?.(cfg.apiUrl) },
        redirect: 'error',
        body: JSON.stringify({
          speaker_audio: preset.speakerAudioPath,
          prompt_audio: preset.promptAudioPath,
          prompt_text: preset.promptText,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async *stream(text: string, voice: string, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    if (!this.opts.voiceManager) throw new Error('GSV 提供方未配置音色管理器');
    const preset = this.opts.voiceManager.get(voice);
    if (!preset) throw new Error(`未找到音色 "${voice}"`);
    yield* this.streamWithPreset(text, preset, signal);
  }

  /** 直接以预设流式合成（朗读/自动朗读/试听的临时预设都走这里）。 */
  async *streamWithPreset(
    text: string,
    voice: VoicePreset,
    signal?: AbortSignal,
    opts?: { timeoutMs?: number; config?: Config; captions?: boolean },
  ): AsyncIterable<ProviderChunk> {
    if (!voice.speakerAudioPath) throw new Error(`音色 "${voice.name}" 缺少 speakerAudioPath（参考音频路径）`);
    if (!voice.promptAudioPath) throw new Error(`音色 "${voice.name}" 缺少 promptAudioPath（提示音频路径）`);
    // promptText 留空时交给服务端：引擎支持 ASR 则自动转写，否则返回明确错误

    const cfg = opts?.config ?? this.opts.getConfig();
    const body = {
      text,
      speaker_audio: voice.speakerAudioPath,
      prompt_audio: voice.promptAudioPath,
      prompt_text: voice.promptText,
      speed: cfg.gsvSpeed ?? 1,
      stream_chunk: 25,
      return_subtitles: opts?.captions ?? false,
    };

    // 合并调用方取消信号与超时信号（timeoutMs=0 表示由调用方自行控制，不设超时）
    const timeoutMs = opts?.timeoutMs ?? cfg.timeout;
    const signals = [signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined];
    const operation = AbortSignal.any(signals.filter((item): item is AbortSignal => Boolean(item)));

    const resp = await fetch(`${cfg.apiUrl.replace(/\/$/, '')}/tts/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.opts.headers?.(cfg.apiUrl) },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: operation,
      });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`TTS API 失败: ${resp.status} ${resp.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
    }
    if (!resp.body) throw new Error('TTS API 未返回响应体');

    let currentEvent = '';
    let buffer = '';
    let totalDuration = 0;
    let completed = false;
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
                  cues: Array.isArray(data.subtitles) ? data.subtitles.flatMap(cue =>
                    typeof cue?.text === 'string' && typeof cue?.start_s === 'number' && typeof cue?.end_s === 'number' &&
                    cue.end_s > cue.start_s ? [{ text: cue.text, start: cue.start_s, end: cue.end_s }] : []) : undefined,
                };
              }
            } else if (currentEvent === 'done') {
              totalDuration = Number(data.total_duration) || 0;
              completed = true;
            } else if (currentEvent === 'error') {
              throw new Error('API 错误: ' + String(data.error ?? '未知错误'));
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    operation.throwIfAborted();
    if (!completed) throw new Error('GSV 音频流提前结束');
    // 携带总时长收尾
    yield { mime: 'audio/meta', data: new Uint8Array(0), totalDuration };
  }
}
