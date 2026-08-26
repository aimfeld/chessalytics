/**
 * pastedGameHandoff — sessionStorage handoff carrying a sniffed FEN/PGN paste
 * from the Import tab to the analysis board (Quick 260826-qdl).
 *
 * Exists because `?line=` cannot express what a paste can carry: it replays
 * UCI from the STANDARD START only, so a `[SetUp]`/custom-root PGN is
 * unrepresentable, and the parsed White/Black/Elo/Result/Date headers that
 * drive the player bars would be lost entirely. `?fen=` covers only the
 * `kind: 'fen'` case. One sessionStorage carrier covers both kinds instead of
 * splitting the mechanism by kind.
 *
 * Deliberately tab-scoped and one-shot: `takePastedGameHandoff` is a
 * destructive read (it clears the key on every call, including a malformed
 * payload), so a browser Back-then-Forward to /analysis never resurrects a
 * stale paste. Modeled line-for-line on `frontend/src/lib/trainRevealCache.ts`.
 *
 * Must never touch persistent per-origin storage (`localStorage`) — that is
 * where the Bearer auth token lives (T-qdl-02).
 */

import type { PasteParseResult } from '@/lib/pastedGame';

const STORAGE_KEY = 'pasted_game_handoff';

export interface PastedGameHandoff {
  result: PasteParseResult;
  userColor: 'white' | 'black';
}

/** Shallow-but-complete shape check — rejects a hand-edited, corrupt, or
 *  foreign payload before it ever reaches `loadMainLine` (T-qdl-01). Only
 *  `kind: 'fen'` (string `fen`) or `kind: 'pgn'` (array `sans`, string
 *  `rootFen`, object `headers`, string `pgn`) are accepted; anything else
 *  returns false. */
function isPastedGameHandoff(value: unknown): value is PastedGameHandoff {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.userColor !== 'white' && v.userColor !== 'black') return false;

  const result = v.result as Record<string, unknown> | null | undefined;
  if (typeof result !== 'object' || result === null) return false;

  if (result.kind === 'fen') {
    return typeof result.fen === 'string';
  }
  if (result.kind === 'pgn') {
    return (
      Array.isArray(result.sans) &&
      typeof result.rootFen === 'string' &&
      typeof result.headers === 'object' &&
      result.headers !== null &&
      typeof result.pgn === 'string'
    );
  }
  return false;
}

/** Best-effort save — a `QuotaExceededError` (Safari private mode) degrades
 *  silently to a no-op (T-qdl-04), same accepted degradation as
 *  `saveTrainRevealCache`: the user lands on a bare analysis board instead of
 *  their pasted game, rather than a crash. */
export function savePastedGameHandoff(handoff: PastedGameHandoff): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handoff));
  } catch {
    // Best-effort only — see module doc comment.
  }
}

/**
 * Destructive read: always removes the key, even when the stored payload
 * turns out to be malformed (T-qdl-03) — a corrupt entry self-heals after one
 * mount instead of wedging every future analysis-page mount. Returns null on
 * an absent key, a JSON parse failure, or a shape that fails validation.
 */
export function takePastedGameHandoff(): PastedGameHandoff | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPastedGameHandoff(parsed) ? parsed : null;
  } catch {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Best-effort — see module doc comment.
    }
    return null;
  }
}
