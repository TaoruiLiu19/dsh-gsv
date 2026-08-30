import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Config, VoicePreset, VoiceRegistry, VoiceRegistryPkg } from './types.js';

/** 单文件下载硬上限（独立于清单声明，防超限）。 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 允许的音频后缀白名单。 */
export const ALLOWED_EXT = ['.wav', '.mp3', '.ogg', '.flac', '.m4a'];
/** 音色 id 白名单。 */
export const ID_RE = /^[a-z0-9][a-z0-9-_]*$/;
/** sha256 十六进制串。 */
const SHA_RE = /^[0-9a-f]{64}$/;

export type RegistrySource = 'bundled' | 'remote';

export interface RegistryListEntry extends VoiceRegistryPkg {
  installed: boolean;
}

export interface RegistryListResult {
  source: RegistrySource;
  trusted: boolean;
  version: string;
  voices: RegistryListEntry[];
}

export interface RegistryInstallResult {
  ok: boolean;
  /** 阶段 1 需要确认时置 true（信任边界外不下载任何字节） */
  needsConfirm?: boolean;
  pkg?: VoiceRegistryPkg;
  voice?: VoicePreset;
  message: string;
}

export interface RegistryRemoveResult {
  ok: boolean;
  message: string;
}

export interface RegistryFetchers {
  /** 拉取文本（清单）。 */
  fetchText(url: string): Promise<string>;
  /** 下载二进制（音频）。 */
  fetchBinary(url: string): Promise<Buffer>;
}

/** 包内离线清单路径（编译后 lib/ 同级的 docs/voices.json）。 */
export function bundledManifestPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url)); // .../lib/
  return resolve(here, '..', 'docs', 'voices.json');
}

/** 清单结构校验：schema、id/name 唯一、https 直链、sha256 格式。 */
export function validateManifest(raw: unknown): VoiceRegistry {
  const m = raw as VoiceRegistry;
  const errors: string[] = [];
  if (!m || typeof m !== 'object') throw new Error('清单格式错误：非对象');
  if (m.schema !== 1) errors.push(`schema 必须为 1（实际 ${String(m.schema)}）`);
  if (typeof m.version !== 'string' || !m.version) errors.push('缺少 version');
  if (!Array.isArray(m.voices)) errors.push('缺少 voices 数组');
  if (Array.isArray(m.voices)) {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [i, v] of m.voices.entries()) {
      const where = `voices[${i}]`;
      if (!v || typeof v !== 'object') {
        errors.push(`${where} 非对象`);
        continue;
      }
      if (typeof v.id !== 'string' || !ID_RE.test(v.id)) {
        errors.push(`${where}.id 非法（须匹配 ${ID_RE}）`);
      } else if (ids.has(v.id)) {
        errors.push(`${where}.id 重复: ${v.id}`);
      } else {
        ids.add(v.id);
      }
      if (typeof v.name !== 'string' || !v.name.trim()) {
        errors.push(`${where}.name 缺失`);
      } else if (names.has(v.name)) {
        errors.push(`${where}.name 重复: ${v.name}`);
      } else {
        names.add(v.name);
      }
      if (typeof v.license !== 'string' || !v.license) errors.push(`${where}.license 缺失`);
      if (typeof v.speaker !== 'string' || !v.speaker.startsWith('https://')) {
        errors.push(`${where}.speaker 必须为 https:// 直链`);
      }
      if (typeof v.prompt !== 'string' || !v.prompt.startsWith('https://')) {
        errors.push(`${where}.prompt 必须为 https:// 直链`);
      }
      const s = (v as VoiceRegistryPkg).sha256;
      if (!s || typeof s.speaker !== 'string' || !SHA_RE.test(s.speaker)) {
        errors.push(`${where}.sha256.speaker 非法`);
      }
      if (!s || typeof s.prompt !== 'string' || !SHA_RE.test(s.prompt)) {
        errors.push(`${where}.sha256.prompt 非法`);
      }
    }
  }
  if (errors.length) throw new Error('清单校验失败：' + errors.join('；'));
  return m as VoiceRegistry;
}

/**
 * 音色注册表核心（工具与 HTTP 路由共享）。
 *
 * 信任规则（唯一一条）：信任 = 随插件发版内置。仅包内离线清单且 trusted 为真可免确认；
 * 任何经 voiceRegistryUrl 来的远端清单一律两阶段确认，即便它自报 trusted。
 */
