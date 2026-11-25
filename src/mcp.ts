import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { childName } from "./config";
import { fetchDocument, searchDocuments } from "./docs";
import { analysisBundle, buildDashboard, formatLatestText, getDay, todayInZone } from "./feeding";
import { resolveDate } from "./date";
import { FeedError, loadFeed, loadRange } from "./piyolog";
import { queryRecords } from "./records";
import type { FeedSnapshot } from "./types";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const oauthSchemes = [{ type: "oauth2" as const, scopes: ["mcp:read"] }];
const toolMeta = { securitySchemes: oauthSchemes };

const emptyInput = z.object({});
const dateInput = z.object({
  date: z.string().optional().describe("JST date YYYY-MM-DD. Empty means today."),
});
const rangeInput = z.object({
  from: z.string().describe("First JST date, YYYY-MM-DD."),
  to: z.string().optional().describe("Last JST date, inclusive. Empty means today."),
  types: z
    .array(z.string())
    .optional()
    .describe("Record types to keep, e.g. BreastFeeding, Formula, Sleep, WakeUp, Pee, Poop, Weight, Temperature. Empty means all."),
  offset: z.number().int().min(0).optional().describe("Pass nextOffset from the previous page."),
  limit: z.number().int().min(1).max(1000).optional().describe("Page size. Default 500."),
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
  feed: z.object({
    stale: z.boolean(),
    generatedAt: z.string(),
    reason: z.enum(["request_failed", "empty_feed"]).optional(),
  }),
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

function staleNotice(snapshot: FeedSnapshot): string | null {
  if (!snapshot.staleReason) {
    return null;
  }
  const cause = snapshot.staleReason === "empty_feed" ? "ぴよログのフィードが空だった" : "ぴよログの取得に失敗した";
  return `注意: ${cause}ため、${snapshot.generated_at} 時点の保存済み記録です。最新ではない可能性があります。`;
}

function recordsResult(snapshot: FeedSnapshot, data: unknown, text?: string) {
  const notice = staleNotice(snapshot);
  const result = {
    feed: {
      stale: snapshot.staleReason !== undefined,
      generatedAt: snapshot.generated_at,
      ...(snapshot.staleReason ? { reason: snapshot.staleReason } : {}),
    },
    data,
  };
  return {
    structuredContent: result,
    content: [notice, text, JSON.stringify(result, null, 2)]
      .filter((item): item is string => typeof item === "string")
      .map((item) => ({ type: "text" as const, text: item })),
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
          `${child}のぴよログ読み取り専用。フィードは直近28日だが、それより前の記録はこちらに残してある。期間や種別を絞る分析は get_records、全件が必要なときだけ get_all_records。今日は get_today_records。最新は get_latest_status。日付指定の食事は get_feeding_records。search/fetch は記録の検索用。feed.stale が true なら最新ではない可能性を伝える。母乳mlは記録があるときだけ使い、授乳時間から推定しない。呼び出し前にOAuthが必要。`,
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
          const today = todayInZone();
          const snapshot = await loadRange(env, today, today);
          return recordsResult(snapshot, analysisBundle(snapshot, { date: today }));
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
          return recordsResult(
            snapshot,
            analysisBundle(snapshot, { date: dashboard.today }),
            formatLatestText(snapshot, dashboard, child),
          );
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
          const target = resolveDate(date, todayInZone());
          const snapshot = await loadRange(env, target, target);
          return recordsResult(snapshot, getDay(buildDashboard(snapshot), target));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      "get_records",
      {
        title: "期間の記録",
        description:
          `Use this for ${child}'s records over a date range, optionally by type. Prefer it over get_all_records. If nextOffset is not null, call again with it.`,
        inputSchema: rangeInput,
        outputSchema: recordsOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      async ({ from, to, types, offset, limit }) => {
        if (!familyAuthed(ctx)) {
          return authRequired(origin);
        }
        try {
          const today = todayInZone();
          if (!from.trim()) {
            throw new Error("from を YYYY-MM-DD で指定してください");
          }
          const start = resolveDate(from, today);
          const end = resolveDate(to, today);
          if (start > end) {
            throw new Error("from は to 以前の日付にしてください");
          }
          const snapshot = await loadRange(env, start, end);
          return recordsResult(snapshot, queryRecords(snapshot.records, { from: start, to: end, types, offset, limit }));
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
          return recordsResult(snapshot, analysisBundle(snapshot));
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
          const notice = staleNotice(snapshot);
          if (notice) {
            return jsonResult({
              ...document,
              text: `${notice}\n\n${document.text}`,
              metadata: { ...document.metadata, stale: "true" },
            });
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
