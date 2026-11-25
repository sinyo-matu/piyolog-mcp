const encoder = new TextEncoder();

/** タイミング攻撃を避けるため、定数時間でパスワードを比較する。 */
export async function passwordsEqual(provided: string, expected: string): Promise<boolean> {
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  // timingSafeEqual は同じ長さの配列しか比較できないため、ゼロ埋めで長さを揃える。
  // 最低 32 バイトにして、短いパスワードの長さが処理時間から漏れにくくする。
  const length = Math.max(a.byteLength, b.byteLength, 32);
  const left = new Uint8Array(length);
  const right = new Uint8Array(length);
  left.set(a);
  right.set(b);
  // ゼロ埋めで中身が一致しても長さが違えば不一致とする。
  const sameBytes = crypto.subtle.timingSafeEqual(left, right);
  return sameBytes && a.byteLength === b.byteLength;
}

/** UTF-8 文字列を base64url (パディングなし) に変換する。 */
export function encodeBase64Url(value: string): string {
  const bytes = encoder.encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** encodeBase64Url の逆変換。不正な入力では例外を投げる。 */
export function decodeBase64Url(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export function toHex(buffer: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 で value に署名し、16 進文字列で返す。 */
export async function signValue(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toHex(signature);
}

/** 署名を定数時間で比較する。署名は固定長なので、長さの違いは即座に不一致としてよい。 */
export async function signaturesEqual(left: string, right: string): Promise<boolean> {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * 認可用 Cookie の属性。HTTPS 時のみ Secure を付ける (ローカル開発の http でも動かすため)。
 * SameSite=Lax なので、認可フォームの同一サイト POST には Cookie が付く。
 */
export function cookieFlags(request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  return secure ? "HttpOnly; Secure; Path=/; SameSite=Lax" : "HttpOnly; Path=/; SameSite=Lax";
}

/**
 * HTTPS 時は `__Host-` 接頭辞を付け、サブドメインや http からの上書きを防ぐ。
 * `__Host-` は Secure 必須のため、http では素の名前を使う。
 */
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
