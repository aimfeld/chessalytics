---
phase: 215-frontend-god-file-decomposition
plan: 03
subsystem: ui
tags: [react-hooks, refactor, complexity, bot-game, mutation-testing, eslint-hooks]

requires:
  - phase: 215-frontend-god-file-decomposition (plan 01)
    provides: "eslint complexity/max-depth/max-statements enforced at error; CLI-override proof command"
provides:
  - "useBotGame() reduced from 544 to 233 counted lines, over five named sibling hooks (useBotGameClock, useBotGameDrawOffer, useBotGameEngineDispatch, useBotGameSnapshot, useBotGameMoves)"
  - "Full-encapsulation pattern for cross-hook refs/setters that avoids react-hooks/exhaustive-deps drift: never return a raw ref/setter unless a consumer genuinely needs the ref object itself (mirrors runBotTurnRef's plan-mandated design); otherwise wrap mutation in an exposed function and add unavoidable ref/setter crossings to the consuming callback's own deps array (behaviorally inert, since ref/setState identity never changes)"
  - "Four two-way mutation proofs demonstrating the 169-test oracle genuinely exercises each new sibling hook's seam"
affects: [215-04, 215-05, 215-06, 215-07, 215-08]

actuals:
  tokens: 42320
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Full encapsulation over raw ref exposure: a sub-hook that owns refs/setters ALSO owns every effect/callback that touches them internally, exposing only named functions (applyMoveDebit, resetClock, getClockBase, resetDrawOfferState, bumpConsecutiveLowScoreTurns, applyDrawOfferUpdate) — this is what keeps eslint-plugin-react-hooks's exhaustive-deps warning count at 0 across a hook-boundary split, since the plugin can only prove a ref/setState-setter is stable when it is created by a literal useRef()/useState() call in the SAME function scope that reads it."
    - "Where a raw ref genuinely must cross a hook boundary (matches the plan's own design for runBotTurnRef, and this plan's abortControllerRef/isBotThinking flowing the OTHER direction to break a circular option dependency), add the ref/setter to the CONSUMING callback's own dependency array — behaviorally inert (ref/setState identity is stable across the component's lifetime), but keeps the static exhaustive-deps proof honest without inventing wrapper functions for every crossing."
    - "Breaking circular hook-call dependencies: buildSnapshot takes movesSinceLastDecline as a plain call-time argument instead of closing over a ref owned by a hook that itself depends on THIS hook's output (useBotGameSnapshot must be called before useBotGameDrawOffer, but buildSnapshot needs a value that ref owns) — pass the value as a parameter at call sites that run after both hooks are wired, rather than threading the ref through hook options."

key-files:
  created:
    - frontend/src/hooks/useBotGameClock.ts
    - frontend/src/hooks/useBotGameDrawOffer.ts
    - frontend/src/hooks/useBotGameEngineDispatch.ts
    - frontend/src/hooks/useBotGameSnapshot.ts
    - frontend/src/hooks/useBotGameMoves.ts
  modified:
    - frontend/src/hooks/useBotGame.ts
    - frontend/src/hooks/__tests__/useBotGame.test.ts

