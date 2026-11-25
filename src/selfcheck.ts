import type { ChatgptScanReport, ChatgptToolAd } from "./html.ts";

/** /mcp の入口。index.ts から渡す。 */
type SendMcp = (request: Request) => Promise<Response>;

const EXPECTED_TOOLS = [
  "get_latest_status",
  "get_records",
  "get_summary",
  "search",
  "fetch",
];

async function mcpRpc(
  origin: string,
  send: SendMcp,
  payload: Record<string, unknown>,
): Promise<{ httpStatus: number; body: unknown }> {
  const response = await send(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // A Request built here has no Host, and the MCP handler rejects that.
        Host: new URL(origin).host,
      },
      body: JSON.stringify(payload),
    }),
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

/** ChatGPT のツール一覧スキャンと同じ呼び方で /mcp を調べる。 */
export async function scanAsChatgpt(origin: string, send: SendMcp): Promise<ChatgptScanReport> {
  const init = await mcpRpc(origin, send, {
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
  const tools = await mcpRpc(origin, send, {
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
  const call = await mcpRpc(origin, send, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_records", arguments: {} },
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
