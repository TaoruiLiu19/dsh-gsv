import type { Config, ProviderKind, VoicePreset } from './types.js';

/** 默认值（与 Config Schema 保持一致；用于无值/精简宿主兜底）。 */
export const DEFAULT_API_URL = 'http://localhost:9880';
export const DEFAULT_INSTALL_DIR = './GSV-TTS-Lite';
export const DEFAULT_VOICE_REGISTRY_URL = 'https://taoruiliu19.github.io/gsv-market/voices.json';
export const SCHEMA_VERSION = 1;

/**
 * DSH 0.2+ 的 `Schema.volatile()` 字段在插件 `apply(config)` 中不是普通值，
 * 而是可读引用 `{ get(): T }`：设置面板保存后宿主就地更新引用，插件无需重载即可读到新值。
 * 这里统一做一次「解引用 + 默认值兜底」，把引用形态或普通形态的配置都归一成快照。
 */
export interface ConfigRef<T> {
  get(): T;
}

/** 判断一个配置值是否是宿主下发的 volatile 引用。 */
export function isConfigRef(value: unknown): value is ConfigRef<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { get?: unknown }).get === 'function'
  );
}

/** 解引用单个配置值；引用缺值时回退 fallback。 */
export function readConfigValue<T>(value: unknown, fallback: T): T {
  if (isConfigRef(value)) {
    const current = value.get();
    return current === undefined ? fallback : (current as T);
  }
  return value === undefined ? fallback : (value as T);
}

/**
 * 未显式选择 provider 时的判定：
 * - 已配置音色预设 → gsv（老用户沿用本地专业模式，声音不变）
 * - 全新安装（无音色）→ edge（云端快速体验，装上即听）
 */
export function resolveProviderKind(stored: unknown, voices: readonly VoicePreset[]): ProviderKind {
  if (stored === 'edge' || stored === 'gsv') return stored;
  return voices.length > 0 ? 'gsv' : 'edge';
}

/** 读取显式持久化的 provider（未设置时为 undefined），用于迁移守卫判断是否需要写回。 */
export function storedProvider(raw: unknown): unknown {
  return readConfigValue<unknown>(raw, undefined);
}

/** 把 `apply(ctx, config)` 收到的配置（含 volatile 引用）归一为当前生效的普通对象。 */
export function snapshotConfig(raw: unknown): Config {
  const source = (raw ?? {}) as Record<string, unknown>;
  const voices = readConfigValue<VoicePreset[]>(source.voices, []);
  const list = Array.isArray(voices) ? voices : [];
  const timeout = readConfigValue(source.timeout, 30000);
  return {
    apiUrl: readConfigValue(source.apiUrl, DEFAULT_API_URL),
    voices: list,
    defaultVoice: readConfigValue(source.defaultVoice, ''),
    autoPlay: readConfigValue(source.autoPlay, false),
    interruptOnNew: readConfigValue(source.interruptOnNew, true),
    // AbortSignal.timeout / 工具 timeoutMs 都要求正数：非法值回退默认，避免旧配置把插件弄挂
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    installDir: readConfigValue(source.installDir, DEFAULT_INSTALL_DIR),
    voiceRegistryUrl: readConfigValue(source.voiceRegistryUrl, DEFAULT_VOICE_REGISTRY_URL),
    schemaVersion: readConfigValue(source.schemaVersion, SCHEMA_VERSION),
    provider: resolveProviderKind(readConfigValue<unknown>(source.provider, undefined), list),
    quotaDaily: readConfigValue<number | null>(source.quotaDaily, null),
  };
}
