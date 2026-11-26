import { createReadStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

export const TTS_API_PATH = '/api/dsh-gsv-tts';
const MAX_FILES = 200;
export const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^[A-Za-z0-9_-]+\.(wav|mp3|ogg)$/;
const PENDING_RE = /^\.[A-Za-z0-9_-]+\.(wav|mp3|ogg)\.[a-f0-9-]+\.tmp$/;

function mimeFor(name: string): string {
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.ogg')) return 'audio/ogg';
  return 'audio/wav';
}

interface CachedFile {
  path: string;
  size: number;
  modified: number;
}

function remove(file: string): void {
  try { unlinkSync(file); } catch { /* 正在使用的文件稍后再回收 */ }
}

export interface AudioChunk {
  base64: string;
  sampleRate: number;
}

export class AudioStore {
  readonly directory: string;
  readonly profileDirectory: string;

  constructor(
    private readonly originProvider?: string | (() => string | undefined),
    scope = '',
    tempRoot = tmpdir(),
  ) {
    const scopeKey = createHash('sha256').update(scope).digest('hex').slice(0, 24);
    const cacheRoot = join(resolve(tempRoot), 'dsh-gsv-tts', scopeKey);
    this.profileDirectory = cacheRoot;
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    this.directory = mkdtempSync(join(cacheRoot, `instance-${process.pid}-`));
    this.pruneExitedInstances(cacheRoot);
  }

  private origin(): string | undefined {
    if (typeof this.originProvider !== 'function') return this.originProvider;
    try { return this.originProvider(); } catch { return undefined; }
  }

  save(name: string, chunks: AudioChunk[]): { url: string; name: string } {
    const sampleRate = chunks[0]?.sampleRate || 32000;
    const pcm = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.base64, 'base64')));
    return this.saveRaw(name, buildWav(pcm, sampleRate));
  }

  temporaryPath(name: string): string {
    if (!FILE_RE.test(name)) throw new Error('无效的音频文件名');
    return join(this.directory, `.${name}.${randomUUID()}.tmp`);
  }

  publish(name: string, pending: string): { url: string; name: string } {
    if (!FILE_RE.test(name) || resolve(pending, '..') !== this.directory) throw new Error('无效的音频路径');
    if (lstatSync(pending).size > MAX_AUDIO_BYTES) throw new Error('音频文件超过缓存容量');
    renameSync(pending, join(this.directory, name));
    this.prune(name);
    return { url: this.urlFor(name), name };
  }

  saveRaw(name: string, data: Buffer): { url: string; name: string } {
    const pending = this.temporaryPath(name);
    try {
      writeFileSync(pending, data, { flag: 'wx', mode: 0o600 });
      return this.publish(name, pending);
    } finally { remove(pending); }
  }

  urlFor(name: string): string {
    return `${this.origin() ?? ''}${TTS_API_PATH}/audio?file=${encodeURIComponent(name)}`;
  }

  has(name: string): boolean {
    if (!FILE_RE.test(name)) return false;
    try {
      const stat = lstatSync(join(this.directory, name));
      return stat.isFile() && Date.now() - stat.mtimeMs <= TTL_MS;
    } catch { return false; }
  }

  stats(): { directory: string; fileCount: number } {
    this.prune();
    return { directory: this.directory, fileCount: this.list(this.directory).length };
  }

  serve(request: Request): Response {
    const name = new URL(request.url).searchParams.get('file') ?? '';
    if (!FILE_RE.test(name)) return new Response('not found', { status: 404 });
    const file = join(this.directory, name);
    let size: number;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || Date.now() - stat.mtimeMs > TTL_MS) return new Response('not found', { status: 404 });
      size = stat.size;
    } catch {
      return new Response('not found', { status: 404 });
    }
    const headers = new Headers({
      'Content-Type': mimeFor(name),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    });
    const range = request.headers.get('range');
    let start = 0;
    let end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match && (match[1] || match[2])) {
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), end) : end;
        } else {
          start = Math.max(0, size - Number(match[2]));
        }
      } else {
        start = size;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        headers.set('Content-Range', `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(end - start + 1));
    const body = request.method === 'HEAD' || size === 0 ? null
      : Readable.toWeb(createReadStream(file, { start, end, signal: request.signal })) as ReadableStream<Uint8Array>;
    return new Response(body, { status: range ? 206 : 200, headers });
  }

  dispose(): void {
    this.removeInstance(this.directory);
  }

  private prune(newFile?: string): void {
    const files = this.list(this.directory).sort((a, b) => b.modified - a.modified);
    let count = 0;
    let size = 0;
    for (const file of files) {
      if (file.path === join(this.directory, newFile ?? '')) {
        count++;
        size += file.size;
        break;
      }
    }
    for (const file of files) {
      if (file.path === join(this.directory, newFile ?? '')) continue;
      if (Date.now() - file.modified > TTL_MS || count >= MAX_FILES || size + file.size > MAX_AUDIO_BYTES) {
        remove(file.path);
        continue;
      }
      count++;
      size += file.size;
    }
  }

  private list(dir: string, pending = false): CachedFile[] {
    try {
      return readdirSync(dir).flatMap(name => {
        if (!(FILE_RE.test(name) || (pending && PENDING_RE.test(name)))) return [];
        const path = join(dir, name);
        try {
          const stat = lstatSync(path);
          return stat.isFile() ? [{ path, size: stat.size, modified: stat.mtimeMs }] : [];
        } catch { return []; }
      });
    } catch { return []; }
  }

  private removeInstance(dir: string): void {
    for (const file of this.list(dir, true)) remove(file.path);
    try { rmdirSync(dir); } catch { /* 跳过仍在使用的目录 */ }
  }

  private pruneExitedInstances(root: string): void {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const match = /^instance-(\d+)-[A-Za-z0-9]+$/.exec(entry.name);
      if (!match || !entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      try {
        if (Date.now() - lstatSync(dir).mtimeMs < TTL_MS) continue;
        process.kill(Number(match[1]), 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') this.removeInstance(dir);
      }
    }
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
