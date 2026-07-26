# Phase 190: Train Page + Solve Loop - Context

**Gathered:** 2026-07-25
**Status:** Ready for planning

<domain>
## Phase Boundary

The frontend for Train (v2.9): a gated `/train` route wired into all three nav surfaces (desktop header, mobile bottom bar, mobile More drawer) plus the full session solve loop end-to-end — landing/start screen → queue → binary guess → single-move attempt → client-side graded reveal (verdicts, steppable pv, game card, analysis deep-link, opt-in tactic stepper) → session-end score screen — against Phase 189's shipped endpoints. Covers SOLV-01..07, NAV-01, NAV-02. No schedule settings UI, no streak/progress surface, no celebrations (Phase 191); no backend pool/scheduler changes (Phase 189, shipped) except small additive payload fields noted below.

The solve-loop design is SETTLED via SEED-037 (six gsd-explore rounds, final 2026-07-25). Do not re-litigate: guess-then-one-move rhythm, one attempt, lichess-minimal solve screen (no eval bar, no game metadata), client-side grading (exact best-move match, else WASM expected-score-drop vs MISTAKE threshold), reveal content list, opt-in never-auto-triggered tactic stepper, 0–2 points per puzzle, green/yellow/red session rating, nav placement between Library and Bots with test-ID/isActive/ROUTE_TITLES details.

</domain>

<decisions>
## Implementation Decisions

### Train landing & session states
- **D-01:** **Minimal start screen** at `/train` — "N puzzles waiting" + a Start/Resume session button, nothing else. No auto-start on visit. Rationale: gives Phase 191 a natural surface to grow (settings, streak, progress) without restructuring.
- **D-02:** **Short sessions surface with a notice** when `blob_pending_count > 0` and `puzzle_count < requested_count`: start screen says "N puzzles ready" plus a subtle line like "More of your games are still being analyzed." Never block training on real material; never a dead end.
- **D-03:** **Completed-session state = score recap + next-session date** for the rest of the session window: the landing shows today's score/rating and "Next session: <date>" (derived from the API's session dates / `expires_on`).
- **D-04:** **Truly-empty cases get one plain placeholder** in this phase ("No puzzles available yet — analyze more games"; no crash paths). The differentiated PROG-05 cold states (import pointer, pool-exhausted celebration) stay in Phase 191 and will replace it.

### Solve-screen interaction flow
- **D-05:** **Board locked until the binary guess is committed.** Position fully visible for study; pieces don't respond until the user taps "One critical move" or "Several fine moves" (buttons sit where the move prompt is). Guarantees SOLV-01's guess-before-move with no accidental skips.
- **D-06:** **Inline thinking state during WASM grading**: played move stays on the board with a small "Checking your move…" spinner replacing the guess/prompt area. No overlay, no board flicker. Exact-match moves skip the wait entirely.
- **D-07:** **Auto-reveal** — reveal content appears on the same screen as soon as grading + the solve POST land. No "Show solution" tap.
- **D-08:** **Board snaps back to the puzzle position as the reveal opens** and becomes the stage for stepping the best line / tactic line; the played move is reported in the verdict text, not left on the board.

### Reveal layout & tone
- **D-09:** **Reveal is a panel beside the board on desktop (analysis-page pattern), stacked below the board on mobile.** Order: verdicts on top, then best line + stepper controls, then game card + analysis deep link + Next. One interactive board throughout — no mini-board reveal card.
- **D-10:** **Two verdict rows + explicit points**: "Guess: ✓ / Move: ✗" rows using theme.ts green/red semantics, plus a visible "+1 point"-style tally per puzzle so the session score stays legible.
- **D-11:** **Neutral-factual reveal copy** on misses: state what happened ("In the game you played Qxb2, losing a rook. Best was Rd8."), no coaching padding. Matches the product's honest-analytics voice (herring copy per SEED-037: "you handled this well in the game — several moves are fine").
- **D-12:** **Small comeback hint on SR items**: one quiet line ("You'll see this position again in ~3 days", or plain "Mastered — retired" text when `item_status` flips). Herrings show no SR feedback. The full PROG-03 "Flaw fixed!" celebration stays in Phase 191 — do not build it here.

