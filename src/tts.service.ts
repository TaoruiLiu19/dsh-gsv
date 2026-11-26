import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TextCleaner, MAX_TEXT_LENGTH, MAX_SEGMENTED_TEXT_LENGTH, SEGMENT_MAX_CHARS, FIRST_SEGMENT_MAX_CHARS } from './text-cleaner.js';
import { splitIntoSegments } from './segmenter.js';
import { float32ToInt16, wavHeader } from './wav-stream.js';
import { GsvProvider } from './providers/gsv.js';
import { EdgeProvider } from './providers/edge.js';
import { DeepseekProvider, parseWav } from './providers/deepseek.js';
import { CustomSpeechProvider } from './providers/custom.js';
import type { SpeechStats } from './speech-stats.js';
import { SharedWork, waitWithSignal } from './shared-work.js';
import { defaultVoiceFor, isValidVoiceId } from './catalog.js';
import { applyLexicon, parseLexicon } from './lexicon.js';
import type { CredentialFacts } from './doctor.js';
import { MAX_AUDIO_BYTES, type AudioStore } from './audio-store.js';
import type {
  Config, ProviderChunk, ProviderHealth, ProviderKind, SynthesizeResult,
  SpeechCue, SynthesizeSegmentsResult, TTSProvider, VoiceInfo, VoicePreset,
} from './types.js';
import type { VoiceManager } from './voice-manager.js';

export interface SpeechJob {
  config: Config;
  text: string;
  voice: VoicePreset | string;
  automatic?: boolean;
  followText?: boolean;
}

interface CompleteAudio {
  audioUrl: string;
  duration: number;
  bytes: number;
  parts: number;
}

type PcmSource = (signal: AbortSignal) => AsyncIterable<{ sampleRate: number; data: Buffer }>;

interface WavProgress {
  file: string;
  sampleRate: number;
  bytes: number;
  change: ReturnType<typeof changeSignal>;
  state: 'running' | 'complete' | 'failed';
  error?: unknown;
}

function changeSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function notify(progress: WavProgress): void {
  const previous = progress.change;
  progress.change = changeSignal();
  previous.resolve();
}

export class TTSService {
  private readonly gsv: GsvProvider;
  private readonly edge: EdgeProvider;
  private readonly deepseek: DeepseekProvider;
  private readonly custom: CustomSpeechProvider;
  private readonly saved = new Map<string, CompleteAudio & { cues?: SpeechCue[] }>();
  private readonly partsInFlight = new Map<string, SharedWork<SynthesizeResult>>();
  private readonly mp3InFlight = new Map<string, SharedWork<CompleteAudio>>();
  private readonly wavInFlight = new Map<string, { work: SharedWork<CompleteAudio>; progress: WavProgress }>();

  constructor(
    private readonly getConfig: () => Config,
    private readonly audioStore: AudioStore,
    private readonly opts: {
      voiceManager?: VoiceManager;
      gsv?: GsvProvider;
      edge?: EdgeProvider;
      deepseek?: DeepseekProvider;
      custom?: CustomSpeechProvider;
      stats?: SpeechStats;
      onFailure?: (error: unknown) => void;
    } = {},
  ) {
    this.gsv = opts.gsv ?? new GsvProvider({ getConfig, voiceManager: opts.voiceManager });
    this.edge = opts.edge ?? new EdgeProvider();
    this.deepseek = opts.deepseek ?? new DeepseekProvider({ getConfig });
    this.custom = opts.custom ?? new CustomSpeechProvider(getConfig);
  }

  private provider(kind = this.getConfig().provider): TTSProvider {
    if (kind === 'edge') return this.edge;
    if (kind === 'deepseek') return this.deepseek;
    if (kind === 'custom') return this.custom;
    return this.gsv;
  }

  listVoices(kind?: ProviderKind): Promise<VoiceInfo[]> {
    return this.provider(kind).listVoices();
  }

  health(kind?: ProviderKind): Promise<ProviderHealth> {
    return this.provider(kind).health();
  }

