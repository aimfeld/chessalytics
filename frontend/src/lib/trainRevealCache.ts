/**
 * trainRevealCache — sessionStorage cache of a solved Train puzzle's full
 * solution state (190.1 UAT round 5).
 *
 * Written when the user leaves the reveal via the Analyze deep link, so the
 * browser back button lands on the SAME solved reveal instead of the start
 * screen: a resumed session no longer contains the just-solved puzzle (the
 * backend returns only unattempted puzzles), and the grade result lives only
 * in the client engine's memory — without this cache the solution state is
 * unrecoverable after the Train page unmounts.
 *
 * sessionStorage (not localStorage) on purpose: the cache is a per-tab
 * navigation aid, not durable data. `sessionId` guards against restoring a
 * reveal from an older session (e.g. a new day's session composed since the
 * cache was written) — `Train.tsx` validates it against the freshly resumed
 * session and drops mismatches. All fields are plain JSON-serializable data
 * (`GradeResult`/`TrainEngineLine` are UCI strings and numbers).
 */

import type { GradeResult } from '@/hooks/useTrainGradingEngine';
import type { Guess } from '@/lib/trainGuessLabels';
import type { SolveResponse, TrainPuzzle } from '@/types/train';

const STORAGE_KEY = 'train_reveal_cache';

export interface CachedTrainReveal {
  sessionId: number;
  puzzle: TrainPuzzle;
  verdict: SolveResponse;
  guess: Guess;
  playedMoveUci: string;
  gradeResult: GradeResult;
}

export function saveTrainRevealCache(cached: CachedTrainReveal): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Best-effort only — a storage failure just means back lands on the
    // start screen (the pre-cache behavior), never a crash.
  }
}

export function readTrainRevealCache(): CachedTrainReveal | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCachedTrainReveal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearTrainRevealCache(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort — see saveTrainRevealCache.
  }
}

/** Shallow shape check — enough to reject corrupt/foreign payloads without
 * re-validating every nested field the compiler already typed at write time.
 *
 * SEED-119: `verdict.move_quality` (a string on every post-tiering entry) is
 * checked specifically to reject a pre-SEED-119 cache entry, whose `verdict`
 * has no `move_quality` field at all — such an entry lands the back button
 * on the start screen, the module's already-documented best-effort fallback.
 * This nested check exists ONLY to catch that one shape drift; it is not a
 * license to deep-validate every field of `verdict`/`gradeResult`. */
function isCachedTrainReveal(value: unknown): value is CachedTrainReveal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const puzzle = v.puzzle as Record<string, unknown> | null | undefined;
  const gradeResult = v.gradeResult as Record<string, unknown> | null | undefined;
  const verdict = v.verdict as Record<string, unknown> | null | undefined;
  return (
    typeof v.sessionId === 'number' &&
    (v.guess === 'critical' || v.guess === 'several') &&
    typeof v.playedMoveUci === 'string' &&
    typeof puzzle === 'object' &&
    puzzle !== null &&
    typeof puzzle.fen === 'string' &&
    typeof puzzle.position === 'number' &&
    typeof verdict === 'object' &&
    verdict !== null &&
    typeof verdict.move_quality === 'string' &&
    typeof gradeResult === 'object' &&
    gradeResult !== null &&
    typeof gradeResult.bestLine === 'object'
  );
}