export class VoiceRegistryManager {
  constructor(
    private opts: {
      getConfig: () => Config;
      /** 持久化配置补丁（settingsScope.update(patch)），热更新触发 reconfigure */
      writeConfig: (patch: Partial<Config>) => Promise<void>;
      fetchers?: Partial<RegistryFetchers>;
    },
  ) {}

  private fetchers(): RegistryFetchers {
    const f = this.opts.fetchers ?? {};
    return {
      fetchText:
        f.fetchText ??
        (async (url) => {
          const resp = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
          if (!resp.ok) throw new Error(`清单拉取失败: HTTP ${resp.status}`);
          return resp.text();
        }),
      fetchBinary:
        f.fetchBinary ??
        (async (url) => {
          if (!url.startsWith('https://')) throw new Error('仅允许 https:// 直链');
          const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
          if (!resp.ok) throw new Error(`音频下载失败: HTTP ${resp.status}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length === 0) throw new Error('下载内容为空');
          if (buf.length > MAX_FILE_BYTES) throw new Error(`文件超限（${buf.length} > ${MAX_FILE_BYTES} 字节）`);
          return buf;
        }),
    };
  }

  /** 解析清单：无 voiceRegistryUrl → 包内离线；有 → 远端（不可自证信任）。 */
  private async resolveRegistry(registryUrl?: string): Promise<{ source: RegistrySource; trusted: boolean; manifest: VoiceRegistry }> {
    const url = (registryUrl ?? this.opts.getConfig().voiceRegistryUrl ?? '').trim();
    if (!url) {
      const p = bundledManifestPath();
      let text: string;
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        throw new Error(`包内清单缺失: ${p}`);
      }
      const manifest = validateManifest(JSON.parse(text));
      return { source: 'bundled', trusted: manifest.trusted === true, manifest };
    }
    if (!url.startsWith('https://')) throw new Error('voiceRegistryUrl 必须为 https:// 地址');
    const text = await this.fetchers().fetchText(url);
    const manifest = validateManifest(JSON.parse(text));
    return { source: 'remote', trusted: false, manifest };
  }

  /** 市场列表：拉取清单并标注已安装状态。 */
  async list(registryUrl?: string): Promise<RegistryListResult> {
    const { source, trusted, manifest } = await this.resolveRegistry(registryUrl);
    const installed = new Set(
      this.opts.getConfig().voices.filter((v) => v.source === 'registry' && v.id).map((v) => v.id as string),
    );
    return {
      source,
      trusted,
      version: manifest.version,
      voices: manifest.voices.map((v) => ({ ...v, installed: installed.has(v.id) })),
    };
  }

  /**
   * 安装（两阶段幂等）：
   * - 需确认时（非包内可信清单）第一段返回 needsConfirm，不下载任何字节；
   * - confirm 后（或包内可信）才下载 → sha256 校验 → 原子落盘 → 写 Config.voices。
   */
  async install(id: string, confirm: boolean): Promise<RegistryInstallResult> {
    const { source, trusted, manifest } = await this.resolveRegistry();
    const pkg = manifest.voices.find((v) => v.id === id);
    if (!pkg) return { ok: false, message: `清单中不存在音色 "${id}"` };

    const needsConfirm = !(source === 'bundled' && trusted);
    if (needsConfirm && !confirm) {
      return { ok: false, needsConfirm: true, pkg, message: `来源为${source === 'bundled' ? '包内但未标记信任' : '远端清单'}，需要确认后安装` };
    }

    const tmpBase = mkdtempSync(join(tmpdir(), 'dsh-gsv-registry-'));
    try {
      const staged = await this.stage(pkg, tmpBase);
      const cfg = this.opts.getConfig();
      const next = [
        ...cfg.voices.filter((v) => !(v.source === 'registry' && v.id === pkg.id)),
        staged.voice,
      ];
      await this.opts.writeConfig({ voices: next });
      return { ok: true, pkg, voice: staged.voice, message: `已安装音色 "${pkg.name}"` };
    } catch (e) {
      return { ok: false, message: String((e as Error)?.message ?? e) };
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  }

  /** 卸载：仅限 source:'registry'，按 id 精确匹配；defaultVoice 悬空一并清空；deleteFiles 限定在 voices 目录内。 */
  async remove(id: string, deleteFiles: boolean): Promise<RegistryRemoveResult> {
    const cfg = this.opts.getConfig();
    const voice = cfg.voices.find((v) => v.id === id);
    if (!voice) return { ok: false, message: `未安装音色 "${id}"` };
    if (voice.source !== 'registry') {
      return { ok: false, message: `音色 "${voice.name}" 为自定义音色，注册表卸载仅限注册表安装的音色` };
    }
    const next = cfg.voices.filter((v) => !(v.id === id && v.source === 'registry'));
    const patch: Partial<Config> = { voices: next };
    if (cfg.defaultVoice === voice.name) patch.defaultVoice = ''; // 防悬空
    await this.opts.writeConfig(patch);
    if (deleteFiles) {
      const dir = this.voiceDir(id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    return { ok: true, message: `已卸载音色 "${voice.name}"` };
  }

  /** 下载 → sha256 校验 → 原子落盘；返回可写回 Config 的 VoicePreset。 */
  private async stage(pkg: VoiceRegistryPkg, tmpBase: string): Promise<{ voice: VoicePreset }> {
    const extOf = (url: string) => {
      try {
        return extname(new URL(url).pathname).toLowerCase();
      } catch {
        return '';
      }
    };
    const speakerExt = extOf(pkg.speaker);
    const promptExt = extOf(pkg.prompt);
    if (!ALLOWED_EXT.includes(speakerExt)) throw new Error(`speaker 后缀不允许: ${speakerExt || '(无)'}`);
    if (!ALLOWED_EXT.includes(promptExt)) throw new Error(`prompt 后缀不允许: ${promptExt || '(无)'}`);

    const fetchers = this.fetchers();
    // 两个文件都先落临时目录并各自校验，全部通过才提交（原子）
    const speakerBuf = fetchers.fetchBinary(pkg.speaker);
    const promptBuf = fetchers.fetchBinary(pkg.prompt);
    const [speakerData, promptData] = await Promise.all([speakerBuf, promptBuf]);

    // 大小硬上限在 stage 层强制执行（不依赖 fetcher 实现），默认 fetcher 里的检查只是提前止损
    if (speakerData.length > MAX_FILE_BYTES) throw new Error(`speaker 文件超限（${speakerData.length} > ${MAX_FILE_BYTES} 字节）`);
    if (promptData.length > MAX_FILE_BYTES) throw new Error(`prompt 文件超限（${promptData.length} > ${MAX_FILE_BYTES} 字节）`);

    const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const speakerSha = hash(speakerData);
    const promptSha = hash(promptData);
    if (speakerSha !== pkg.sha256.speaker) {
      throw new Error(`speaker sha256 校验失败（期望 ${pkg.sha256.speaker.slice(0, 12)}…，实际 ${speakerSha.slice(0, 12)}…）`);
    }
    if (promptSha !== pkg.sha256.prompt) {
      throw new Error(`prompt sha256 校验失败（期望 ${pkg.sha256.prompt.slice(0, 12)}…，实际 ${promptSha.slice(0, 12)}…）`);
    }

    const dir = this.voiceDir(pkg.id);
    const speakerFile = join(tmpBase, `speaker${speakerExt}`);
    const promptFile = join(tmpBase, `prompt${promptExt}`);
    writeFileSync(speakerFile, speakerData);
    writeFileSync(promptFile, promptData);

    // 提交：建目录 + 双文件改名（失败则回滚整个目录）
    mkdirSync(dir, { recursive: true });
    try {
      renameSync(speakerFile, join(dir, `speaker${speakerExt}`));
      renameSync(promptFile, join(dir, `prompt${promptExt}`));
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return {
      voice: {
        name: pkg.name,
        speakerAudioPath: join(dir, `speaker${speakerExt}`),
        promptAudioPath: join(dir, `prompt${promptExt}`),
        promptText: pkg.promptText,
        id: pkg.id,
        source: 'registry',
      },
    };
  }

  /** 安装/删除目录：resolve 后必须仍位于 <installDir>/voices/ 之下。 */
  private voiceDir(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`非法音色 id: ${id}`);
    const base = resolve(this.opts.getConfig().installDir, 'voices');
    const dir = join(base, id);
    const prefix = base + sep;
    if (dir !== base && !dir.startsWith(prefix)) throw new Error(`非法安装路径: ${id}`);
    return dir;
  }
}
