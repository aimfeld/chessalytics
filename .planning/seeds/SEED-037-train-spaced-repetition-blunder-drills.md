---
id: SEED-037
status: dormant
planted: 2026-06-04
planted_during: 2026-06-04 split of SEED-010 into Library (SEED-036) + Train (this seed)
refined: 2026-07-25 (gsd-explore round 6 — motif layer removed, name/nav settled)
lineage: split from SEED-010 (planted 2026-05-01, reworked 2026-06-03); SEED-010 closed
trigger_when: user invokes `/gsd-new-milestone` for Train (all data dependencies already shipped as of v2.5)
scope: milestone (multi-phase)
depends_on: none open — the original SEED-036 dependencies are satisfied or obsolete (see Data Dependencies)
---

# SEED-037: Train — spaced-repetition blunder drills

> **Lineage.** Split out of SEED-010 (closed) on 2026-06-04. Refined 2026-07-23 and again
> on 2026-07-25 in gsd-explore sessions: the design below is *settled*, not provisional.
> The old seed's premises (best-move endpoint dependency, FSRS adoption, GM-coach
> prototype loop, motif multiple-choice quiz) are superseded — see Rejected Alternatives.

## Why This Matters

The **retention play** — the feature that turns FlawChess from an analysis tool into a
habit. Analysis tells a user *where* they went wrong; training makes them *stop* going
wrong by re-presenting their own blunders on a spaced schedule until the pattern sticks.
Aimchess monetizes essentially this at $7.99/mo; FlawChess differentiates on price
(free/open).

## Settled Design (2026-07-23, revised 2026-07-25)

### Training model: true spaced repetition, session-gated

Per-item due dates, but sessions happen on a **user-configured weekly schedule**
(weekday picker + N puzzles per session). Due dates snap to the first scheduled session
on/after the ideal date. The schedule is a commitment device, not a lock — an ad-hoc
"train now" session on an off day is allowed and draws the same queue.

### Scheduler: rolled our own (FSRS rejected)

A pure-function **interval ladder keyed by mastery streak**:

- streak 0 → due next scheduled session
- streak 1 → due ~3 days out
- streak 2 → due ~10 days out
- each due date snapped forward to the next scheduled session day

Wrong answer → streak resets to 0, item returns next session. State per item: `streak`,
`due_date` (plus a solve log). Fully testable, no dependency.

### Session composition: exactly N, cap + backfill, ~25% red herrings

Every session is exactly N while material lasts:

