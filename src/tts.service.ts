import { closeSync, openSync, unlinkSync, writeSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { TextCleaner, MAX_TEXT_LENGTH, MAX_SEGMENTED_TEXT_LENGTH, SEGMENT_MAX_CHARS, FIRST_SEGMENT_MAX_CHARS } from './text-cleaner.js';
import { splitIntoSegments } from './segmenter.js';
import { float32ToInt16, wavHeader } from './wav-stream.js';
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

  /**
   * @param getConfig 读取当前生效配置（DSH 0.2+ 设置为 volatile 就地更新，
   *   因此每次调用都要重新读取，不能缓存配置快照）。
   */
  constructor(
    private getConfig: () => Config,
    private audioStore: AudioStore,
    opts?: { voiceManager?: VoiceManager; gsv?: GsvProvider; edge?: EdgeProvider },
  ) {
    this.voiceManager = opts?.voiceManager;
    this.gsv = opts?.gsv ?? new GsvProvider({ getConfig: () => this.getConfig(), voiceManager: opts?.voiceManager });
    this.edge = opts?.edge ?? new EdgeProvider();
  }

  private provider(kind?: ProviderKind): TTSProvider {
    return (kind ?? this.getConfig().provider ?? 'gsv') === 'edge' ? this.edge : this.gsv;
  }

  /** 当前提供方音色列表（gsv = 本地预设；edge = 精选微软声音）。 */
  listVoices(kind?: ProviderKind): Promise<VoiceInfo[]> {
    return this.provider(kind).listVoices();
  }

  /** 当前提供方健康（edge = 试合成退避；gsv = 引擎状态）。 */
  health(kind?: ProviderKind): Promise<ProviderHealth> {
    return this.provider(kind).health();
  }

  /** 预热指定音色（缓存 speaker/prompt + 短推理），失败静默。 */
  warmupVoice(preset: VoicePreset): Promise<boolean> {
    return this.gsv.warmup(preset);
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

  /** 清洗并切分朗读文本：首段更短，后续段按 SEGMENT_MAX_CHARS 打包。 */
  planSegments(text: string): string[] {
    const cleanText = TextCleaner.clean(text);
    if (!cleanText) throw new Error('文本清洗后为空，无法合成');
    if (cleanText.length > MAX_SEGMENTED_TEXT_LENGTH) {
      throw new Error(`文本过长（${cleanText.length} 字符，上限 ${MAX_SEGMENTED_TEXT_LENGTH}），请分段朗读`);
    }
    return splitIntoSegments(cleanText, SEGMENT_MAX_CHARS, FIRST_SEGMENT_MAX_CHARS);
  }

  /** 渐进分段合成（朗读按钮 / 自动朗读路径）：按 provider 逐段合成，段间 0 静音。 */
  async synthesizeSegments(text: string, voice?: VoicePreset | string, signal?: AbortSignal): Promise<SynthesizeSegmentsResult> {
    const parts = this.planSegments(text);
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

  /**
   * 流式分段合成：每完成一段就 yield，调用方可以立刻把 URL 交给浏览器播放，
   * 无需等整条回复全部分段合成完（首音时间从"全部段落"降到"首段"）。
   */
  async *synthesizeSegmentsStream(
    text: string,
    voice?: VoicePreset | string,
    signal?: AbortSignal,
  ): AsyncGenerator<{ index: number; total: number; url: string; duration: number }> {
    const parts = this.planSegments(text);
    for (let i = 0; i < parts.length; i++) {
      const r = await this.synthesize(parts[i], voice, signal);
      yield { index: i, total: parts.length, url: r.audioUrl, duration: r.audioLen };
    }
  }

  /**
   * 流式 PCM：把整段文本交给引擎一次合成，逐块产出 float32 PCM。
   * 用于"边合成边播放"的 WAV 流（首音≈引擎首块，不再等全部分段）。
   * 不设超时：由调用方在客户端断开时 abort。
   */
  async *streamPcm(
    text: string,
    voice: VoicePreset,
    signal?: AbortSignal,
  ): AsyncGenerator<{ sampleRate: number; data: Buffer }> {
    const cleanText = TextCleaner.clean(text);
    if (!cleanText) throw new Error('文本清洗后为空，无法合成');
    if (cleanText.length > MAX_SEGMENTED_TEXT_LENGTH) {
      throw new Error(`文本过长（${cleanText.length} 字符，上限 ${MAX_SEGMENTED_TEXT_LENGTH}），请分段朗读`);
    }
    for await (const chunk of this.gsv.streamWithPreset(cleanText, voice, signal, { timeoutMs: 0 })) {
      if (chunk.mime.startsWith('audio/pcm') && chunk.sampleRate && chunk.data.length > 0) {
        yield { sampleRate: chunk.sampleRate, data: Buffer.from(chunk.data) };
      }
    }
  }

  /**
   * 整段 WAV：把流式 PCM 直接写成一个完整 WAV 文件（不设超时、不占内存）。
   * 只用于"整段播放 / 下载"这类需要 seek 的可选路径；默认朗读仍走流式 HTTP。
   */
  async synthesizeFullWav(
    text: string,
    voice: VoicePreset,
    signal?: AbortSignal,
  ): Promise<{ audioUrl: string; duration: number; bytes: number; parts: number }> {
    const cleanText = TextCleaner.clean(text);
    if (!cleanText) throw new Error('文本清洗后为空，无法合成');
    if (cleanText.length > MAX_SEGMENTED_TEXT_LENGTH) {
      throw new Error(`文本过长（${cleanText.length} 字符，上限 ${MAX_SEGMENTED_TEXT_LENGTH}），请分段朗读`);
    }
    const name = `reply_${Date.now()}_${randomUUID().slice(0, 8)}.wav`;
    const file = join(this.audioStore.directory, name);
    let sampleRate = 32000;
    let pcmBytes = 0;
    const fd = openSync(file, 'w');
    try {
      writeSync(fd, wavHeader(sampleRate));
      for await (const chunk of this.streamPcm(cleanText, voice, signal)) {
        sampleRate = chunk.sampleRate || sampleRate;
        const pcm = float32ToInt16(chunk.data);
        if (pcm.length === 0) continue;
        writeSync(fd, pcm);
        pcmBytes += pcm.length;
      }
      if (pcmBytes === 0) throw new Error('未收到任何音频数据');
      const header = wavHeader(sampleRate);
      header.writeUInt32LE(36 + pcmBytes, 4);
      header.writeUInt32LE(pcmBytes, 40);
      writeSync(fd, header, 0, header.length, 0);
    } catch (e) {
      try { closeSync(fd); } catch { /* 忽略 */ }
      try { unlinkSync(file); } catch { /* 忽略 */ }
      throw e;
    }
    closeSync(fd);
    return {
      audioUrl: this.audioStore.urlFor(name),
      duration: pcmBytes / (sampleRate * 2),
      bytes: pcmBytes + 44,
      parts: 1,
    };
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
    const id = voiceId || this.getConfig().defaultVoice || EDGE_FALLBACK_VOICE;
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
