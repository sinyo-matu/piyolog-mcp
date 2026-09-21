const encoder = new TextEncoder();

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function passwordsEqual(provided: string, expected: string): Promise<boolean> {
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  const length = Math.max(a.byteLength, b.byteLength, 32);
  const left = new Uint8Array(length);
  const right = new Uint8Array(length);
  left.set(a);
  right.set(b);
  const sameBytes = crypto.subtle.timingSafeEqual(left, right);
  return sameBytes && a.byteLength === b.byteLength;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signValue(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toHex(signature);
}

export async function signaturesEqual(left: string, right: string): Promise<boolean> {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

export function cookieFlags(request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  return secure ? "HttpOnly; Secure; Path=/; SameSite=Lax" : "HttpOnly; Path=/; SameSite=Lax";
}

export function cookieName(request: Request, base: string): string {
  return new URL(request.url).protocol === "https:" ? `__Host-${base}` : base;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}
