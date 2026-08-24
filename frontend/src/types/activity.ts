/**
 * Mirrors the `Payload` TypedDict in `app/services/activity_queries.py` — the
 * full Activity Pulse dataset served by `GET /api/admin/activity/stats`.
 *
 * Row arrays are heterogeneous (a mix of dates, counts, and labels per row,
 * matching the raw SQL result shape), so they type as tuples of
 * `string | number | null` rather than a named interface per row — the same
 * shape pages/activity/render.js destructures positionally.
 */
export interface ActivityStatsPayload {
  generated_at: string;
  promoted_since: string;
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