  async checkCredential(kind?: ProviderKind): Promise<{ ok: boolean; message?: string }> {
    return this.provider(kind).kind === 'deepseek' ? this.deepseek.checkCredential() : { ok: true };
  }

  async describeCredential(kind?: ProviderKind): Promise<CredentialFacts> {
    return this.provider(kind).kind === 'deepseek'
      ? this.deepseek.describeCredential()
      : { configured: false, source: 'none' };
  }

  warmupVoice(preset: VoicePreset): Promise<boolean> {
    return this.gsv.warmup(preset);
  }

  private prepareText(text: string, config: Config, limit: number): string {
    const cleaned = applyLexicon(TextCleaner.clean(text), parseLexicon(config.lexicon ?? ''), config.provider);
    if (!cleaned.trim()) throw new Error('文本清洗后为空，无法合成');
    if (cleaned.length > limit) throw new Error(`文本过长（${cleaned.length} 字符，上限 ${limit}），请分段朗读`);
    return cleaned;
  }

  prepareJob(
    text: string,
    voice?: VoicePreset | string,
    kind?: ProviderKind,
    limit = MAX_SEGMENTED_TEXT_LENGTH,
    snapshot = this.getConfig(),
  ): SpeechJob {
    const config = { ...snapshot };
    config.provider = kind ?? config.provider ?? 'gsv';
    if (kind && kind !== snapshot.provider) config.defaultVoice = config.voiceByProvider?.[kind] ?? '';
    const cleaned = this.prepareText(text, config, limit);
    if (config.provider === 'gsv') {
      const voiceName = typeof voice === 'string' ? voice : config.defaultVoice;
      const preset = typeof voice === 'object' ? voice
        : config.voices?.find(entry => entry.name === voiceName)
          ?? config.voices?.find(entry => entry.name === config.defaultVoice)
          ?? config.voices?.[0];
      if (!preset) throw new Error('未指定音色预设');
      return { config, text: cleaned, voice: { ...preset } };
    }
    if (typeof voice === 'object') {
      const mode = config.provider === 'deepseek' ? 'DeepSeek 官方语音模式'
        : config.provider === 'custom' ? '自定义语音' : 'Edge（云端简单）模式';
      throw new Error(`${mode}不支持本地音色预设`);
    }
    const requested = voice || config.defaultVoice;
    const id = isValidVoiceId(config.provider, requested)
      ? requested.trim()
      : defaultVoiceFor(config.provider) || 'zh-CN-XiaoxiaoNeural';
    return { config, text: cleaned, voice: id };
  }

  private report(error: unknown, signal?: AbortSignal): void {
    if (signal?.aborted) return;
    try { this.opts.onFailure?.(error); } catch { /* 诊断不应覆盖合成错误 */ }
  }

  async synthesize(text: string, voice?: VoicePreset | string, signal?: AbortSignal, kind?: ProviderKind): Promise<SynthesizeResult> {
    try {
      const job = this.prepareJob(text, voice, kind, MAX_TEXT_LENGTH);
      return await this.synthesizePart(job, job.text, signal);
    } catch (error) {
      this.report(error, signal);
      throw error;
    }
  }

  planSegments(text: string): string[] {
    const config = this.getConfig();
    return this.split(this.prepareText(text, config, MAX_SEGMENTED_TEXT_LENGTH));
  }

  private split(text: string, followText = false): string[] {
    if (followText) return Array.from(new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(text))
      .flatMap(({ segment }) => splitIntoSegments(segment.trim(), SEGMENT_MAX_CHARS, 0));
    return splitIntoSegments(text, SEGMENT_MAX_CHARS, FIRST_SEGMENT_MAX_CHARS);
  }

  async synthesizeSegments(text: string, voice?: VoicePreset | string, signal?: AbortSignal): Promise<SynthesizeSegmentsResult> {
    return this.synthesizeJobSegments(this.prepareJob(text, voice), signal);
  }

