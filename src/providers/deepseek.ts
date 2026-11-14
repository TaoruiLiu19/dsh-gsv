import { splitIntoSegments } from '../segmenter.js';
import { DEFAULT_DEEPSEEK_KEY_REF } from '../config.js';
import type { ProviderChunk, ProviderHealth, TTSProvider, VoiceInfo } from '../types.js';

/**
 * DeepSeek 官方语音（TTS）提供方。
 *
 * 官方接口：`POST https://api.deepseek.com/v1/tools/tts`
 * - 请求体 `{ text, voice_id, format, filter_markdown }`，响应体是流式 WAV 字节；
 * - 单次请求文本上限 10,000 计费字符（汉字算 2 个）、请求体 64 KiB；
 * - 音色只有 `stella`（海星，女声，默认）和 `tide`（暗潮，男声），不支持调速/克隆；
 * - 支持整段 HTTP 与 WebSocket 流式两种形态。本插件按句分段朗读（每段约 150 字），
 *   所以这里只用整段 HTTP：一次分段一次请求，解出 16-bit PCM 后交给服务层装 WAV。
 *
 * 与 Edge 提供方的关键差异：DeepSeek 返回的是完整 WAV 容器（带 RIFF 头），
 * 不能像 MP3 那样把多段字节直接拼起来——长文本必须解出 `data` 块再重新装头。
 */

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_VOICE = 'stella';

/** 官方音色（2026-11 文档：stella / tide）。 */
export const DEEPSEEK_VOICES: readonly VoiceInfo[] = [
  { id: 'stella', name: '海星（女声）', gender: 'Female', locale: 'zh-CN' },
  { id: 'tide', name: '暗潮（男声）', gender: 'Male', locale: 'zh-CN' },
];

/** 是否为官方音色 id。 */
export function isDeepseekVoiceId(value: unknown): value is string {
  return value === 'stella' || value === 'tide';
}

/**
 * 单个请求的切分字符数：官方上限 1 万计费字符，汉字按 2 字符计，
 * 取 2000 字（约 4000 计费字符）留足余量，也避免单请求生成时间过长。
 */
export const DEEPSEEK_CHUNK_CHARS = 2000;

/** 单请求超时下限：2000 字最多约 8 分钟音频，30 秒默认超时不够用。 */
const MIN_REQUEST_TIMEOUT_MS = 90000;

/** WAV 里我们需要的字段。 */
export interface ParsedWav {
  sampleRate: number;
  channels: number;
  bits: number;
  data: Buffer;
}

/**
 * 解析 RIFF/WAVE：扫描块直到 `data`，取出 fmt 的采样率/声道/位深与音频负载。
 * 流式响应的 data 长度字段可能是 0xFFFFFFFF，此时按实际可用字节截取。
 * 解析失败（非 WAV / 缺 fmt / 缺 data）返回 null，由调用方决定是否降级。
 */
export function parseWav(bytes: Buffer): ParsedWav | null {
  if (bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;

  let fmt: { sampleRate: number; channels: number; bits: number } | null = null;
  let data: Buffer | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) {
      fmt = {
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      const available = Math.min(size, bytes.length - body);
      data = bytes.subarray(body, body + available);
      break; // data 之后通常是补齐字节，忽略
    }
    if (size === 0xffffffff || size === 0) break; // 流式/异常长度：无法安全跳过
    offset = body + size + (size % 2);
  }

  if (!fmt || !data || !fmt.sampleRate || !fmt.channels) return null;
  return { ...fmt, data };
}

