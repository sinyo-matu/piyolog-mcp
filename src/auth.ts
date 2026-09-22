import { passwordsEqual } from "./crypto";

export async function verifyAuthPassword(env: Env, password: string): Promise<boolean> {
  if (!env.AUTH_PASSWORD) {
    return false;
  }
  return passwordsEqual(password, env.AUTH_PASSWORD);
}
