import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { childName } from "./config.ts";
import { dayDocument, recordDocument, searchDocuments } from "./docs.ts";
import { addDays, daysBetween, resolveDate } from "./date.ts";
import { FeedError, loadFeed, loadRange } from "./piyolog.ts";
import { queryRecords } from "./records.ts";
import { buildLatest, buildSummary, previousRange } from "./summary.ts";
import { todayInZone } from "./time.ts";
import type { FeedSnapshot } from "./types.ts";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const oauthSchemes = [{ type: "oauth2" as const, scopes: ["mcp:read"] }];
const toolMeta = { securitySchemes: oauthSchemes };

const emptyInput = z.object({});
const rangeInput = z.object({
  from: z.string().optional().describe("First JST date, YYYY-MM-DD. Empty means the same as to."),
  to: z.string().optional().describe("Last JST date, inclusive. Empty means today."),
  types: z
    .array(z.string())
    .optional()
    .describe("Categories (feeding, sleep, diaper, measurement) or exact types such as Formula, Poop, Weight, Medicine. Empty means all."),
  offset: z.number().int().min(0).optional().describe("Pass nextOffset from the previous page."),
  limit: z.number().int().min(1).max(1000).optional().describe("Page size. Default 500."),
});
const summaryInput = z.object({
  from: z.string().optional().describe("First JST date, YYYY-MM-DD. Empty means 6 days before to."),
  to: z.string().optional().describe("Last JST date, inclusive. Empty means today."),
  groupBy: z.enum(["day", "week"]).optional().describe("day (default, up to 92 days) or week (7-day blocks from the first date, up to 366 days)."),
  compare: z.boolean().optional().describe("Also return the previous period of the same length and the change."),
});
const searchInput = z.object({
  query: z.string().describe("A word in a memo, a record label or type, or a JST date YYYY-MM-DD."),
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
const feedOutput = z.object({
  stale: z.boolean(),
  generatedAt: z.string(),
  reason: z.enum(["request_failed", "empty_feed"]).optional(),
});
// Amounts and memos come from the feed unvalidated, so only the fields set here are typed.
const recordItem = z.looseObject({
  eventId: z.string(),
  datetime: z.string(),
  date: z.string(),
  time: z.string(),
  type: z.string(),
  label: z.string(),
  kind: z.string(),
});
const recordListOutput = z.object({
  feed: feedOutput,
  data: z.object({
    timezone: z.string(),
    from: z.string(),
    to: z.string(),
    typeCounts: z.record(z.string(), z.number()),
    total: z.number(),
    skippedCount: z.number(),
    nextOffset: z.number().nullable(),
    records: z.array(recordItem),
  }),
});
const daySummary = z.looseObject({ date: z.string(), partial: z.boolean(), sleepMinutes: z.number().nullable() });
const periodSummary = z.object({
  from: z.string(),
  to: z.string(),
  dayCount: z.number(),
  averagedDays: z.number(),
  averages: z.record(z.string(), z.number().nullable()),
});
const summaryOutput = z.object({
  feed: feedOutput,
  data: z.object({
    timezone: z.string(),
    overall: periodSummary,
    days: z.array(daySummary).optional(),
    weeks: z.array(periodSummary).optional(),
    previous: periodSummary.optional(),
    change: z.record(z.string(), z.number().nullable()).optional(),
    measurements: z.array(z.looseObject({ eventId: z.string(), date: z.string(), type: z.string() })),
    notes: z.array(z.string()),
  }),
});
const latestOutput = z.object({
  feed: feedOutput,
  data: z.object({
    timezone: z.string(),
    now: z.string(),
    today: z.string(),
    sleepingSince: z.string().nullable(),
    latest: z.record(z.string(), recordItem.extend({ minutesAgo: z.number() }).nullable()),
    todaySummary: daySummary.nullable(),
  }),
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
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function staleNotice(snapshot: FeedSnapshot): string | null {
  if (!snapshot.staleReason) {
    return null;
  }
  const cause = snapshot.staleReason === "empty_feed" ? "ぴよログのフィードが空だった" : "ぴよログの取得に失敗した";
  return `注意: ${cause}ため、${snapshot.generated_at} 時点の保存済み記録です。最新ではない可能性があります。`;
}

function recordsResult(snapshot: FeedSnapshot, data: unknown) {
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
    content: [notice, JSON.stringify(result)]
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
  /** Every tool goes through this, so none can return records without a token. */
  const guarded =
    <A, R>(run: (args: A) => Promise<R>) =>
    async (args: A) => {
      if (!familyAuthed(ctx)) {
        return authRequired(origin);
      }
      try {
        return await run(args);
      } catch (error) {
        return errorResult(error);
      }
    };
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      {
        name: "piyo-mcp",
        version: "2.0.0",
        description: `${child}のぴよログ読み取り。授乳・睡眠・おむつの記録を取得、集計する。`,
      },
      {
        instructions:
          `${child}のぴよログ読み取り専用。今の状態は get_latest_status。個々の記録は get_records。合計・平均・傾向・比較は get_summary。メモや特定の記録を探すときは search のあと fetch。日付は日本時間。28日より前の記録も残してある。feed.stale が true なら最新ではない可能性を伝える。母乳mlは記録があるときだけ使い、授乳時間から推定しない。呼び出し前にOAuthが必要。`,
      },
    );

    server.registerTool(
      "get_latest_status",
      {
        title: "最新ステータス",
        description:
          `Use this for ${child}'s current state: the latest record of each kind with minutesAgo, whether ${child} is asleep, and today's totals so far. For a list of records use get_records. No arguments.`,
        inputSchema: emptyInput,
        outputSchema: latestOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      guarded(async () => {
        const snapshot = await loadFeed(env);
        return recordsResult(snapshot, buildLatest(snapshot.records));
      }),
    );

    server.registerTool(
      "get_records",
      {
        title: "期間の記録",
        description:
          `Use this for ${child}'s individual records on a date or over a range, optionally by category or type. No arguments means today. For totals, averages, trends or comparisons use get_summary. If nextOffset is not null, call again with it.`,
        inputSchema: rangeInput,
        outputSchema: recordListOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      guarded(async ({ from, to, types, offset, limit }) => {
        const end = resolveDate(to, todayInZone());
        const start = resolveDate(from, end);
        if (start > end) {
          throw new Error("from は to 以前の日付にしてください");
        }
        const snapshot = await loadRange(env, start, end);
        return recordsResult(snapshot, queryRecords(snapshot.records, { from: start, to: end, types, offset, limit }));
      }),
    );

    server.registerTool(
      "get_summary",
      {
        title: "集計と比較",
        description:
          `Use this for ${child}'s totals, averages, trends and comparisons: feeding, feeding intervals, sleep, diapers, and measurements such as weight. Defaults to the last 7 days. For individual records use get_records.`,
        inputSchema: summaryInput,
        outputSchema: summaryOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      guarded(async ({ from, to, groupBy = "day", compare = false }) => {
        const end = resolveDate(to, todayInZone());
        const start = resolveDate(from, addDays(end, -6));
        if (start > end) {
          throw new Error("from は to 以前の日付にしてください");
        }
        const maxDays = groupBy === "week" ? 366 : 92;
        if (daysBetween(start, end) > maxDays) {
          throw new Error(`groupBy が ${groupBy} のときは ${maxDays} 日以内で指定してください`);
        }
        const snapshot = await loadRange(env, compare ? previousRange(start, end).from : start, end);
        return recordsResult(snapshot, buildSummary(snapshot.records, { from: start, to: end, groupBy, compare }));
      }),
    );

    server.registerTool(
      "search",
      {
        title: "記録を検索",
        description: `Search ${child}'s records by memo text, label, type or date, newest first. Returns up to 20 ids for fetch, and nothing when there is no match. To list records in a range use get_records.`,
        inputSchema: searchInput,
        outputSchema: searchOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      guarded(async ({ query }) => {
        const snapshot = await loadFeed(env);
        return jsonResult({ results: searchDocuments(snapshot, origin, query) });
      }),
    );

    server.registerTool(
      "fetch",
      {
        title: "記録を取得",
        description: "Fetch one search result by id: record:<eventId> for a record, or day:YYYY-MM-DD for a day.",
        inputSchema: fetchInput,
        outputSchema: fetchOutput,
        annotations: readOnly,
        _meta: toolMeta,
      },
      guarded(async ({ id }) => {
        const date = /^day:(.+)$/.exec(id)?.[1];
        const day = date ? resolveDate(date, todayInZone()) : null;
        const snapshot = day ? await loadRange(env, day, day) : await loadFeed(env);
        const document = day ? dayDocument(snapshot, origin, day) : recordDocument(snapshot, origin, id);
        if (!document) {
          return { content: [{ type: "text" as const, text: `id ${id} は見つかりませんでした` }], isError: true };
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
      }),
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
