# Phase 190: Train Page + Solve Loop - Pattern Map

**Mapped:** 2026-07-25
**Files analyzed:** 12 (2 backend additive, 10 new frontend + 1 modified)
**Analogs found:** 12 / 12

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/schemas/train.py` (modify) | model/schema | request-response | itself (existing `TrainPuzzle`/`PuzzleRevealResponse`) | exact |
| `app/routers/train.py` (modify, no new routes) | route | request-response | itself | exact |
| `frontend/src/pages/Train.tsx` | component (lazy route page) | request-response | `frontend/src/pages/Bots.tsx` | exact |
| `frontend/src/components/train/TrainStartScreen.tsx` | component | CRUD (read session state) | `frontend/src/pages/Bots.tsx` setup-screen section | role-match |
| `frontend/src/components/train/TrainSolveScreen.tsx` | component | request-response + streaming (engine msgs) | `frontend/src/pages/Analysis.tsx` board+overlay wiring | role-match |
| `frontend/src/components/train/TrainReveal.tsx` | component | request-response | `frontend/src/components/results/GameCard.tsx` consumer pattern in `Analysis.tsx` | role-match |
| `frontend/src/components/train/TrainLineStepper.tsx` | component | transform (SAN replay) | `frontend/src/components/analysis/VariationTree.tsx` (utilities only, not the component) | partial |
| `frontend/src/components/train/TrainScoreScreen.tsx` | component | transform | `frontend/src/pages/Bots.tsx` game-end summary section | role-match |
| `frontend/src/hooks/useTrainSession.ts` | hook (TanStack Query) | CRUD/request-response | `frontend/src/hooks/useBotGame.ts` (orchestration shape) + `frontend/src/hooks/useImport.ts` (query/mutation shape) | role-match |
| `frontend/src/hooks/useTrainGradingEngine.ts` | hook (Worker lifecycle) | event-driven | `frontend/src/hooks/useStockfishEngine.ts` | exact |
| `frontend/src/lib/trainScore.ts` | utility (pure) | transform | `frontend/src/lib/liveFlaw.ts` (pure classification functions) | role-match |
| `frontend/src/api/client.ts` (modify) | service (API client) | request-response | `botsApi` / `libraryApi` objects in same file | exact |
| `frontend/src/App.tsx` (modify) | route/nav config | request-response | existing `NAV_ITEMS`/`BOTTOM_NAV_ITEMS`/`ROUTE_TITLES`/`isActive`/`IMPORT_EXEMPT_ROUTES` wiring for `/openings` | exact |

## Pattern Assignments

### `app/schemas/train.py` (model, request-response)

**Analog:** itself — additive fields only, do not restructure.

Current `TrainPuzzle` (lines 17-32) is explicitly documented as "EXACTLY these five fields":
```python
class TrainPuzzle(BaseModel):
    """One pre-attempt puzzle. EXACTLY these five fields — no more, no less.
    POOL-10 / P-01 (LOCKED): the pre-attempt payload carries no answer key.
    ...
    """
    position: int
    game_id: int
    ply: int
    fen: str
    side_to_move: Literal["white", "black"]
