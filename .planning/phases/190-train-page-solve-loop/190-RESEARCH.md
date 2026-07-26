# Phase 190: Train Page + Solve Loop - Research

**Researched:** 2026-07-25
**Domain:** Frontend session/solve-loop UI + client-side WASM chess grading, bolted onto a shipped FastAPI/React chess-analysis app
**Confidence:** HIGH

## Summary

Phase 189's backend is shipped and merged on `main`. Every field and endpoint this phase consumes was read directly from `app/schemas/train.py` and `app/routers/train.py` in this session (not inferred from the milestone-level pre-189 research docs, which describe an earlier, looser payload shape than what actually shipped — see "Correcting stale milestone research" below). The single most important finding for planning this phase correctly: **`TrainPuzzle` (the pre-attempt payload) ships with ZERO answer-key fields** — not even `best_move`. Phase 189's plan (`189-01-PLAN.md`, decision P-01) explicitly resolved this stricter than the seed assumed: *"the client already runs the vendored Stockfish WASM to grade any non-exact move, and that same search yields the best move and its eval, so the exact-match shortcut is a latency optimization, not a requirement... Phase 190 note: the solve loop must grade entirely from its own engine output."* This means Train's grading engine is **fully self-contained** — it needs only the puzzle FEN (already in `TrainPuzzle`) and the client's own Stockfish WASM search, mirroring the codebase's existing `useLiveMoveFlaw.ts` / `liveFlaw.ts` free-play grading pattern almost exactly. No new backend endpoint, no answer-key round-trip, is needed to determine `correct_move` before the solve POST.

