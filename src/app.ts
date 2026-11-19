import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { verifyAuthPassword } from "./auth";
import { childName } from "./config";
import { cookieFlags, cookieName, readCookie, signaturesEqual, signValue } from "./crypto";
import { authorizePage, authorizeRedirectPage, homePage } from "./html";

type AppEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

// GET /authorize で受け取った認可リクエストを、パスワード送信 (POST) まで
// サーバー側に状態を持たずに引き継ぐため、署名付きの値としてフォームと Cookie に載せる。
const OAUTH_STATE_COOKIE = "OAUTH_REQ";
// 認可画面を開いてからパスワードを送るまでの猶予 (10 分)。
const OAUTH_REQ_TTL_SECONDS = 600;

// iat は発行時刻 (UNIX 秒)。期限切れの判定に使う。
type StoredOAuthRequest = { iat: number; request: AuthRequest };

// UTF-8 文字列を base64url (パディングなし) に変換する。
function encodeBytes(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// encodeBytes の逆変換。不正な入力では例外を投げる。
function decodeBytes(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * 認可リクエストを `<base64url ペイロード>.<HMAC 署名>` 形式にする。
 * 署名により、クライアント側で redirect_uri などを書き換えられないようにする。
 */
async function signOAuthRequest(env: Env, oauthRequest: AuthRequest): Promise<string> {
  const payload = encodeBytes(
    JSON.stringify({ iat: Math.floor(Date.now() / 1000), request: oauthRequest } satisfies StoredOAuthRequest),
  );
  const signature = await signValue(payload, env.COOKIE_ENCRYPTION_KEY);
  return `${payload}.${signature}`;
}

/**
 * signOAuthRequest の値を検証して認可リクエストを取り出す。
 * 署名不一致・形式不正・必須項目の欠落・期限切れのいずれかなら null を返す。
 */
async function readSignedOAuthRequest(env: Env, value: string | null | undefined): Promise<AuthRequest | null> {
  if (!value) {
    return null;
  }
  // 署名は 16 進文字列で "." を含まないので、最後の "." で分割する。
  const lastDot = value.lastIndexOf(".");
  if (lastDot <= 0) {
    return null;
  }
  const payload = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  const expected = await signValue(payload, env.COOKIE_ENCRYPTION_KEY);
  if (!(await signaturesEqual(signature, expected))) {
    return null;
  }
  // 署名検証を通った後でのみ中身をデコードする。
  try {
    const stored = JSON.parse(decodeBytes(payload)) as StoredOAuthRequest;
    if (!stored?.request?.clientId || !stored.request.redirectUri) {
      return null;
    }
    if (!Number.isFinite(stored.iat) || Math.floor(Date.now() / 1000) - stored.iat > OAUTH_REQ_TTL_SECONDS) {
      return null;
    }
    return stored.request;
  } catch {
    return null;
  }
}

async function signedOAuthCookie(request: Request, env: Env, signed: string): Promise<string> {
  return `${cookieName(request, OAUTH_STATE_COOKIE)}=${encodeURIComponent(signed)}; ${cookieFlags(request)}; Max-Age=${OAUTH_REQ_TTL_SECONDS}`;
}

function clearOAuthCookie(request: Request): string {
  return `${cookieName(request, OAUTH_STATE_COOKIE)}=; ${cookieFlags(request)}; Max-Age=0`;
}

// 認可画面に表示するクライアント名。登録名がなければ client_id を出す。
function clientName(client: { clientName?: string } | null | undefined, clientId: string): string {
  return client?.clientName?.trim() || clientId;
}

export const app = new Hono<{ Bindings: AppEnv }>();

app.get("/", (c) => homePage(new URL(c.req.url).origin, childName(c.env)));
app.get("/login", (c) => c.redirect("/", 302));
app.get("/api/dashboard", (c) => c.body(null, 410));

// 認可エンドポイント (GET): リクエストを検証し、パスワード入力画面を返す。
app.get("/authorize", async (c) => {
  let oauthRequest: AuthRequest;
  try {
    // client_id や redirect_uri の登録内容との照合はライブラリ側で行われる。
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch {
    return c.text("無効な認可リクエストです。", 400);
  }
  if (!oauthRequest.clientId) {
    return c.text("無効な認可リクエストです。", 400);
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  // 署名済みリクエストはフォームの hidden 項目と Cookie の両方に入れる。
  // どちらか一方が失われても (例: Cookie がブロックされた場合) POST で復元できる。
  const oauthReq = await signOAuthRequest(c.env, oauthRequest);
  const response = authorizePage({
    oauthReq,
    clientName: clientName(client, oauthRequest.clientId),
    redirectUri: oauthRequest.redirectUri,
  });
  response.headers.append("Set-Cookie", await signedOAuthCookie(c.req.raw, c.env, oauthReq));
  return response;
});

// 認可エンドポイント (POST): パスワードを確認し、認可コード付きでクライアントへ戻す。
app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  // フォームの値を優先し、なければ Cookie から取り出す。
  const formOAuthReq = form.get("oauth_req");
  const oauthReqValue =
    (typeof formOAuthReq === "string" && formOAuthReq) ||
    readCookie(c.req.raw, cookieName(c.req.raw, OAUTH_STATE_COOKIE)) ||
    "";
  const oauthRequest = await readSignedOAuthRequest(c.env, oauthReqValue);

  // エラー表示付きで認可画面を出し直す。同じ署名済みリクエストを引き継ぐので再入力できる
  // (iat は更新しないため、最初の GET から 10 分経てば期限切れになる)。
  const fail = async (message: string) => {
    const response = authorizePage({
      oauthReq: oauthReqValue,
      clientName: "Claude",
      redirectUri: oauthRequest?.redirectUri,
      error: message,
    });
    if (oauthReqValue) {
      response.headers.append("Set-Cookie", await signedOAuthCookie(c.req.raw, c.env, oauthReqValue));
    }
    return response;
  };

  if (!oauthRequest) {
    return fail("認可セッションが切れました。Claude Desktop の連携ボタンからやり直してください。");
  }
  const password = String(form.get("password") ?? "");
  if (!(await verifyAuthPassword(c.env, password))) {
    return fail("パスワードが違います。");
  }

  // スコープ指定がなければ読み取り専用の mcp:read を付与する。
  const scope = oauthRequest.scope.length > 0 ? oauthRequest.scope : ["mcp:read"];
  let redirectTo: string;
  try {
    // 利用者は家族ひとまとめの単一ユーザー扱い。props は MCP ハンドラー側に渡る。
    ({ redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: "family",
      metadata: { label: "family" },
      scope,
      props: { family: true },
    }));
  } catch {
    return fail("認可に失敗しました。Claude Desktop からやり直してください。");
  }

  // 認可が済んだら一時 Cookie は消して、同じリクエストを再利用できないようにする。
  const response = authorizeRedirectPage(redirectTo);
  response.headers.append("Set-Cookie", clearOAuthCookie(c.req.raw));
  return response;
});