```
**Pattern to copy:** add `last_move_uci: str | None` as a sixth field, and rewrite the docstring's "EXACTLY these five fields" claim to explain why a sixth is safe (arrival data, not answer key) — don't silently leave the stale claim. Mirror the same additive-field + updated-docstring discipline for `PuzzleRevealResponse` (lines 96-111ff, has `best_move`/`best_move_san`, needs `pv: list[str] | None` added after `best_move_san` with a comment tying it to the post-attempt-only 409 gate already described in that docstring).

### `app/routers/train.py` (route, request-response)

**Analog:** itself — no new endpoints, only response-model field population changes inside `compose_or_resume_session` (session/puzzle assembly, ~line 44) and `reveal_puzzle` (~line 132). Read the existing PGN-replay call site that derives `fen`/`ply` to find where the one-ply-earlier move is already available for `last_move_uci`, and the existing `game_positions.pv`/`best_move` derivation site in `reveal_puzzle` to add the new `pv` field alongside it — same query, same object construction, additive attribute only.

### `frontend/src/pages/Train.tsx` (component, request-response)

**Analog:** `frontend/src/pages/Bots.tsx`

**Export pattern** (line 530):
```typescript
export default function BotsPage(): ReactElement {
```
Train.tsx must mirror this **default export** (not named), matching the app's one other lazy-loaded route:
```typescript
// frontend/src/App.tsx:40-43
const AnalysisPage = lazy(() => import('./pages/Analysis'));
const BotsPage = lazy(() => import('./pages/Bots'));
```
Add `const TrainPage = lazy(() => import('./pages/Train'));` following this exact two-line comment convention (explaining why it's lazy-loaded — WASM bundle weight).

### `frontend/src/components/train/*` (components)

**Analog for state-machine composition:** `frontend/src/hooks/useBotGame.ts` — demonstrates this codebase's pattern for a single orchestrating hook composing multiple pure modules (chessClock, botGameEnd, etc.) rather than scattering state across components; `useTrainSession.ts` should follow the same "one hook owns the loop" shape (session state, current puzzle index, guess/attempt/reveal transitions) rather than lifting state into `Train.tsx` directly.

**Analog for board integration:** `frontend/src/components/board/ChessBoard.tsx` (props, lines 62-73, verbatim reuse — do not fork):
```typescript
interface ChessBoardProps {
  ...
  flipped?: boolean;
  lastMove?: { from: string; to: string } | null;
  lastMoveColor?: string;
  ...
}
export function ChessBoard({ position, onPieceDrop, flipped = false, lastMove, lastMoveColor, arrows = [], squareMarkers = [], id, maxWidth = 400, heightRef }: ChessBoardProps) {
```
`TrainSolveScreen` passes `flipped={puzzle.side_to_move === 'black'}`, `lastMove={{from: ..., to: ...}}` derived from the new `last_move_uci` field, and relies on the existing click+drag input the component already implements (`data-testid="chessboard"` + `data-testid="square-{square}"` at line 379 are already present — no new plumbing needed).

**Analog for game card + deep link:** `frontend/src/components/results/GameCard.tsx` (lines 17-51, 221-227):
```typescript
interface GameCardProps {
  game: GameFlawCard;
  analyzePly?: number;
}
export function GameCard({ game, analyzePly }: GameCardProps) {
  ...
  {analyzePly != null && (
    <Link to={buildGameAnalysisUrl(game.game_id, analyzePly)}>
```
`TrainReveal.tsx` renders `<GameCard game={gameFlawCard} analyzePly={puzzle.ply} />` verbatim — fetch the `GameFlawCard` via `libraryApi.getGame(game_id)` (existing endpoint, see api/client.ts pattern below) only after the solve POST succeeds, never speculatively.

### `frontend/src/components/train/TrainLineStepper.tsx` (component, transform)

**Analog:** `frontend/src/components/analysis/VariationTree.tsx` — reuse ONLY these two portable pure-function exports, not the component itself (per RESEARCH.md Pattern 3, confirmed by direct read: full component is 1097 LOC coupled to `Analysis.tsx`'s branching-tree editor state):
```typescript
// frontend/src/lib/tacticComparisonMeta.ts
export function tacticMotifLabel(motif: string): string { ... }      // line 470
export function tacticDepthBadge(...): ... { ... }                    // line 586
```
Build a small new component: `moves: string[]` (SAN) + `startFen: string` props, internal `currentIndex` state, replay via `chess.js` to derive per-step FEN (mirror how the existing `tactic-lines` consumer already replays `position_fen` + SAN — grep that consumer before writing this from scratch), render `<ChessBoard>` + prev/next controls + the two imported label helpers. **Do a short timeboxed spike first** confirming this shape works for both the best-line (`pv` field) case and the tactic-line (`missed_moves`/`allowed_moves`) case before committing to two call sites of one component.

### `frontend/src/hooks/useTrainSession.ts` (hook, CRUD/request-response)

**Analog:** `frontend/src/hooks/useImport.ts` for the plain TanStack Query mutation/query shape (session POST, solve POST, reveal GET as three separate query/mutation hooks composed together), and `frontend/src/hooks/useBotGame.ts` for how a single hook should own the full loop's derived state (current puzzle index, resume-vs-fresh branching per Pitfall 5 in RESEARCH.md — seed the index from `solved_count`, never hardcode 0).

### `frontend/src/hooks/useTrainGradingEngine.ts` (hook, event-driven)

**Analog:** `frontend/src/hooks/useStockfishEngine.ts` — copy this file's lifecycle almost verbatim (single Worker, not the N-worker pool in `useStockfishGradingEngine.ts`).

**Constants pattern** (lines 27, 30):
```typescript
const MOVETIME_MS = 1500;
const MAX_NODES = 2000000;
```
Train needs its own named constants here (validate via the headless measurement pass per RESEARCH.md Pitfall 1 before finalizing the value — do not just copy `1500`).

**Worker creation + UCI handshake** (lines 235-284, 338-339):
```typescript
useEffect(() => {
  const worker = new Worker(ENGINE_PATH); // '/engine/stockfish-18-lite-single.js'
  // ... classic (non-module) Worker — do NOT pass { type: 'module' }
  worker.onmessage = (e) => {
    const line = e.data;
    if (line === 'uciok') {
      worker.postMessage(`setoption name MultiPV value ${MULTIPV}`);
      worker.postMessage('isready');
    }
    if (line === 'readyok') { /* trigger first search */ }
  };
  worker.postMessage('uci');
  return () => { worker.postMessage('stop'); worker.terminate(); };
}, [...]);
```
**Search dispatch** (lines 217-218):
```typescript
worker.postMessage(`position fen ${fenToAnalyze}`);
worker.postMessage(`go movetime ${MOVETIME_MS} nodes ${MAX_NODES}`);
```
Per RESEARCH.md Anti-Patterns: if a future variant restricts `searchmoves`, it must be the LAST clause in the `go` command (see `workerPool.ts`'s `sendGo` comment) — not relevant to the initial free-search version but worth the constant-ordering note in the new file's header comment.

**Grading classification** — reuse `useLiveMoveFlaw.ts`'s import block verbatim (lines 17-24):
```typescript
import { classifyLiveSeverity, evalToExpectedScore, sideToMoveFromFen } from '@/lib/liveFlaw';
```
and its before/after pattern:
```typescript
const mover = sideToMoveFromFen(puzzle.fen);
const esBefore = evalToExpectedScore(bestSearch.evalCp, bestSearch.evalMate, mover);
const esAfter = playedMoveUci === bestSearch.bestMoveUci
  ? esBefore
  : evalToExpectedScore(afterMoveSearch.evalCp, afterMoveSearch.evalMate, mover);
