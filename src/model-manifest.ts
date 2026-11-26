import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { GSV_ENGINE } from './catalog.js';

export async function verifyModelManifest(models: string, manifest: string, signal?: AbortSignal) {
  if (!manifest.trim()) return { verified: false, version: '', checked: 0 };
  const root = await realpath(models);
  const document = JSON.parse(await readFile(resolve(manifest), 'utf8')) as { version?: unknown; files?: Record<string, unknown> };
  if (typeof document?.version !== 'string' || !document.version.trim() || !document.files ||
    typeof document.files !== 'object' || Array.isArray(document.files)) {
    throw new Error('模型清单需要 version 和文件到 SHA-256 的映射');
  }
  for (const model of GSV_ENGINE.models.filter(model => model.required)) {
    if (!Object.hasOwn(document.files, model.file)) throw new Error(`模型清单缺少 ${model.file}`);
  }
  const files = Object.entries(document.files);
  for (const [file, expected] of files) {
    signal?.throwIfAborted();
    if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(file) ||
      file.split('/').some(part => part === '.' || part === '..') ||
      typeof expected !== 'string' || !/^[a-fA-F0-9]{64}$/.test(expected)) {
      throw new Error('模型清单包含无效的路径或 SHA-256');
    }
    const target = await realpath(resolve(root, file));
    const child = relative(root, target);
    if (!child || isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) throw new Error('模型文件超出模型目录');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== expected.toLowerCase()) throw new Error(`模型 SHA-256 不匹配：${file}`);
  }
  return { verified: true, version: document.version, checked: files.length };
}