The second major finding: `VariationTree.tsx` (1097 LOC) is deeply coupled to `Analysis.tsx`'s full branching-editor state (`Map<NodeId, MoveNode>`, sibling-block forking, flaw-chip click handlers, sideline deletion). It has no extracted lightweight single-line stepper — a prior `TacticLineExplorer.tsx` was absorbed into it and no longer exists standalone. Building a minimal single-chain `nodes`/`mainLine` graph to feed the full component is *technically* possible (its props are optional-heavy enough to support a no-sibling instantiation) but drags in far more machinery than Train's reveal needs: no forking, no deletion, no flaw-chip click-to-fetch-PV interactivity (Train already HAS its PV data, unlike Analysis which fetches it on click). **Recommendation: build a small purpose-built stepper** reusing only the genuinely portable utilities (`tacticDepthBadge`, `tacticMotifLabel` from `frontend/src/lib/tacticComparisonMeta.ts`) plus the `ChessBoard` component for board rendering — not the full `VariationTree`. This should still be validated with a short timeboxed spike at plan/execute time (render the puzzle's SAN list, click a token, confirm the board updates) since "the spike is the point," not a foregone conclusion.

Two additive backend payload gaps must be resolved as part of this phase's plan (small, safe, post-attempt-only changes — no POOL-10 risk): (a) `TrainPuzzle` needs a `last_move_uci` (or `last_move_san`) field so the solve screen can animate/highlight the opponent's last move (SOLV-02) — this is NOT answer-key data (it describes how the position was reached, not what to play), so it is safe to add pre-attempt; (b) `PuzzleRevealResponse` needs a `pv: list[str] | None` field (UCI or SAN) sourced from `game_positions.pv` at the puzzle's ply, for the SOLV-05 steppable best-line on non-tactic-tagged puzzles — this is strictly post-attempt (reveal is 409-gated until solved), so no leak risk.

**Primary recommendation:** Build the grading engine as a new `useTrainGradingEngine.ts` (single persistent Worker per session, not per puzzle — reuse `useStockfishEngine.ts`'s single-line-search shape), feed its output through the already-shipped `evalToExpectedScore`/`classifyLiveSeverity` from `liveFlaw.ts`, reuse `ChessBoard.tsx` verbatim for the solve screen, reuse `GameCard` (with its existing `analyzePly` prop) verbatim for the reveal's game card + analysis deep link, and build a small new stepper component for the tactic/PV line rather than force-fitting `VariationTree`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Nav route registration + import gating | Frontend Server (SPA routing) | — | Pure client-side routing state (`App.tsx`), matches Openings/Endgames precedent |
| Session composition, puzzle queue, SR state | API / Backend (Phase 189, shipped) | Database | Already built; Phase 190 only consumes `POST /train/sessions` |
| Move grading (exact-match + WASM expected-score-drop) | Browser / Client | — | Locked design: "no grading endpoint, no backend engine load" (REQUIREMENTS.md Out-of-Scope table) |
| Result persistence (streak/due/fail/parked) | API / Backend (Phase 189, shipped) | Database | `POST /train/sessions/{id}/solve`; backend trusts client-asserted `correct_move` |
| Reveal data (best_move, pv, game card) | API / Backend (Phase 189 shipped + 1 additive field) | — | 409-gated until solved; safe to extend post-attempt |
| Tactic-line stepper data | API / Backend (existing, Phase 135) | — | `GET /library/flaws/{game_id}/{ply}/tactic-lines`, reused as-is, not owner-scoped |
| Board rendering, click/drag-to-move | Browser / Client | — | `ChessBoard.tsx` component, already handles both interaction modes |
| Score/rating computation, session-end display | Browser / Client | — | Pure display logic from `SolveResponse`/`TrainSessionResponse` fields already returned per-puzzle |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions

- **D-01:** Minimal start screen at `/train` — "N puzzles waiting" + a Start/Resume session button, nothing else. No auto-start on visit.
- **D-02:** Short sessions surface with a notice when `blob_pending_count > 0` and `puzzle_count < requested_count`: "N puzzles ready" plus "More of your games are still being analyzed." Never block training on real material; never a dead end.
- **D-03:** Completed-session state = score recap + next-session date for the rest of the session window: landing shows today's score/rating and "Next session: <date>" (derived from the API's session dates / `expires_on`).
- **D-04:** Truly-empty cases get one plain placeholder this phase ("No puzzles available yet — analyze more games"; no crash paths). Differentiated PROG-05 cold states stay in Phase 191.
- **D-05:** Board locked until the binary guess is committed. Guess buttons ("One critical move" / "Several fine moves") sit where the move prompt lives; pieces don't respond until tapped.
- **D-06:** Inline thinking state during WASM grading: played move stays on the board with a small "Checking your move…" spinner replacing the guess/prompt area. No overlay, no board flicker. Exact-match moves skip the wait entirely.
- **D-07:** Auto-reveal — reveal content appears on the same screen as soon as grading + the solve POST land. No "Show solution" tap.
- **D-08:** Board snaps back to the puzzle position as the reveal opens and becomes the stage for stepping the best line / tactic line; the played move is reported in verdict text, not left on the board.
- **D-09:** Reveal is a panel beside the board on desktop (analysis-page pattern), stacked below the board on mobile. Order: verdicts, then best line + stepper, then game card + analysis deep link + Next. One interactive board throughout — no mini-board reveal card.
- **D-10:** Two verdict rows + explicit points: "Guess: ✓ / Move: ✗" using theme.ts green/red semantics, plus a visible "+1 point"-style tally per puzzle.
- **D-11:** Neutral-factual reveal copy on misses ("In the game you played Qxb2, losing a rook. Best was Rd8."), no coaching padding.
- **D-12:** Small comeback hint on SR items ("You'll see this position again in ~3 days", or "Mastered — retired" text when `item_status` flips). Herrings show no SR feedback. Full "Flaw fixed!" celebration stays in Phase 191.
- **D-13:** Progress indicator = "4 of 12" header text + a thin progress bar under it, visible on both desktop and mobile layouts throughout the loop.
- **D-14:** Re-entry goes through the start screen: an open session renders "Resume session — 4 of 12 done"; the button drops the user onto the next unsolved puzzle. No auto-jump into the loop.
- **D-15:** No abandon guard. Navigating away mid-puzzle loses only the in-flight puzzle's uncommitted guess (results persist per completed puzzle via the solve POST). No confirm dialogs.
- **D-16:** Train joins the first-visit nav notification dot chain (existing `useUserFlag` Openings → Endgames pattern).

### Claude's Discretion

- Nav icon choice (SEED-037 candidates: lucide `Target` / `Dumbbell` / `Swords`).
- Exact start-screen and placeholder copy, spinner/transition styling, progress-bar styling, score-screen composition details (SOLV-07 fixes total/2N percentage + green/yellow/red named constants; layout is open).
- `VariationTree` full-component-reuse vs. a new lightweight stepper — spike early, don't discover mid-build (see Architecture Patterns, Pattern 3, for this research's recommendation).
- WASM grading movetime budget — headless measurement pass before finalizing the D-06 wait UX (see Common Pitfalls, Pitfall 1).
- How the reveal sources data beyond `PuzzleRevealResponse` — planner picks the mechanism, respecting POOL-10 (no answer data reachable pre-attempt, including via other endpoints' payloads in the network tab).

### Deferred Ideas (OUT OF SCOPE)

- PROG-05 differentiated cold/empty states (import pointer, pool-exhausted celebration) — Phase 191.
- PROG-02/PROG-03 celebrations (green-session confetti, "Flaw fixed!" with thumbnail) — Phase 191; D-12's plain text is the Phase 190 stand-in.
- Delete-all modal warning copy (189 D-03) and Welcome.tsx guest copy (189 D-05) — small copy tasks; planner may fold into this phase or leave to Phase 191, but must not be lost.
- Phase 191 nav badge ("12 puzzles waiting") supersedes the D-16 first-visit dot.
- No retry on wrong move, no eval bar / game metadata on the solve screen, no 3-way guess, no SR-tracked herrings, no backend grading endpoint (all locked-out per REQUIREMENTS.md's Out-of-Scope table).

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SOLV-01 | Binary guess before moving (critical vs. several) | `SolveRequest.guess: Literal["critical","several"]`; server computes `correct_guess` from the live blob classifier (P-02) — client never receives sharp/soft ground truth pre-attempt |
| SOLV-02 | Lichess-minimal solve screen, one move, opponent's last move animated+highlighted | `ChessBoard.tsx` already supports `flipped`/`lastMove`/`lastMoveColor`/click+drag; **payload gap**: `TrainPuzzle` has no last-move field — needs an additive `last_move_uci` field (see Architecture Patterns, Pattern 1) |
| SOLV-03 | Fully client-side grading, exact-match or WASM expected-score-drop vs MISTAKE | **Resolved by Phase 189 P-01**: grade entirely from the client's own engine output (no stored `best_move` to compare against) — see Architecture Patterns, Pattern 2 |
| SOLV-04 | "N of M" progress indicator | Pure frontend; `TrainSessionResponse.puzzle_count`/`solved_count` already provide the counts |
| SOLV-05 | Reveal: guess+move verdicts, blunder vs. best line (steppable pv), game card, analysis deep link | `PuzzleRevealResponse` has `best_move`/`best_move_san` but no `pv` — **payload gap**, needs additive post-attempt field (Pattern 1); game card + deep link come free from `GameCard`'s existing `analyzePly` prop |
| SOLV-06 | Opt-in tactic stepper, both orientations, never auto-triggered | `GET /library/flaws/{game_id}/{ply}/tactic-lines` (Phase 135, shipped, not owner-scoped) already returns `missed_moves`/`allowed_moves` SAN + depths + motifs — no new backend endpoint needed |
| SOLV-07 | 0-2 pts/puzzle, session score/2N %, green/yellow/red named constants | Pure frontend aggregation over per-puzzle `SolveResponse` results already returned |
| NAV-01 | `/train` between Library and Bots on all 3 nav surfaces, test IDs | Exact `App.tsx` insertion points identified (Pattern 4) |
| NAV-02 | Import-gated like Openings/Endgames, NOT in `IMPORT_EXEMPT_ROUTES` | `isNavLocked`/`ImportRequiredRoute` reused verbatim |

</phase_requirements>

## Standard Stack

Zero new dependencies. Every capability this phase needs is already installed and used elsewhere in this exact codebase.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react-chessboard | 5.x (installed) | Board rendering | Already wrapped by `ChessBoard.tsx`, used verbatim by Analysis/Bots |
| chess.js | installed | Move legality, FEN manipulation | Already the project's sole chess-logic library |
| @tanstack/react-query | installed | Session/puzzle/reveal data fetching + caching | Project-wide convention (`useTrain*` hooks alongside `useBotGame`/`useImport` etc.) |
| Vendored Stockfish WASM (`stockfish-18-lite-single.js`) | already vendored in `public/engine/` | Client-side move grading | v2.3 Bot Play dependency; zero new bundle weight, served as a plain non-module Worker |
| canvas-confetti | 1.9.4 (installed) | (Phase 191, not this phase — flagged for awareness) | Already wrapped in `frontend/src/lib/confetti.ts` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | installed | Train nav icon (`Target`/`Dumbbell`/`Swords` candidates per SEED-037) | Icon choice is Claude's discretion |
| date-fns | 4.4.0 (installed) | "Next session: <date>" display formatting | Sole date library in the codebase |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New `useTrainGradingEngine.ts` (single-line search shape) | Extend `useStockfishGradingEngine.ts`'s `searchmoves`-restricted pool shape | The pool shape is built for grading N pre-known candidate moves at once (Moves-by-Rating chart); Train grades one ad-hoc move per puzzle — a single-worker, single-line search (`useStockfishEngine.ts`'s shape) is the closer template, not the N-worker pool |
| New lightweight PV stepper | Full `VariationTree.tsx` reuse | See Architecture Patterns Pattern 3 — real build-cost tradeoff, spike recommended |

**Installation:** None required — no `npm install` / `uv add` needed for this phase.

**Version verification:** N/A — no new packages.

## Package Legitimacy Audit

Not applicable — this phase introduces zero new external packages (frontend or backend). All capabilities are covered by dependencies already vendored/installed and verified in prior phases (v2.3 Bot Play for Stockfish WASM, v1.29 for the engine vendoring pattern).

## Architecture Patterns

### System Architecture Diagram

```
User visits /train
      │
      ▼
┌─────────────────────────────┐   ImportRequiredRoute (existing) gates entry
│ Train.tsx (lazy route)      │   like Openings/Endgames — NOT like Bots
│  landing/start screen        │
└──────────────┬───────────────┘
               │ Start/Resume tapped
               ▼
   POST /train/sessions  ──────────────────► Phase 189 backend (shipped)
               │  returns TrainSessionResponse
               │  { session_id, puzzle_count, requested_count,
               │    blob_pending_count, puzzles: TrainPuzzle[] }
               ▼
┌───────────────────────────────────────────────────────────┐
│ Solve loop (session queue, index i = 0..puzzle_count-1)   │
│                                                             │
│  1. Show puzzle i's FEN on ChessBoard (locked, D-05)       │
│     - orientation = puzzle.side_to_move                    │
│     - opponent's last move highlighted (NEW field needed) │
│     - kick off background grading search on puzzle.fen    │
│       (useTrainGradingEngine — this IS the "best move"     │
│       source; no stored best_move exists pre-attempt)      │
│                                                             │
│  2. User taps "critical" or "several" → board unlocks      │
│                                                             │
│  3. User plays exactly one move (click or drag)             │
│     - UCI equals engine's own top move? → instant correct   │
│       (D-06 fast path)                                      │
│     - else → grade the resulting position (2nd search),     │
│       "Checking your move…" spinner (D-06 slow path)        │
│     - classifyLiveSeverity(esBefore, esAfter) from           │
│       liveFlaw.ts decides correct_move (drop < MISTAKE_DROP) │
│                                                             │
│  4. POST /train/sessions/{id}/solve                         │
│     { position, guess, played_move, correct_move }          │
│     ──────────────────────────► Phase 189 backend (shipped) │
│     ◄────────── SolveResponse { correct_guess (server-      │
│        computed), correct_move, puzzle_type, item_status,   │
│        streak, due_date, session_complete }                 │
│                                                             │
│  5. GET /train/sessions/{id}/puzzles/{position}/reveal       │
│     ──────────────────────────► Phase 189 backend (shipped, │
│        + 1 additive `pv` field this phase adds)              │
│     ◄────────── PuzzleRevealResponse { best_move,            │
│        best_move_san, pv (NEW), played_in_game_san,          │
│        puzzle_type, has_tactic_lines, ... }                  │
│                                                             │
│  6. Auto-reveal (D-07): verdicts, best-line stepper          │
│     (new lightweight component, NOT VariationTree),          │
│     opt-in tactic stepper (fetches existing                  │
│     GET /library/flaws/{game_id}/{ply}/tactic-lines           │
│     when has_tactic_lines), GameCard w/ analyzePly=ply        │
│     (deep link is FREE — already built into GameCard)         │
│                                                             │
│  7. "Next" → i += 1, or session_complete → score screen       │
└───────────────────────────────────────────────────────────┘
               │  score screen: sum of per-puzzle 0-2 pts / 2N
               ▼
        Green/Yellow/Red rating (named threshold constants)
```

### Recommended Project Structure
```
frontend/src/
├── pages/
│   └── Train.tsx                    # lazy route, default export (Pitfall 1 pattern, mirrors Bots.tsx)
├── components/train/
│   ├── TrainStartScreen.tsx         # D-01..D-04 landing states
│   ├── TrainSolveScreen.tsx         # board + guess buttons + progress indicator (D-05, D-13)
│   ├── TrainReveal.tsx              # D-09..D-12 reveal panel/stack
│   ├── TrainLineStepper.tsx         # NEW lightweight stepper (best-line + tactic line), replaces a VariationTree embed
│   └── TrainScoreScreen.tsx         # SOLV-07 session-end score/rating
├── hooks/
│   ├── useTrainSession.ts           # TanStack Query wrapper: POST /train/sessions, solve, reveal
│   └── useTrainGradingEngine.ts     # new sibling of useStockfishEngine.ts — single persistent Worker/session
├── lib/
│   └── trainScore.ts                # pure: score aggregation, green/yellow/red threshold constants
└── api/
    └── client.ts                    # add typed train* functions (mirrors existing endpoint groupings)
```

### Pattern 1: Additive backend payload fixes (small, safe, this phase's only backend work)

**What:** Two small, additive, non-leaking fields close the integration gaps CONTEXT.md flagged.

1. `TrainPuzzle` gains `last_move_uci: str | None` (or `last_move_san`) — describes how the position was reached (the opponent's prior move), which is NOT part of the answer key (it does not reveal what to play next). Safe to add pre-attempt; does not reopen POOL-10. Source: the puzzle FEN is reconstructed via `full_fen_at_ply(pgn, ply)` (per 189-01-PLAN.md P-03) — the move that produced ply's position is available from the same PGN replay, one ply earlier.
2. `PuzzleRevealResponse` gains `pv: list[str] | None` — the stored best line, sourced from `game_positions.pv` at the puzzle's decision ply (the exact place `best_move`/`best_move_san` are already derived from per 189-05-PLAN.md's `reveal_for_puzzle`). Strictly post-attempt (409-gated), so no POOL-10 concern. Format decision (UCI vs. SAN list) should match whatever the new lightweight stepper (Pattern 3) consumes most directly — SAN is likely simpler since it avoids re-deriving SAN client-side move-by-move.

**When to use:** Both changes should land as small additive Pydantic/router edits at the start of this phase's plan (Wave 0-ish), verified with a couple of new backend tests (`test_reveal_pv_field`, `test_puzzle_last_move_field`) — not a re-architecture of Phase 189's schema.

**Example:**
```python
# app/schemas/train.py — additive, does not touch the "exactly five fields" TrainPuzzle
# contract's SPIRIT (no answer key), only its literal field count. Update the docstring
# alongside the change so it doesn't silently drift from what P-01 established.
class TrainPuzzle(BaseModel):
    position: int
    game_id: int
    ply: int
    fen: str
    side_to_move: Literal["white", "black"]
    last_move_uci: str | None  # NEW — describes arrival, not the answer; safe pre-attempt

class PuzzleRevealResponse(BaseModel):
    ...
    best_move: str | None
    best_move_san: str | None
    pv: list[str] | None  # NEW — SAN list of the stored best line, post-attempt only
    ...
```

### Pattern 2: Client-side grading — self-contained, no stored answer key (SOLV-03)

**What:** Because `TrainPuzzle` carries no answer key at all (locked, P-01), Train's grading engine must independently determine "the best move" via its own Stockfish WASM search on the puzzle FEN — there is nothing server-provided to exact-match against. This directly resolves the apparent tension in CONTEXT.md/SEED-037 between "exact match to stored best_move" (seed's original phrasing) and POOL-10 (no answer key pre-attempt): Phase 189 already decided the exact-match reference is the **client's own search result**, not a server value.

