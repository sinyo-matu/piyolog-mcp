const DEFAULT_CHILD_NAME = "Baby";

export function childName(env: Env): string {
  const value = env.CHILD_NAME?.trim();
  return value && value.length > 0 ? value : DEFAULT_CHILD_NAME;
}
