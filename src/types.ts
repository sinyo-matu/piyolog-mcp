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
