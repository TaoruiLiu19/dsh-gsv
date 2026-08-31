import type { ProviderKind } from './types.js';

/**
 * 4.0.0 迁移守卫：读 settings 的**原始 user 层**判定初始 provider（schema 默认值会污染判定）。
 * - user 层不存在（settings.yaml 无 dsh-gsv-tts 段）→ 全新安装 → edge
 * - user 层存在但无 provider → 老用户 → gsv（声音不变）
 * - user.provider 已设置 → 沿用
 */
export function resolveProvider(user: Record<string, unknown> | undefined): ProviderKind {
  if (user === undefined) return 'edge';
  if (user.provider === 'edge' || user.provider === 'gsv') return user.provider;
  return 'gsv';
}