**When to use:** The whole solve loop's grading logic. Concretely:

1. As soon as the puzzle position is shown (ideally right when the board unlocks after the guess, D-05, so the search runs during the time the user spends studying/choosing a move), start a single-line search on `puzzle.fen` via a persistent per-session Worker (see Pattern 4 below on lifecycle). This yields `bestMoveUci` (pv[0]) and `esBefore` (via `evalToExpectedScore` on the search's top eval, using `sideToMoveFromFen(puzzle.fen)` as `mover`).
2. When the user plays a move:
   - If `playedMoveUci === bestMoveUci` (search already resolved) → instantly `correct_move = true`, no additional wait (D-06 fast path). `esAfter = esBefore` by construction.
   - Otherwise, run a SECOND search on the resulting position (`puzzle.fen` + the played move) to get `esAfter` (same `mover` argument as `esBefore` — this is the exact mechanism `useLiveMoveFlaw.ts` already uses for free-play grading). Show "Checking your move…" during this second search (D-06 slow path).
3. `classifyLiveSeverity(esBefore, esAfter)` from `liveFlaw.ts` returns `null | 'inaccuracy' | 'mistake' | 'blunder'`. Per SOLV-03 ("inaccuracies pass"), `correct_move = severity == null || severity === 'inaccuracy'` (i.e., drop `< MISTAKE_DROP`).
4. Submit `SolveRequest { position, guess, played_move: playedMoveUci, correct_move }`.

**Correcting stale milestone research:** `.planning/research/ARCHITECTURE.md` (written before Phase 189 was planned) describes the session-composition endpoint as returning puzzles "with `game_id`, `ply`, `fen`, `best_move`" — this is **incorrect** relative to the shipped schema; treat that document's payload-shape claims as superseded by the direct code read in this session (`app/schemas/train.py`). `.planning/research/PITFALLS.md`'s Pitfall 9 (built on the same pre-189 assumption) is likewise partially superseded: the "leak" it describes doesn't exist for `best_move` anymore (P-01 removed it from the payload entirely), though its guidance to avoid bundling reveal-only fields (`pv`, blob classification) into the pre-attempt fetch remains fully correct and is exactly what Pattern 1 above respects.

**Example:**
```typescript
// Mirrors frontend/src/hooks/useLiveMoveFlaw.ts's before/after expected-score pattern,
// but driven by the client's OWN search output instead of a cached parent eval.
import { evalToExpectedScore, classifyLiveSeverity, sideToMoveFromFen } from '@/lib/liveFlaw';

const mover = sideToMoveFromFen(puzzle.fen);
const esBefore = evalToExpectedScore(bestSearch.evalCp, bestSearch.evalMate, mover);
const esAfter = playedMoveUci === bestSearch.bestMoveUci
  ? esBefore
  : evalToExpectedScore(afterMoveSearch.evalCp, afterMoveSearch.evalMate, mover);
const severity = classifyLiveSeverity(esBefore, esAfter);
const correctMove = severity === null || severity === 'inaccuracy';
```

### Pattern 3: Lightweight PV/tactic stepper — do NOT force-fit VariationTree

**What:** `VariationTree.tsx` (1097 LOC) is built for `Analysis.tsx`'s full branching move-tree editor: a `Map<NodeId, MoveNode>` node graph with parent pointers, flat-sibling-block sideline forking (`buildSiblingBlocks`), free-move deletion (`onDeleteLine`), and click-to-fetch-PV chip interactivity (`onPvChipClick` triggers `useTacticLines` + `insertPvLine` grafting in `Analysis.tsx`). Train's reveal needs none of this: it has exactly ONE line to display (either the best line from the new `pv` field, or the tactic line from the existing `tactic-lines` endpoint), no forking, no deletion, and the data is already fetched (not click-triggered).

**When to use:** Build `TrainLineStepper.tsx` as a small new component:
- Props: `moves: string[]` (SAN), `startFen: string`, optional `tacticDepth`/`motif` labels.
- Internal state: a `currentIndex` into `moves`, replaying moves onto a `chess.js` board to derive the FEN at each step (mirrors how `TacticLinesResponse.position_fen` + SAN replay already works for the existing tactic-lines consumer).
- Renders `ChessBoard` (reused) + simple prev/next controls + `tacticDepthBadge`/`tacticMotifLabel` (reused from `frontend/src/lib/tacticComparisonMeta.ts` — these ARE genuinely portable, pure-function utilities, unlike the component itself).
- Two instantiations per reveal: one for the stored best line (`pv` field, non-tactic case) and one for the tactic line (`missed_moves`/`allowed_moves` from the existing tactic-lines endpoint, tactic case) — SOLV-05 and SOLV-06 share this one small component rather than needing two.

**Spike recommendation:** Timebox a short spike at the start of implementation: (a) confirm a minimal `VariationTree` instantiation (single mainLine, no siblings) actually renders cleanly with all the optional props omitted — if it does with acceptably little wiring, partial reuse might still be worth it for the tactic-line case specifically (since its data shape — motif, depth, orientation — matches `VariationTree`'s existing `FlawMarkerEntry` design most closely); (b) if that wiring proves as heavy as this research suggests, confirm the small purpose-built stepper renders both the best-line and tactic-line cases from one shared component. Do not assume the outcome — the phase description explicitly calls this an unknown to resolve, not a decision to make from research alone.

### Pattern 4: Grading Worker lifecycle — one per session, not one per puzzle

**What:** Per `.planning/research/PITFALLS.md`'s Performance Traps table (still valid, not superseded): recreating a fresh Stockfish Worker per puzzle pays a full WASM cold-start (compile + `uci`/`uciok`/`isready`/`readyok` handshake) on every single puzzle instead of once per session.

**When to use:** Instantiate `useTrainGradingEngine`'s Worker once when the solve loop mounts (or when the session starts), and reuse it across every puzzle in that session — mirroring `useStockfishEngine.ts`'s single-instance-per-mount lifecycle (worker created in a `useEffect` keyed on `enabled`, torn down on unmount). Warm it on session start rather than waiting for the first puzzle's guess-commit, so puzzle 1 doesn't pay the cold-start cost.

**Example:**
```typescript
// frontend/src/hooks/useStockfishEngine.ts:235-260 — the exact lifecycle template.
// Do NOT instantiate a new Worker inside the per-puzzle render/effect; key the
// worker-creation effect on session mount / `enabled`, not on `puzzle.position`.
```

### Anti-Patterns to Avoid

- **Re-deriving the expected-score sigmoid or MISTAKE_DROP threshold on the frontend:** `liveFlaw.ts` + `flawThresholds.ts` are CI-drift-checked against `flaws_service.py`. A hand-rolled Train-specific copy would silently diverge the moment the threshold is retuned server-side.
- **Fetching the reveal's `pv`/tactic data before the attempt "for simplicity":** even though `PuzzleRevealResponse` is safely post-attempt-only by the 409 gate, a component that PREFETCHES it (e.g., speculatively on puzzle mount) reopens the exact leak Pitfall 9 describes structurally. Fetch reveal data only after the solve POST succeeds.
- **Putting `movetime` before `searchmoves` in a `go` UCI command** (only relevant if Pattern 2's second search restricts candidates rather than doing a free search) — the vendored engine silently swallows everything after `searchmoves` into the move list. `searchmoves` must be the LAST clause (see `workerPool.ts`'s `sendGo`, `go depth ... searchmoves ... movetime ...` ordering, and `useStockfishGradingEngine.ts`'s own fixed-bug comment).
- **Building a from-scratch third Stockfish Worker wrapper that reinvents the stop-before-go race handling:** `useStockfishEngine.ts`'s state machine (`idle`/`thinking`/`stopping`, `stopPendingRef`) already solves the single-threaded-engine serialization problem Train's grading engine will also hit (search 1 must fully settle before search 2 for the same puzzle starts).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Expected-score sigmoid + severity thresholds | New Train-specific grading math | `evalToExpectedScore`/`classifyLiveSeverity` (`frontend/src/lib/liveFlaw.ts`) + `MISTAKE_DROP` (`frontend/src/generated/flawThresholds.ts`) | CI-drift-checked against the backend; SOLV-03 explicitly says reuse these |
| Board rendering, orientation, last-move highlight, click+drag input | A new board component | `ChessBoard.tsx` (`frontend/src/components/board/ChessBoard.tsx`) | Already has `flipped`, `lastMove`/`lastMoveColor`, click-to-move + drag, `id="chessboard"` stable square IDs — exactly SOLV-02's requirements |
| Game card + analysis deep link | A new mini-card + URL builder | `GameCard` (`frontend/src/components/results/GameCard.tsx`) with its existing `analyzePly` prop, backed by `buildGameAnalysisUrl` | The deep link already carries orientation from the backend's `user_color` in game mode — building a second one risks the "deep link doesn't land on the right orientation" pitfall the milestone PITFALLS.md already flagged |
| Tactic line PV data | A new backend PV endpoint for tactic-tagged flaws | `GET /library/flaws/{game_id}/{ply}/tactic-lines` (Phase 135, shipped, not owner-scoped) | Already returns `missed_moves`/`allowed_moves` SAN, depths, motifs, `position_fen` — exactly what SOLV-06 needs |
| Nav notification dot infrastructure | A second flag mechanism for Train | `useUserFlag`/`setUserFlag` (`frontend/src/hooks/useUserFlag.ts`), chained after Endgames per D-16 | Generic per-email localStorage flag, already the established pattern for exactly this UX |
| Import-gating logic | A new readiness check for `/train` | `useReadiness().tier1` + `totalGames > 0` (exactly `NavHeader`'s existing `navUnlocked` computation) | Same gate as Openings/Endgames; a second readiness check risks disagreeing with the nav's own gate |

**Key insight:** This phase's frontend surface is almost entirely composition of already-shipped primitives (board, game card, flaw-grading math, nav-gating hooks) plus three genuinely new pieces: the session/solve-loop state machine, the grading engine's session-lifecycle Worker wrapper, and the lightweight PV stepper. Recognizing which of the five "Don't Hand-Roll" rows apply avoids the two biggest false-effort traps in this phase (reinventing grading math, reinventing the deep link).

## Common Pitfalls

### Pitfall 1: WASM grading movetime budget is unvalidated for Train's single-move-eval shape

**What goes wrong:** The seed's "~1s" grading-time assumption was never re-validated for this exact search shape (a full, unrestricted single-line search on an arbitrary position, run twice per non-exact-match puzzle). The sibling `useStockfishGradingEngine.ts` hook caps its (differently-shaped, `searchmoves`-restricted) grading runs at up to `GRADING_MOVETIME_SAFETY_CAP_MS = 2500`ms (workerPool.ts) — not 1000ms. `useStockfishEngine.ts`'s own primary search uses `MOVETIME_MS = 1500` plus a `MAX_NODES = 2000000` node cap. Using too short a movetime risks the WASM engine disagreeing with the "true" best move near the MISTAKE_DROP boundary in sharp puzzles specifically — the case where getting it right matters most (a sharp puzzle's whole premise is that only the best move is correct).

**Why it happens:** Train's grading shape (evaluate an arbitrary FEN cold, twice per non-exact puzzle, on a mobile-capable device) is a genuinely different workload than either existing hook was tuned for (one is a continuously-re-triggered live eval bar, the other is a fixed-candidate-set grading pool).

**How to avoid:** Run a headless measurement pass before finalizing the budget, per this project's own established recipe (`project_headless_stockfish_wasm_verification` memory note): copy the vendored `stockfish-18-lite-single.js` to a `.cjs` file and run it in Node via stdin/stdout UCI, feeding it a curated set of real Train-shaped positions (sharp blunders where second-best is a genuine mistake) at a few candidate movetimes, and check whether the found best move / eval stabilizes. Pick a movetime that is generous enough for sharp-puzzle accuracy but doesn't make the D-06 "Checking your move…" wait feel broken on mobile — treat near-threshold disagreement as an accepted, bounded noise band (this project already accepts `eval_cp` non-determinism across machines per `project_eval_nondeterminism`), not something to chase to zero.

**Warning signs:** A UAT session where "I know that was the right move" contests cluster near MISTAKE_DROP-adjacent drops rather than being randomly distributed.

### Pitfall 2: Recreating the grading Worker per puzzle instead of per session

**What goes wrong:** Every non-exact-match puzzle pays a full WASM cold-start (module compile + UCI handshake) on top of the actual search, on every puzzle — most sessions have several non-exact answers, so this multiplies real wait time across the whole session.

**Why it happens:** The natural first implementation mounts the grading hook per-puzzle (matching how the puzzle component itself is likely keyed/remounted between puzzles) rather than lifting the Worker to the session-level parent.

**How to avoid:** See Architecture Patterns Pattern 4 — one Worker instance for the whole session, warmed at session start.

**Warning signs:** Repeated WASM module loads visible in the browser's Network/Performance panel within a single session (not just once at Train mount).

### Pitfall 3: Board component remount losing grading state between puzzles

**What goes wrong:** If `TrainSolveScreen` (or its `ChessBoard` instance) is keyed by `puzzle.position` (a common React pattern to force a clean reset between puzzles), any in-flight background grading search for the CURRENT puzzle survives the remount as a dangling promise, and its `resolve` callback may fire into unmounted state or race the next puzzle's own search.

**Why it happens:** Keying-to-force-reset is the idiomatic React pattern for "fresh state per item," but it interacts badly with an imperative Worker-based search that outlives a single render cycle by design (that's the whole point of starting it early, per Pattern 2).

**How to avoid:** Keep the grading engine hook at a level ABOVE the per-puzzle key boundary (session-scoped, per Pattern 4), and have it expose an explicit `startGrading(fen)` / `abortGrading()` pair the puzzle-transition logic calls deliberately, rather than relying on mount/unmount to manage the search lifecycle. Mirror `workerPool.ts`'s `AbortSignal` support if the puzzle changes before a search resolves (e.g., abandon-mid-puzzle per D-15).

**Warning signs:** A grading verdict for puzzle N briefly flashes on puzzle N+1's screen, or the "Checking your move…" spinner never resolves after rapid Next-clicking.

### Pitfall 4: Solve POST failure silently loses SR progress

**What goes wrong:** Per CLAUDE.md's established pattern requirement ("solve POST failures need explicit handling too... a lost solve = lost SR progress"), a network failure on `POST /train/sessions/{id}/solve` after the user has already played and been graded looks, from the user's perspective, like nothing happened — but the backend's streak/due-date/fail-count update never occurred.

**Why it happens:** The grading (client-side, instant-feeling) and the persistence (a network round-trip that can fail) are two separate steps; it's easy to treat the local grading result as "done" and under-handle the POST's own failure mode.

**How to avoid:** Explicit retry/error UI on solve-POST failure (toast + retry action, not a silent swallow), consistent with the project's global "every data-loading ternary needs an `isError` branch" convention extended to mutations here. Consider whether a failed solve should block advancing to the next puzzle (safer) or allow it with a persistent "N unsaved" indicator — this is a UX call for the plan to make explicitly, not default silently.

**Warning signs:** A user's streak/due-date visibly doesn't reflect a session they believe they completed.

### Pitfall 5: Session progress index desyncing from the frozen puzzle list on resume

**What goes wrong:** Per 189 D-09, the puzzle list is frozen (materialized) at session composition — resuming mid-window must show exactly the remaining puzzles with a stable "4 of 12." If the frontend recomputes "current puzzle index" from a naive `puzzles.findIndex(unsolved)` against a FRESH `POST /train/sessions` response (which, per 189's resume semantics, returns the same materialized list plus `solved_count`), a bug here could show "1 of 12" after resuming a session already 4 puzzles in.

**Why it happens:** `POST /train/sessions` is both the "start a new session" AND "resume an open session" endpoint (189 D-12: at most one open session per user) — the frontend must branch on whether the response represents a fresh or resumed session and seed its local index from `solved_count`, not always start at 0.

**How to avoid:** On session load, initialize the solve-loop's current index from `TrainSessionResponse.solved_count` (skip to the first unsolved puzzle in the returned `puzzles` array), not from a hardcoded 0. Verify against D-14's exact wording: "Resume session — 4 of 12 done... drops the user onto the next unsolved puzzle."

**Warning signs:** Resuming a session re-shows already-solved puzzles, or the progress bar briefly flashes 0% before jumping to the correct position.

## Runtime State Inventory

Not applicable — this is a greenfield frontend feature build (new route, new components, new hooks), not a rename/refactor/migration phase.

## Environment Availability

Skipped — this phase has no external service/tool dependencies beyond what's already vendored in the repo (the Stockfish WASM binary, already present at `public/engine/stockfish-18-lite-single.js` and confirmed working by every Bot Play / Analysis page in production). No new CLI tools, databases, or runtimes are introduced.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (frontend), pytest (backend, for the two additive schema/endpoint changes) |
| Config file | `frontend/vite.config.ts` (no dedicated `test:` block — 5s default `testTimeout` project-wide, per `project_frontend_heavy_test_timeout_flake` memory note); `pyproject.toml` (pytest) |
| Quick run command | `cd frontend && npm test -- --run <pattern>`; `uv run pytest tests/test_train_router.py -x` |
| Full suite command | `cd frontend && npm test -- --run`; `uv run pytest -n auto` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SOLV-01 | Board stays locked until guess committed | unit (component) | `npm test -- --run TrainSolveScreen` | ❌ Wave 0 |
| SOLV-02 | Board orientation + last-move highlight match `TrainPuzzle` | unit (component) | `npm test -- --run TrainSolveScreen` | ❌ Wave 0 |
| SOLV-03 | Grading: exact-match instant-correct; non-exact drop classification | unit (hook, headless) | `npm test -- --run useTrainGradingEngine` | ❌ Wave 0 |
| SOLV-03 | Backend `last_move_uci`/`pv` additive fields | unit (backend) | `uv run pytest tests/test_train_schemas.py -x` | ❌ Wave 0 |
| SOLV-04 | "N of M" indicator reflects `solved_count`/`puzzle_count` | unit (component) | `npm test -- --run TrainSolveScreen` | ❌ Wave 0 |
| SOLV-05 | Reveal shows both verdicts + best line + game card + deep link | unit (component) | `npm test -- --run TrainReveal` | ❌ Wave 0 |
| SOLV-06 | Tactic stepper offered only when `has_tactic_lines`, both orientations | unit (component) | `npm test -- --run TrainLineStepper` | ❌ Wave 0 |
| SOLV-07 | Score aggregation + green/yellow/red thresholds | unit (pure function) | `npm test -- --run trainScore` | ❌ Wave 0 |
| NAV-01 | `/train` in `NAV_ITEMS`/`BOTTOM_NAV_ITEMS`/drawer, test IDs, `isActive` | unit (App.test.tsx) | `npm test -- --run App.test` | ✅ (extend existing) |
| NAV-02 | `/train` NOT in `IMPORT_EXEMPT_ROUTES`, gated like Openings | unit (App.test.tsx) | `npm test -- --run App.test` | ✅ (extend existing) |

### Sampling Rate
- **Per task commit:** `npm test -- --run <touched-file-pattern>`; `uv run pytest tests/test_train_*.py -x` for the two backend additions
- **Per wave merge:** `npm test -- --run`; `uv run pytest -n auto`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` — headless test against fixture FENs, mirroring `useStockfishGradingEngine.test.ts`'s existing pattern (mock/stub the Worker, or run against the real vendored engine in a Node-compatible harness per the project's WASM-verification recipe)
- [ ] `frontend/src/lib/__tests__/trainScore.test.ts` — pure scoring/threshold logic
- [ ] `tests/test_train_schemas.py` (or extend `189`'s existing test file) — covers the two additive `last_move_uci`/`pv` fields
- [ ] Framework install: none — Vitest/pytest already configured project-wide

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (indirect) | `current_active_user` dependency, unchanged from Phase 189 — this phase adds no new auth surface |
| V3 Session Management | no | No new session/token handling; reuses existing JWT auth |
| V4 Access Control | yes | `_reject_guest` gate already enforced server-side (Phase 189); frontend must not assume a guest can reach `/train` — `ProtectedLayout`/`ImportRequiredRoute` already redirect unauthenticated/ungated users before any Train component mounts |
| V5 Input Validation | yes | `SolveRequest.played_move` already has `Field(min_length=4, max_length=5)`; frontend should validate the UCI shape client-side before POSTing as a UX nicety, not a security boundary (server validates regardless) |
| V6 Cryptography | no | Not applicable to this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Client-asserted `correct_move` tampering (devtools-edited request) | Tampering | **Explicitly accepted risk, already documented in 189-05-PLAN.md (T-189-18):** "Client-side grading is the settled design (SEED-037); v1 has no leaderboard or competitive integrity, so a self-inflicted false verdict harms only that user's own schedule." Not this phase's problem to fix — do not add server-side move validation, it would contradict the locked "no grading endpoint" design. Revisit only if/when a leaderboard is built (v2, explicitly deferred). |
| Reveal-data prefetch leaking guess ground truth before the user commits | Information Disclosure | Fetch `PuzzleRevealResponse` and tactic-lines data ONLY after the solve POST succeeds — never speculatively on puzzle mount (Anti-Patterns above); the 409 gate on the reveal endpoint already enforces this server-side, but the frontend must not defeat it by holding reveal-only fields in pre-attempt component state/props (per PITFALLS.md's "Looks Done But Isn't" checklist item on this exact point) |
| IDOR on `session_id`/`position` path params | Tampering / Information Disclosure | Already mitigated server-side (Phase 189): `current_active_user.id` scopes every query, never trusts a client-supplied user id; this phase's frontend work introduces no new IDOR surface since it only calls the already-scoped endpoints |

## Code Examples

Verified patterns from this exact codebase (not external docs — every excerpt below was read directly in this session):

### Before/after expected-score grading (the template for `useTrainGradingEngine`'s classification step)
```typescript
// Source: frontend/src/hooks/useLiveMoveFlaw.ts (read in full this session)
const mover = sideToMoveFromFen(parentFen);
const esBefore = evalToExpectedScore(parentEval.cp, parentEval.mate, mover);
const esAfter = evalToExpectedScore(childEvalCp, childEvalMate, mover);
const severity = classifyLiveSeverity(esBefore, esAfter);
// severity === null → clean/correct; 'inaccuracy' also passes per SOLV-03
```

### Single-worker lifecycle template (the shape `useTrainGradingEngine` should copy, NOT the N-worker pool)
```typescript
// Source: frontend/src/hooks/useStockfishEngine.ts:235-260 (read in full this session)
// Classic (non-module) Worker; UCI handshake uciok -> setoption -> isready -> readyok;
// stop-before-go serialization via a stateRef 'idle'|'thinking'|'stopping' state machine.
const worker = new Worker(ENGINE_PATH); // '/engine/stockfish-18-lite-single.js'
worker.postMessage('uci');
// ... on 'readyok': trigger the first search; on 'bestmove': commit result, go idle.
```

### GameCard deep-link reuse (SOLV-05's "deep link into the analysis board" — already built)
```typescript
// Source: frontend/src/components/results/GameCard.tsx (props signature, read this session)
// <GameCard game={gameFlawCard} analyzePly={puzzle.ply} /> renders a full-width
// Analyze button that opens buildGameAnalysisUrl(game_id, ply) — orientation
// is derived server-side from the game's user_color in game mode.
```

### Existing tactic-lines endpoint (SOLV-06's data source — no new backend work)
```python
# Source: app/routers/library.py:355-379 (read in full this session)
@router.get("/flaws/{game_id}/{ply}/tactic-lines", response_model=TacticLinesResponse)
async def get_tactic_lines(session, user, game_id: int, ply: int) -> TacticLinesResponse:
    # NOT owner-scoped (Quick 260717-agv) — any authenticated user may call this
    # with a drill item's own (game_id, ply). Returns 404 if no flaw exists there.
    ...
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Seed's assumed payload shape (`TrainPuzzle` carries `best_move` for exact-match) | `TrainPuzzle` carries NO answer key at all; grading is 100% self-contained via the client's own search | Phase 189 planning, decision P-01 (2026-07-25) | Changes this phase's grading engine design fundamentally from "compare to a fetched value" to "the client IS the source of truth for its own grading" — see Architecture Patterns Pattern 2 |
| Pre-189 milestone research's assumption that the pool-composition endpoint returns `best_move` | Confirmed by direct code read: it does not (`app/schemas/train.py`, `app/routers/train.py`) | This research session, 2026-07-25 | `.planning/research/ARCHITECTURE.md`'s System Overview diagram is stale on this one point; do not carry that assumption into planning |

**Deprecated/outdated:**
- `.planning/research/ARCHITECTURE.md`'s and `.planning/research/PITFALLS.md`'s pre-Phase-189 assumption that `best_move` ships in the pre-attempt payload — superseded by the actual shipped schema (P-01). Everything else in those two documents (nav wiring, VariationTree coupling analysis, cascade/timezone findings for Phases 189/191) remains accurate and was cross-checked against the real code again in this session.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `pv` field format for `PuzzleRevealResponse` should be a SAN list (not UCI) to simplify the stepper | Pattern 1 / Pattern 3 | Low — either format works with `chess.js` replay; a UCI list just needs one extra `chess.move({from,to})` step per token. Planner should pick based on what's most convenient given how `TacticLinesResponse` already does it (SAN) for consistency |
| A2 | The best fix for last-move data is a new `last_move_uci` field on `TrainPuzzle` rather than deriving it client-side from the game's full PGN | Pattern 1 | Low-medium — fetching the full PGN client-side to derive the last move would require a new/different endpoint call and risks incidentally exposing more game context than SOLV-02 wants on the "lichess-minimal" solve screen; the additive-field approach is deliberately narrow |
| A3 | A single new `TrainLineStepper` component can serve both the best-line (SOLV-05) and tactic-line (SOLV-06) cases | Pattern 3 | Low — both are "SAN list + board + prev/next," but the tactic case's dual-orientation (missed/allowed) requirement may want a thin wrapper distinguishing the two; worth confirming during the spike, not assuming |

**If this table is empty:** N/A — see above; all three assumptions are LOW risk and stem from Claude's-discretion areas CONTEXT.md already delegated to the planner, not from unverified factual claims about the codebase.

## Open Questions

1. **Should the grading engine's first ("find the best move") search start at guess-commit time (board unlock, D-05) or at puzzle-mount time (before the guess)?**
   - What we know: Starting earlier gives the search more time to complete before the user submits a move (favoring the D-06 instant-correct fast path), and the position is fully visible for study before the guess per D-05's own wording ("Position fully visible for study; pieces don't respond until...").
   - What's unclear: Whether starting the search at mount time (before the guess is even committed) risks any perception of "the engine is already thinking about this" undermining the guess's honesty as a pure judgment call — probably not a real concern (the search result isn't shown to the user either way), but worth a quick gut-check during UAT.
   - Recommendation: Start at puzzle-mount time (maximizes the fast-path hit rate); this is invisible to the user either way since nothing about the search is displayed pre-move.

2. **Does a failed `POST /train/sessions/{id}/solve` block advancing to the next puzzle?**
   - What we know: Pitfall 4 above flags this as a real gap; CLAUDE.md requires explicit handling, not silent swallowing.
   - What's unclear: The UX tradeoff between "block and force retry" (safer for data integrity, worse for flow) vs. "allow advancing with a persistent unsaved-count indicator" (better flow, requires more state tracking).
   - Recommendation: Block-and-retry is simpler to implement correctly and matches the "no grading endpoint, but persistence still matters" spirit of the design; revisit if UAT finds it too disruptive.

## Sources

### Primary (HIGH confidence — direct code reads this session)
- `app/schemas/train.py`, `app/routers/train.py` — the actual shipped Phase 189 API contract
- `.planning/phases/189-pool-scheduler-backend/189-01-PLAN.md`, `189-05-PLAN.md` — the P-01/P-02/P-03/P-06 decisions resolving the grading-architecture tension
- `.planning/phases/190-train-page-solve-loop/190-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/phases/189-pool-scheduler-backend/189-CONTEXT.md` — locked decisions and carried-forward D-03/D-05/D-09..D-12
- `frontend/src/App.tsx` — exact nav wiring insertion points (`NAV_ITEMS`, `BOTTOM_NAV_ITEMS`, `ROUTE_TITLES`, `isActive`, `IMPORT_EXEMPT_ROUTES`, `isNavLocked`, `MobileBottomBar`, `MobileMoreDrawer`, `ImportRequiredRoute`)
- `frontend/src/components/analysis/VariationTree.tsx` — full read confirming the coupling-to-Analysis.tsx concern
- `frontend/src/lib/liveFlaw.ts`, `frontend/src/generated/flawThresholds.ts`, `frontend/src/hooks/useLiveMoveFlaw.ts` — the exact reusable grading classification chain
- `frontend/src/hooks/useStockfishEngine.ts`, `frontend/src/lib/engine/workerPool.ts` — the two candidate Worker lifecycle templates, confirming the single-line shape fits Train better than the N-candidate pool shape
- `frontend/src/components/results/GameCard.tsx`, `frontend/src/lib/analysisUrl.ts` — confirming the deep-link + game card are already fully built
- `app/routers/library.py`, `app/schemas/library.py` — the existing, reusable `tactic-lines` endpoint and `GameFlawCard`/`GET /library/games/{game_id}`
- `app/models/game_position.py` — confirming `pv`/`best_move` column existence for the additive reveal field
- `frontend/src/hooks/useUserFlag.ts`, `frontend/src/lib/theme.ts`, `frontend/src/lib/confetti.ts` — nav-dot, color, and (Phase-191-adjacent) celebration infrastructure

### Secondary (MEDIUM confidence)
- `.planning/research/SUMMARY.md`, `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md` — pre-Phase-189 milestone-level research; cross-checked against the real shipped code this session and corrected where superseded (see State of the Art section)
- `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` — settled design source; its "exact match to stored best_move" phrasing predates and is superseded by Phase 189's P-01 resolution

### Tertiary (LOW confidence)
- None flagged — every claim in this document is either a direct code read this session or explicitly marked in the Assumptions Log above.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies, every capability verified installed/vendored and in active use elsewhere in this exact codebase
- Architecture: HIGH — grounded in direct reads of the real shipped Phase 189 files, not the pre-189 milestone assumptions
- Pitfalls: HIGH — five pitfalls, all either newly identified from the actual shipped schema (Pitfalls 3-5) or carried forward from the milestone-level PITFALLS.md and re-verified (Pitfalls 1-2)

**Research date:** 2026-07-25
**Valid until:** Stable until Phase 189's schema changes again or the vendored Stockfish binary is upgraded; re-verify the movetime-budget recommendation (Pitfall 1) if the headless measurement pass this phase should run produces a different number than assumed here.