const severity = classifyLiveSeverity(esBefore, esAfter);
const correctMove = severity === null || severity === 'inaccuracy';
```
**Never re-derive the sigmoid or threshold locally** — `flawThresholds.ts` is CI-drift-checked against the backend; import, don't copy values.

### `frontend/src/lib/trainScore.ts` (utility, transform)

**Analog:** `frontend/src/lib/liveFlaw.ts` — a pure-function module with no React/component coupling, exported constants for thresholds (mirror the "named constants, no magic numbers" convention CLAUDE.md requires — e.g. `SCORE_RATING_GREEN_MIN`, `SCORE_RATING_YELLOW_MIN` rather than inline comparisons). Also check `frontend/src/lib/scoreConfidence.ts` / `frontend/src/lib/scoreBulletConfig.ts` for this project's existing score-band-to-color-name convention before inventing a new one — reuse the naming style if compatible with `theme.ts`'s green/yellow/red semantics.

### `frontend/src/api/client.ts` (modify, request-response)

**Analog:** existing endpoint-group object literals in the same file (`botsApi` line 231, `libraryApi` line 240):
```typescript
export const botsApi = {
  storeBotGame: (data: StoreBotGameRequest) =>
    apiClient.post<StoreBotGameResponse>('/bots/games', data).then(r => r.data),
  getPersonaWins: () =>
    apiClient.get<PersonaWinsResponse>('/bots/persona-wins').then(r => r.data),
};
```
Add a `trainApi` object in the same style: `composeOrResumeSession`, `solvePuzzle`, `revealPuzzle`, `getSettings`, `updateSettings` — each a thin `apiClient.<verb>(...).then(r => r.data)` one-liner, matching this file's existing convention exactly (no axios usage outside this file, per the project's httpx/axios-only rule mirrored on the frontend).

### `frontend/src/App.tsx` (modify, route/nav config)

**Analog:** the existing `/openings` and `/endgames` wiring (exact same pattern to replicate for `/train`, NOT the `/bots` pattern since Train IS import-gated).

**Nav const arrays** (lines 65-77):
```typescript
const NAV_ITEMS = [
  { to: '/library', label: 'Library', Icon: FolderOpen },
  { to: '/bots', label: 'Bots', Icon: Bot },
  { to: '/openings', label: 'Openings', Icon: BookOpenIcon },
  { to: '/endgames', label: 'Endgames', Icon: TrophyIcon },
] as const;
```
Per CONTEXT.md's placement decision ("between Library and Bots on all 3 nav surfaces"), insert a `{ to: '/train', label: 'Train', Icon: <chosen icon> }` entry at index 1 in BOTH `NAV_ITEMS` and `BOTTOM_NAV_ITEMS` (lines 65-70 and 72-77) — these two arrays are currently identical; do not let them diverge only on the Train entry.

**`ROUTE_TITLES`** (lines 85-92): add `'/train': 'Train',`.

**`isActive` helper** (lines 115-121): add a branch `if (to === '/train') return pathname.startsWith('/train');` following the exact `/bots`/`/openings` precedent (line 117-118) — do NOT fall through to the generic `pathname === to` which would break sub-routes if Train ever grows one.

**`IMPORT_EXEMPT_ROUTES`** (line 107): Train must **NOT** be added here (NAV-02) — leave it as `new Set(['/library', '/admin', '/bots'])` unchanged; Train follows the `isNavLocked` gate exactly like Openings/Endgames.

**Notification dot chain** (D-16) — `NavHeader` (lines 140-145):
```typescript
const openingsVisited = useUserFlag(FLAG_OPENINGS_VISITED, profile?.email);
const endgamesVisited = useUserFlag(FLAG_ENDGAMES_VISITED, profile?.email);
const showOpeningsDot = navUnlocked && !openingsVisited;
const showEndgamesDot = navUnlocked && openingsVisited && !endgamesVisited;
```
Extend the chain with `FLAG_TRAIN_VISITED` (declared alongside `FLAG_OPENINGS_VISITED`/`FLAG_ENDGAMES_VISITED` at lines 45-46) and `showTrainDot = navUnlocked && endgamesVisited && !trainVisited` (chained AFTER Endgames per D-16's "Openings → Endgames" ordering, extended to "→ Train"). Mirror the dot JSX block (lines 188-205) with a `data-testid="train-notification-dot"` variant.

**Route registration** — `ImportRequiredRoute` wrapping (line 757):
```typescript
<Route path="/openings/*" element={<ImportRequiredRoute><OpeningsPage /></ImportRequiredRoute>} />
<Route path="/endgames/*" element={<ImportRequiredRoute><EndgamesPage /></ImportRequiredRoute>} />
```
Add `<Route path="/train/*" element={<ImportRequiredRoute><Suspense fallback={...}><TrainPage /></Suspense></ImportRequiredRoute>} />` inside `ProtectedLayout`'s route tree (near line 750-758) — combine the `ImportRequiredRoute` wrapper (Openings/Endgames precedent) with the `Suspense` wrapper (Bots/Analysis lazy-loading precedent, check how `BotsPage`'s route entry wraps `Suspense` around the lazy import at its own route line).

## Shared Patterns

### Import gating
**Source:** `frontend/src/App.tsx` — `isNavLocked()` (lines 109-111) + `useReadiness().tier1` + `totalGames > 0` (line 138-139)
**Apply to:** `Train.tsx` nav entry, `/train/*` route wrapper. Do NOT reimplement a second readiness check — reuse `useReadiness()` verbatim, the same hook `NavHeader` already calls.

### Client-side expected-score grading
**Source:** `frontend/src/lib/liveFlaw.ts` (`evalToExpectedScore`, `classifyLiveSeverity`, `sideToMoveFromFen`) + `frontend/src/generated/flawThresholds.ts` (`MISTAKE_DROP` constant)
**Apply to:** `useTrainGradingEngine.ts`'s classification step only — never re-derive the sigmoid or threshold locally (CI-drift-checked against `flaws_service.py`).

### Stockfish Worker lifecycle (single-instance, not pool)
**Source:** `frontend/src/hooks/useStockfishEngine.ts` (full UCI handshake state machine, `idle`/`thinking`/`stopping`)
**Apply to:** `useTrainGradingEngine.ts` — one Worker per session (warmed at session start per Pattern 4 in RESEARCH.md), exposing explicit `startGrading(fen)`/`abortGrading()` rather than relying on mount/unmount (Pitfall 3).

### `isError` branch on every data-loading ternary + mutation
**Source:** CLAUDE.md convention, already followed throughout `frontend/src/pages/*`
**Apply to:** `useTrainSession.ts`'s solve-POST mutation especially — per RESEARCH.md Pitfall 4, a failed solve POST must surface explicit retry UI, not fall through silently (a lost solve = lost SR progress).

### Theme colors for verdicts/ratings
**Source:** `frontend/src/lib/theme.ts`
**Apply to:** `TrainReveal.tsx`'s verdict rows (D-10 green/red) and `TrainScoreScreen.tsx`'s green/yellow/red rating — never hardcode `bg-green-500` etc. directly in these components.

## No Analog Found

None — every file in scope has at least a role-match analog in the existing codebase; this phase is composition-heavy per RESEARCH.md's own conclusion ("almost entirely composition of already-shipped primitives").

## Metadata

**Analog search scope:** `frontend/src/pages/`, `frontend/src/hooks/`, `frontend/src/components/{board,results,analysis,train}/`, `frontend/src/lib/`, `frontend/src/api/client.ts`, `frontend/src/App.tsx`, `app/schemas/train.py`, `app/routers/train.py`
**Files scanned:** ~15 (Bots.tsx, Analysis.tsx, App.tsx, useBotGame.ts, useLiveMoveFlaw.ts, useStockfishEngine.ts, useStockfishGradingEngine.ts, useImport.ts, liveFlaw.ts, tacticComparisonMeta.ts, VariationTree.tsx, GameCard.tsx, ChessBoard.tsx, client.ts, train.py schemas/router)
**Pattern extraction date:** 2026-07-25
