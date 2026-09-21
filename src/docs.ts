import {
  analysisBundle,
  buildDashboard,
  filterFeeding,
  formatAnalysisText,
  formatDailyStatsText,
  formatDayOverviewText,
  formatDayText,
  formatLatestText,
  formatMemosText,
  formatRecentText,
  formatWeightText,
  getDay,
} from "./feeding";
import { FEEDING_TYPES, TYPE_LABELS, type FeedSnapshot } from "./types";

export type SearchResult = {
  id: string;
  title: string;
  url: string;
};

export type FetchDocument = {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, string>;
};

function docUrl(origin: string, id: string): string {
  return `${origin}/#${encodeURIComponent(id)}`;
}

function result(origin: string, id: string, title: string): SearchResult {
  return { id, title, url: docUrl(origin, id) };
}

function uniqueResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const item of results) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function catalog(origin: string, today: string, child: string): SearchResult[] {
  return [
    result(origin, "all", `${child}の全記録JSON（分析用・期間内すべて）`),
    result(origin, "latest", `${child}の最新記録（${today}）`),
    result(origin, `records:${today}`, `${today} の全記録JSON`),
    result(origin, `overview:${today}`, `${today} の一日（授乳・睡眠・おむつ含む）`),
    result(origin, `day:${today}`, `${today} の食事`),
    result(origin, "recent", "直近の食事・授乳"),
    result(origin, "stats", "日ごとの食事集計"),
    result(origin, "weight", "体重推移"),
    result(origin, "memos", "メモ一覧"),
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchDocuments(snapshot: FeedSnapshot, origin: string, query: string, child = "Baby"): SearchResult[] {
  const dashboard = buildDashboard(snapshot);
  const needle = query.trim().toLowerCase();
  const results: SearchResult[] = [];
  const all = catalog(origin, dashboard.today, child);

  const wantsAll =
    needle.length === 0 ||
    /分析|すべて|全部|全件|json|raw|データ|数据|記録|记录/.test(needle);
  const wantsLatest = new RegExp(`最新|today|今日|今天|いま|今|latest|${escapeRegExp(child)}`, "i").test(needle);
  if (wantsAll || wantsLatest) {
    results.push(...all);
  }

  const dates = [...needle.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((match) => match[1]).filter((value): value is string => Boolean(value));
  if (dates.length === 1) {
    const date = dates[0];
    results.push(
      result(origin, `records:${date}`, `${date} の全記録JSON`),
      result(origin, `day:${date}`, `${date} の食事`),
      result(origin, `overview:${date}`, `${date} の一日`),
    );
  }
  if (dates.length >= 2) {
    results.push(result(origin, `stats:${dates[0]}:${dates[1]}`, `${dates[0]}〜${dates[1]} の食事集計`));
  }

  if (/体重|weight/.test(needle)) results.push(result(origin, "weight", "体重推移"));
  if (/集計|stats|統計|推移/.test(needle)) results.push(result(origin, "stats", "日ごとの食事集計"));
  if (/メモ|memo|備考/.test(needle)) results.push(result(origin, "memos", "メモ一覧"));
  if (/母乳|ミルク|搾|離乳|おやつ|ごはん|奶|辅食|授乳/.test(needle)) {
    results.push(result(origin, `day:${dashboard.today}`, `${dashboard.today} の食事`), result(origin, "recent", "直近の食事・授乳"));
  }
  if (/睡眠|寝る|起きる|おむつ|おしっこ|うんち|お風呂|睡觉|尿布|便/.test(needle)) {
    results.push(
      result(origin, `records:${dashboard.today}`, `${dashboard.today} の全記録JSON`),
      result(origin, "latest", `${child}の最新記録（${dashboard.today}）`),
    );
  }

  for (const type of FEEDING_TYPES) {
    const label = TYPE_LABELS[type] ?? type;
    if (needle.includes(type.toLowerCase()) || needle.includes(label.toLowerCase())) {
      results.push(result(origin, `recent:${type}`, `直近の${label}`));
    }
  }

  if (needle && !wantsAll && !wantsLatest) {
    for (const memo of dashboard.memos) {
      if (memo.memo.toLowerCase().includes(needle) || memo.label.toLowerCase().includes(needle)) {
        results.push(result(origin, `memo:${memo.eventId}`, `${memo.localDate} ${memo.localTime} ${memo.label}のメモ`));
      }
    }
  }

  if (results.length === 0) {
    results.push(...all);
  }
  return uniqueResults(results).slice(0, 16);
}

export function fetchDocument(snapshot: FeedSnapshot, origin: string, id: string, child = "Baby"): FetchDocument | null {
  const dashboard = buildDashboard(snapshot);
  const document = (docId: string, title: string, text: string, metadata: Record<string, string>): FetchDocument => ({
    id: docId,
    title,
    text,
    url: docUrl(origin, docId),
    metadata,
  });

  if (id === "all") {
    return document(id, `${child}の全記録JSON（分析用）`, formatAnalysisText(`${child}のぴよログ全件`, analysisBundle(snapshot)), {
      kind: "all",
      wraps: "snapshot",
    });
  }
  if (id === "latest") {
    const todayJson = formatAnalysisText(`${dashboard.today} の記録JSON`, analysisBundle(snapshot, { date: dashboard.today }));
    return document(id, `${child}の最新記録（${dashboard.today}）`, `${formatLatestText(snapshot, dashboard, child)}\n\n${todayJson}`, {
      kind: "latest",
      date: dashboard.today,
      wraps: "get_day_overview,get_feeding_day,get_weight_trend",
    });
  }
  if (id === "recent") {
    const events = filterFeeding(snapshot, { limit: 20 }).reverse();
    return document(
      id,
      "直近の食事・授乳",
      `${formatRecentText(events)}\n\n${JSON.stringify(events)}`,
      { kind: "recent", wraps: "get_recent_feedings" },
    );
  }
  const recentType = id.match(/^recent:([A-Za-z]+)$/);
  if (recentType?.[1] && (FEEDING_TYPES as readonly string[]).includes(recentType[1])) {
    const type = recentType[1];
    const label = TYPE_LABELS[type] ?? type;
    const events = filterFeeding(snapshot, { types: [type], limit: 20 }).reverse();
    return document(id, `直近の${label}`, `${formatRecentText(events)}\n\n${JSON.stringify(events)}`, {
      kind: "recent",
      type,
      wraps: "get_recent_feedings",
    });
  }
  if (id === "weight") {
    return document(
      id,
      "体重推移",
      `${formatWeightText(dashboard)}\n\n${JSON.stringify(dashboard.weights)}`,
      { kind: "weight", wraps: "get_weight_trend" },
    );
  }
  if (id === "stats") {
    const bundle = analysisBundle(snapshot);
    return document(
      id,
      "日ごとの食事集計",
      `${formatDailyStatsText(dashboard)}\n\n${JSON.stringify(bundle.dailyStats)}`,
      { kind: "stats", wraps: "get_daily_feeding_stats" },
    );
  }
  const statsRange = id.match(/^stats:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
  if (statsRange?.[1] && statsRange[2]) {
    const from = statsRange[1];
    const to = statsRange[2];
    return document(id, `${from}〜${to} の食事集計`, formatDailyStatsText(dashboard, from, to), {
      kind: "stats",
      from,
      to,
      wraps: "get_daily_feeding_stats",
    });
  }
  if (id === "memos") {
    return document(id, "メモ一覧", `${formatMemosText(dashboard.memos)}\n\n${JSON.stringify(dashboard.memos)}`, {
      kind: "memos",
      wraps: "search_memos",
    });
  }
  const recordsMatch = id.match(/^records:(\d{4}-\d{2}-\d{2})$/);
  if (recordsMatch?.[1]) {
    const date = recordsMatch[1];
    return document(id, `${date} の全記録JSON`, formatAnalysisText(`${date} の記録`, analysisBundle(snapshot, { date })), {
      kind: "records",
      date,
      wraps: "get_day_overview",
    });
  }
  const dayMatch = id.match(/^day:(\d{4}-\d{2}-\d{2})$/);
  if (dayMatch?.[1]) {
    const date = dayMatch[1];
    const day = getDay(dashboard, date);
    return document(id, `${date} の食事`, `${formatDayText(day)}\n\n${JSON.stringify(day)}`, {
      kind: "day",
      date,
      wraps: "get_feeding_day",
    });
  }
  const overviewMatch = id.match(/^overview:(\d{4}-\d{2}-\d{2})$/);
  if (overviewMatch?.[1]) {
    const date = overviewMatch[1];
    return document(
      id,
      `${date} の一日`,
      `${formatDayOverviewText(snapshot, dashboard, date)}\n\n${formatAnalysisText(`${date} の記録JSON`, analysisBundle(snapshot, { date }))}`,
      { kind: "overview", date, wraps: "get_day_overview" },
    );
  }
  const memoMatch = id.match(/^memo:(.+)$/);
  if (memoMatch?.[1]) {
    const memo = dashboard.memos.find((item) => item.eventId === memoMatch[1]);
    if (!memo) return null;
    return document(id, `${memo.localDate} ${memo.localTime} ${memo.label}のメモ`, formatMemosText([memo]), {
      kind: "memo",
      date: memo.localDate,
      wraps: "search_memos",
    });
  }
  return null;
}
