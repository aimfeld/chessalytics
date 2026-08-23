# Phase 206: Train Warm-Up Sessions & Sharp Filler Pool - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-07
**Phase:** 206-train-warmup-sharp-filler
**Areas discussed:** Filler mix & herring cap, Exhausted-day filler policy, Sharp set storage & selection, Warm-up framing & reveal, Schema/flag/dead-code follow-ups

---

## Evidence gathered during discussion

Three prod measurements reframed the discussion and are recorded as F-01..F-04 in CONTEXT.md:

| Query | Result | Consequence |
|---|---|---|
| `count(*) FROM herring_pool` (prod) | 5,000 | Burn concern is theoretical |
| Qualifying rows (qual≥2 @ 0.05 ES, gap≥0.02) | ~3,512 | ~1,750 sessions/user before exhaustion |
| `drill_sessions` with `puzzle_count < requested_count` (prod) | **0 of 120**, 59 users | Empty/short landing states are already dead |
| `count(DISTINCT herring_pool_id)` served | 22 | Herring order is globally deterministic (F-04) |

---

## Filler mix & herring cap

### Q1 — Where do the warm-up's several-fine-moves positions come from?

| Option | Description | Selected |
|--------|-------------|----------|
| herring_pool as-is | Existing serve path unchanged; `exclude_served=True` retirement kept | ✓ |
| herring_pool, exempt from retirement | Skip the exclusion write for filler-only sessions | |
| A frozen static several set | Freeze ~15 pool rows outside normal exclusion | |

**User's choice:** herring_pool as-is
**Notes:** Chosen after the ~3,512-qualifying-row measurement showed the seed's "burns supply" cost is negligible in practice.

### Q2 — How should the cross-backfill split a shortfall?

| Option | Description | Selected |
|--------|-------------|----------|
| Cap herrings at HERRING_SHARE, sharp takes rest | 8-puzzle warm-up = 2 herrings + 6 sharp, matching the real 75/25 prior | ✓ |
| Cap, but let herrings exceed if sharp runs out | Fallback branch; near-unreachable given repeats | |
| 50/50 split | Coin-flip prior rather than the real one | |

**User's choice:** Cap herrings at HERRING_SHARE

### Q3 — Does sharp filler fill every SR shortfall, or only all-filler sessions?

| Option | Description | Selected |
|--------|-------------|----------|
| Every shortfall | One mechanism; also fixes the standing "several"-skew on partial shortfalls | ✓ |
| Only all-filler warm-up sessions | Narrower blast radius; needs an is-this-a-warm-up branch | |

**User's choice:** Every shortfall

### Q4 — What replaces the "still analyzing" notice for a partial shortfall?

| Option | Description | Selected |
|--------|-------------|----------|
| New server field `sr_puzzle_count` | Notice fires on `blob_pending > 0 AND sr_puzzle_count < sr_slots` | |
| Warm-up label only, no partial notice | Only the zero-SR case is labeled | ✓ |
| Derive from `blob_pending_count` alone | Fires on full ordinary sessions; rejected as D-02 in Phase 190 | |

**User's choice:** Warm-up label only
**Notes:** Question was raised because sharp filler repeating on exhaustion means sessions are always full, so the existing `puzzle_count < requested_count` gate stays dead regardless of the cap (F-03). This answer is what makes the `'short'` landing state removable.

---

## Exhausted-day filler policy

Reframed by F-01: exhausted days are *already* filled with all-herring sessions, and "All caught up! Next review: {date}" has never rendered in production.

### Q1 — What should exhausted days get?

| Option | Description | Selected |
|--------|-------------|----------|
| Fill honestly + label | Same treatment as cold-start; honors "never an empty Train screen" | ✓ |
| Suppress filler, make the empty state real | Early return before the herring fetch; resurrects shipped-but-dead UI | |
| Empty state + opt-in "Practice anyway" CTA | New intent param, second composition path | |

**User's choice:** Fill honestly + label

### Q2 — Same label for cold-start and exhausted-day?

| Option | Description | Selected |
|--------|-------------|----------|
| One label for both | One boolean, one string, one path | ✓ |
| Distinct copy per case | Needs a third enum value and client-side state combination | |

**User's choice:** One label for both

