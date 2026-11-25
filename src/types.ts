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

export type StaleReason = "request_failed" | "empty_feed";

export type FeedSnapshot = {
  schema_version: number;
  generated_at: string;
  range: { from: string; to: string };
  records: PiyoRecord[];
  /** Set when the live feed was unusable and the records come from the archive. */
  staleReason?: StaleReason;
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
