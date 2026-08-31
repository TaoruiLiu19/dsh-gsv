import { TextCleaner, MAX_TEXT_LENGTH, MAX_SEGMENTED_TEXT_LENGTH, SEGMENT_MAX_CHARS } from './text-cleaner.js';
import { splitIntoSegments } from './segmenter.js';
import { GsvProvider } from './providers/gsv.js';
import { EdgeProvider } from './providers/edge.js';
import type { AudioChunk, AudioStore } from './audio-store.js';
import type {
  Config,
  ProviderHealth,
  ProviderKind,
  SynthesizeResult,
  SynthesizeSegmentsResult,
  TTSAudioSegment,
  TTSProvider,
  VoiceInfo,
  VoicePreset,
} from './types.js';
import type { VoiceManager } from './voice-manager.js';

let fileCounter = 0;

const EDGE_FALLBACK_VOICE = 'zh-CN-XiaoxiaoNeural';

export class TTSService {
  private voiceManager: VoiceManager | undefined;
  private gsv: GsvProvider;
  private edge: EdgeProvider;

  constructor(
    private config: Config,
    private audioStore: AudioStore,
    opts?: { voiceManager?: VoiceManager; gsv?: GsvProvider; edge?: EdgeProvider },
  ) {
    this.voiceManager = opts?.voiceManager;
    this.gsv = opts?.gsv ?? new GsvProvider({ getConfig: () => config, voiceManager: opts?.voiceManager });
    this.edge = opts?.edge ?? new EdgeProvider();
  }

  private provider(kind?: ProviderKind): TTSProvider {
    return (kind ?? this.config.provider ?? 'gsv') === 'edge' ? this.edge : this.gsv;
  }

  /** 当前提供方音色列表（gsv = 本地预设；edge = 精选微软声音）。 */
  listVoices(kind?: ProviderKind): Promise<VoiceInfo[]> {
    return this.provider(kind).listVoices();
  }

  /** 当前提供方健康（edge = 试合成退避；gsv = 引擎状态）。 */
  health(kind?: ProviderKind): Promise<ProviderHealth> {
    return this.provider(kind).health();
  }

  /** 单次合成整段（tts_speak / 试听路径）。voice 可为预设对象（gsv）或音色 id（edge）。 */
  async synthesize(
    text: string,
    voice?: VoicePreset | string,
    signal?: AbortSignal,
    kind?: ProviderKind,
  ): Promise<SynthesizeResult> {
    const cleanText = TextCleaner.clean(text);
    if (!cleanText) throw new Error('文本清洗后为空，无法合成');
    if (cleanText.length > MAX_TEXT_LENGTH) {
      throw new Error(`文本过长（${cleanText.length} 字符，上限 ${MAX_TEXT_LENGTH}），请分段朗读`);
    }
    const p = this.provider(kind);
    if (p.kind === 'gsv') {
      const preset = typeof voice === 'string' ? this.voiceManager?.get(voice) : voice;
      if (!preset) throw new Error('未指定音色预设');
      return this.synthesizeGsv(cleanText, preset, signal);
    }
    if (typeof voice === 'object' && voice !== null) {
      throw new Error('Edge（云端简单）模式不支持本地音色预设，请在音色下拉选择云端声音');
    }
    return this.synthesizeEdge(cleanText, typeof voice === 'string' ? voice : undefined, signal);
  }

  /** 渐进分段合成（朗读按钮 / 自动朗读路径）：按 provider 逐段合成，段间 0 静音。 */
  async synthesizeSegments(text: string, voice?: VoicePreset | string, signal?: AbortSignal): Promise<SynthesizeSegmentsResult> {
    const cleanText = TextCleaner.clean(text);
    if (!cleanText) throw new Error('文本清洗后为空，无法合成');
    if (cleanText.length > MAX_SEGMENTED_TEXT_LENGTH) {
      throw new Error(`文本过长（${cleanText.length} 字符，上限 ${MAX_SEGMENTED_TEXT_LENGTH}），请分段朗读`);
    }
    const parts = splitIntoSegments(cleanText, SEGMENT_MAX_CHARS);
    const segments: TTSAudioSegment[] = [];
    let totalLen = 0;
    let error: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      try {
        const r = await this.synthesize(parts[i], voice, signal);
        segments.push({ url: r.audioUrl, duration: r.audioLen });
        totalLen += r.audioLen;
      } catch (e) {
        if (signal?.aborted) throw e; // 取消/超时：整次失败，丢弃半成品
        error = `第 ${i + 1}/${parts.length} 段合成失败：${String((e as Error)?.message ?? e)}`;
        break;
      }
    }
    return { segments, totalLen, error };
  }

  private async synthesizeGsv(cleanText: string, preset: VoicePreset, signal?: AbortSignal): Promise<SynthesizeResult> {
    const chunks: AudioChunk[] = [];
    let totalDuration = 0;
    for await (const chunk of this.gsv.streamWithPreset(cleanText, preset, signal)) {
      if (chunk.mime.startsWith('audio/pcm') && chunk.sampleRate) {
        chunks.push({ base64: Buffer.from(chunk.data).toString('base64'), sampleRate: chunk.sampleRate });
      }
      if (chunk.totalDuration) totalDuration = chunk.totalDuration;
    }
    if (chunks.length === 0) throw new Error('未收到任何音频数据');
    const saved = this.audioStore.save(`tts_${Date.now()}_${(fileCounter++).toString(36)}.wav`, chunks);
    return { audioUrl: saved.url, audioLen: totalDuration, filename: saved.name };
  }

  private async synthesizeEdge(cleanText: string, voiceId?: string, signal?: AbortSignal): Promise<SynthesizeResult> {
    const id = voiceId || this.config.defaultVoice || EDGE_FALLBACK_VOICE;
    const parts: Buffer[] = [];
    for await (const chunk of this.edge.stream(cleanText, id, signal)) {
      if (chunk.mime === 'audio/mpeg' && chunk.data.length > 0) {
        parts.push(Buffer.from(chunk.data));
      }
    }
    if (parts.length === 0) throw new Error('Edge 未返回音频数据（云端通道可能不可用）');
    const saved = this.audioStore.saveRaw(`tts_${Date.now()}_${(fileCounter++).toString(36)}.mp3`, Buffer.concat(parts));
    return { audioUrl: saved.url, audioLen: 0, filename: saved.name };
  }
}
