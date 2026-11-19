import { passwordsEqual } from "./crypto";

/**
 * 家族共有パスワード (AUTH_PASSWORD) と照合する。認可画面でのログインにだけ使う。
 * AUTH_PASSWORD 未設定時は誰も通さない。
 */
export async function verifyAuthPassword(env: Env, password: string): Promise<boolean> {
  if (!env.AUTH_PASSWORD) {
    return false;
  }
  return passwordsEqual(password, env.AUTH_PASSWORD);
}
