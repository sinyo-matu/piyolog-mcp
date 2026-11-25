// Google の OpenID Connect で本人確認する。GOOGLE_ALLOWED_DOMAINS の Google Workspace 組織の
// アカウントだけを通す。

import { decodeBase64Url } from "./crypto.ts";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export const GOOGLE_CALLBACK_PATH = "/callback/google";

/**
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET があり、許可ドメインが 1 件以上あるときだけ有効。
 * 許可先が空のまま有効にすると、どの Google アカウントでも通ってしまうため。
 */
export function googleLoginEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && allowedDomains(env).size > 0);
}

// カンマ・空白区切り。大文字小文字は区別しない。
function allowedDomains(env: Env): Set<string> {
  return new Set(
    (env.GOOGLE_ALLOWED_DOMAINS ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function googleRedirectUri(request: Request): string {
  return `${new URL(request.url).origin}${GOOGLE_CALLBACK_PATH}`;
}

/** Google の認可画面の URL。prompt=select_account で毎回アカウントを選ばせる。 */
export function googleAuthUrl(env: Env, request: Request, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", googleRedirectUri(request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  // 組織が 1 つなら、Google のアカウント選択をその組織に絞る。表示上のヒントなので判定は hd クレームで行う。
  const [domain, ...others] = allowedDomains(env);
  if (domain && others.length === 0) {
    url.searchParams.set("hd", domain);
  }
  return url.toString();
}

type GoogleIdClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
};

function decodeJwtPayload(jwt: string): GoogleIdClaims | null {
  const part = jwt.split(".")[1];
  if (!part) {
    return null;
  }
  try {
    return JSON.parse(decodeBase64Url(part)) as GoogleIdClaims;
  } catch {
    return null;
  }
}

/**
 * 認可コードをトークンに交換し、許可された組織の確認済みメールアドレスを返す。
 * 組織の判定は hd クレーム (Workspace アカウントにだけ付く) で行う。メールアドレスのドメインは
 * 組織外の Google アカウントでも名乗れるので使わない。
 * ID トークンはトークンエンドポイントから TLS で直接受け取るので署名検証は省略できる
 * (OpenID Connect Core 3.1.3.7)。iss / aud / exp は確認する。
 * 拒否・失敗時は null。
 */
export async function verifyGoogleCode(env: Env, request: Request, code: string): Promise<string | null> {
  if (!googleLoginEnabled(env)) {
    return null;
  }
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: googleRedirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    return null;
  }
  const token = (await response.json().catch(() => null)) as { id_token?: unknown } | null;
  if (typeof token?.id_token !== "string") {
    return null;
  }
  const claims = decodeJwtPayload(token.id_token);
  if (!claims) {
    return null;
  }
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) {
    return null;
  }
  if (claims.aud !== env.GOOGLE_CLIENT_ID) {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (claims.email_verified !== true || typeof claims.email !== "string") {
    return null;
  }
  const email = claims.email.toLowerCase();
  const domain = typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
  return domain && allowedDomains(env).has(domain) ? email : null;
}
