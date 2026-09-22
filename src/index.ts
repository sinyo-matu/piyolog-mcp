import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { app } from "./app";
import { verifyAuthPassword } from "./auth";
import { authTtlSeconds } from "./config";
import { toolsCheckPage, type ChatgptScanReport, type ChatgptToolAd } from "./html";
import { handleMcp } from "./mcp";

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

const OAUTH_SCHEMES = [{ type: "oauth2", scopes: ["mcp:read"] }];
const EXPECTED_TOOLS = [
  "get_today_records",
  "get_latest_status",
  "get_feeding_records",
  "get_all_records",
  "search",
  "fetch",
];

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
    scopesSupported: ["mcp:read"],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      scopes_supported: ["mcp:read"],
      bearer_methods_supported: ["header"],
      resource_name: "ぴよログ MCP",
    },
    resolveExternalToken: async ({ token, env }) => {
      if (!(await verifyAuthPassword(env, token))) {
        return null;
      }
      return { props: { family: true } };
    },
  });
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", request.headers.get("Origin") ?? "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, Last-Event-ID",
  );
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
    record.securitySchemes = OAUTH_SCHEMES;
    const meta =
      record._meta && typeof record._meta === "object" && !Array.isArray(record._meta)
        ? { ...(record._meta as Record<string, unknown>) }
        : {};
    meta.securitySchemes = OAUTH_SCHEMES;
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

async function mcpRpc(
  origin: string,
  env: Env,
  ctx: ExecutionContext,
  payload: Record<string, unknown>,
): Promise<{ httpStatus: number; body: unknown }> {
  const response = await serveMcp(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    }),
    env,
    ctx,
  );
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = { error: "non-json MCP response" };
  }
  return { httpStatus: response.status, body };
}

function rpcResult(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || !("result" in body)) {
    return null;
  }
  const result = (body as { result?: unknown }).result;
  return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
}

function rpcError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return "invalid response";
  }
  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : undefined;
}

async function scanAsChatgpt(request: Request, env: Env, ctx: ExecutionContext): Promise<ChatgptScanReport> {
  const origin = new URL(request.url).origin;
  const init = await mcpRpc(origin, env, ctx, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "chatgpt-scan", version: "1.0" },
    },
  });
  const initResult = rpcResult(init.body);
  const serverInfo = initResult?.serverInfo as { name?: string; version?: string } | undefined;
  const tools = await mcpRpc(origin, env, ctx, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const listed = rpcResult(tools.body)?.tools;
  const toolAds: ChatgptToolAd[] = Array.isArray(listed)
    ? listed.flatMap((item) => {
        if (!item || typeof item !== "object" || typeof (item as { name?: unknown }).name !== "string") {
          return [];
        }
        const tool = item as { name: string; title?: unknown; description?: unknown; securitySchemes?: unknown };
        return [
          {
            name: tool.name,
            title: typeof tool.title === "string" ? tool.title : undefined,
            description: typeof tool.description === "string" ? tool.description : undefined,
            securitySchemes: tool.securitySchemes,
          },
        ];
      })
    : [];
  const call = await mcpRpc(origin, env, ctx, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_today_records", arguments: {} },
  });
  const callResult = rpcResult(call.body);
  const callText = JSON.stringify(call.body);
  const leakedRecords = /"records"\s*:/.test(callText) || /event_id/.test(callText);
  return {
    checkedAt: new Date().toISOString(),
    endpoint: `${origin}/mcp`,
    expected: EXPECTED_TOOLS,
    initialize: {
      httpStatus: init.httpStatus,
      ok: init.httpStatus === 200 && Boolean(initResult),
      serverName: serverInfo?.name,
      version: serverInfo?.version,
      error: rpcError(init.body),
    },
    toolsList: {
      httpStatus: tools.httpStatus,
      ok: tools.httpStatus === 200 && toolAds.length > 0,
      names: toolAds.map((tool) => tool.name),
      tools: toolAds,
      error: rpcError(tools.body),
    },
    unauthCall: {
      httpStatus: call.httpStatus,
      ok:
        !leakedRecords &&
        (call.httpStatus === 401 || (call.httpStatus === 200 && callResult?.isError === true)),
      isError: call.httpStatus === 401 || callResult?.isError === true,
      leakedRecords,
      error: rpcError(call.body),
    },
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/chatgpt-tools.json") {
      return Response.json(await scanAsChatgpt(request, env, ctx), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/chatgpt-tools") {
      return toolsCheckPage(await scanAsChatgpt(request, env, ctx));
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
};
