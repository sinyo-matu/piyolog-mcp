import type { FeedSnapshot, PiyoRecord } from "./types";

const CACHE_KEY = "cache:piyolog-feed";
const CACHE_TTL_SECONDS = 900;

export class FeedError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FeedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSnapshot(data: unknown): FeedSnapshot {
  if (!isRecord(data)) {
    throw new FeedError("Unexpected feed payload", 502);
  }
  if (data.schema_version !== 1) {
    throw new FeedError(`Unsupported schema_version: ${String(data.schema_version)}`, 502);
  }
  if (!Array.isArray(data.records) || !isRecord(data.range)) {
    throw new FeedError("Feed JSON is missing records or range", 502);
  }
  return {
    schema_version: 1,
    generated_at: String(data.generated_at),
    range: {
      from: String(data.range.from),
      to: String(data.range.to),
    },
    records: data.records as PiyoRecord[],
  };
}

export async function loadFeed(env: Env): Promise<FeedSnapshot> {
  const cached = await env.OAUTH_KV.get(CACHE_KEY);
  if (cached) {
    return parseSnapshot(JSON.parse(cached));
  }

  const response = await fetch(env.PIYOLOG_FEED_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "piyo-mcp/1.0",
    },
  });

  if (!response.ok) {
    let code: string | undefined;
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") {
        code = body.error.code;
      }
    } catch {
      // Keep the HTTP status as the signal when the body is not JSON.
    }
    throw new FeedError("PiyoLog feed request failed", response.status, code);
  }

  const snapshot = parseSnapshot(await response.json());
  await env.OAUTH_KV.put(CACHE_KEY, JSON.stringify(snapshot), { expirationTtl: CACHE_TTL_SECONDS });
  return snapshot;
}
