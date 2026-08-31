import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * 合成音频的本地存储与投递。
 *
 * - 正常路径：把 PCM 块拼成合法 WAV 文件（含 RIFF 头）写入系统临时目录，
 *   通过 DSH `webServer` 注册的路由以同源短 URL 返回（模型上下文/会话日志
 *   不再被几十 MB 的 data URL 撑爆）。
 * - 兜底路径：无 webServer 时退回 `data:audio/wav;base64,...`（含合法 WAV 头）。
 */

const MAX_FILES = 200;
const FILE_RE = /^[A-Za-z0-9._-]+\.(wav|mp3|ogg)$/;

/** 按扩展名回 MIME（Edge MP3 透传需要 audio/mpeg）。 */
function mimeFor(name: string): string {
  return name.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
}

export interface AudioChunk {
  /** 该块的 base64 编码音频数据（GSV-TTS-Lite 输出 32-bit float32 波形） */
  base64: string;
  /** 采样率（Hz） */
  sampleRate: number;
}

export class AudioStore {
  private dir: string;

  /**
   * @param baseUrl DSH webServer 的 `http://host:port`；缺省时退回 data URL。
   */
  constructor(private baseUrl?: string) {
    this.dir = join(tmpdir(), 'dsh-gsv-tts');
    mkdirSync(this.dir, { recursive: true });
    this.purgeAll();
  }

  get enabled(): boolean {
    return !!this.baseUrl;
  }

  /** 将音频块写成 WAV 文件并返回可播放 URL。 */
  save(name: string, chunks: AudioChunk[]): { url: string; name: string } {
    const sampleRate = chunks[0]?.sampleRate || 32000;
    const pcm = Buffer.concat(chunks.map((c) => Buffer.from(c.base64, 'base64')));
    const wav = buildWav(pcm, sampleRate);
    return this.saveRaw(name, wav);
  }

  /** 将原始音频字节（MP3/WAV 等）落盘并返回可播放 URL（4.0.0 Edge MP3 透传）。 */
  saveRaw(name: string, data: Buffer): { url: string; name: string } {
    const file = join(this.dir, name);
    writeFileSync(file, data);
    this.enforceCap();
    const url = this.baseUrl
      ? `${this.baseUrl}/dsh-gsv-tts/audio/${name}`
      : `data:${mimeFor(name)};base64,${data.toString('base64')}`;
    return { url, name };
  }

  /** 服务 `/dsh-gsv-tts/audio/<file>` 请求。 */
  async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const name = decodeURIComponent(pathname.split('/').pop() ?? '');
      if (!FILE_RE.test(name)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const file = join(this.dir, name);
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const stat = statSync(file);
      res.writeHead(200, {
        'Content-Type': mimeFor(name),
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(file);
        stream.on('error', reject);
        stream.on('close', resolve);
        stream.pipe(res);
      });
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('internal error');
      } else {
        res.destroy();
      }
    }
  }

  /** 启动时清空上次会话残留。 */
  private purgeAll(): void {
    for (const file of this.listFiles()) {
      try {
        unlinkSync(file);
      } catch {
        // 忽略清理失败
      }
    }
  }

  /** 会话内限制文件数量，超出删除最旧的。 */
  private enforceCap(): void {
    const files = this.listFiles();
    if (files.length <= MAX_FILES) return;
    files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    for (const file of files.slice(0, files.length - MAX_FILES)) {
      try {
        unlinkSync(file);
      } catch {
        // 忽略清理失败
      }
    }
  }

  private listFiles(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => FILE_RE.test(name))
      .map((name) => join(this.dir, name))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });
  }
}

/** 为 32-bit 单声道 IEEE float PCM 构造标准 44 字节 WAV(RIFF) 头。
 *  GSV-TTS-Lite 的 `clip.audio_data` 是 float32 波形（-1~1），对应 WAV format=3。 */
export function buildWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 32;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