key-decisions:
  - "Deviated from the plan's literal 'return the ref alongside the callback' suggestion for clockBaseRef/turnStartedAtRef/pausedAtRef (Task 1): full encapsulation instead, because returning those three refs raw (as first attempted) introduced 7 new react-hooks/exhaustive-deps warnings — the plugin cannot prove a ref returned from a custom hook is stable, unlike a same-scope useRef(). Followed the plan's literal suggestion only for runBotTurnRef (Task 2), where a matching same-scope useRef() origin was preserved on neither side, so a wrapper wasn't cheaper than the documented ref-crossing-plus-deps-array pattern."
  - "abortControllerRef and isBotThinking/setIsBotThinking stay owned by useBotGame.ts (not moved into useBotGameEngineDispatch) to avoid a circular option dependency: finalizeGame (useBotGameSnapshot) needs to abort/clear them directly, but engine-dispatch's own options already include finalizeGame — so engine-dispatch cannot ALSO own the things finalizeGame needs from it."
  - "buildSnapshot takes movesSinceLastDecline as a plain parameter, not a closed-over movesSinceLastDeclineRef — the ref is owned by useBotGameDrawOffer, which itself needs finalizeGame from useBotGameSnapshot as an option; threading the ref through as an option would create a circular hook-call ordering."
  - "useBotGameMoves.ts WAS needed (Task 3 step 2): after Task 2, useBotGame.ts was still 324 counted lines. Extracting it (updateViewedPly/commitMove/attemptMove/viewPly/returnToLive/resign) brought it to 233 — still over the 200 target, so a reasoned exemption is recorded below rather than inventing a sixth split."
  - "applyDrawOfferUpdate's mutation proof left the pre-existing 167-test suite fully green (no test anywhere asserted botDrawOffer becomes true) — per the plan's step-3 instruction, two tests were ADDED to the existing useBotGame.test.ts (never a parallel file) rather than accepting the gap. The new tests seed a resume snapshot with an engine-verified 58-ply, non-repeating game reaching chess.moveNumber() === 30 (BOT_DRAW_OFFER_MIN_FULLMOVE's exact boundary), then play 7 further rounds to also clear BOT_DRAW_OFFER_COOLDOWN_MOVES (6)."

requirements-completed: [SC-1, SC-2, SC-3]

coverage:
  - id: D1
    description: "useBotGame() reduced from 544 to 233 counted lines over five named sibling hooks; UseBotGameState keeps all 26 fields and the same return-literal key order"
    requirement: "SC-1"
    verification:
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'max-lines-per-function: [\"warn\", {\"max\": 200, \"skipBlankLines\": true, \"skipComments\": true}]' src/hooks/useBotGame*.ts (useBotGame at 233 lines, only warning; all five sibling hooks under 200)"
        status: pass
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\", 15]' --rule 'max-depth: [\"error\", 4]' --rule 'max-statements: [\"error\", 100]' src/hooks/useBotGame*.ts (exit 0)"
        status: pass
    human_judgment: true
    rationale: "useBotGame at 233 lines is a reasoned exemption, not a clean pass against the 200-line target — a human should confirm the residual (init/resume + refs/state + five sub-hook wiring calls + two cross-cutting effects + newGame + return) is genuinely irreducible wiring glue, matching the phase's own 'init/resume, state and sub-hook wiring' target shape, before this is accepted as satisfying SC-1."
  - id: D2
    description: "The 169-test oracle (167 pre-existing + 2 added) passes unchanged in intent; no existing test deleted or weakened; test diff is additions-only (130 insertions, 0 deletions); no mock factory edited"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/hooks/__tests__/useBotGame.test.ts src/pages/__tests__/Bots.test.tsx src/hooks/__tests__/useStoreBotGame.test.ts src/lib/__tests__/botGameSnapshot.test.ts src/lib/__tests__/botPendingStore.test.ts (169/169 passed)"
        status: pass
      - kind: other
        ref: "cd frontend && git diff --stat -- 'src/**/__tests__/*' 'src/**/*.test.*' (130 insertions(+), 0 deletions); git diff -- src/hooks/__tests__/useBotGame.test.ts | grep -c vi.mock (0)"
        status: pass
    human_judgment: false
  - id: D3
    description: "No data-testid/data-umami-event attributes added or removed (0/0); all 3 Sentry.captureException sites survive (now in useBotGameEngineDispatch.ts); zero eslint-disable comments; zero eslint.config.js baseline entries; zero lint:cognitive findings"
    requirement: "SC-3"
    verification:
      - kind: other
        ref: "cd frontend && grep -o 'data-testid=\"[^\"]*\"' src/hooks/useBotGame*.ts | wc -l (0); grep -c 'Sentry.captureException' src/hooks/useBotGame*.ts (sums to 3); grep -c eslint-disable src/hooks/useBotGame*.ts (sums to 0); grep -v '^\\s*//' eslint.config.js | grep -c useBotGame (0); npm run lint:cognitive | grep -i useBotGame (0 findings)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Four two-way mutation proofs (flagIfOutOfTime, runBotTurn, applyDrawOfferUpdate, buildSnapshot) demonstrate the oracle genuinely exercises each new sibling hook's seam, not merely importing it"
    verification:
      - kind: unit
        ref: "flagIfOutOfTime mutated to always return false: 2/120 failed (bot-clock timeout tests); restored 120/120"
        status: pass
      - kind: unit
        ref: "runBotTurn mutated to an immediate return: 35/120 failed; restored 120/120"
        status: pass
      - kind: unit
        ref: "applyDrawOfferUpdate mutated to a no-op: 0/120 failed (unguarded — 2 tests added), re-mutated: 2/122 failed; restored 122/122"
        status: pass
      - kind: unit
        ref: "buildSnapshot mutated to a fixed constant: 5/169 failed; restored 169/169"
        status: pass
    human_judgment: false
  - id: D5
    description: "npm run lint, npm run build, npm run knip all green; full frontend suite (npm test -- --run) green except the pre-existing, unrelated Train.guestGate.test.tsx flake (documented in 215-01/215-02-SUMMARY.md, re-confirmed here)"
    verification:
      - kind: other
        ref: "cd frontend && npm run lint (0 warnings); npm run build (0 errors); npm run knip (0 findings); npm test -- --run (3884/3886 passed; the 2 failures are Train.guestGate.test.tsx, unrelated to any file this plan touched)"
        status: pass
    human_judgment: false

