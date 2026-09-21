export type PiyoRecord = {
  event_id: string;
  datetime: string;
  type: string;
  memo?: string;
  last?: "left" | "right";
  leftTime?: number;
  rightTime?: number;
  value?: {
    value?: number;
    left?: number;
    right?: number;
    unit?: string;
  };
  details?: Record<string, string>;
};

export type FeedSnapshot = {
  schema_version: number;
  generated_at: string;
  range: { from: string; to: string };
  records: PiyoRecord[];
};

export const FEEDING_TYPES = [
  "BreastFeeding",
  "Formula",
  "ExpressedBreastMilk",
  "Pumping",
  "Solid",
  "Snack",
  "Meal",
  "Drink",
] as const;

export type FeedingType = (typeof FEEDING_TYPES)[number];

export const TYPE_LABELS: Record<string, string> = {
  BreastFeeding: "母乳",
  Formula: "ミルク",
  ExpressedBreastMilk: "搾母乳",
  Pumping: "搾乳",
  Solid: "離乳食",
  Snack: "おやつ",
  Meal: "ごはん",
  Drink: "のみもの",
  Sleep: "寝る",
  WakeUp: "起きる",
  Pee: "おしっこ",
  Poop: "うんち",
  Temperature: "体温",
  Height: "身長",
  Weight: "体重",
  Head: "頭囲",
  Chest: "胸囲",
  Foot: "足サイズ",
  Bath: "お風呂",
  Medicine: "くすり",
  Hospital: "病院",
  Walking: "さんぽ",
  Vaccine: "予防接種",
  Milestone: "できた",
  Other: "その他",
  Memo: "メモ",
};

export type FeedingEvent = {
  eventId: string;
  datetime: string;
  localDate: string;
  localTime: string;
  type: string;
  label: string;
  memo?: string;
  volumeMl?: number;
  leftSeconds?: number;
  rightSeconds?: number;
  lastSide?: "left" | "right";
  summary: string;
};

export type DayFeeding = {
  date: string;
  formulaMl: number;
  expressedMl: number;
  breastMl: number;
  pumpingMl: number;
  drinkMl: number;
  totalMilkMl: number;
  breastSeconds: number;
  breastCount: number;
  formulaCount: number;
  expressedCount: number;
  pumpingCount: number;
  solidCount: number;
  snackCount: number;
  mealCount: number;
  drinkCount: number;
  events: FeedingEvent[];
};

export type WeightPoint = {
  date: string;
  datetime: string;
  kg: number;
};

export type MemoItem = {
  eventId: string;
  datetime: string;
  localDate: string;
  localTime: string;
  type: string;
  label: string;
  memo: string;
};

export type DashboardPayload = {
  timezone: string;
  generatedAt: string;
  range: { from: string; to: string };
  today: string;
  todayFeeding: DayFeeding;
  days: DayFeeding[];
  weights: WeightPoint[];
  memos: MemoItem[];
  lastFeeding: FeedingEvent | null;
};