- **~75% of N — SR items**: due items **most-overdue first**; if due < slots, pad by
  **introducing new flaws** from the pool (recent games preferred). Backlogs drain
  gradually; being caught up never yields an empty session (Anki's model).
- **~25% of N — red herrings**: one-off fillers drawn fresh from the herring source
  (below), recency-weighted, no repeats until the source is exhausted. No streak/due
  bookkeeping — they vaccinate against "there's always a killer move here"
  pattern-gaming, they're not material to master. Failing one just shows the reveal.

### Puzzle taxonomy: three types, one grading rule

All puzzles look identical to the solver ("play the best move you can find") and share
one grading rule; they differ only in sourcing and reveal messaging:

1. **Sharp find-the-move** — own blunder where the blob's best-vs-second expected-score
   gap is large: effectively only the best move grades correct.
2. **Avoid-the-blunder** — own blunder where best-vs-second is close: several moves
   grade correct; the point is not repeating the mistake.
3. **Red herring** — a position the user handled *well* with several roughly-equal
   options, sourced from **non-gem `game_best_moves` candidate rows** (user played the
   stored best move out-of-book, best ≈ second — the exact complement of gem
   detection). Winnability-floor applies. No new analysis needed.

The best-vs-second gap is a **classifier, not an entry gate** — soft-answer blunders
become type 2 instead of being excluded, so the pool grows.

### Pool entry (which flaws qualify)

- **Blunders only** (v1). Mistakes are a later pool-expansion lever if active users run dry.
- **User's own flaws only** — `game_flaws` stores both players; filter by ply parity vs
  `user_color`.
- **Winnability floor** — exclude positions already lost before the blunder (expected
  score below ~20–25%, via `eval_cp_to_expected_score`). Drilling hopeless positions
  teaches nothing.
- **Answer key present** — require stored `best_move` + `pv` AND a non-empty
  `game_flaws.missed_pv_lines` blob (node 0 carries best `b`/`bm` vs second-best
  `s`/`sm`/`su` — MultiPV-2 at the decision position, Phase 141). The blob classifies
  the puzzle as sharp vs avoid-the-blunder (see taxonomy above). Blobs are tier-4
  opportunistic (new games ~100% inline, backlog still filling), so this is a
  present-data filter, not a blocker.
- **Recency-weighted introduction** — prefer flaws from recent games when padding
  sessions with new items. No Zobrist dedup (repeat blunders may coexist).

### Pool exit — two doors: mastered, or parked

**Door A — mastered.** Retire after **3 consecutive spaced correct solves** (correct
solves in 3 separate sessions; a miss resets to 0). Simple to explain in UI ("2/3
mastered"). The ladder decides *when* reps happen; this counter decides *retirement*.

**Door B — parked (the fail-out escape valve).** An item failed **N times (constant,
start at 3) with zero correct solves ever** is parked as *"too hard for now"* and leaves
the queue. Without this, an unsolvable item never leaves streak 0, so it stays
permanently most-overdue and reappears **every single session**, crowding out learnable
material. This is why there is **no tactic-depth cap on pool entry** (rejected below):
depth is only one way an item can be unsolvable — a deflection-in-9, an untagged sharp
blunder above the user's level, and a position needing a plan rather than a move all fail
the same way, and the fail counter catches all three without guessing which.

- Item state gains `fail_count`; a single correct solve zeroes it permanently (it is a
  *never-solved* counter, not a rolling one, so a mastered-then-lapsed item is never
  parked).
- **Parked items do not return in v1** — no auto-return after a cooldown, no manual
  un-park control. Auto-return re-creates the clog; un-park UI is a knob nobody asks for
  before they have seen the count. Cooldown re-introduction is a v2 lever.
- Surfaced honestly on the progress screen next to the mastered count ("3 parked — too
  hard for now"), never as a failure state.

### Solve loop

- **Assess first (binary guess)**: before moving, the user commits to *"one critical
  move"* vs *"several fine moves"* — pure position judgment, worth a point. Ground
  truth comes from the same blob classifier (sharp → critical; avoid-the-blunder and
  herrings → several). Deliberately NOT a 3-way type guess: blunder-history vs herring
  is episodic memory, not chess skill, and would add noise to the score.
- **Then always play a move — single move, one attempt.** Even on a "several fine
  moves" claim: choosing a concrete move in a quiet position is real training. No
  multi-move lines (pv-line quality from eval data isn't curated like lichess puzzles).
- **Lichess-minimal solve screen**: board oriented to user's color, opponent's last move
  animated + highlighted, "White/Black to move" prompt. No eval bar, no game metadata —
  nothing that leaks the answer or severity.
- **Grading is fully client-side and uniform across all three puzzle types**: exact
  match to stored `best_move` → instant correct; any other move → the vendored client
  Stockfish WASM (shipped for Bot Play, v2.3) evals it ~1s. **Correct = the played
  move's expected-score drop vs best stays below the project's existing MISTAKE
  threshold** (reuse the flaw-taxonomy constants; inaccuracies pass). Sharp puzzles
  still effectively require the best move because second-best is a mistake there by
  construction. No grading endpoint, no backend engine load. Backend only **records
  results** (streak, due date, solve log).
- **Reveal (after the attempt)**: guess verdict + move verdict, original blunder vs best
  line (pv shown passively as a playable/steppable line), plus the game card and a deep
  link into the analysis board ("see what actually happened"). Full game context lives
  here, not on the solve screen. Herring reveal: "you handled this well in the game —
  several moves are fine"; blunder reveal names the original mistake. Tactic-tagged
  flaws additionally get the opt-in line stepper (below).

### Tactic line stepping (opt-in, on the reveal — replaces the motif layer)

On tactic-tagged flaws the reveal offers a **"step through the line" control with the
tactic ply countdown (depth indicator)**, reusing the analysis board's existing
missed/allowed tactic line-stepping UI (`VariationTree.tsx` — `tacticDepthBadge`,
`missedDepth`/`allowedDepth`). Missed-tactic → step the tactic the user missed
(`missed_pv_lines`); allowed-tactic → step the opponent's punishment
(`allowed_pv_lines`). The stepper already handles both orientations, so covering both is
free symmetry rather than extra work.

Design constraints:

- **Always offered when tagged, never auto-triggered.** No escalation branch, no
  repeat-blunder detection, no interruption. One uniform affordance on every tagged
  reveal; the solve loop's rhythm (attempt → reveal → Next) is unchanged for anyone who
  ignores it.
- **Embedded in the reveal, not a navigation.** Stepping must not cost the user their
  session. The separate "open analysis board" deep link stays for people who want the
  full game.
- **Motif name is a label, not a question** — shown as reveal copy ("missed tactic:
  deflection, in 5"), with no quiz and no distractor generation.

**Known deferral (be honest about it):** the motif layer existed to counter learning
*the card, not the concept*. An opt-in stepper is weaker medicine — a user can click Next
forever. The real cures are both parked in Deferred/v2 (motif-aggregated progress,
motif-variation injection). v1 knowingly ships without a forcing function here.

### Scoring & gamification (solid learning, light game layer)

- **Per puzzle: 0–2 points, independent** — +1 correct guess, +1 correct move. Correct
  guess with a failed move still earns 1 (right judgment, failed execution).
- **Session result**: total score / 2N as a percentage, mapped to a green/yellow/red
  rating (theme.ts colors; band thresholds are named constants, planner tunes — e.g.
  ≥80% green, ≥50% yellow).
- **Scoring never touches the SR mechanics**: mastery streak and due dates are driven by
  move correctness alone. The guess layer is metacognition + score only, so pool
  behavior stays predictable.
- **Weekly streak** — N consecutive weeks with every scheduled session completed.
  Naturally forgiving (the user sets their own schedule), so no freeze-token mechanics.
  Guiding rule for all gamification here (self-determination theory): **competence
  feedback yes, behavior control no** — no guilt mechanics, no decaying rewards.
- **Two celebration moments (v1)**:
  - **Confetti on a green-rated session** (session-end burst; `prefers-reduced-motion`
    safe; canvas-confetti-class tiny lib or CSS).
  - **"Flaw fixed!" moment** when an item hits 3/3 and retires — distinct celebration
    with the position thumbnail. The core product promise made visceral; the higher-
    leverage moment of the two.
- **v1 gamification inventory**: per-puzzle points, session score + color rating, weekly
  streak, mastered count, parked count, the two celebrations. No XP, leagues, or badges
  — the learning is the product. (The "patterns named" tally died with the motif quiz;
  0–2 per puzzle is now the only per-puzzle score, which makes sessions trivially
  comparable.)

### Schedule & reminders (v1: in-app only)

Settings: weekday picker + N per session. Surfacing: nav badge / dashboard card on
session days ("12 puzzles waiting") + the weekly-streak counter (see Scoring &
gamification). **No push, no email in v1** — PWA push (service worker, VAPID,
subscription storage, scheduled sender) is its own project; defer to v2.

### Empty/cold states

- No analyzed games yet → point to import/analysis (reuse Library readiness patterns).
- Pool exhausted (everything mastered, nothing due) → celebrate + offer mistakes-tier
  expansion later; never a dead screen.

## Rejected Alternatives (decision log 2026-07-23)

- **FSRS** — rejected. Item lifetime is ~3–6 reps, grading is binary, and due dates get
  quantized to scheduled session days anyway; FSRS's per-user memory-model fitting has
  nothing to bite on. The interval ladder is honest and testable.
- **`POST /api/analysis/best-move` grading endpoint** (the original SEED-036 dependency,
  never built) — obsolete. The full-game eval pipeline (v1.26+) already stores
  `best_move`+`pv` per ply, and client Stockfish WASM grades arbitrary moves locally.
- **Session-mastery / Leitner-lite model** (no due dates) — considered; user chose true
  SR with per-item due dates.
- **Retry on wrong move** — rejected; one attempt, matching "in the real game you got
  one chance". Reveal follows immediately.
- **Eval bar / game metadata during solving** — rejected (leaks answer/severity);
  context moves to the reveal screen.
- **GM-coach collaboration loop** — dropped from this seed. The `/train-sketch`
  prototype built for it was deleted on 2026-07-23 (route + `frontend/src/pages/TrainSketch/`).
- **Zobrist dedup of repeat blunders** — not necessary.
- **Sharp answer key as an entry GATE** (round-1 decision) — superseded in round 2: the
  best-vs-second gap classifies puzzle type instead of excluding soft-answer blunders.
- **Per-type grading thresholds** — rejected; one uniform not-a-mistake rule keeps the
  solver-facing contract honest and the grading code type-blind.
- **SR-tracking red herrings** (streaks/due dates, or fail-promotes-to-pool) — rejected;
  herrings are one-off fillers.
- **3-way type guess** (sharp / avoid-blunder / herring) — rejected; types 2 and 3 are
  indistinguishable from the board (they differ by user history, not position
  character), so the third option would test memory, not judgment.
- **"Declare herring = done, no move"** — rejected; a move is always required, the loop
  stays uniform and quiet-position move choice is itself training.
- **Move-gated scoring** (wrong move = 0 regardless of guess) — rejected in favor of
  independent guess/move points.
- **Per-session streak + freeze tokens** — rejected; the weekly streak over a
  user-configured schedule is self-forgiving without freeze UX.
- **Leaderboard in v1 (hidden-gated)** — rejected; infrastructure for a feature that
  may idle for months. Deferred with an explicit active-user trigger instead.
- **Motif multiple-choice quiz** (round 4) — rejected 2026-07-25. Tedious across a long
  session, thin material per motif, and unreliable ground truth: tactics tagged at
  depth > 8 are genuinely hard to *see*, let alone name, so the quiz would punish
  perception rather than test schema. Replaced by the opt-in line stepper.
- **Escalated auto-walkthrough on repeat-blunder** (round 4) — rejected 2026-07-25 along
  with the quiz. It bought a forcing function at the cost of an entire conditional
  branch (repeat-blunder move comparison, tagged-vs-untagged split, an interrupt in the
  reveal). One always-available opt-in control is simpler and never fights the solve
  rhythm. Accepted cost: the user who most needs the walkthrough is the least likely to
  open it.
- **Tactic-depth cap on pool entry** — rejected 2026-07-25 in favour of the fail-out
  valve. A cap guesses at which items are unsolvable using one proxy; the fail counter
  *observes* unsolvability directly and generalises to untagged sharp blunders and
  positions above the user's level. No `MAX_DRILL_TACTIC_DEPTH` constant.
- **Auto-returning parked items after a cooldown** — rejected for v1; it re-creates the
  queue clog parking exists to prevent. v2 lever.
- **Manual un-park control in v1** — rejected; a knob nobody asks for before they have
  seen the parked count.
- **Shrinking the mobile nav font to fit six labels** — rejected 2026-07-25. The bottom
  bar is already at `text-xs`, one step below CLAUDE.md's `text-sm` floor, and the rule
  says fix the layout, not the type. The measurement says six labels fit anyway.
- **Demoting Bots to the More drawer to make room for Train** — rejected; Bots is a
  guest-acquisition surface and losing one-tap mobile reach costs more than a tighter
  bar does.
- **Alternative feature names** (*Fix / FlawFix*, *Rematch / Comebacks*, *Drills /
  Practice*) — rejected 2026-07-25; the name is **Train**.

## Data Dependencies (all shipped)

- `game_flaws` — materialized blunders/mistakes for both players (v1.24/v1.27); ply
  parity gives ownership.
- `game_positions.best_move` / `.pv` — full-game eval pipeline (v1.26+); the answer key.
- `game_flaws.missed_pv_lines` / `.allowed_pv_lines` — write-once JSONB blobs
  (Phase 141); `missed_pv_lines` node 0 has best (`b`/`bm`) + second-best
  (`s`/`sm`/`su`) — the sharp-vs-soft puzzle classifier; both lines feed the opt-in
  reveal stepper. Deferred columns: load via `undefer()`. Tier-4 opportunistic coverage.
- `game_flaws.missed_tactic_motif` / `.allowed_tactic_motif` (+ confidence/depth/piece)
  — **demoted 2026-07-25** from "gate + content of the motif layer" to a reveal label and
  the trigger for showing the opt-in stepper. No distractor enum needed. Depth is
  displayed, never used as a filter.
- Analysis board tactic line-stepping UI (`frontend/src/components/analysis/VariationTree.tsx`
  — `tacticDepthBadge`, `missedDepth`/`allowedDepth`) — reuse for the opt-in reveal
  stepper; already handles both missed and allowed orientations.
- `game_best_moves` — MultiPV-2 best/second eval for plies where the user played the
  stored best move out-of-book (v2.4); **non-gem rows (best ≈ second) are the red
  herring source**. Same opportunistic-backfill caveat (two populations).
- Client Stockfish WASM — vendored for Bot Play (v2.3); the grading engine.
- `eval_cp_to_expected_score` (`app/services/eval_utils.py`) — expected-score mapping
  for the winnability floor and grading verdicts.
- Analysis board — the reveal's deep-link target.

## Name & navigation — settled 2026-07-25

The feature is **Train**. Not a working name — the decision is closed, and the
alternatives (*Fix / FlawFix*, *Rematch / Comebacks*, *Drills / Practice*) are rejected.

Route `/train`, placed **between Library and Bots** on all three nav surfaces. The old
seed's `Import · Openings · Endgames · Library · Train` string was stale — there is no
Import nav entry, and mobile has its own item list.

| Surface | Const / component (`frontend/src/App.tsx`) | Result |
|---|---|---|
| Desktop header | `NAV_ITEMS` → `NavHeader` | `Library · Train · Bots · Openings · Endgames` (+ `Admin` for superusers) |
| Mobile bottom bar | `BOTTOM_NAV_ITEMS` → `MobileBottomBar` | same five + the existing `More` button = **6 tap targets** |
| Mobile more drawer | `NAV_ITEMS` → `MobileMoreDrawer` | same five (+ `Admin`) |

Implementation notes for the planner:

- Also needs a `ROUTE_TITLES['/train'] = 'Train'` entry and a `/train` clause in
  `isActive()` (prefix match, since the solve loop will own sub-routes).
- Test IDs follow the shipped convention, derived from the label:
  `nav-train` / `mobile-nav-train` / `drawer-nav-train`.
- **Train is import-gated.** Keep `/train` OUT of `IMPORT_EXEMPT_ROUTES` so `isNavLocked`
  greys it out until the user has games AND import tier 1 is complete — it needs analyzed
  flaws, so it must behave like Openings/Endgames, not like Library/Bots.
- Icon: TBD by the planner (lucide `Target` / `Dumbbell` / `Swords` are the candidates).
- Consider whether Train earns a first-visit notification dot in the existing
  Openings → Endgames dot chain (`useUserFlag`), or stays out of it.

**Six targets fit at the size already shipped.** The bar's links are `flex-1 ... py-2`
with no horizontal padding, so the whole cell is available to the label; at `text-xs`
the longest labels ("Openings"/"Endgames") measure ~50px against 53px per cell at 320px,
60px at 360px, 65px at 390px. **Do not shrink the font to buy room** — the bar is already
one step below the project's `text-sm` floor, and CLAUDE.md's rule is to fix the layout,
not the type. UAT check at 320px; if it reads cramped, the fixes in order are tighter
`tracking`, then a shorter mobile-only label (`BOTTOM_NAV_ITEMS` is already a separate
const from `NAV_ITEMS`, so mobile labels can diverge from desktop for free).

## Phase Decomposition (rough sketch — planner refines)

1. **Pool + scheduler backend.** Drill-item data model (per-user per-flaw: `streak`,
   `due_date`, `fail_count`, parked flag, solve log), pool-entry query (blunders,
   ownership, winnability, blob present, recency — **no depth filter**), sharp-vs-soft
   blob classifier, red-herring source query (non-gem `game_best_moves`), interval
   ladder, both exit doors (3-spaced-correct → mastered, N-fails-never-solved → parked),
   session-composition endpoint (75/25 mix), result-recording endpoint.
2. **Train page + solve loop (frontend).** Route `/train` + nav on all three surfaces
   (see Name & navigation), session flow (queue → guess → solve → reveal → done),
   client-side grading via Stockfish WASM, reveal with verdicts + pv + game card +
   analysis-board link + **opt-in tactic line stepper** (reuse `VariationTree`),
   session-end score + color rating screen.
3. **Schedule + progress surface.** Weekday/N settings, nav badge + dashboard card,
   weekly streak, celebrations (green confetti + flaw-fixed moment), mastered and parked
   counts / retention stats, cold/empty states.

## Deferred / v2

- **Mistakes tier** — expand pool entry beyond blunders.
- **Un-parking** — bring parked ("too hard for now") items back after a long cooldown, or
  once the user's rating has climbed since the last failure. Deliberately absent from v1;
  revisit once real parked counts exist and we can see whether users want the second
  chance or just want the item gone.
- **Motif-aggregated progress** (candidate, not yet decided) — progress surface groups
  mastery by motif ("forks: 1/4, two failed twice"), turning stats into a diagnosis of
  conceptual weaknesses rather than an item counter.
- **Motif-variation injection** — when a user keeps failing a motif, prefer introducing
  *different* positions sharing that motif (variability of practice; the real cure for
  card-memorization — motif mastery should be demonstrated on unseen positions).
- **LLM one-line "why"** — pydantic-ai generated explanation sentence on the reveal
  ("the knight was overloaded defending e5 and the back rank"). Capability exists
  (endgame insights stack); cost/caching is the open question.
- **Weekly leaderboard** — trigger: **≥10–15 weekly-active trainers** (a leaderboard of
  4 advertises emptiness and permanently ranks the same person last). Opt-in, display
  names, metric = points earned this week (session scores aren't comparable across
  users' pools). Do not build hidden-gated in v1.
- **Milestone counters / personal-best callouts** (candidates) — every-10-flaws-fixed
  bursts, "best score in 4 weeks", score count-up. Considered in round 5, left out of
  v1; revisit if the session-end screen feels flat.
- **Push/email reminders** — PWA push subsystem or an email pipeline.
- **Half-credit / retry variants** — if one-attempt proves too harsh in practice.

## Breadcrumbs

- `app/services/eval_utils.py` — `eval_cp_to_expected_score` (Lichess sigmoid).
- `frontend/src/pages/Bots/` + vendored `stockfish-18-lite-single.js` — client engine
  integration to reuse for grading.
- `.planning/seeds/closed/SEED-036-library-page-milestone.md` — origin of the (now
  obsolete) best-move-endpoint plan.
- lichess-puzzler — https://github.com/ornicar/lichess-puzzler — reference for turning
  eval swings into training positions (sharpness filtering ideas).

## Source / decision log

**2026-07-25 round 6 (user + Claude, gsd-explore — motif layer removal + naming):** the
whole motif layer removed (multiple-choice quiz AND the escalated repeat-blunder
walkthrough), replaced by a single opt-in "step through the line" control with the tactic
ply countdown on the reveal, reusing the analysis board's `VariationTree` stepper and
covering both missed and allowed orientations. Consequences recorded: "patterns named"
tally dropped, `missed_tactic_motif` demoted to a label, repeat-blunder detection no
longer needed by any mechanic. The user's tactic-depth concern resolved *not* with a
depth cap but with a **fail-out escape valve** — N failures with zero correct solves
parks an item ("too hard for now"), which generalises past tactics and keeps unsolvable
items from permanently clogging the most-overdue queue; parked items do not return in v1.
Name settled as **Train** (alternatives rejected), route `/train`, placed between Library
and Bots on all three nav surfaces; the mobile bar goes to six tap targets with labels
intact at the shipped `text-xs` (font-shrinking rejected against CLAUDE.md's type floor;
measurement shows six fit down to 320px, flagged for UAT). Train is import-gated. The
learning-theory gap the motif layer was covering is explicitly recorded as a knowing v1
deferral, with motif-aggregated progress and motif-variation injection as the v2 cures.

**2026-07-23 round 5 (user + Claude, gamification):** weekly streak (all scheduled
sessions done that week; no freeze mechanics); v1 celebrations = confetti on green
session + "Flaw fixed!" retirement moment; SDT guardrail recorded (competence feedback
yes, behavior control no); weekly leaderboard deferred to v2 behind a ≥10–15
weekly-active-trainers trigger (opt-in, points-earned metric); milestone counters and
personal bests parked as candidates.

**2026-07-23 round 4 (user + Claude, learning-theory review) — SUPERSEDED by round 6,
kept for the rationale:** motif layer added to
counter card-memorization — multiple-choice motif quiz on missed-tactic flaws (correct
AND failed attempts, separate "patterns named" tally, plausible distractors), escalated
active walkthrough (click-through, reusing analysis-board line stepping) triggered only
by replaying the exact original blunder on a tactic-tagged flaw. Motif-aggregated
progress, motif-variation injection, and LLM explanations recorded as v2 candidates.

**2026-07-23 round 3 (user + Claude):** pre-move metacognition layer added — binary
"one critical move vs several fine moves" guess (3-way type guess rejected as
memory-testing), move always required, independent 0–2 scoring per puzzle, session
score → green/yellow/red rating, guess layer isolated from SR mechanics; gamification
capped at points/rating/streak/mastered-count.

**2026-07-23 round 2 (user + Claude):** red herrings promoted from v2 into v1 at ~25%
of each session (one-off fillers, sourced from non-gem `game_best_moves` rows);
avoid-the-blunder puzzle type added; sharp-answer-key gate demoted to a classifier fed
by `missed_pv_lines` blob MultiPV-2 data (resolves the round-1 open question); grading
unified to one not-a-mistake threshold across all types.

**2026-07-23 refinement (user + Claude, gsd-explore):** all Settled Design decisions
above; `/train-sketch` prototype deleted; GM-coach loop dropped; FSRS rejected in favor
of the streak-keyed interval ladder; grading moved fully client-side.

**2026-06-04 split (user + Claude):** SEED-010 split into SEED-036 (Library) +
SEED-037 (this seed); SEED-010 closed.

**2026-06-03 origin (SEED-010 "Deferred extensions"):** SR blunder-training as the
milestone after Library; red herrings deferred; name TBD.