duration: 68min
completed: 2026-09-03
status: complete
---

# Phase 215 Plan 03: useBotGame Hook Decomposition Summary

**`useBotGame()` split from 544 to 233 counted lines across five named sibling hooks (clock, draw-offer, engine-dispatch, snapshot/finalization, move-commit), with full ref/setState encapsulation across every hook boundary to keep `react-hooks/exhaustive-deps` at zero drift, four two-way mutation proofs, and two new tests closing a genuine coverage gap in the bot's own outgoing draw offer (Phase 183 D-07).**

## Performance

- **Duration:** ~68 min
- **Started:** 2026-09-03T21:38Z (approx, first read after 215-02 landed)
- **Completed:** 2026-09-03T22:44:07Z
- **Tasks:** 3
- **Files modified:** 7 (5 created, 2 modified)

## Accomplishments

- `useBotGameClock.ts` created (Task 1): owns `clockBaseRef`/`turnStartedAtRef`/`pausedAtRef`/`whiteClockMs`/`blackClockMs`, the turn-anchor mount-init effect, the clock-tick effect, and the hidden-tab pause effect — all fully encapsulated, exposing only `applyMoveDebit`/`resetClock`/`getClockBase`/`resetTurnAnchor`/`chargeableElapsedMs`/`flagIfOutOfTime`. useBotGame drops from 544 to 480 lines.
- `useBotGameEngineDispatch.ts` and `useBotGameDrawOffer.ts` created (Task 2): the bot-engine dispatch cluster (`poolRef`/`queueRef`/`runBotTurnRef`, the provider bring-up/teardown effect, the D-16 honest-clock `runBotTurn` dispatcher, all 3 Sentry capture sites) and both draw-offer directions (user-initiated resolution, the bot's own outgoing offer, the resign-hysteresis counter). `useBotGameDrawOffer` is wired before `useBotGameEngineDispatch` since `runBotTurn`'s grade continuation calls its exposed `bumpConsecutiveLowScoreTurns`/`applyDrawOfferUpdate`. useBotGame drops to 324 lines.
- `useBotGameSnapshot.ts` and `useBotGameMoves.ts` created (Task 3): finalization/persistence (`finalizeGame`, `buildSnapshot`, `hasLeftBookRef`, `hasFiredLowTimeRef`, `lastRootPracticalScoreRef`) and the move-commit path (`updateViewedPly`, `commitMove`, `attemptMove`, `viewPly`, `returnToLive`, `resign`). `useBotGameSnapshot` is wired FIRST among all five sub-hooks (everything else needs `finalizeGame`). useBotGame drops to 233 lines — still over the 200 target after both Task 3 extractions; a reasoned exemption is recorded (see Line-Count Exemption below) rather than inventing a sixth split.
- Four two-way mutation proofs (see Mutation Proofs below), one of which (`applyDrawOfferUpdate`) exposed a genuine coverage gap, closed by two new tests in the existing `useBotGame.test.ts`.
- `UseBotGameState`'s 26-field return literal is byte-identical to the pre-Phase-215 file at every commit; zero `data-testid`/`data-umami-event` attributes touched; all 3 `Sentry.captureException` sites survive (now consolidated in `useBotGameEngineDispatch.ts`); zero `eslint-disable` comments added; zero `eslint.config.js` baseline entries added.

## Task Commits

1. **Task 1: Extract useBotGameClock end to end through the 167-test oracle** — `3573ee907` (feat)
2. **Task 2: Extract the bot-engine dispatch cluster and the draw-offer cluster** — `e2a7d56fa` (feat)
3. **Task 3: Extract the snapshot cluster, land the 200-line target, and prove the seams with a two-way mutation test** — `197bbe1a8` (feat)

**Plan metadata:** this SUMMARY commit (pending)

## Files Created/Modified

- `frontend/src/hooks/useBotGameClock.ts` (new, 348 lines) — clock/turn-timing sub-hook
- `frontend/src/hooks/useBotGameDrawOffer.ts` (new, 322 lines) — draw-offer sub-hook (both directions)
- `frontend/src/hooks/useBotGameEngineDispatch.ts` (new, 557 lines) — bot-engine dispatch sub-hook
- `frontend/src/hooks/useBotGameSnapshot.ts` (new, 247 lines) — finalization/persistence sub-hook
- `frontend/src/hooks/useBotGameMoves.ts` (new, 337 lines) — move-commit sub-hook
- `frontend/src/hooks/useBotGame.ts` (modified) — reduced to init/resume, state, and five sub-hook wiring calls (233 counted lines)
- `frontend/src/hooks/__tests__/useBotGame.test.ts` (modified, +130/-0) — two new tests for the bot's own outgoing draw offer (D-07)

## Before/After Measurements

**`max-lines-per-function` on `useBotGame`:**

| Point | Lines |
|---|---|
| Before (pre-phase-215 baseline) | 544 |
| After Task 1 (clock extracted) | 480 |
| After Task 2 (engine-dispatch + draw-offer extracted) | 324 |
| After Task 3 (snapshot + moves extracted) — **final** | **233** |

No sibling hook exceeds 200 counted lines: `useBotGameClock` 109, `useBotGameDrawOffer` 106, `useBotGameEngineDispatch` 173 (its `runBotTurn` closure is the single largest inner function at 91 lines), `useBotGameMoves` 148, `useBotGameSnapshot` 79.

**`complexity`/`max-depth`/`max-statements`** (`npx eslint --no-inline-config --rule 'complexity: ["error", 15]' --rule 'max-depth: ["error", 4]' --rule 'max-statements: ["error", 100]' src/hooks/useBotGame*.ts`): exit 0 across all six files at every task checkpoint.

**`npm run lint:cognitive` (Sonar cognitive complexity) for `src/hooks/useBotGame*`:**

| Point | Breaches |
|---|---|
| Before (215-01 baseline for `useBotGame.ts`) | 0 |
| After this plan (all six files) | 0 |

**Sentry capture-site count** (`grep -c 'Sentry.captureException'`):

| Location | Count |
|---|---|
| `useBotGame.ts` (post-split) | 0 |
| `useBotGameClock.ts` | 0 |
| `useBotGameDrawOffer.ts` | 0 |
| `useBotGameEngineDispatch.ts` | 3 |
| `useBotGameSnapshot.ts` | 0 |
| `useBotGameMoves.ts` | 0 |
| **Total** | **3** |

Matches the pre-split count exactly — all three sites moved verbatim (in `resolveBookMove` and twice inside `runBotTurn`'s async body) into `useBotGameEngineDispatch.ts`.

**`react-hooks/exhaustive-deps` / `react-hooks/refs` warning count:** 0 at every commit in this plan (`npm run lint` exits with zero warnings throughout) — unchanged from the pre-split baseline of 0. See Key Decisions above for the encapsulation pattern that made this possible across five new hook-call boundaries.

## Mutation Proofs (Task 3, step 3)

One function per new sibling hook (plus the engine-dispatch cluster from Task 2), temporarily replaced with an immediate return / no-op, the 5-file oracle re-run, body restored, suite re-confirmed green.

| Function (module) | Mutated result | Failing tests | Restored result |
|---|---|---|---|
| `flagIfOutOfTime` (`useBotGameClock.ts`) | 118 passed, 2 failed | Both in `bot clock (D-15/D-16/D-18, amended SC1)`: "a bot search resolving after its clock has already run out flags the bot..." and "a user move attempted after their own clock has already run out flags the user..." | 120/120 passed |
| `runBotTurn` (`useBotGameEngineDispatch.ts`) | 85 passed, 35 failed | Spans `turn-gate`, `last-move highlight`, `pacing`, `end-conditions`, `bot clock`, all 4 `ABORT-02` sites, `hidden-tab time`, `resign-draw`, all of `book`, `finalize idempotency`, `pgn-export`, `resume-seed`, `prewarm-gate`, `snapshot-write`, all of `finalize-enqueue`, and 2 of the `styled resign wiring` tests — this is the highest-risk function in the phase (the async bot-turn dispatcher essentially everything routes through), matching 215-02's `handleLine` mutation-proof pattern |
| `applyDrawOfferUpdate` (`useBotGameDrawOffer.ts`) | **120 passed, 0 failed (first attempt) — UNGUARDED** | — | 120/120 passed |
| `applyDrawOfferUpdate`, re-run after adding 2 tests | 120 passed, 2 failed | Both new tests in `bot's own outgoing draw offer (D-07)`: "raises botDrawOffer once moveNumber >= 30 AND movesSinceOwnOffer >= 6 both hold, not before" and "acceptBotDraw() ends the game as an agreed draw once the bot has raised its own offer" | 122/122 passed |
| `buildSnapshot` (`useBotGameSnapshot.ts`) | 164 passed, 5 failed | Both `snapshot-write` tests and all 3 `hide-fold` tests (D-01/D-02 fold + pagehide equivalence) | 169/169 passed |

**Coverage gap closed:** `applyDrawOfferUpdate`'s first mutation run left the entire suite green — no existing test anywhere asserted `botDrawOffer` (the bot's own outgoing draw offer, Phase 183 D-07) ever becomes `true`. Per the plan's step-3 instruction, two tests were ADDED to the existing `src/hooks/__tests__/useBotGame.test.ts` (never a parallel file, never a rewrite of an existing test):
- `raises botDrawOffer once moveNumber >= 30 AND movesSinceOwnOffer >= 6 both hold, not before`
- `acceptBotDraw() ends the game as an agreed draw once the bot has raised its own offer`

Both seed a `resume` snapshot with an engine-verified (chess.js, this session, `node -e` script), 58-ply non-repeating game reaching `chess.moveNumber() === 30` — `BOT_DRAW_OFFER_MIN_FULLMOVE`'s exact boundary — then play 7 further rounds so `movesSinceOwnOffer`'s pre-increment read also clears `BOT_DRAW_OFFER_COOLDOWN_MOVES` (6) on the 7th round. Re-running the `applyDrawOfferUpdate` mutation after adding these tests correctly turned them red (see table above); the pre-existing 120 stayed green throughout, confirming the new tests are additive, not a rewrite.

## Line-Count Exemption

`useBotGame` measures **233 counted lines** (`max-lines-per-function`, `skipBlankLines`/`skipComments`) after both Task 3 extractions (`useBotGameSnapshot.ts`, `useBotGameMoves.ts`) — still over the 200-line target. Per 215-03-PLAN.md's Task 3 step 2 instruction ("If it is STILL over 200 after that, stop. Do not invent a sixth split to fit the number"), no further extraction was made.

**What remains and why it resists further splitting:**
- Init/resume seam (`initFromResume`, refs, state) — the constructor-shaped setup every sub-hook depends on; RESEARCH.md's own seam map classifies this as staying with the top-level hook body.
- Five sub-hook wiring calls (`useBotGameSnapshot`, `useBotGameClock`, `useBotGameDrawOffer`, `useBotGameMoves`, `useBotGameEngineDispatch`) — each is verbose (10-17 lines) because it passes an explicit, fully-named options object rather than a positional-args or grab-bag signature (CLAUDE.md's own stated preference); this verbosity IS the "sub-hook wiring" the phase's target shape ("useBotGame is reduced to init/resume, state and sub-hook wiring") explicitly anticipates keeping in the top-level hook, not a candidate for further extraction.
- `newGame()` (~40 lines) — calls into every one of the five sub-hooks' reset functions (`resetClock`, `resetDrawOfferState`) plus several local ref/state resets. Extracting it would require threading ~10+ cross-cutting values through a new options object to save ~40 lines — a textbook "split to fit a signature" CLAUDE.md and the plan's own framing explicitly reject.
- The hidden-tab snapshot-write effect (~30 lines) — reads `activeColor`/`settings.userColor` (local), `chargeableElapsedMs`/`getClockBase` (clock hook), `buildSnapshot` (snapshot hook), and `movesSinceLastDeclineRef` (draw-offer hook) — a genuinely cross-cutting effect with no single-cluster home.
- The bot-turn-trigger effect (~10 lines) and the final return statement (~30 lines) — both irreducibly small and cross-cutting.

No function within `useBotGame.ts` (including `newGame`, the largest remaining named function at ~40 lines) breaches `complexity`/`max-depth`/`max-statements`/cognitive-complexity — the residual size is line-count only, not a hidden complexity problem. 215-08 (phase-level verification) can carry this exemption forward as an SC-1 survivor entry, per the same precedent 214-04 established for `fetch_flaw_comparison`.

## Decisions Made

See `key-decisions` in the frontmatter above for the full list. The most consequential: the plan's own suggested design for cross-hook refs ("return the ref alongside the callback," written for `runBotTurnRef`) does NOT generalize safely to every ref that crosses a hook boundary — `eslint-plugin-react-hooks`'s `exhaustive-deps` rule can only prove a ref is stable when it is created by a literal `useRef()` call in the SAME function scope that reads it, so returning a ref from a hook and reading it in a DIFFERENT hook's `useCallback`/`useEffect` body triggers a new "missing dependency" warning on the receiving side — regardless of which side "owns" the `useRef()` call. Two compliant patterns were used throughout, chosen per-case:
1. **Full encapsulation** (clock refs, most draw-offer refs): the owning hook keeps every mutation internal, exposing only named functions. Zero cross-hook ref reads anywhere.
2. **Explicit ref-crossing + deps-array addition** (`runBotTurnRef`, `abortControllerRef`, `movesSinceLastDeclineRef`, `getClockBase`, etc. where a raw value/function genuinely needs to reach a consumer that isn't itself moving): add the crossing ref/setter/function to the CONSUMING callback's own dependency array. This is behaviorally inert (ref/setState identity never changes across a component's lifetime) but keeps ESLint's static proof honest.

Both patterns were applied consistently and documented in-line at every crossing (`// added (215-03 Task N): pre-split this was a direct same-scope useRef access...`), so a future reader can distinguish "genuinely new code" from "same operation, now expressed through a stable cross-hook reference."

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The plan's literal "return the ref" design for cross-hook refs caused a 7-warning react-hooks/exhaustive-deps drift**
- **Found during:** Task 1 (first implementation attempt at `useBotGameClock`, before any commit)
- **Issue:** Following the plan's suggested pattern of simply returning `clockBaseRef`/`turnStartedAtRef`/`pausedAtRef` from `useBotGameClock` and having `useBotGame.ts` read them directly (as originally attempted) introduced 7 NEW `react-hooks/exhaustive-deps` warnings — ESLint cannot prove a ref returned from a custom hook is stable, unlike a same-scope `useRef()`. This would have violated the plan's own explicit requirement ("record the count so the phase-wide react-hooks/* warning total cannot drift") and 215-01-SUMMARY.md's phase-wide contract (baseline of 0 must stay 0).
- **Fix:** Redesigned `useBotGameClock` (and every subsequent sub-hook) to fully encapsulate its refs, exposing only named functions (`applyMoveDebit`, `resetClock`, `getClockBase`, etc.); moved the turn-anchor mount-init effect and hidden-tab pause effect into the clock hook too (not explicitly named by the plan's Task 1 action text, but both exclusively touch `turnStartedAtRef`/`pausedAtRef`, so true self-containment required it). Where a raw ref genuinely needed to cross a boundary later (Task 2's `runBotTurnRef`, matching the plan's own suggested design), added it to the consuming callback's dependency array instead of inventing a wrapper function.
- **Files modified:** `frontend/src/hooks/useBotGameClock.ts` (and the pattern was then applied consistently in `useBotGameEngineDispatch.ts`, `useBotGameDrawOffer.ts`, `useBotGameSnapshot.ts`, `useBotGameMoves.ts`)
- **Verification:** `npm run lint` reports 0 warnings at every task checkpoint; confirmed via `npx eslint --no-inline-config` against the base config with no baseline region interference.
- **Committed in:** `3573ee907` (Task 1 commit) and consistently thereafter

---

**Total deviations:** 1 auto-fixed (a design-pattern correction, applied consistently across all 3 tasks)
**Impact on plan:** The deviation is invisible to any external consumer of `useBotGame` — `UseBotGameState`'s 26-field contract, the 169-test oracle, and all `vi.mock` factories are unaffected. No scope creep; the deviation stayed entirely within Task 1-3's own stated file boundaries.

## Issues Encountered

- **Pre-existing test-isolation flake in `src/pages/__tests__/Train.guestGate.test.tsx`** (documented in 215-01/215-02-SUMMARY.md, re-confirmed here): 2 of 6 tests fail when the full `npm test -- --run` suite runs, unrelated to this plan (no file under `src/pages/` or `src/hooks/__tests__/Train*` was touched). Full suite: 3884/3886 passed, both failures in this pre-existing flake.
- **First `applyDrawOfferUpdate` mutation-proof attempt was invalidated by a leftover mutation.** After the `runBotTurn` mutation proof, the `applyDrawOfferUpdate` body was mutated for its own proof, but the new tests were written and first run WITHOUT restoring the still-active mutation from the same editing pass — causing the new tests to fail even against what should have been working code. Caught immediately (the failure mode — score/moveNumber tracing all correct but `botDrawOffer` never true — was inconsistent with a genuine test bug), traced to the leftover mutation, restored, and both new tests passed cleanly on the first real run. No incorrect result was recorded; this is noted here as a process note for anyone repeating multi-mutation sessions.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

`useBotGame.ts` is functionally done for Phase 215: reduced from 544 to 233 counted lines (57% reduction), zero complexity/depth/statements/cognitive breaches anywhere, all 169 tests green, all 3 Sentry sites accounted for, zero new lint warnings of any kind. The 233-line residual is a recorded, reasoned exemption (see above) — 215-08 (phase-level verification) should carry it forward as an SC-1 survivor entry, matching the 214-04 precedent for `fetch_flaw_comparison`.

The full-encapsulation / explicit-ref-crossing pattern established here (see Decisions Made) is now a validated precedent for any later Phase 215 plan that extracts React hooks with cross-cluster ref/setState sharing — `Analysis.tsx` and `Openings.tsx` (215-06/215-07) will very likely hit the same `react-hooks/exhaustive-deps` boundary issue when their own extracted hooks need to share refs, and can apply this pattern directly rather than rediscovering it.

No blockers for 215-04 onward.

---
*Phase: 215-frontend-god-file-decomposition*
*Completed: 2026-09-03*

## Self-Check: PASSED

- FOUND: `frontend/src/hooks/useBotGameClock.ts`
- FOUND: `frontend/src/hooks/useBotGameDrawOffer.ts`
- FOUND: `frontend/src/hooks/useBotGameEngineDispatch.ts`
- FOUND: `frontend/src/hooks/useBotGameSnapshot.ts`
- FOUND: `frontend/src/hooks/useBotGameMoves.ts`
- FOUND commit `3573ee907` (Task 1)
- FOUND commit `e2a7d56fa` (Task 2)
- FOUND commit `197bbe1a8` (Task 3)
- Re-ran `npx vitest run` over the five oracle modules: 169/169 passed
- Re-ran `max-lines-per-function` at 200 across all six files: only `useBotGame` breaches, at 233 lines (recorded exemption)
- Re-ran `npm run lint`, `npm run build`, `npm run knip`: all green
