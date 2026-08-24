/**
 * Mirrors `dashboard/queries.py`'s `Payload` TypedDict — the full Activity
 * Pulse dashboard dataset served by `GET /api/admin/activity/stats`.
 *
 * Row arrays are heterogeneous (a mix of dates, counts, and labels per row,
 * matching the raw SQL result shape), so they type as tuples of
 * `string | number | null` rather than a named interface per row — the same
 * shape the standalone dashboard's app.js/charts.js already destructure
 * positionally.
 */
export interface ActivityStatsPayload {
  generated_at: string;
  promoted_since: string;
  poll_interval_seconds: number;
  days: string[];
  last_complete_index: number;
  activity: number[][];
  signups: (string | number | null)[][];
  bot: (string | number | null)[][];
  train: (string | number | null)[][];
  solves: (string | number | null)[][];
  imports: (string | number | null)[][];
  persona: (string | number | null)[][];
  bot_players: number;
  elo: number[][];
  funnel: (string | number | null)[][];
  tti: (string | number | null)[][];
  stick: (string | number | null)[][];
  conversion: Record<string, number | string>;
  conversion_compare: (string | number | null)[][];
}