### Q3 — Should a zero-SR filler session tick the streak?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, uniformly | Confirms the locked decision; requires the `_stamp_pool_eligibility` widening | ✓ |
| Yes for cold-start, no for exhausted | Reintroduces special-casing into streak settling | |

**User's choice:** Yes, uniformly

### Q4 — Where does "Next review: {date}" go?

| Option | Description | Selected |
|--------|-------------|----------|
| Onto the labeled start screen | `next_due_date` already on TrainProgressResponse; copy + conditional | ✓ |
| Drop it | Deletes the only place the SR schedule was visible on the landing surface | |
| Only on the score screen | Third surface; shown after the decision to train | |

**User's choice:** Onto the labeled start screen
**Notes:** The null-vs-set conditional is what lets one string (Q2) be true in both cases.

---

## Sharp set storage & selection

### Q1 — Storage

| Option | Description | Selected |
|--------|-------------|----------|
| Committed data file + TEXT id column | No table, no generator, no per-env seeding | ✓ |
| `sharp_pool` table mirroring herring_pool | FK no-repeat key; table + seeding script for ~50 immutable rows | |
| Table seeded by an Alembic data migration | Puts chess content in a schema migration | |

**User's choice:** Committed data file + TEXT id column
**Notes (free-text):** "Use 200 puzzles and avoid mate in 1 as this might be too easy."

### Q2 — Selection criteria

| Option | Description | Selected |
|--------|-------------|----------|
| mateIn1 + mateIn2, rating ≤1200 | Forced mate is provably sharp under Train's own ES gate, no Stockfish pass needed | |
| Broader: any low-rated short/crushing puzzle | More variety; sharpness becomes lichess's word | |
| Broader themes + one-off offline Stockfish verify | Best variety with verified sharpness | |

**User's choice (free-text):** "Avoid mateIn1/mateIn2 and use more positional variety"
**Notes:** This override removed the free sharpness guarantee, which forced a follow-up round (below). The operator's preference for variety was accepted over the seed's "deliberately easy" leaning.

### Q3 — Serve ordering

| Option | Description | Selected |
|--------|-------------|----------|
| Per-user deterministic shuffle, then repeats | Avoids the F-04 pathology measured on the herring side | |
| Globally fixed order, then repeats | Literal `herring_stmt` mirror; simplest | ✓ |

**User's choice (free-text):** "Use the simplest option" → globally fixed order
**Notes:** Chosen with the F-04 measurement already on the table. Do not "improve" this during planning.

### Q4 — Set size

| Option | Description | Selected |
|--------|-------------|----------|
| ~200 positions | ~a month of all-filler sessions before a repeat | ✓ |
| ~50 positions | The seed's original sizing (~a week) | |
| All ~2,694 qualifying | No repeats ever, but nobody reviews 2,694 positions | |

**User's choice:** ~200 positions
**Notes:** Sized for the unbounded exhausted-day filler the previous area's decision creates.

### Follow-up round (triggered by the mate exclusion)

**Sharpness guarantee**

| Option | Description | Selected |
|--------|-------------|----------|
| One-off offline Stockfish MultiPV verify | Commit only candidates clearing INACCURACY_DROP=0.05; script not shipped | ✓ |
| Trust lichess + filter to 'crushing' | Zero verification code; their margin ≠ our ES sigmoid | |
| Verify and store the measured ES gap in the file | Enables a future whole-set assertion test | |

**User's choice:** One-off offline Stockfish verify

**Rating band and PV shape**

| Option | Description | Selected |
|--------|-------------|----------|
| 1000–1400, `short` PVs only | Above the trivial one-movers, first move is the whole point | ✓ |
| ≤1200, any PV length | Closest to "deliberately easy"; long PVs have quiet first moves | |
| 1200–1600, `short` PVs only | More bite; conflicts with the locked warm-up framing | |

**User's choice:** 1000–1400, `short` PVs only

**Motif balance**

| Option | Description | Selected |
|--------|-------------|----------|
| Balanced across motifs | Per-theme cap; avoids the fixture's endgame/promotion skew | ✓ |
| Rating order, no balancing | Simplest; would skew heavily to pawn endings | |

**User's choice:** Balanced across motifs

---

## Warm-up framing & reveal

### Q1 — Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Start screen only, as a new landing state | Slots into `resolveLandingState`'s existing six-state resolver | ✓ |
| Start screen + persistent in-loop indicator | New surface inside the tightly-tuned solve screen | |
| Start screen + score screen | Second copy string, third surface | |