  async synthesizeJobSegments(job: SpeechJob, signal?: AbortSignal): Promise<SynthesizeSegmentsResult> {
    const segments: SynthesizeSegmentsResult['segments'] = [];
    let totalLen = 0;
    try {
      for await (const segment of this.streamSegments(job, signal)) {
        segments.push({ url: segment.url, duration: segment.duration, text: segment.text, cues: segment.cues });
        totalLen += segment.duration;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (!segments.length) throw error;
      return { segments, totalLen, error: (error as Error).message };
    }
    return { segments, totalLen };
  }

  async *synthesizeSegmentsStream(text: string, voice?: VoicePreset | string, signal?: AbortSignal) {
    yield* this.streamSegments(this.prepareJob(text, voice), signal);
  }

  async *streamSegments(job: SpeechJob, signal?: AbortSignal) {
    const parts = this.split(job.text, job.followText);
    for (const [index, text] of parts.entries()) {
      try {
        const part = await this.synthesizePart(job, text, signal);
        const duration = this.saved.get(part.filename)?.duration ?? part.audioLen;
        yield { index, total: parts.length, url: part.audioUrl, duration, text, cues: part.cues };
      } catch (error) {
        this.report(error, signal);
        throw new Error(`第 ${index + 1}/${parts.length} 段合成失败：${(error as Error).message}`, { cause: error });
      }
    }
  }

  private async synthesizePart(job: SpeechJob, text: string, signal?: AbortSignal): Promise<SynthesizeResult> {
    signal?.throwIfAborted();
    const { config, voice } = job;
    const name = this.cacheName(job, text, config.provider === 'gsv' ? 'part' : 'speech');
    const cached = this.find(name, job.config.provider);
    if (cached) return { audioUrl: cached.audioUrl, filename: name,
      audioLen: config.provider === 'edge' ? 0 : cached.duration, cues: cached.cues };
    if (config.provider !== 'edge' && config.provider !== 'gsv') {
      const saved = await this.wavFlight(name, active => this.pcm({ ...job, text }, active)).work.wait(signal);
      return { audioUrl: saved.audioUrl, filename: name, audioLen: saved.duration };
    }
    return this.shared(this.partsInFlight, name, active => this.renderPart(job, text, name, active)).wait(signal);
  }

  private shared<T>(
    pool: Map<string, SharedWork<T>>, name: string, run: (active: AbortSignal) => Promise<T>,
  ): SharedWork<T> {
    const existing = pool.get(name);
    if (existing && !existing.signal.aborted) return existing;
    const work = new SharedWork(run);
    pool.set(name, work);
    const forget = () => { if (pool.get(name) === work) pool.delete(name); };
    void work.result.then(forget, forget);
    return work;
  }

  private async renderPart(job: SpeechJob, text: string, name: string, signal: AbortSignal): Promise<SynthesizeResult> {
    const { config, voice } = job;
    if (config.provider === 'edge') {
      const operation = AbortSignal.timeout(Math.ceil(config.timeout));
      const combined = signal ? AbortSignal.any([signal, operation]) : operation;
      const { mp3, cues } = await this.edgeAudio(text, String(voice), combined);
      signal.throwIfAborted();
      const saved = this.audioStore.saveRaw(name, mp3);
      this.remember(name, { audioUrl: saved.url, bytes: mp3.length, duration: mp3.length * 8 / 48000, parts: 1, cues });
      return { audioUrl: saved.url, filename: saved.name, audioLen: 0, cues };
    }
    const chunks = [];
    const cues: SpeechCue[] = [];
    let duration = 0;
    for await (const chunk of this.gsv.streamWithPreset(text, voice as VoicePreset, signal, { config, captions: true })) {
      if (chunk.mime.startsWith('audio/pcm') && chunk.sampleRate && chunk.data.length) {
        chunks.push({ base64: Buffer.from(chunk.data).toString('base64'), sampleRate: chunk.sampleRate });
      }
      if (chunk.totalDuration) duration = chunk.totalDuration;
      if (chunk.cues) cues.push(...chunk.cues);
    }
    signal.throwIfAborted();
    if (!chunks.length) throw new Error('未收到任何音频数据');
    const saved = this.audioStore.save(name, chunks);
    this.remember(name, { audioUrl: saved.url, bytes: 0, duration, parts: 1, cues });
    return { audioUrl: saved.url, filename: saved.name, audioLen: duration, cues };
  }

  private cacheName(job: SpeechJob, text: string, mode: string): string {
    const c = job.config;
    const fingerprint = (path: string) => {
      if (!path) return '';
      try { const stat = statSync(path); return [path, stat.size, stat.mtimeMs]; } catch { return path; }
    };
    const provider = c.provider === 'gsv'
      ? [c.apiUrl, c.gsvSpeed, fingerprint(c.gsvModelManifest), typeof job.voice === 'object'
        ? [fingerprint(job.voice.speakerAudioPath), fingerprint(job.voice.promptAudioPath)] : []]
      : c.provider === 'custom'
        ? [c.customBaseUrl, c.customModel, c.customKeyRef, c.customInstructions, c.customFormat]
        : c.provider === 'deepseek' ? [process.env.DEEPSEEK_BASE_URL, c.deepseekApiKeyEnv, c.deepseekApiKey] : [];
    const digest = createHash('sha256').update(JSON.stringify([1, mode, text, c.provider, job.voice, provider])).digest('hex');
    return `speech_${digest}.${c.provider === 'edge' ? 'mp3' : 'wav'}`;
  }

  private find(name: string, provider: ProviderKind) {
    const entry = this.saved.get(name);
    if (entry && this.audioStore.has(name)) {
      this.opts.stats?.record(provider, 'cacheHit');
      return entry;
    }
    this.saved.delete(name);
    return undefined;
  }

  private remember(name: string, result: CompleteAudio & { cues?: SpeechCue[] }): void {
    this.saved.set(name, result);
    if (this.saved.size > 400) this.saved.delete(this.saved.keys().next().value!);
  }

  cachedComplete(job: SpeechJob) {
    return this.find(this.cacheName(job, job.text, this.completeMode(job)), job.config.provider);
  }

  hasWavInFlight(job: SpeechJob): boolean {
    const flight = this.wavInFlight.get(this.cacheName(job, job.text, this.completeMode(job)));
    return Boolean(flight && !flight.work.signal.aborted);
  }

  private completeMode(job: SpeechJob): string {
    return job.followText ? 'aligned' : job.config.provider === 'edge' ? 'complete' : 'speech';
  }

  /** PCM for the browser and WAV writer is always signed 16-bit little-endian. */
  async *pcm(job: SpeechJob, signal?: AbortSignal): AsyncGenerator<{ sampleRate: number; data: Buffer }> {
    const { config, voice, text } = job;
    const local = config.provider === 'gsv';
    const chunks: AsyncIterable<ProviderChunk> = local
      ? this.gsv.streamWithPreset(text, voice as VoicePreset, signal, { config, timeoutMs: 0 })
      : config.provider === 'custom' ? this.custom.stream(text, voice as string, signal, config)
        : this.deepseek.stream(text, voice as string, signal, config, part =>
          this.opts.stats?.reserveDeepseek(part, Boolean(job.automatic), config.deepseekAutoCharsPerDay ?? null));
    let sampleRate: number | undefined;
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      if (!chunk.mime.startsWith('audio/pcm') || !chunk.sampleRate || !chunk.data.length) continue;
      if (sampleRate && chunk.sampleRate !== sampleRate) throw new Error('朗读过程中音频采样率发生变化');
      sampleRate = chunk.sampleRate;
      yield {
        sampleRate,
        data: local ? float32ToInt16(Buffer.from(chunk.data)) : Buffer.from(chunk.data),
      };
    }
  }