### Progress & interruption
- **D-13:** **Progress indicator = "4 of 12" header text + a thin progress bar** under it, visible on both desktop and mobile layouts throughout the loop.
- **D-14:** **Re-entry goes through the start screen**: an open session renders the landing as "Resume session — 4 of 12 done", and the button drops the user onto the next unsolved puzzle. No auto-jump into the loop.
- **D-15:** **No abandon guard.** Navigating away mid-puzzle loses only the in-flight puzzle's uncommitted guess (results persist per completed puzzle via the solve POST); the puzzle resurfaces fresh on resume. No confirm dialogs.
- **D-16:** **Train joins the first-visit nav notification dot chain** (the existing `useUserFlag` Openings → Endgames dot pattern) so existing users discover the new surface. Phase 191's session-day badge later supersedes it as the attention mechanism.

### Claude's Discretion
- Nav icon choice (SEED-037 candidates: lucide `Target` / `Dumbbell` / `Swords`), exact start-screen and placeholder copy, spinner/transition styling, progress-bar styling, and score-screen composition details (SOLV-07 fixes total/2N percentage + green/yellow/red named constants; layout is open).
- `VariationTree` full-component-reuse vs. a new lightweight stepper — ROADMAP flags this as a plan-time spike (the component is deeply coupled to Analysis.tsx editor state). Spike early, don't discover mid-build.
- WASM grading movetime budget — ROADMAP flags a headless measurement pass (the seed's "~1s" is unvalidated for Train's single-move-eval shape) before finalizing the D-06 wait UX.
- How the reveal sources data beyond `PuzzleRevealResponse` (see integration gaps in code_context) — planner picks the mechanism, respecting POOL-10 (no answer data reachable pre-attempt, including via other endpoints' payloads in the network tab).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design (settled — the source of truth for scope)
- `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` — the settled design; for this phase especially §Solve loop, §Tactic line stepping, §Scoring & gamification, §Name & navigation (nav consts, test IDs, isActive, import gating, 320px six-label fit guidance — do NOT shrink the font).
- `.planning/REQUIREMENTS.md` — SOLV-01..07, NAV-01..02 (this phase); PROG/SCHD are Phase 191; out-of-scope table (no retry, no eval bar, no 3-way guess).
- `.planning/ROADMAP.md` — Phase 190 goal + success criteria; flags the VariationTree spike and WASM movetime measurement as plan-time work.

### API contract (Phase 189, shipped)
- `app/schemas/train.py` — LOCKED payload shapes: `TrainPuzzle` (exactly 5 fields, no answer key — POOL-10), `TrainSessionResponse` (`session_id` nullable, `blob_pending_count` semantics), `SolveRequest` (client asserts `correct_move`, never `correct_guess`), `SolveResponse`, `PuzzleRevealResponse` (`has_tactic_lines` is a pointer to the existing tactic-lines endpoint), `TrainSettingsResponse`.
- `app/routers/train.py` — endpoint surface: POST `/train/sessions`, POST `/train/sessions/{id}/solve`, GET `/train/sessions/{id}/puzzles/{position}/reveal` (409 before solve), GET/PUT `/train/settings`; guest 403 gate.
- `.planning/phases/189-pool-scheduler-backend/189-CONTEXT.md` — carried-forward decisions: D-03 (delete-all modal warning copy — lands in this phase or 191), D-05 (guests rejected; Welcome.tsx must state Train requires a full account), D-09..D-12 (session materialization/window semantics the UI reflects).

### Research (2026-07-25 pass)
- `.planning/research/SUMMARY.md` — phase mapping; zero new frontend dependencies.
- `.planning/research/ARCHITECTURE.md` — proposed frontend file layout for Train.
- `.planning/research/PITFALLS.md` — #9 pre-attempt payload leak (applies to any reveal-data workaround this phase adds).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `frontend/src/App.tsx` — `NAV_ITEMS`, `BOTTOM_NAV_ITEMS`, `ROUTE_TITLES`, `isActive()`, `IMPORT_EXEMPT_ROUTES` (keep `/train` OUT), `MobileBottomBar`/`MobileMoreDrawer`; mobile labels can diverge from desktop for free (separate consts).
- `frontend/src/generated/flawThresholds.ts` + `frontend/src/lib/liveFlaw.ts` — the MISTAKE-threshold expected-score-drop grading rule (SOLV-03 says reuse these, not reimplement).
- `frontend/src/lib/engine/` — vendored Stockfish WASM worker infrastructure from Bot Play (workerPool, engineEvalLookup) for the single-move grading eval.
- `frontend/src/components/analysis/VariationTree.tsx` — tactic line stepping UI (`tacticDepthBadge`, `missedDepth`/`allowedDepth`), both orientations; subject of the reuse-vs-lightweight-stepper spike.
- `frontend/src/components/results/GameCard.tsx` / `LibraryGameCard.tsx` — reveal's game card; GET `/api/library/games/{game_id}` returns a `GameFlawCard`.
- `GET /api/library/flaws/{game_id}/{ply}/tactic-lines` — the steppable tactic PV source when `has_tactic_lines` is true (Train adds no second PV surface).
- `useUserFlag` first-visit dot chain (Openings → Endgames) — D-16 extends it to Train.

### Established Patterns
- Import gating: `/train` behaves like Openings/Endgames (`isNavLocked` greys it until games exist + import tier 1 done), not like Library/Bots.
- Every data-loading ternary needs an `isError` branch (CLAUDE.md); solve POST failures need explicit handling too (a lost solve = lost SR progress — surface, don't swallow).
- `data-testid` convention: `nav-train` / `mobile-nav-train` / `drawer-nav-train`, `btn-{action}`, board `data-testid="chessboard"` with click-to-move + drag support.
- Mobile bottom bar is already `text-xs` (grandfathered); six labels fit at 320px — fix layout, never shrink type further.
- Theme semantics (verdict green/red, rating bands) come from `frontend/src/lib/theme.ts`; buttons use `variant="default"` / `brand-outline`.

### Integration Points (two known payload gaps — planner must resolve)
- **Pre-attempt last move (SOLV-02):** `TrainPuzzle` carries only `{position, game_id, ply, fen, side_to_move}` — no last-move field, and fetching the game's analysis payload pre-attempt would leak the answer key in the network tab (POOL-10). The clean fix is a small additive Phase 190 backend change: add a `last_move_uci`-style field (not answer data) to `TrainPuzzle`, updating its "exactly five fields" docstring contract deliberately.
- **Reveal best-line pv (SOLV-05):** `PuzzleRevealResponse` has `best_move`/`best_move_san` but no pv; `tactic-lines` covers only tactic-tagged items. For untagged items the steppable best line needs a source — extend the reveal response (post-attempt, so no leak) or reuse an existing post-attempt endpoint; planner decides.
- New frontend surface: `frontend/src/pages/Train.tsx` (+ `pages/train/` or `components/train/` per research ARCHITECTURE.md), a `useTrain*` TanStack Query hook family, typed API calls in `frontend/src/api/client.ts`, route registration in `App.tsx` under `ProtectedLayout`.

</code_context>

<specifics>
## Specific Ideas

- The guess buttons double as the board unlock (D-05): "One critical move" / "Several fine moves" sit where the side-to-move prompt lives, and the board activates only after the tap.
- Reveal copy voice anchored to the product's existing honesty framing ("3 parked — too hard for now, never framed as failure").
- The comeback hint (D-12) exists to make spaced repetition legible ("users won't understand why positions repeat" otherwise) without stealing Phase 191's celebration.

</specifics>

<deferred>
## Deferred Ideas

- **PROG-05 differentiated cold/empty states** (import pointer, pool-exhausted celebration) — Phase 191 replaces D-04's plain placeholder.
- **PROG-02/PROG-03 celebrations** (green-session confetti, "Flaw fixed!" with thumbnail) — Phase 191; D-12's plain "Mastered — retired" text is the Phase 190 stand-in.
- **Delete-all modal warning copy** ("deleting games also resets Train progress", 189 D-03) and **Welcome.tsx guest copy** ("Train requires a full account", 189 D-05) — small copy tasks; planner may fold the Welcome.tsx line here or leave both to Phase 191, but they must not be lost.
- **Phase 191 nav badge** ("12 puzzles waiting") supersedes the D-16 first-visit dot as Train's attention mechanism.

### Reviewed Todos (not folded)
- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — Score Y-axis Tailwind fix on an unrelated chart; reviewed for Phase 189 too, still unrelated.
- `172-deferred-review-findings.md` — analysis-board gem-sweep review findings, unrelated.
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — backend storage idea, unrelated.

</deferred>

---

*Phase: 190-train-page-solve-loop*
*Context gathered: 2026-07-25*