/** 构造 44 字节 16-bit PCM WAV（用于合并多段官方音频）。 */
export function buildWav16(data: Buffer, sampleRate: number, channels = 1): Buffer {
  const bits = 16;
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 音频时长（秒）：按首段采样参数换算。 */
export function wavDuration(wav: ParsedWav): number {
  const bytesPerSec = wav.sampleRate * wav.channels * (wav.bits / 8);
  return bytesPerSec > 0 ? wav.data.length / bytesPerSec : 0;
}

export interface DeepseekProviderOptions {
  /** 读取当前生效配置（API Key / 凭据引用名 / 超时；volatile 配置需每次重读）。 */
  getConfig: () => { deepseekApiKey?: string; deepseekApiKeyEnv?: string; timeout?: number };
  /**
   * Harness 凭据服务（`ctx.get('credentials')`）。
   * 存在时按引用名解析 Key，于是模型设置里保存的 DEEPSEEK_API_KEY 可直接复用，无需再填一次。
   */
  credentials?: () => { resolve(ref: string): Promise<{ value?: string } | undefined> } | undefined;
  /** 覆盖接口地址（测试用）。 */
  baseUrl?: string;
  /** 覆盖 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
  /** 覆盖时钟（健康状态退避测试用）。 */
  clock?: () => number;
  /** 覆盖环境变量读取（测试用；默认读 process.env）。 */
  env?: Record<string, string | undefined>;
}

export class DeepseekProvider implements TTSProvider {
  readonly kind = 'deepseek' as const;
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private clock: () => number;
  private env: Record<string, string | undefined>;
  private healthCache = { at: Number.NEGATIVE_INFINITY, backoff: 30000, ok: true, message: '' };

  constructor(private opts: DeepseekProviderOptions) {
    this.env = opts.env ?? process.env;
    // 与 Harness 的 LLM 路由保持一致：设置了 DEEPSEEK_BASE_URL 就沿用同一网关，否则走官方地址
    const envBase = String(this.env.DEEPSEEK_BASE_URL ?? '').trim();
    this.baseUrl = (opts.baseUrl ?? (envBase || DEEPSEEK_BASE_URL)).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? (() => Date.now());
  }

  /**
   * 解析 API Key，优先级：
   * 1. 插件设置里手填的 Key（显式覆盖，适合用独立额度）；
   * 2. Harness 凭据服务按引用名解析（默认 DEEPSEEK_API_KEY）——与模型鉴权同一份 Key；
   * 3. 同名环境变量（凭据服务缺失 / 解析失败时的兜底）。
   */
  async apiKey(): Promise<string> {
    const cfg = this.opts.getConfig();
    const manual = String(cfg.deepseekApiKey ?? '').trim();
    if (manual) return manual;

    const refName = String(cfg.deepseekApiKeyEnv ?? '').trim();
    if (!refName) return '';

    const service = this.opts.credentials?.();
    if (service) {
      try {
        const hit = await service.resolve(refName);
        const value = String(hit?.value ?? '').trim();
        if (value) return value;
      } catch {
        // 凭据服务不可用（精简宿主 / 只读存储）：继续走环境变量
      }
    }
    return String(this.env[refName] ?? '').trim();
  }

  listVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve(DEEPSEEK_VOICES.map((v) => ({ ...v })));
  }

  async health(): Promise<ProviderHealth> {
    const key = await this.apiKey();
    if (!key) {
      return {
        available: false,
        message:
          '未找到 DeepSeek 凭据：在 Harness 设置（模型/账户）里保存 DEEPSEEK_API_KEY 即可自动复用，' +
          '也可在本插件设置里手填 Key，或导出同名环境变量',
      };
    }
    const now = this.clock();
    if (now - this.healthCache.at < this.healthCache.backoff) {
      return this.healthCache.ok ? { available: true } : { available: false, message: this.healthCache.message };
    }
    this.healthCache.at = now;
    try {
      await this.probe(key);
      this.healthCache.ok = true;
      // 成功也缓存 5 分钟：设置面板每分钟刷新时不该每分钟真发一次请求
      this.healthCache.backoff = 300000;
      this.healthCache.message = '';
      return { available: true };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      this.healthCache.ok = false;
      this.healthCache.message = msg;
      this.healthCache.backoff = Math.min(this.healthCache.backoff * 2, 120000);
      return { available: false, message: msg };
    }
  }

  /**
   * 免费探活：GET /models 只验证 Key 与网络，不生成音频、不产生费用，通常 200–400ms。
   * 之前用「试合成两个字」探活，每次要 1–4 秒且真的计费，切模式时会明显拖慢设置面板。
   */
  private async probe(key: string): Promise<void> {
    const resp = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.status === 401 || resp.status === 403) throw new Error('DeepSeek API Key 无效或未授权');
    // 自建网关可能没有 /models：凭据存在即视为可用，不误报不可用
    if (!resp.ok && resp.status !== 404 && resp.status !== 405) {
      throw new Error(`DeepSeek 健康检查失败（HTTP ${resp.status}）`);
    }
  }

  async *stream(text: string, voice: string, signal?: AbortSignal): AsyncIterable<ProviderChunk> {
    const voiceId = isDeepseekVoiceId(voice) ? voice : DEEPSEEK_DEFAULT_VOICE;
    const parts = splitIntoSegments(text, DEEPSEEK_CHUNK_CHARS, 0);
    if (parts.length === 0) throw new Error('没有可合成的文本');

    let totalDuration = 0;
    for (const part of parts) {
      const wav = await this.requestWav(part, voiceId, signal);
      const info = parseWav(wav);
      if (!info) throw new Error('DeepSeek 返回的音频不是可解析的 WAV');
      if (info.bits !== 16) throw new Error(`DeepSeek 返回 ${info.bits}-bit WAV，暂不支持该位深`);
      totalDuration += wavDuration(info);
      // 逐块吐 16-bit PCM，由调用方决定落盘方式：短文本装 WAV，长文本边收边写文件
      if (info.data.length > 0) {
        yield { mime: 'audio/pcm-s16', data: info.data, sampleRate: info.sampleRate };
      }
    }

    yield { mime: 'audio/meta', data: new Uint8Array(0), totalDuration };
  }

  /** 单次官方 TTS 请求，返回完整 WAV 字节。 */
  private async requestWav(text: string, voiceId: string, signal?: AbortSignal): Promise<Buffer> {
    const key = await this.apiKey();
    if (!key) {
      throw new Error(
        '未找到 DeepSeek 凭据：在 Harness 设置里保存 DEEPSEEK_API_KEY 即可自动复用（本插件默认读取该引用名），' +
          '也可手填 Key 或导出同名环境变量',
      );
    }
    const cfg = this.opts.getConfig();
    const timeoutMs = Math.max(Number(cfg.timeout) || 0, MIN_REQUEST_TIMEOUT_MS);

    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/v1/tools/tts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          voice_id: voiceId,
          format: 'wav',
          // 插件侧已做 Markdown 清洗，避免官方再处理一遍把正常文本改坏
          filter_markdown: false,
        }),
        signal: combined,
      });
    } catch (e) {
      if (combined.aborted) throw new Error(`DeepSeek TTS 请求超时或已取消（${timeoutMs}ms）`);
      throw e;
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      const hint =
        resp.status === 401 || resp.status === 403
          ? 'API Key 无效或未授权'
          : resp.status === 429
            ? '并发请求数超限，请稍后重试'
            : resp.status === 503
              ? '官方服务繁忙，请稍后重试'
              : resp.status === 400
                ? '文本为空、超长或未通过内容审核'
                : '';
      throw new Error(`DeepSeek TTS 失败（${resp.status}${hint ? `：${hint}` : ''}）${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error('DeepSeek TTS 未返回音频数据');
    return buf;
  }
}
