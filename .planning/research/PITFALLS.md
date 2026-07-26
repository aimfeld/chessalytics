# Pitfalls Research — v2.9 Train (Spaced-Repetition Blunder Drills)

**Domain:** Adding a spaced-repetition training feature on top of an existing chess-analysis
platform's data pipeline (FlawChess-specific, not generic SR advice)
**Researched:** 2026-07-25
**Confidence:** HIGH — every pitfall below is grounded in direct reads of the shipped code
(`app/models/game_flaw.py`, `app/services/eval_apply.py`, `app/services/forcing_line_gate.py`,
`app/services/best_move_candidates.py`, `app/repositories/query_utils.py`,
`app/repositories/library_repository.py`, `app/services/guest_cleanup_service.py`,
`app/repositories/game_repository.py`, `frontend/src/hooks/useStockfishGradingEngine.ts`,
`frontend/src/lib/confetti.ts`, `frontend/src/App.tsx`) plus this project's own memory notes
on eval nondeterminism and blob backfill behavior, not web search — the failure modes are
specific to how THIS codebase already stores and reprocesses this data. SEED-037's settled
design is treated as fixed; every item below is a failure mode *in executing* it, not a
proposal to reverse a decision.

## Critical Pitfalls

### Pitfall 1: Opponent-flaw leakage via a hand-rolled ply-parity check

