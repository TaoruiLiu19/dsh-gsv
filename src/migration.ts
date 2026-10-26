import type { ProviderKind, VoicePreset } from './types.js';

/**
 * provider 迁移守卫（5.0.0 起）：配置里没有显式 provider 时落定一次并写回。
 * - 已有音色预设 → gsv（老用户沿用本地专业模式，声音不变）
 * - 无音色预设 → edge（全新安装默认云端快速体验）
 * - 已显式设置（gsv/edge）→ 沿用，不再改写
 */
export function resolveProvider(stored: unknown, voices: readonly VoicePreset[]): ProviderKind {
  if (stored === 'edge' || stored === 'gsv') return stored;
  return voices.length > 0 ? 'gsv' : 'edge';
}
