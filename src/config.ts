const DEFAULT_CHILD_NAME = "Baby";

/** Access, refresh, and DCR client lifetime when AUTH_TTL_SECONDS is unset. */
export const DEFAULT_AUTH_TTL_SECONDS = 180 * 24 * 60 * 60;
const KV_MIN_TTL_SECONDS = 60;

export function childName(env: Env): string {
  const value = env.CHILD_NAME?.trim();
  return value && value.length > 0 ? value : DEFAULT_CHILD_NAME;
}

/**
 * アクセストークン・リフレッシュトークン・DCR クライアントの有効期間 (秒)。
 * 不正な値や KV の最小 TTL (60 秒) 未満の値は無視して既定値を使う。
 */
export function authTtlSeconds(env: Env): number {
  const raw = env.AUTH_TTL_SECONDS?.trim();
  if (!raw) {
    return DEFAULT_AUTH_TTL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < KV_MIN_TTL_SECONDS) {
    return DEFAULT_AUTH_TTL_SECONDS;
  }
  return parsed;
}