**What goes wrong:**
The pool-entry query (and any other place Train needs "this flaw belongs to the user, not
their opponent") re-derives ownership from `ply % 2` instead of reusing the project's
canonical ownership predicate. A sign error here silently pulls the *opponent's* blunders
into the user's drill pool, or excludes half the user's own blunders depending on which
color they played.

**Why it happens:**
`game_flaws` deliberately stores both players' flaws in one table (ply parity vs
`Game.user_color` is the only ownership signal — see CLAUDE.md and the model's own comments).
It is very easy to write `ply % 2 == 0` inline and get the white/black mapping backwards for
one color, because the mapping also depends on `user_color`, not ply alone.

**How to avoid:**
Reuse `app/repositories/query_utils.py`'s `player_only_gate` / `is_opponent_expr` (SQL) and
`app/services/best_move_candidates.py`'s `mover_color_for_ply` (Python) verbatim. Do not
write a new `ply % 2` predicate anywhere in the Train pool-entry query, the red-herring
source query, or the reveal.

**Warning signs:**
`query_utils.py` already carries a comment noting "a prior" bug in this exact area
(`TestIsOpponentExpr`) — this is not a hypothetical risk, it has happened once already in
this codebase. Any manual test where a black-playing user's Train session surfaces a
suspiciously "good" move as the answer key (because it was really the opponent's blunder) is
this bug.

**Phase to address:**
Phase 1 (Pool + scheduler backend) — the pool-entry and red-herring source queries.

---

### Pitfall 2: Post-move eval shift misapplied to the winnability floor

**What goes wrong:**
The winnability floor ("exclude positions already lost before the blunder, expected score
below ~20–25%") reads `game_positions.eval_cp` at the flaw's own row instead of the row
whose eval actually describes the *pre-move* position, producing a floor computed one ply
late — sometimes excluding genuinely-winnable blunders, sometimes admitting hopeless ones.

**Why it happens:**
`game_positions` stores `eval_cp` under a **post-move convention**: the eval at row `ply` is
the eval of the position *after* move `ply` was played (SEED-044's "+1 shift", implemented at
`app/services/eval_apply.py:342` and inverted by `app/services/eval_apply.py:2057`). But
`best_move`/`pv` on that same row are **decision-ply-keyed and NOT shifted** — they describe
the position *before* move `ply`, i.e. the exact position the drill puzzle presents. Mixing
these two different reference frames on the same row is the single easiest bug to write here,
because both columns live on the identical `GamePosition` row and look symmetric.

**How to avoid:**
For the winnability floor, use the eval that describes the position **before** the flaw move
(the previous row's post-move eval, or the pipeline's existing un-shift helper at
`eval_apply.py:2057`) — never the flaw row's own `eval_cp`. For the answer key (`best_move`,
`pv`), the flaw row's own value is correct as-is (it is already decision-ply-keyed). Add an
explicit code comment at the query site distinguishing the two, mirroring the existing
`eval_apply.py` comments (SEED-044).

**Warning signs:**
Manually verify one drilled position against its FEN + eval on the `/analysis` board deep
link. If the winnability floor's expected score doesn't match what the analysis board shows
for the position immediately before the flaw move, the shift is backwards.

**Phase to address:**
Phase 1 (Pool + scheduler backend) — pool-entry query.

---

### Pitfall 3: Answer key drifts after a drill item is already mid-ladder

**What goes wrong:**
A user progresses an item to streak 1 or 2 (or even "3 spaced correct → mastered"). Later,
the underlying `game_flaws` row's `best_move`, `pv`, or `missed_pv_lines`/`allowed_pv_lines`
blob is silently overwritten by a subsequent re-analysis pass — and the drill item's history
(what the user was actually graded against) no longer matches what the reveal now shows, or
the sharp/soft classification (which fed the pre-move guess's ground truth) flips underneath
an in-flight item.

**Why it happens:**
This is not hypothetical in this codebase: `eval_apply.py` explicitly overwrites `best_move`
"unconditionally" when re-evaluated (`eval_apply.py:440`), and the flaw-classification write
path (`_classify_and_fill_oracle`) has historically been delete-then-insert and is now a
diff/upsert that can still drop or replace a flaw ply's blob content depending on what the
reclassification finds (per this project's own memory notes on "dedup transplants" and
"tier-4 `[]`-sentinels the flaw's blob permanently"). `missed_pv_lines` is tier-4
*opportunistic* — a flaw can legitimately enter the pool with a blob computed by one engine
pass, and get re-blobbed by a later, different pass (dedup transplant, backfill, or an engine
upgrade) while the item is already in a user's queue.

**How to avoid:**
Decide explicitly (Phase 1) whether Train's drill item stores a **snapshot** of the answer
key at pool-entry time (immune to drift, but can go stale relative to a genuinely-improved
re-analysis) or **joins live** to `game_flaws`/`game_positions` every session (always current,
but an item's graded answer can change between sessions). Either choice is fine — the pitfall
is not picking one and instead silently getting a live join by accident (the natural default
when writing a straightforward query), which means the reveal a user sees for a "mastered"
item's retrospective badge may not match what was actually graded when they solved it.

**Warning signs:**
A parked or mastered item whose reveal `best_move`/blob-derived classification doesn't match
what the solve log recorded for an earlier session on the same item.

**Phase to address:**
Phase 1 (Pool + scheduler backend) — drill-item data model decision.

---

### Pitfall 4: Source-game deletion silently orphans drill progress

**What goes wrong:**
A user's mastered/in-progress drill items disappear (or worse, the drill-item table itself
errors on an FK violation) when their underlying game is deleted — via the **already-shipped**
30-day guest-inactivity prune (`app/services/guest_cleanup_service.py`) or via the
**already-shipped** user-facing "delete all games" + re-import flow. Because `Game.id` is a
plain serial surrogate key and `delete_all_games_for_user` does a real `DELETE`
(`app/repositories/game_repository.py:249`), a re-imported game — even the *exact same*
chess.com/lichess game — gets a **new** `Game.id`. Any drill item CASCADE-FK'd to the old
`game_id` is gone for good; a user who re-imports their whole history to fix a filter setting
loses all Train progress with zero warning, indistinguishable from a bug.

**Why it happens:**
`game_flaws`/`game_positions`/`game_best_moves` all use `ForeignKey(..., ondelete="CASCADE")`
to `games.id` (per CLAUDE.md's mandatory-FK rule), which is correct for those tables — but a
drill-item table naturally inherits the same CASCADE by following the same pattern, and
nobody on the Train team is likely to be thinking about the guest-pruning job or the
"DELETE /api/games" endpoint when designing the drill-item schema.

**How to avoid:**
Make this a conscious decision, not an accident: either (a) accept CASCADE deletion of drill
items as correct (mastery is tied to the specific analyzed game; re-import legitimately means
"start over" and the empty/cold state in Phase 3 should say so), or (b) explicitly
`SET NULL` / soft-orphan the drill item and keep its solve-log history detached from a live
FK for user-visible stats. Whichever is chosen, the guest-pruning path and the "delete all
games" path both need to be in scope when reasoning about drill-item lifecycle, not just
normal usage.

**Warning signs:**
Mastered/parked counts drop after a user re-imports; a guest who re-registers finds their
train history gone with no explanation (their `User` row survives guest cleanup per
`guest_cleanup_service.py`'s D-05, but their games — and by inheritance their drill items —
do not).

**Phase to address:**
Phase 1 (Pool + scheduler backend) — schema decision; Phase 3 (Schedule + progress surface)
— must message the outcome honestly in the empty/cold states, matching CLAUDE.md's precedent
for the readiness gate ("no message claims full completion while X is still running" applies
symmetrically here — no screen should imply progress was lost to a bug when it was lost by
design).

---

### Pitfall 5: Tier-4 blob backfill starves session composition for recently-analyzed flaws

**What goes wrong:**
Pool entry requires a non-empty `missed_pv_lines` blob (the sharp/soft classifier). Blob
coverage is **tier-4, opportunistic**: new games get it ~100% inline, but the backlog is
still filling and — per this project's own memory notes — the tier-4b lottery is "the
lowest idle rung" that "starves behind #1." A user whose games were imported and analyzed
before this backfill caught up (or a very recently re-analyzed batch) can have real, severe
blunders that simply don't qualify for the pool yet. Combined with "pad due < slots by
introducing new flaws," a low-blob-coverage user's sessions silently skew almost entirely to
red herrings, or (worse) come up genuinely short of N — which looks exactly like a Train bug
("why does my session only have 2 puzzles?") rather than a known, present-data filter
limitation.

**Why it happens:**
The seed correctly treats blob presence as "a present-data filter, not a blocker" for pool
*eligibility* — but session *composition* (Phase 1's 75/25 mix, exactly-N-while-material-lasts
contract) is a separate mechanism that was designed assuming a healthy-sized pool. It wasn't
explicitly re-checked against a thin-pool scenario driven by backfill lag specifically (as
opposed to a genuinely low-blunder-count user).

**How to avoid:**
Session composition must have an explicit, tested degenerate path for "fewer SR-eligible
items than requested, red-herring source also thin" that renders as an honest "still catching
up on your recent games" state rather than a truncated or empty-looking session. This is
distinct from the seed's already-covered "pool exhausted, everything mastered" cold state —
it needs its own copy.

**Warning signs:**
A user with a large, freshly-imported game history (common: a first-time Train visit right
after finishing initial import) sees a suspiciously thin or all-herring first session.

**Phase to address:**
Phase 1 (session-composition endpoint) for the degenerate-path logic; Phase 3 (cold/empty
states) for user-facing messaging that distinguishes "no eligible material yet, still
analyzing" from "genuinely caught up."

---

### Pitfall 6: Returning-user re-entry shock — overdue pileup compounds with streak loss

**What goes wrong:**
A user who skips their scheduled sessions for a few weeks (illness, travel, life) returns to
find every scheduled session unactioned, so on their next visit **the entire due queue is
backlog** — by design this drains gradually over several sessions (capped at N, "Anki's
model"), so there's no *volume* pileup. But two second-order effects compound at the same
moment: (1) a rusty user is more likely to fail several of those overdue items, and a fail
resets `streak` to 0 with `due_date` = next scheduled session — meaning several of the exact
same items come right back in the very next session, producing 2-3 consecutive
mostly-familiar-failures sessions; (2) the weekly streak (all scheduled sessions completed)
broke the moment they missed a day, so the comeback session is scored and rated at the same
time the streak resets. The net first-impression-back experience can read as "wall of
red-rated sessions + streak reset," which cuts directly against the seed's own explicit
guardrail ("competence feedback yes, behavior control no").

**Why it happens:**
Both mechanisms (most-overdue-first scheduling, streak-reset-on-fail, weekly-streak-on-every-
scheduled-day) are individually well-reasoned and explicitly chosen in the settled design —
the risk is purely the *interaction* at the specific moment a lapsed user returns, which is
also the highest-leverage moment for retention.

**How to avoid:**
Not a design reversal — the mechanics stay as specified. But the *messaging* on the
comeback session should not amplify it: avoid a session-end rating that reads as "you failed"
for a session dominated by cold-restart material, and don't let the weekly-streak reset and
the session color-rating fire in the same visual beat without separating them. This is a
copy/sequencing concern for Phase 3, not a scheduler change.

**Warning signs:**
Watch qualitatively for user drop-off specifically correlated with a return-after-gap
session; this is the kind of thing that won't show up in a unit test.

**Phase to address:**
Phase 3 (Schedule + progress surface) — session-end and streak-reset messaging.

---

### Pitfall 7: No user-timezone infrastructure exists — schedule/due-date/streak day boundaries default to UTC

**What goes wrong:**
The weekday picker ("session days"), due-date snapping ("next scheduled session day"), and
weekly streak ("all scheduled sessions completed that week") all require a concept of
"day" and "week" — but every timestamp column in this codebase (`users.created_at`,
`last_login`, `last_activity`, everywhere else) is stored and reasoned about in UTC with no
per-user timezone or offset field anywhere in the schema. Left unaddressed, "Monday" is
computed in UTC: a US-based user's local Sunday evening or Monday-night session can silently
land on the wrong UTC calendar day, causing a scheduled session to appear a day early/late,
or — worse — causing a legitimately-completed session to not count toward that week's streak
because it landed on the "wrong" UTC weekday.

**Why it happens:**
This is genuinely new ground for the codebase, not an existing pattern being misapplied —
which is exactly why it's easy to skip: there's no precedent method to copy, so the natural
default (server `datetime.now(timezone.utc)`, matching every other service in this repo) is
silently wrong for anyone not near UTC.

**How to avoid:**
Decide explicitly in Phase 1/3: either (a) add a lightweight per-user UTC-offset (captured
client-side, e.g. `Intl.DateTimeFormat().resolvedOptions().timeZone` or a simple minutes
offset, stored alongside the schedule settings — not a full IANA-timezone system, just enough
to compute "today" correctly) or (b) explicitly document and accept UTC-day boundaries as a
known approximation and surface the schedule in the user's LOCAL time on the settings screen
while computing under the hood in UTC (so at minimum the display doesn't lie about which day
is selected). Whatever is chosen, `due_date`'s column type (DATE vs TIMESTAMPTZ) should be
picked deliberately with this decision in mind — it's expensive to change once items are
mid-ladder.

**Warning signs:**
QA a schedule with a UTC-offset persona (e.g. UTC-8) and check whether their "Monday" session
actually appears on their local Monday, and whether a session completed at 11pm local time
counts for the correct calendar week.

**Phase to address:**
Phase 1 (due-date/ladder pure functions — day-boundary convention baked into the interval
ladder from day one) and Phase 3 (schedule settings UI, weekly streak).

---

### Pitfall 8: Client-side WASM grading disagrees with the server-computed answer key near the MISTAKE threshold

**What goes wrong:**
A played move whose true expected-score drop (per the server's deep, native-Stockfish
analysis, 1M nodes/move) sits just under `MISTAKE_DROP` (0.10) grades as **wrong** in the
client, because the vendored single-threaded WASM engine — capped by wall-clock movetime, not
node count — doesn't reach the depth needed to find the saving line within its budget. The
inverse also happens: a genuinely bad move grades **correct** because the WASM search hasn't
found the refutation yet. This directly corrupts the SR mechanics (streak advancement,
mastery, and parking all key off "correct"), not just a cosmetic eval-number mismatch.

**Why it happens:**
This project's own memory notes already establish that `eval_cp` is "not reproducible across
machines" even for the *same* engine — Train's situation is strictly harder, because the
server answer key and the client grading engine are **two structurally different search
configurations** (native full-strength Stockfish vs. a vendored, single-thread,
movetime-capped WASM build; the sibling `useStockfishGradingEngine` hook caps grading runs at
up to `GRADING_MOVETIME_SAFETY_CAP_MS = 4000` ms, not the "~1s" figure the seed's UX
description assumes). Near the MISTAKE_DROP boundary is exactly where shallower search is
most likely to disagree with the deep one, because that's where "does the refutation exist"
is genuinely hard to see.

**How to avoid:**
Budget the grading search generously (reuse the sibling hook's measured 4000ms cap rather
than assuming ~1s is enough — that number was NOT re-validated for Train's single-move-eval
shape and may need its own headless measurement, mirroring Phase 158's approach). Treat
near-threshold disagreement as an accepted, bounded noise band rather than something to chase
to zero, and make sure the reveal doesn't overstate certainty ("close — Stockfish rates this
within X of the best move" reads more honestly than a hard right/wrong at the boundary).

**Warning signs:**
User reports of "I know that was the right move" contesting a wrong grading, clustered near
MISTAKE_DROP-adjacent evals rather than randomly distributed.

**Phase to address:**
Phase 2 (solve loop / client-side grading) — movetime budget and grading-search design;
worth a dedicated headless measurement pass before shipping, per this project's own precedent
(`project_headless_stockfish_wasm_verification` memory note).

---

### Pitfall 9: The answer key is structurally present in the browser before the user acts

**What goes wrong:**
Because grading is fully client-side by design (no grading endpoint), `best_move` must ship
to the browser before the user attempts the puzzle, so it can be exact-matched instantly. If
the session-fetch payload also eagerly includes `missed_pv_lines`/`allowed_pv_lines` (needed
later for the reveal's tactic stepper) up front, the node-0 `b`/`s`/`sm`/`su` fields — the
**exact ground truth for the pre-move "critical move vs several fine moves" guess** — are
also sitting in the network tab / React state before the user commits to their guess. A
technically curious (not even malicious) user can trivially see both answers via devtools
before doing anything.

**Why it happens:**
This is not a bug so much as an unavoidable consequence of the settled "no grading endpoint,
no backend engine load" design — but it's easy to make *worse than necessary* by fetching
everything the reveal will eventually need in the same initial request as a simplification,
when only `best_move` (for exact-match) needs to be present pre-attempt.

**How to avoid:**
Split the session/puzzle payload: ship only what grading actually needs before the attempt
(`best_move`, the position FEN, side to move) in the pre-attempt fetch; fetch or reveal the
blob-derived classification, `pv`, and tactic-stepper data lazily, **after** the attempt is
submitted. This doesn't make the feature cheat-proof (it can't be, given the design), but it
keeps the casual-inspection surface honest with what the solve screen is actually asking the
user to do at each step, and specifically protects the pre-move guess (which is otherwise
trivially defeatable by anyone who opens devtools once). Also keep pre-attempt components from
receiving these fields as props at all — a value never passed down can't leak through React
DevTools even before any network-level fix.

**Warning signs:**
Inspect the network response for the session-fetch call during code review: if it contains
`sm`/`su`/full `pv` arrays before the first move of the session is even attempted, this
pitfall is present.

**Phase to address:**
Phase 1 (session-fetch endpoint response shape — split solve vs. reveal payloads) and
Phase 2 (solve UI must not prefetch/hold reveal-only fields in pre-attempt component state).

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|------------------|
| Building a third from-scratch Stockfish Worker wrapper for grading instead of extending `useStockfishGradingEngine.ts` | Feels like a clean, single-purpose implementation | Re-discovers already-fixed bugs (searchmoves-must-be-last-clause silently swallowing movetime; illegal searchmoves silently dropped; multipv-index vs pv[0] keying; the stop-before-go race on the single-threaded engine) | Never — the sibling hook's single-move case (`searchmoves <one move>`) is a strict subset of what it already does |
| Denormalizing the flaw's answer key into `drill_item` at pool-entry time (snapshot, not live join) | Immune to mid-ladder answer-key drift (Pitfall 3); simpler queries | Can go stale relative to a genuinely-improved re-analysis; needs its own "does the source flaw still exist" reconciliation | Acceptable, and arguably the right default, **if** it's a conscious, documented choice (Pitfall 3) — not acceptable as an accidental side effect of a naive query |
| Hand-rolling `ply % 2` ownership or expected-score sigmoid math instead of importing `player_only_gate` / `eval_cp_to_expected_score` / `classify_best_move` | Fewer imports, feels self-contained | Silently diverges from the Library's own gem/great and flaw-severity definitions the moment either threshold is retuned there (both threshold surfaces are designed as single-retune-point code per their own docstrings) | Never |
| Adding a second `canvas-confetti` call site with new colors instead of generalizing `frontend/src/lib/confetti.ts`'s `fireWinConfetti`/`prefersReducedMotion` | Slightly faster to ship two visually-distinct celebrations | Bundle duplication risk, and a second `prefers-reduced-motion` check that can drift from the first if one gets fixed and not the other | Acceptable only as a thin variant (different colors/particle count) that still calls the same `prefersReducedMotion()` gate |

## Integration Gotchas

Internal-subsystem reuse, not external services — this feature's biggest integration risk is
with FlawChess's own eval/blob pipeline and existing client engine code, not any third party.

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| Vendored Stockfish WASM (`stockfish-18-lite-single.js`) | Put `movetime` before `searchmoves` in the `go` command | `searchmoves` must be the LAST clause — the engine silently swallows everything after it into the move list, so a wrong order means movetime never actually limits the search (fixed once already in `useStockfishGradingEngine.ts`, comment cites the exact bug) |
| `game_flaws` / `game_positions` join for the answer key | Reading `eval_cp` and `best_move` off the same row as if both describe the same position | `eval_cp` is post-move (position AFTER `ply`); `best_move`/`pv` are decision-ply-keyed (position BEFORE `ply`) — see Pitfall 2 |
| `game_best_moves` as the red-herring source | Re-deriving "non-gem" via a fresh margin check instead of `classify_best_move`/`best_move_tier_sql` | Reuse those functions so "herring" (neither gem nor great) stays consistent with what the Library's own "has gem/great" filter already shows for the same rows |
| `VariationTree.tsx` reuse for the reveal stepper | Assuming `missed_pv_lines` and `allowed_pv_lines` share one uniform node shape when adapting them to the component's expected props | The two lines have different POV/indexing conventions per `forcing_line_gate.py`'s own documented asymmetry (missed = decision-ply POV, allowed = flaw_ply+1 POV) — map each orientation explicitly, don't assume symmetry |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Session-composition query re-joins `game_flaws` + `game_positions` + `game_best_moves` + winnability floor from scratch on every session load with no index-aware filtering | Slow `/train` session start for users with large histories | Reuse the existing `ix_game_flaws_user_severity` index pattern and EXISTS-based composition already established in `library_repository.py`/`query_utils.py`, rather than a fresh full-scan query | Users with several thousand imported games and a large flaw count |
| Recreating a fresh Stockfish `Worker` per puzzle instead of one session-scoped worker | Every non-exact-match answer pays a full WASM cold-start (compile + `uci`/`uciok`/`isready`/`readyok` round trip) on top of the search itself | Instantiate one grading worker when the session starts (or on `/train` mount) and reuse it across all puzzles in that session, mirroring the sibling hook's single-instance-per-mount lifecycle | Any session with more than one non-exact-match puzzle — i.e. almost every real session |

## Security Mistakes

This feature has low adversarial stakes (single-user WDL/blunder data, no leaderboard in v1),
so the notable item is forward-looking rather than urgent.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Treating the structural answer-key leak (Pitfall 9) as acceptable forever rather than as a v1-scoped tradeoff | Fine today (no competitive integrity at stake — the v2 leaderboard is explicitly deferred behind a ≥10–15 weekly-active-trainer trigger); becomes a real integrity problem the moment any point-comparison-across-users feature ships, since scores are trivially game-able client-side | Document the tradeoff explicitly now so it's revisited (not rediscovered) if/when the leaderboard is built — a server-side grading endpoint would need to be added at that point, which the seed already flags as the rejected-for-v1 alternative |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| Conflating "no analyzed games yet" with "games exist but blob/answer-key coverage hasn't caught up" (Pitfall 5) in the empty state | A user with real, fresh blunders sees a generic "import more games" message that doesn't match their actual situation, or gets a confusingly thin first session | Give the "still analyzing / catching up" state its own honest copy, distinct from the true zero-games cold state |
| Parked count styled/positioned as a failure metric | Undermines the design's explicit "never a failure state" intent | Use a neutral/muted color (not the WDL-loss red) and place it descriptively, not as a warning badge |
| Grading latency (potentially several seconds on the WASM cold path, per Pitfall 8/10) with no loading affordance | Reads as the app freezing on mobile, especially on the session's first non-exact-match answer | Show explicit "checking your move…" feedback tied to the actual `isGrading` state (the sibling hook already exposes this), and warm the engine before it's needed |
| First-session-back after a gap rated the same as any other session (Pitfall 6) | Compounds streak loss with a red/low score right when a lapsed user most needs encouragement to continue | Not a scoring-mechanic change — just don't let the streak-reset and the session color-rating land in the same visual beat without separation |
| Reveal's "open analysis board" deep link not landing on the exact flaw position/orientation | User loses context switching from the puzzle to the analysis board, undermining "see what actually happened" | Deep-link with the specific FEN/ply/orientation already used to render the puzzle, not a generic game-open |

## "Looks Done But Isn't" Checklist

- [ ] **Pool-entry / red-herring query:** Uses `player_only_gate`/`is_opponent_expr` from
  `query_utils.py` — verify by grepping the new query code for a raw `ply % 2`, which should
  not exist anywhere in Train's backend.
- [ ] **Winnability floor:** Reads the eval of the position *before* the flaw move, not the
  flaw row's own (post-move-shifted) `eval_cp` — verify against the `/analysis` board for a
  handful of sampled drill items.
- [ ] **Answer-key freshness policy:** A drill item's relationship to live `game_flaws` data
  (snapshot vs. live join) is an explicit, documented decision — not whatever a straightforward
  query happened to produce.
- [ ] **Game-deletion behavior:** What happens to drill items when their source game is deleted
  (guest prune or user re-import) is a deliberate, tested decision, not an unexamined CASCADE.
- [ ] **Grading worker lifecycle:** One Worker instance persists for the whole Train session
  (not recreated per puzzle) — verify by watching the Network/Performance panel for repeated
  WASM module loads within a single session.
- [ ] **Schedule day-boundary convention:** Explicitly chosen (UTC-approximation-and-documented,
  or a real offset field) — not left as "whatever `datetime.now(timezone.utc)` naturally
  produces," since there is no existing per-user timezone precedent anywhere in this codebase.
- [ ] **Pre-attempt payload:** The network response fetched before the user's guess/move does
  not already contain `missed_pv_lines`'s `s`/`sm`/`su` fields or the full reveal `pv` —
  verify via the Network tab on a fresh session load.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|-----------------|------------------|
| Answer-key drift discovered post-launch (Pitfall 3) | LOW–MEDIUM | If snapshotted: add a re-validation pass on session load that re-checks the snapshot against current `game_flaws` and re-syncs or flags a diff. If live-joined: no recovery needed, but audit historical solve-log entries for consistency before trusting aggregate stats. |
| Mastery progress lost to game deletion (Pitfall 4) | HIGH (data is genuinely gone) | No automatic recovery once games are deleted — communicate honestly in the UI going forward; this mirrors the guest-cleanup job's own "no un-delete" philosophy, so treat it as an accepted, documented product tradeoff rather than a bug to patch retroactively. |
| Timezone mismatch causing incorrect due dates/streak resets (Pitfall 7) | MEDIUM | Add the deferred offset field, backfill a best-guess (e.g. from `last_activity` clustering or a one-time prompt), and run a one-time streak/due-date repair pass; communicate the fix ("we recalculated your schedule") rather than silently shifting dates. |
| WASM grading false-reject/false-accept clustering near MISTAKE_DROP (Pitfall 8) | LOW | Widen the grading movetime budget (mirroring the sibling hook's 4000ms cap) and/or add a small documented tolerance band around the threshold; re-run a headless measurement pass (per the project's existing WASM-verification precedent) before retuning. |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| 1. Ply-parity ownership reuse | Phase 1 | Grep for raw `ply % 2` in Train backend code; unit test with both a white-playing and black-playing fixture user |
| 2. Post-move eval shift on winnability floor | Phase 1 | Cross-check sampled drill items' winnability against the `/analysis` board's pre-move eval |
| 3. Answer-key drift mid-ladder | Phase 1 | Explicit schema-design decision documented in the plan; test a flaw whose blob is re-written between two sessions |
| 4. Source-game deletion orphans progress | Phase 1 (schema) / Phase 3 (messaging) | Test both the guest-prune path and the user "delete all games + re-import" path against an in-progress drill item |
| 5. Tier-4 blob backfill starves session composition | Phase 1 (composition logic) / Phase 3 (cold-state copy) | Simulate a user with flaws but no blob coverage; verify session doesn't come up empty/degenerate without explanation |
| 6. Returning-user re-entry shock | Phase 3 | UAT a "lapsed for 3+ weeks" persona through their comeback session and streak-reset messaging |
| 7. Missing timezone infra | Phase 1 (ladder) / Phase 3 (schedule UI) | QA a non-UTC persona's weekday picker and weekly-streak boundary |
| 8. WASM grading vs. server answer key near threshold | Phase 2 | Headless WASM measurement pass on a curated near-threshold position set before ship |
| 9. Structural answer-key leak in the pre-attempt payload | Phase 1 (payload shape) / Phase 2 (UI) | Inspect Network tab response before first attempt in a session; confirm reveal-only fields are absent |
| Reimplementing the grading worker from scratch | Phase 2 | Code review: grading path extends `useStockfishGradingEngine.ts`, not a new Worker wrapper |
| Session-composition N-query performance | Phase 1 | Load-test session-fetch against a large-history fixture user |
| Per-puzzle Worker recreation | Phase 2 | Performance-panel check: one WASM module load per session, not per puzzle |
| Parked-count shame | Phase 3 | Visual review against theme.ts semantic color usage (no danger/red band on parked count) |

## Sources

- `app/models/game_flaw.py` — ownership convention, `missed_pv_lines`/`allowed_pv_lines`
  deferred JSONB columns, tactic-family comments.
- `app/services/eval_apply.py` — post-move eval shift (SEED-044), `best_move` overwrite
  behavior, `_classify_and_fill_oracle` diff/upsert history.
- `app/services/forcing_line_gate.py` — `missed_pv_lines`/`allowed_pv_lines` node-0 shape,
  POV/indexing asymmetry between the two orientations.
- `app/services/best_move_candidates.py` — gem/great classification, `mover_color_for_ply`,
  the shared expected-score sigmoid helper.
- `app/repositories/query_utils.py` — `player_only_gate`/`is_opponent_expr`, with an explicit
  comment referencing a prior ownership bug in this exact area.
- `app/repositories/library_repository.py` — `is_decided_lost`/`decided_lost_sql` (an
  adjacent-but-distinct "already lost" concept, not to be confused with Train's winnability
  floor), `player_only_gate` usage precedent.
- `app/services/guest_cleanup_service.py` — 30-day guest-inactivity prune, cascade scope,
  `User` row survival vs. game/data deletion.
- `app/repositories/game_repository.py` — `delete_all_games_for_user` (real DELETE, not
  soft-delete), `bulk_insert_games`'s `ON CONFLICT DO NOTHING` (confirms normal incremental
  sync preserves `Game.id`, only the explicit delete-then-reimport path breaks it).
- `frontend/src/hooks/useStockfishGradingEngine.ts` — the existing single-move-grading-capable
  Stockfish Worker hook, its documented UCI bugs/fixes, and its measured movetime cap.
- `frontend/src/lib/confetti.ts` — existing `canvas-confetti` wrapper and
  `prefers-reduced-motion` handling, available for reuse.
- `frontend/src/App.tsx` — `IMPORT_EXEMPT_ROUTES`/`isNavLocked` nav-gating pattern Train must
  follow (not itself a pitfall, but confirms the gating mechanism this feature depends on).
- Project memory notes: `project_eval_nondeterminism.md` (eval_cp not reproducible across
  machines), `project_tier4_blob_backfill_measurement.md` and
  `project_bestmove_backfill_two_populations.md` (blob/best-move backfill is opportunistic,
  two separate populations, no ETA), `project_atomic_eval_submit_incremental_lease.md` (dedup
  transplants and tier-4 `[]`-sentinels affecting blob permanence), `project_gem_great_user_scoping.md`
  (ply-parity ownership convention confirmed elsewhere in the app).
- `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` — the settled design
  itself (source of the Phase Decomposition and Data Dependencies this document maps against).

---
*Pitfalls research for: v2.9 Train — spaced-repetition blunder drills*
*Researched: 2026-07-25*
