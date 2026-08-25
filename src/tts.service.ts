import { TextCleaner } from './text-cleaner.js';
import type { Config, TTSStreamRequest, SynthesizeResult, VoicePreset } from './types.js';

export class TTSService {
  constructor(private config: Config) {}

  async synthesize(text: string, voice?: VoicePreset): Promise<SynthesizeResult> {
    const cleanText = TextCleaner.clean(text);
    if (!cleanText) throw new Error('文本清洗后为空，无法合成');
    if (!voice) throw new Error('未指定音色预设');

    const body: TTSStreamRequest = {
      text: cleanText,
      speaker_audio: voice.speakerAudioPath,
      prompt_audio: voice.promptAudioPath,
      speed: 1.0,
      stream_chunk: 25,
    };
    if (voice.promptText) body.prompt_text = voice.promptText;

    const resp = await fetch(`${this.config.apiUrl}/tts/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout),
    });
    if (!resp.ok) {
      throw new Error(`TTS API 失败: ${resp.status} ${resp.statusText}`);
    }
    if (!resp.body) throw new Error('TTS API 未返回响应体');

    const audioChunks: string[] = [];
    let totalDuration = 0;
    let currentEvent = '';
    let buffer = '';

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

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
          if (currentEvent === 'audio') {
            audioChunks.push(JSON.parse(payload).audio);
          } else if (currentEvent === 'done') {
            totalDuration = JSON.parse(payload).total_duration;
          } else if (currentEvent === 'error') {
            throw new Error('API 错误: ' + JSON.parse(payload).error);
          }
        }
      }
    }

    if (audioChunks.length === 0) {
      throw new Error('未收到任何音频数据');
    }

    const base64 = audioChunks.join('');
    const filename = `tts_${Date.now()}.wav`;

    return {
      audioUrl: `data:audio/wav;base64,${base64}`,
      audioLen: totalDuration,
      filename,
    };
  }
}
