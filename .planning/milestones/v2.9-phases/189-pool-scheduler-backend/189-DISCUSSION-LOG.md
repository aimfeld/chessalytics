# Phase 189: Pool + Scheduler Backend - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-25
**Phase:** 189-pool-scheduler-backend
**Areas discussed:** Answer-key freshness, Deletion semantics, Timezone/day boundary, Schedule bootstrap & N, Session lifecycle

---

## Answer-key freshness

| Option | Description | Selected |
|--------|-------------|----------|
| Snapshot at entry (Recommended) | Copy grading-critical fields into drill_items at pool entry; stable across the item lifetime, immune to re-analysis rewrites | |
| Live-join at serve time | Read game_positions/game_flaws fresh at composition; always current, no duplication | ✓ |
| Hybrid: snapshot grading, live reveal | Snapshot best_move + verdict only; reveal pv fetched live | |

**User's choice:** Live-join at serve time ("leaning live-join to reduce complexity"). Asked whether a snapshot would protect against user game deletion; clarified that it wouldn't and shouldn't — items should die with games, with warning copy in the delete-all modal (user: "which is fine").

### FK anchor (follow-up)

| Option | Description | Selected |
|--------|-------------|----------|
| FK to games + lazy evict (Recommended) | drill_items → games(id) CASCADE + plain (game_id, ply) columns; serve-time join with lazy eviction | ✓ (on second round) |
| FK to game_flaws composite key | Chain through game_flaws | initially picked, revised |
| FK to game_flaws + snapshot/restore | Extend reclassify snapshot/restore machinery to drill_items | |
| FK to game_flaws, accept the loss | Accept progress wipe on resweep/backfill reclassify | |

**Notes:** The user first chose the game_flaws composite FK; after the reclassify delete-then-insert cascade risk was flagged (`_classify_and_fill_oracle`, resweeps/tier-4 touching pooled games), they switched to FK-to-games + lazy evict.

---

## Deletion semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve history (Recommended) | drill_sessions FKs only to users; session dates/scores and weekly streak survive re-import | ✓ |
| Wipe everything | Explicit delete of drill_sessions in the delete-all path | |

**User's choice:** Preserve history.

### Guest prune (superseded by a broader call)

| Option | Description | Selected |
|--------|-------------|----------|
| Prune sessions + settings too (Recommended) | Extend guest_cleanup_service | |
| Only what cascades | Leave the tiny rows | |

**User's choice:** Neither — free-text: guests don't get their games analysed by the remote workers, so **Train should not be available to guest accounts at all**, and this should be stated on the Welcome.tsx page. Guest-prune handling is therefore moot.

---

## Timezone/day boundary

| Option | Description | Selected |
|--------|-------------|----------|
| IANA timezone in train_settings (Recommended) | tz string from browser Intl at settings save, default UTC; zoneinfo day boundaries server-side | ✓ |
| Documented UTC approximation | Naive UTC days; wrong-weekday sessions for the Americas | |
| Fixed UTC-offset integer | Lighter but DST-drifting | |

**User's choice:** IANA timezone in train_settings.

---

## Schedule bootstrap & N

| Option | Description | Selected |
|--------|-------------|----------|
| No schedule = every day (Recommended) | Create-on-first-touch settings, empty weekday set = train anytime, identity snapping | ✓ |
| Seed a default schedule | Canned Tue/Fri default | |

| Option | Description | Selected |
|--------|-------------|----------|
| N = 12 (Recommended) | Seed's own example copy; 9 SR + 3 herrings | ✓ |
| N = 10 | Rounder, needs a split rounding rule anyway | |
| N = 8 | Shortest sensible default | |

**User's choice:** No schedule = every day; N = 12.

---

## Session lifecycle

(Area added by the user at gray-area selection: "a user committing to a session on Tuesday and Friday should have Wednesday and Thursday to complete the Tuesday session.")

| Option | Description | Selected |
|--------|-------------|----------|
| Freeze at session start (Recommended) | Materialized ordered puzzle list; stable resume and "4 of 12" | ✓ |
| Recompute remaining queue each request | Stateless but contents shift mid-window | |

| Option | Description | Selected |
|--------|-------------|----------|
| Expire; unsolved items return to queue (Recommended) | Session marked incomplete at window end; solved results keep; next session composes fresh; one open session max; "train now" resumes | ✓ |
| Carry unfinished puzzles into the next session | Pre-load leftovers before padding to N | |

| Option | Description | Selected |
|--------|-------------|----------|
| Until end of local day (Recommended) | Empty-schedule window = local calendar day per stored tz | ✓ |
| Open until completed | No expiry; stale half-sessions linger | |

**User's choice:** All three recommended options.

---

## Claude's Discretion

- Winnability-floor constant, ladder day values, sharp/soft gap threshold, 75/25 rounding — named constants, planner tunes.
- Endpoint surface/naming and the POOL-10 reveal-unlock mechanism.
- Schema details beyond the anchoring decisions (drill_solves shape, indexes, CHECKs).

## Deferred Ideas

- Welcome.tsx guest copy ("Train requires a full account") — Phase 190.
- Delete-all modal warning copy ("deleting games resets Train progress") — Phase 190/191.
- Reviewed todos not folded: WR-01 Tailwind axis label, Phase-172 sweep review findings, bitboard storage (all unrelated to this backend phase).
