import { TextCleaner } from './text-cleaner.js';
import type { AudioChunk, AudioStore } from './audio-store.js';
import type { Config, TTSStreamRequest, SynthesizeResult, VoicePreset } from './types.js';

export class TTSService {
  constructor(private config: Config, private audioStore: AudioStore) {}

  async synthesize(text: string, voice?: VoicePreset, signal?: AbortSignal): Promise<SynthesizeResult> {
    const cleanText = TextCleaner.clean(text);
    if (!cleanText) throw new Error('文本清洗后为空，无法合成');
    if (!voice) throw new Error('未指定音色预设');
    if (!voice.speakerAudioPath) throw new Error(`音色 "${voice.name}" 缺少 speakerAudioPath（参考音频路径）`);
    if (!voice.promptAudioPath) throw new Error(`音色 "${voice.name}" 缺少 promptAudioPath（提示音频路径）`);
    // promptText 留空时交给服务端：引擎支持 ASR 则自动转写，否则返回明确错误

    const body: TTSStreamRequest = {
      text: cleanText,
      speaker_audio: voice.speakerAudioPath,
      prompt_audio: voice.promptAudioPath,
      prompt_text: voice.promptText,
      speed: 1.0,
      stream_chunk: 25,
    };

    // 合并调用方取消信号与超时信号
    const timeoutSignal = AbortSignal.timeout(this.config.timeout);
    const ac = new AbortController();
    const forward = () => ac.abort(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', forward, { once: true });
    timeoutSignal.addEventListener('abort', forward, { once: true });

    let resp: Response;
    try {
      resp = await fetch(`${this.config.apiUrl}/tts/stream`, {
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

    const chunks: AudioChunk[] = [];
    let totalDuration = 0;
    let currentEvent = '';
    let buffer = '';
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
                chunks.push({ base64: audio, sampleRate });
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
        throw new Error('TTS 请求被取消或超时（' + this.config.timeout + 'ms）');
      }
      throw e;
    }

    if (chunks.length === 0) throw new Error('未收到任何音频数据');

    const saved = this.audioStore.save(`tts_${Date.now()}.wav`, chunks);
    return { audioUrl: saved.url, audioLen: totalDuration, filename: saved.name };
  }
}
