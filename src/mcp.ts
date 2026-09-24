import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { childName } from "./config";
import { fetchDocument, searchDocuments } from "./docs";
import { analysisBundle, buildDashboard, formatLatestText, getDay } from "./feeding";
import { FeedError, loadFeed } from "./piyolog";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const oauthSchemes = [{ type: "oauth2" as const, scopes: ["mcp:read"] }];
const toolMeta = { securitySchemes: oauthSchemes };

const emptyInput = z.object({});
const dateInput = z.object({
  date: z.string().optional().describe("JST date YYYY-MM-DD. Empty means today."),
});
const searchInput = z.object({
  query: z.string().describe("search query"),
});
const fetchInput = z.object({
  id: z.string().describe("document id from search"),
});
const searchOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string(),
    }),
  ),
});
const fetchOutput = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});
const recordsOutput = z.object({
  data: z.unknown(),
});

function familyAuthed(ctx: ExecutionContext): boolean {
  const mcp = getMcpAuthContext();
  if (mcp?.props && (mcp.props as { family?: boolean }).family === true) {
    return true;
  }
  return (ctx as ExecutionContext & { props?: { family?: boolean } }).props?.family === true;
}

function jsonResult<T>(data: T): {
  structuredContent: T;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    structuredContent: data,
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message =
    error instanceof FeedError
      ? `ぴよログの取得に失敗しました (${error.status}${error.code ? ` ${error.code}` : ""})`
      : error instanceof Error
        ? error.message
        : "unknown error";
  return { content: [{ type: "text", text: message }], isError: true };
}

function authRequired(origin: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: "Authentication required: no access token provided." }],
    _meta: {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="You need to login to continue"`,
      ],
    },
  };
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = new URL(request.url).origin;
  const child = childName(env);
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      {
        name: "piyo-mcp",
        version: "1.2.0",
        description: `${child}のぴよログ読み取り。授乳・睡眠・おむつの記録を ChatGPT が直接分析する。`,
      },
      {
        instructions:
          `${child}のぴよログ読み取り専用。フィードは直近28日だが、それより前の記録はこちらに残してある。分析は get_all_records。今日は get_today_records。最新は get_latest_status。日付指定の食事は get_feeding_records。search/fetch は記録の検索用。母乳mlは記録があるときだけ使い、授乳時間から推定しない。呼び出し前にOAuthが必要。`,
      },
    );

    server.registerTool(
      "get_today_records",
      {
        title: "今日の全記録",
        description:
          `Use this when the user wants ${child}'s records for today in JST. Returns feeding, sleep, diaper, weight, and bath JSON. No arguments.`,
        inputSchema: emptyInput,
        outputSchema: recordsOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      async () => {
        if (!familyAuthed(ctx)) {
          return authRequired(origin);
        }
        try {
          const snapshot = await loadFeed(env);
          const dashboard = buildDashboard(snapshot);
          return jsonResult({ data: analysisBundle(snapshot, { date: dashboard.today }) });
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      "get_latest_status",
      {
        title: "最新ステータス",
        description:
          `Use this for ${child}'s latest status: last feeding, today's formula ml, breast time, sleep, diaper, and weight. No arguments.`,
        inputSchema: emptyInput,
        outputSchema: recordsOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      async () => {
        if (!familyAuthed(ctx)) {
          return authRequired(origin);
        }
        try {
          const snapshot = await loadFeed(env);
          const dashboard = buildDashboard(snapshot);
          return {
            structuredContent: { data: analysisBundle(snapshot, { date: dashboard.today }) },
            content: [
              { type: "text" as const, text: formatLatestText(snapshot, dashboard, child) },
              { type: "text" as const, text: JSON.stringify(analysisBundle(snapshot, { date: dashboard.today })) },
            ],
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      "get_feeding_records",
      {
        title: "授乳・食事記録",
        description:
          `Use this for ${child}'s feeding records (breast, formula, expressed milk, solids). date is JST YYYY-MM-DD; omit for today.`,
        inputSchema: dateInput,
        outputSchema: recordsOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      async ({ date }) => {
        if (!familyAuthed(ctx)) {
          return authRequired(origin);
        }
        try {
          const snapshot = await loadFeed(env);
          const dashboard = buildDashboard(snapshot);
          const target = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : dashboard.today;
          return jsonResult({ data: getDay(dashboard, target) });
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      "get_all_records",
      {
        title: "全期間の記録",
        description:
          `Use this when ChatGPT should analyze ${child}'s stored history itself. Returns every saved record, including days older than the 28-day feed. No arguments.`,
        inputSchema: emptyInput,
        outputSchema: recordsOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      async () => {
        if (!familyAuthed(ctx)) {
          return authRequired(origin);
        }
        try {
          const snapshot = await loadFeed(env);
          return jsonResult({ data: analysisBundle(snapshot) });
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      "search",
      {
        title: "記録を検索",
        description: `Search ${child}'s records and return ids. Follow with fetch. Use query all for the full analysis document.`,
        inputSchema: searchInput,
        outputSchema: searchOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      async ({ query }) => {
        if (!familyAuthed(ctx)) {
          return authRequired(origin);
        }
        try {
          const snapshot = await loadFeed(env);
          return jsonResult({ results: searchDocuments(snapshot, origin, query, child) });
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      "fetch",
      {
        title: "記録を取得",
        description: "Fetch a search result by id. Use all for the full JSON, latest for today.",
        inputSchema: fetchInput,
        outputSchema: fetchOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      async ({ id }) => {
        if (!familyAuthed(ctx)) {
          return authRequired(origin);
        }
        try {
          const snapshot = await loadFeed(env);
          const document = fetchDocument(snapshot, origin, id, child);
          if (!document) {
            return { content: [{ type: "text", text: `id ${id} は見つかりませんでした` }], isError: true };
          }
          return jsonResult(document);
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    return server;
  }, {
    responseMode: "json",
    corsOptions: {
      origin: "*",
      headers: "Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, Last-Event-ID",
    },
    allowedOriginHostnames: "*",
  });

  return handler(request, env, ctx);
}