**User's choice:** Start screen only

### Q2 — Copy

| Option | Description | Selected |
|--------|-------------|----------|
| "Warm-up session" + reason + optional next-review | One string, one conditional, true in both cases | ✓ |
| Lead with the honest negative | "These aren't from your games"; reads as an apology when caught up | |
| Neutral: "Practice session" | Discriminates less; conflicts with seed/roadmap naming | |

**User's choice:** "Warm-up session" + reason + optional next-review

### Q3 — Reveal for a foreign sharp puzzle

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal + motif name | Motif is free from the committed Themes column | ✓ |
| Minimal only | Noticeably emptier panel with no explanation | |
| Minimal + motif + lichess attribution link | Outbound link mid-session; CC0 requires none | |

**User's choice:** Minimal + motif name

### Q4 — Third `DrillSource` name

| Option | Description | Selected |
|--------|-------------|----------|
| `SHARP_FILLER` / `'sharp_filler'` | Names the composition role, beside SR_ITEM and RED_HERRING | ✓ |
| `LICHESS_PUZZLE` / `'lichess_puzzle'` | Names provenance; bakes today's source into a CHECK constraint | |
| `STATIC_PUZZLE` / `'static_puzzle'` | Names the storage mechanism | |

**User's choice:** `SHARP_FILLER`

---

## Schema, answer key, and dead code (final round)

### Q1 — Warm-up flag storage

| Option | Description | Selected |
|--------|-------------|----------|
| Persisted column on `drill_sessions` | Frozen at composition, like puzzle_count/requested_count; free on resume | ✓ |
| Derived from `drill_solves.source` | Cannot drift, but needs a widened or second query on every session read | |
| Persist `sr_puzzle_count` instead | Same properties; stores a number nothing reads given the no-partial-notice call | |

**User's choice:** Persisted column on `drill_sessions`

### Q2 — `drill_solves.ply` for a filler row

| Option | Description | Selected |
|--------|-------------|----------|
| Derive from the FEN | `(fullmove−1)*2 + side`; committed in the data file, plausible on the wire | ✓ |
| Sentinel 0 | Magic number shipped through the wire schema | |

**User's choice:** Derive from the FEN

### Q3 — Where `puzzle_type='sharp'` comes from

| Option | Description | Selected |
|--------|-------------|----------|
| Branch in `record_solve` on `source` | Mirrors RED_HERRING's existing POOL-08 short-circuit | ✓ |
| Store expected `puzzle_type` on the row | Uniform, but duplicates a value SR/herring derive from live data | |

**User's choice:** Branch in `record_solve` on `source`

### Q4 — Dead code

| Option | Description | Selected |
|--------|-------------|----------|
| Remove the `'short'` state, keep the empty states | `'short'` dies as a consequence of THIS phase; empty states were already dead | ✓ |
| Remove both | ~60 lines plus tests; would need resurrecting if the exhausted-day call reverses | |
| Remove neither | Ships knowing two UI paths are unreachable and says nothing | |

**User's choice:** Remove the `'short'` state, keep the empty states

---

## Claude's Discretion

- Data-file format (JSON vs CSV) and path under `app/data/`.
- Per-theme cap value and the exact motif list for the 200-position balancing.
- Authoring script location, CLI shape, and Stockfish depth/time budget for the verification pass.
- Copy micro-wording and visual treatment of the new `'warmup'` landing state.

## Deferred Ideas

- **Herring serve ordering is globally deterministic** (F-04) — 22 distinct pool rows served across 59 prod users out of ~3,512 qualifying. A per-user seeded ordering would fix it. Out of scope: this phase touches herring *quantity*, never ordering. Worth a seed.
- **`TrainEmptyBody`'s three unreachable empty states** (F-01) — already dead before this phase; removal touches `pool_state` plumbing. Worth a seed alongside F-04.
- **A partial-shortfall "still analyzing" notice** — rejected here, but the signal is real and would need only a server field if ever wanted.
- **Rating-matched sharp filler** — the 1000–1400 band is global, not per-user. Out of scope, same reasoning as the locked no-rating-matching constraint for herrings.
- **Outbound lichess attribution links on reveal** — considered and dropped.
