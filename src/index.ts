import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { app } from "./app.ts";
import { authTtlSeconds } from "./config.ts";
import { toolsCheckPage } from "./html.ts";
import { handleMcp } from "./mcp.ts";
import { syncArchive } from "./piyolog.ts";
import { MCP_CORS_ALLOW_HEADERS, MCP_OAUTH_SCHEMES, MCP_SCOPE } from "./protocol.ts";
import { scanAsChatgpt } from "./selfcheck.ts";

const DISCOVERY_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "skills/list",
  "skills/get",
]);

/**
 * OAuth 2.1 プロバイダーを組み立てる。
 * /mcp はアクセストークン必須の API として保護し、それ以外 (/authorize など) は Hono アプリに渡す。
 * トークン発行・動的クライアント登録 (DCR)・メタデータ公開はライブラリが処理する。
 */
function oauthProvider(env: Env) {
  const ttl = authTtlSeconds(env);
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (request, env, ctx) => handleMcp(request, env, ctx),
    },
    defaultHandler: {
      fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    accessTokenTTL: ttl,
    refreshTokenTTL: ttl,
    clientRegistrationTTL: ttl,
    scopesSupported: [MCP_SCOPE],
    // DCR を使わず、URL 形式の client_id (Client ID Metadata Document) で来るクライアントも受け付ける。
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "ぴよログ MCP",
    },
  });
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", request.headers.get("Origin") ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", MCP_CORS_ALLOW_HEADERS);
  headers.set("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return headers;
}

async function mcpMethod(request: Request): Promise<string | null> {
  if (request.method !== "POST") {
    return null;
  }
  try {
    const body = (await request.clone().json()) as { method?: unknown };
    return typeof body.method === "string" ? body.method : null;
  } catch {
    return null;
  }
}

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

function withMcpAccept(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("Accept", "application/json, text/event-stream");
  return new Request(request, { headers });
}

async function asJsonIfNeeded(original: Request, response: Response): Promise<Response> {
  const accept = original.headers.get("Accept") ?? "";
  const contentType = response.headers.get("Content-Type") ?? "";
  if (accept.includes("text/event-stream") || !contentType.includes("text/event-stream")) {
    return response;
  }
  const body = await response.text();
  const payloads = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const json =
    payloads.at(-1) ??
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "empty MCP stream" }, id: null });
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Transfer-Encoding");
  return new Response(json, { status: response.status, headers });
}

async function annotateToolSecurity(response: Response): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return response;
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!body || typeof body !== "object") {
    return response;
  }
  const result = (body as { result?: { tools?: unknown } }).result;
  const tools = result && typeof result === "object" ? (result as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) {
    return response;
  }
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const record = tool as Record<string, unknown>;
    record.securitySchemes = MCP_OAUTH_SCHEMES;
    const meta =
      record._meta && typeof record._meta === "object" && !Array.isArray(record._meta)
        ? { ...(record._meta as Record<string, unknown>) }
        : {};
    meta.securitySchemes = MCP_OAUTH_SCHEMES;
    record._meta = meta;
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

function isJsonOnlyAccept(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/event-stream");
}

/**
 * /mcp の入口。通常は OAuthProvider 経由でトークンを検証してから MCP ハンドラーへ渡す。
 * 例外として、未認証の ChatGPT スキャンによる探索系メソッド (DISCOVERY_METHODS) だけは
 * 認証なしで直接応答する。tools/call などのデータ取得は必ず認証を通る。
 */
async function serveMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const accepted = withMcpAccept(request);
  const authorized = Boolean(request.headers.get("Authorization"));
  // ChatGPT's Actions scan uses Accept: application/json only and must see tools/list.
  // Claude connectors require HTTP 401 + WWW-Authenticate; they send both JSON and SSE.
  const chatgptScan = !authorized && request.method === "POST" && isJsonOnlyAccept(request);
  const method = chatgptScan ? await mcpMethod(accepted) : null;
  const response =
    chatgptScan && method !== null && DISCOVERY_METHODS.has(method)
      ? await handleMcp(accepted, env, ctx)
      : await oauthProvider(env).fetch(accepted, env, ctx);
  return withCors(request, await annotateToolSecurity(await asJsonIfNeeded(request, response)));
}

// トークンレスポンスの token_type を "Bearer" 表記に揃える。
// (大文字小文字を区別して比較するクライアントでも確実に通るようにするため)
async function withBearerTokenType(response: Response): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (response.status !== 200 || !contentType.includes("application/json")) {
    return response;
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response;
  }
  const token = body as { token_type?: unknown };
  if (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") {
    return response;
  }
  token.token_type = "Bearer";
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/chatgpt-tools.json") {
      return Response.json(await scanAsChatgpt(url.origin, (check) => serveMcp(check, env, ctx)), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/chatgpt-tools") {
      return toolsCheckPage(await scanAsChatgpt(url.origin, (check) => serveMcp(check, env, ctx)));
    }

    if (url.pathname === "/mcp" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/mcp") {
      return serveMcp(request, env, ctx);
    }

    const response = await oauthProvider(env).fetch(request, env, ctx);
    if (url.pathname === "/oauth/token") {
      return withBearerTokenType(response);
    }
    return response;
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await syncArchive(env);
  },
};
