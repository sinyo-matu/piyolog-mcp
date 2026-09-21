import { passwordsEqual } from "./crypto";

export async function verifyFamilyPassword(env: Env, password: string): Promise<boolean> {
  if (!env.FAMILY_PASSWORD) {
    return false;
  }
  return passwordsEqual(password, env.FAMILY_PASSWORD);
}
