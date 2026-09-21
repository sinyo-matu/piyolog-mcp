import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { verifyFamilyPassword } from "./auth";
import { childName } from "./config";
import { cookieFlags, cookieName, readCookie, signaturesEqual, signValue } from "./crypto";
import { authorizePage, authorizeRedirectPage, homePage } from "./html";

type AppEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const OAUTH_STATE_COOKIE = "OAUTH_REQ";
const OAUTH_REQ_TTL_SECONDS = 600;

type StoredOAuthRequest = { iat: number; request: AuthRequest };

function encodeBytes(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBytes(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function signOAuthRequest(env: Env, oauthRequest: AuthRequest): Promise<string> {
  const payload = encodeBytes(
    JSON.stringify({ iat: Math.floor(Date.now() / 1000), request: oauthRequest } satisfies StoredOAuthRequest),
  );
  const signature = await signValue(payload, env.COOKIE_ENCRYPTION_KEY);
  return `${payload}.${signature}`;
}

async function readSignedOAuthRequest(env: Env, value: string | null | undefined): Promise<AuthRequest | null> {
  if (!value) {
    return null;
  }
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

function clientName(client: { clientName?: string } | null | undefined, clientId: string): string {
  return client?.clientName?.trim() || clientId;
}

export const app = new Hono<{ Bindings: AppEnv }>();

app.get("/", (c) => homePage(new URL(c.req.url).origin, childName(c.env)));
app.get("/login", (c) => c.redirect("/", 302));
app.get("/api/dashboard", (c) => c.body(null, 410));

app.get("/authorize", async (c) => {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch {
    return c.text("無効な認可リクエストです。", 400);
  }
  if (!oauthRequest.clientId) {
    return c.text("無効な認可リクエストです。", 400);
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  const oauthReq = await signOAuthRequest(c.env, oauthRequest);
  const response = authorizePage({
    oauthReq,
    clientName: clientName(client, oauthRequest.clientId),
    redirectUri: oauthRequest.redirectUri,
  });
  response.headers.append("Set-Cookie", await signedOAuthCookie(c.req.raw, c.env, oauthReq));
  return response;
});

app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const formOAuthReq = form.get("oauth_req");
  const oauthReqValue =
    (typeof formOAuthReq === "string" && formOAuthReq) ||
    readCookie(c.req.raw, cookieName(c.req.raw, OAUTH_STATE_COOKIE)) ||
    "";
  const oauthRequest = await readSignedOAuthRequest(c.env, oauthReqValue);

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
  if (!(await verifyFamilyPassword(c.env, password))) {
    return fail("パスワードが違います。");
  }

  const scope = oauthRequest.scope.length > 0 ? oauthRequest.scope : ["mcp:read"];
  let redirectTo: string;
  try {
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

  const response = authorizeRedirectPage(redirectTo);
  response.headers.append("Set-Cookie", clearOAuthCookie(c.req.raw));
  return response;
});