  async synthesizeFullWav(text: string, voice: VoicePreset, signal?: AbortSignal): Promise<CompleteAudio> {
    return this.complete(this.prepareJob(text, voice, 'gsv'), signal);
  }

  async synthesizeLongWav(text: string, voice?: string, signal?: AbortSignal): Promise<CompleteAudio> {
    return this.complete(this.prepareJob(text, voice, 'deepseek'), signal);
  }

  async complete(job: SpeechJob, signal?: AbortSignal): Promise<CompleteAudio> {
    signal?.throwIfAborted();
    const cached = this.cachedComplete(job);
    if (cached) return cached;
    const name = this.cacheName(job, job.text, this.completeMode(job));
    try {
      const work = job.config.provider === 'edge'
        ? this.shared(this.mp3InFlight, name, active => this.renderMp3(job, name, active))
        : this.wavFlight(name, active => job.followText ? this.alignedPcm(job, active) : this.pcm(job, active)).work;
      return await work.wait(signal);
    } catch (error) { this.report(error, signal); throw error; }
  }

  private async renderMp3(job: SpeechJob, name: string, signal: AbortSignal): Promise<CompleteAudio> {
    const parts = this.split(job.text, job.followText);
    const pending = this.audioStore.temporaryPath(name);
    const fd = openSync(pending, 'wx');
    let bytes = 0;
    try {
      try {
        for (const part of parts) {
          signal?.throwIfAborted();
          const clip = await this.synthesizePart(job, part, signal);
          const mp3 = readFileSync(join(this.audioStore.directory, clip.filename));
          if (bytes + mp3.length > MAX_AUDIO_BYTES) throw new Error('音频文件超过缓存容量');
          writeFileSync(fd, mp3);
          bytes += mp3.length;
        }
      } finally { closeSync(fd); }
      signal?.throwIfAborted();
      const saved = this.audioStore.publish(name, pending);
      const result = { audioUrl: saved.url, duration: bytes * 8 / 48000, bytes, parts: parts.length };
      this.remember(name, result);
      return result;
    } finally {
      try { unlinkSync(pending); } catch { /* 文件已清理 */ }
    }
  }

  private wavFlight(name: string, source: PcmSource) {
    const existing = this.wavInFlight.get(name);
    if (existing && !existing.work.signal.aborted) return existing;
    const progress: WavProgress = {
      file: this.audioStore.temporaryPath(name), bytes: 0, sampleRate: 0,
      change: changeSignal(), state: 'running',
    };
    const work = new SharedWork(active => this.renderWav(name, progress, source(active), active));
    const flight = { work, progress };
    this.wavInFlight.set(name, flight);
    const settle = (state: 'complete' | 'failed', error?: unknown) => {
      progress.state = state;
      progress.error = error;
      if (this.wavInFlight.get(name) === flight) this.wavInFlight.delete(name);
      notify(progress);
    };
    void work.result.then(() => settle('complete'), error => settle('failed', error));
    return flight;
  }

  async *liveWav(job: SpeechJob, signal: AbortSignal) {
    signal.throwIfAborted();
    const name = this.cacheName(job, job.text, this.completeMode(job));
    if (this.find(name, job.config.provider)) {
      for await (const chunk of createReadStream(join(this.audioStore.directory, name), { signal })) {
        yield Uint8Array.from(chunk);
      }
      return;
    }
    const { work, progress } = this.wavFlight(name, active =>
      job.followText ? this.alignedPcm(job, active) : this.pcm(job, active));
    const release = work.retain(signal);
    let offset = 0;
    let headerSent = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (progress.state === 'failed') throw progress.error;
        if (progress.bytes && !headerSent) {
          headerSent = true;
          yield Uint8Array.from(wavHeader(progress.sampleRate));
          continue;
        }
        if (offset < progress.bytes) {
          const output = new Uint8Array(Math.min(64 * 1024, progress.bytes - offset));
          const fd = openSync(progress.file, 'r');
          let count: number;
          try { count = readSync(fd, output, 0, output.length, 44 + offset); }
          finally { closeSync(fd); }
          if (!count) throw new Error('共享音频写入意外中止');
          offset += count;
          yield output.subarray(0, count);
          continue;
        }
        if (progress.state === 'complete') return;
        await waitWithSignal(progress.change.promise, signal);
      }
    } finally { release(); }
  }

  private async *alignedPcm(job: SpeechJob, signal?: AbortSignal) {
    let sampleRate = 0;
    for (const text of this.split(job.text, true)) {
      const segment = await this.synthesizePart(job, text, signal);
      const wav = parseWav(readFileSync(join(this.audioStore.directory, segment.filename)));
      if (!wav || wav.channels !== 1 || (wav.bits !== 16 && wav.bits !== 32)
        || (sampleRate && sampleRate !== wav.sampleRate)) {
        throw new Error('逐句音频格式不一致，无法生成对应字幕的整段文件');
      }
      sampleRate = wav.sampleRate;
      yield { sampleRate, data: wav.bits === 32 ? float32ToInt16(wav.data) : wav.data };
    }
  }

  private async renderWav(
    name: string,
    progress: WavProgress,
    chunks: AsyncIterable<{ sampleRate: number; data: Buffer }>,
    signal: AbortSignal,
  ): Promise<CompleteAudio> {
    const pending = progress.file;
    const fd = openSync(pending, 'wx');
    let sampleRate = 0;
    let pcmBytes = 0;
    try {
      try {
        writeFileSync(fd, Buffer.alloc(44));
        for await (const chunk of chunks) {
          signal.throwIfAborted();
          if (pcmBytes + chunk.data.length + 44 > MAX_AUDIO_BYTES) throw new Error('音频文件超过缓存容量');
          sampleRate ||= chunk.sampleRate;
          writeFileSync(fd, chunk.data);
          pcmBytes += chunk.data.length;
          progress.sampleRate = sampleRate;
          progress.bytes = pcmBytes;
          notify(progress);
        }
        if (!pcmBytes) throw new Error('未收到任何音频数据');
        const header = wavHeader(sampleRate);
        header.writeUInt32LE(36 + pcmBytes, 4);
        header.writeUInt32LE(pcmBytes, 40);
        writeSync(fd, header, 0, header.length, 0);
      } finally { closeSync(fd); }
      signal?.throwIfAborted();
      const saved = this.audioStore.publish(name, pending);
      progress.file = join(this.audioStore.directory, name);
      const result = { audioUrl: saved.url, duration: pcmBytes / (sampleRate * 2), bytes: pcmBytes + 44, parts: 1 };
      this.remember(name, result);
      return result;
    } finally {
      try { unlinkSync(pending); } catch { /* 文件已清理 */ }
    }
  }

  private async edgeAudio(text: string, voice: string, signal: AbortSignal): Promise<{ mp3: Buffer; cues: SpeechCue[] }> {
    const fallback = defaultVoiceFor('edge') || 'zh-CN-XiaoxiaoNeural';
    const attempts = voice === fallback ? [voice, voice, voice] : [voice, voice, voice, fallback];
    let lastError: unknown;
    for (const [index, id] of attempts.entries()) {
      signal.throwIfAborted();
      const parts: Buffer[] = [];
      const cues: SpeechCue[] = [];
      try {
        for await (const chunk of this.edge.stream(text, id, signal)) {
          if (chunk.mime === 'audio/mpeg' && chunk.data.length) parts.push(Buffer.from(chunk.data));
          if (chunk.cues) cues.push(...chunk.cues);
        }
        signal.throwIfAborted();
        if (parts.length) return { mp3: Buffer.concat(parts), cues };
      } catch (error) {
        signal.throwIfAborted();
        lastError = error;
      }
      if (index < 2) await delay(400 * (index + 1), undefined, { signal });
    }
    throw new Error(`Edge 未返回音频数据${lastError ? `：${(lastError as Error).message}` : ''}`);
  }
}
