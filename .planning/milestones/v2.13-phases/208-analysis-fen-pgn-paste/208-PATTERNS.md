# Phase 208: Paste a FEN or PGN on /analysis - Pattern Map

**Mapped:** 2026-08-08
**Files analyzed:** 10 (new/modified)
**Analogs found:** 10 / 10

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `frontend/src/components/analysis/PasteModal.tsx` (new) | component (modal) | request-response | `frontend/src/components/feedback/FeedbackModal.tsx` | exact |
| `frontend/src/hooks/usePasteGame.ts` (new, or inline mutation) | hook | request-response | `frontend/src/hooks/useEnqueueGame.ts` | exact |
| `frontend/src/pages/Analysis.tsx` (modified — trigger, sniff, ephemeral state) | component | request-response | itself + `frontend/src/lib/analysisUrl.ts` (`parseAnalysisFenParam`) | exact |
| `frontend/src/hooks/useAnalysisBoard.ts` (consumed, unmodified `loadMainLine`) | hook | transform | n/a — reuse as-is | exact |
| `frontend/src/App.tsx` (modified — `NAV_ITEMS`/`IMPORT_EXEMPT_ROUTES`/`isActive`) | route/config | request-response | itself (existing array pattern) | exact |
| `frontend/src/components/filters/FilterPanel.tsx` (modified — Library-scoped "Pasted" chip) | component | CRUD (filter state) | itself, `PLATFORMS`/`togglePlatform`/`ToggleGroupItem` block | exact |
| `frontend/src/components/results/LibraryGameCard.tsx` (modified — "Pasted" badge) | component | request-response | itself, `platformIconAndLink` slot | exact |
| `app/services/normalization.py` (new function, e.g. `normalize_pasted_game()`) | service | transform | `normalize_flawchess_game()` (same file, ~line 590) | exact |
| `app/services/store_paste_game_service.py` (new, orchestrator) | service | CRUD | `app/services/store_bot_game_service.py` | exact |
| `app/repositories/query_utils.py` (modified — add `'pgn'` to `DEFAULT_EXCLUDED_PLATFORMS`) | utility/config | CRUD | itself | exact |
| `app/routers/imports.py` (new route, e.g. `POST /imports/paste`) | router | request-response | `enqueue_tier1` (same file, ~line 373) | exact |
| `tests/repositories/test_query_utils.py` (extend) | test | CRUD | itself, existing `DEFAULT_EXCLUDED_PLATFORMS` assertions (~line 56) | exact |

## Pattern Assignments

### `frontend/src/components/analysis/PasteModal.tsx` (component, request-response)

**Analog:** `frontend/src/components/feedback/FeedbackModal.tsx` (191 lines, read in full)

**Imports pattern** (lines 1-16):
```typescript
import { useState } from 'react';
import { useLocation } from 'react-router';
import axios from 'axios';
import { toast } from 'sonner';
import { Star } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useFeedback } from '@/hooks/useFeedback';
```
For PasteModal: swap `useFeedback` for the new tier1-save mutation, add `Chess` from `chess.js`, `parseAnalysisFenParam` from `@/lib/analysisUrl`, `ToggleGroup`/`ToggleGroupItem` from `@/components/ui/toggle-group` (see FilterPanel excerpt below), `ClipboardPaste` icon.

**Outside-dismiss draft guard** (lines 90-97) — copy verbatim, gating on textarea non-empty instead of `text.trim()`:
```typescript
onInteractOutside={(e) => {
  // Mobile keyboard fix: tapping outside to dismiss the on-screen keyboard
  // registers as an outside interaction, which Radix treats as a close —
  // discarding a half-written note. Block outside-dismiss while a draft
  // exists (the tap still blurs the textarea, so the keyboard closes). The
  // X and Cancel buttons remain the explicit ways to close.
  if (text.trim()) e.preventDefault();
}}
```

**Draft-clear-on-close pattern** (lines 74-81):
```typescript
const handleOpenChange = (newOpen: boolean) => {
  if (!newOpen) {
    setText('');
    setRating(undefined);
    setSubmitError(null);
  }
  onOpenChange(newOpen);
};
```
For PasteModal: reset textarea text, side selection, and inline error the same way (per UI-SPEC "Draft is cleared on close").

**Form + label + textarea pattern** (lines 106-123):
```tsx
<form onSubmit={handleSubmit} className="flex flex-col gap-4">
  <div className="flex flex-col gap-1.5">
    <label htmlFor="feedback-text-input" className="text-sm font-medium">
      Your feedback
    </label>
    <textarea
      id="feedback-text-input"
      data-testid="feedback-text"
      aria-required="true"
      aria-label="Your feedback"
      placeholder="Tell us what you think about FlawChess or this page in particular"
      rows={4}
      value={text}
      onChange={(e) => setText(e.target.value)}
      className="w-full resize-none rounded-lg border border-input bg-input/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring disabled:opacity-50"
      disabled={isPending}
    />
  </div>
```
UI-SPEC requires the shadcn `Textarea` primitive (`@/components/ui/textarea`) not a bare `<textarea>`, `rows={6}`, `id="paste-input"`, `data-testid="paste-textarea"`, plus an explicit `max-h` + `overflow-y-auto` override (bounded-growth requirement) — this is the one deliberate deviation from the FeedbackModal analog.

**Inline error pattern** (lines 162-166) — reuse verbatim, `role="alert"` matches D-22's `data-testid="paste-error"` requirement:
```tsx
{submitError && (
  <p className="text-sm text-destructive" role="alert">
    {submitError}
  </p>
)}
```

**Error-message mapping function** (lines 25-36) — same shape for the save-error path:
```typescript
function getErrorMessage(error: Error): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 429) { return "..."; }
    if (status === 422) { return '...'; }
  }
  return "Couldn't send your feedback. Something went wrong. Please try again in a moment.";
}
```
PasteModal's save-error copy is locked by UI-SPEC: "Couldn't save that game. Something went wrong. Please try again in a moment." — no status-code branching required unless planning wants one.

**Footer / dual-button pattern** (lines 168-186) — extend from 2 buttons (Cancel/Submit) to the modal's Load / Analyze pair, same `DialogFooter` + `isPending`-driven disabled/label:
```tsx
<DialogFooter>
  <Button type="button" variant="ghost" data-testid="btn-feedback-cancel" onClick={...} disabled={isPending}>Cancel</Button>
  <Button type="submit" variant="default" data-testid="btn-feedback-submit" disabled={!isSubmitEnabled}>
    {isPending ? 'Sending...' : 'Send feedback'}
  </Button>
</DialogFooter>
```
UI-SPEC's footer needs 3 states (empty/valid-FEN/valid-PGN/error) driving which button(s) render — this is new branching logic FeedbackModal doesn't have, but the disabled+pending-label mechanics transfer directly. Note UI-SPEC's button variants differ: primary "Load" = `variant="default"`, secondary "Analyze full game" = `variant="brand-outline"` (NOT `variant="ghost"` like FeedbackModal's Cancel).

**No format toggle / sniffing state machine** — no existing analog in the codebase (this is new logic). Build directly from CONTEXT.md's measured chess.js behavior table and UI-SPEC § Interaction Contract 4. Discard the `Chess()` instance on any `loadPgn` throw (D-21 landmine — construct a fresh instance for the success path).

---

### `frontend/src/hooks/usePasteGame.ts` (hook, request-response)

**Analog:** `frontend/src/hooks/useEnqueueGame.ts` (full file, 61 lines, read in full)

**Mutation-hook shape with query invalidation** (lines 1-42):
```typescript
import { useMutation, useQueryClient, type UseMutationResult, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { EnqueueTier1Response } from '@/types/api';

async function postTier1Enqueue(gameId: number): Promise<EnqueueTier1Response> {
  const response = await apiClient.post<EnqueueTier1Response>(`/imports/eval/tier1/${gameId}`);
  return response.data;
}

function invalidateAfterTier1Enqueue(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['imports', 'eval-coverage'] });
  void queryClient.invalidateQueries({ queryKey: ['library-games'] });
  void queryClient.invalidateQueries({ queryKey: ['library-game'] });
}

export function useTier1Enqueue(gameId: number): UseMutationResult<EnqueueTier1Response, Error, void> {
  const queryClient = useQueryClient();
  return useMutation<EnqueueTier1Response, Error, void>({
    mutationFn: () => postTier1Enqueue(gameId),
    onSuccess: () => invalidateAfterTier1Enqueue(queryClient),
  });
}
```
For "Analyze full game": POST to the new save-and-enqueue endpoint (e.g. `/imports/paste`), which server-side does save + tier1 enqueue in one call (D-08 says use the *existing* `POST /imports/eval/tier1`, so planning must decide: either the paste-save endpoint internally calls `enqueue_tier1_game` directly — mirroring `store_bot_game_service`'s single-transaction orchestration — or the frontend chains two mutations, save-game then `useTier1EnqueueForGame()` mutate-time variant below). The mutate-time variant is the closer fit since the game id is not known until save completes:

**Mutate-time variant (id known only after an async step)** (lines 50-61):
```typescript
export function useTier1EnqueueForGame(): UseMutationResult<EnqueueTier1Response, Error, number> {
  const queryClient = useQueryClient();
  return useMutation<EnqueueTier1Response, Error, number>({
    mutationFn: (gameId: number) => postTier1Enqueue(gameId),
    onSuccess: () => invalidateAfterTier1Enqueue(queryClient),
  });
}
```
This is the exact shape to copy for "save the pasted game, then enqueue tier1 with the returned id" — save mutation resolves with `{ game_id }`, then `.mutate(game_id)` on this hook (or its paste-specific equivalent) in `onSuccess`.

---

### `frontend/src/App.tsx` (route/config, request-response)

**Analog:** itself — `NAV_ITEMS` / `IMPORT_EXEMPT_ROUTES` / `isActive` (lines 76-140, read in full)

```typescript
const NAV_ITEMS = [
  { to: '/library', label: 'Library', Icon: FolderOpen },
  { to: '/train', label: 'Train', Icon: Dumbbell },
  { to: '/bots', label: 'Bots', Icon: Bot },
  { to: '/openings', label: 'Opening', Icon: BookOpenIcon },
  { to: '/endgames', label: 'Endgame', Icon: TrophyIcon },
] as const;

const BOTTOM_NAV_ITEMS = [ /* same 5 entries, byte-identical today */ ] as const;

const IMPORT_EXEMPT_ROUTES: ReadonlySet<string> = new Set(['/library', '/admin', '/bots']);

function isActive(to: string, pathname: string): boolean {
  if (to === '/library') return pathname.startsWith('/library');
  ...
  return pathname === to;
}
```
Per ROADMAP/CONTEXT: append `/analysis` to `NAV_ITEMS` ONLY (not `BOTTOM_NAV_ITEMS`), add `'/analysis'` to `IMPORT_EXEMPT_ROUTES`, add an `isActive` clause (`if (to === '/analysis') return pathname.startsWith('/analysis');`), and add a comment on BOTH arrays recording the intentional divergence (WR-07 precedent at lines 113-119 — read that comment verbatim before writing the new one, it documents exactly this kind of lesson).

---

### `frontend/src/components/filters/FilterPanel.tsx` (component, CRUD filter state)

**Analog:** itself — `PLATFORMS`/`togglePlatform`/toggle-chip block (lines 181-263, read in full)

```typescript
const PLATFORMS: Platform[] = ['chess.com', 'lichess'];
const PLATFORM_LABELS: Record<Platform, string> = {
  'chess.com': 'Chess.com',
  lichess: 'Lichess',
};

const togglePlatform = (p: Platform) => {
  const current = filters.platforms ?? PLATFORMS;
  if (current.includes(p)) {
    const next = current.filter((x) => x !== p);
    update({ platforms: next.length === PLATFORMS.length ? null : next.length === 0 ? [p] : next });
  } else {
    const next = [...current, p];
    update({ platforms: next.length === PLATFORMS.length ? null : next });
  }
};
```
D-14 forbids adding `'pgn'` to the shared `Platform` type / `PLATFORMS` constant. Instead: a Library-scoped constant/prop (e.g. `libraryOnlyPlatformChips` or a new `visibleFilters`-adjacent prop) that renders one extra `ToggleChipButton` (see UI-SPEC's `ToggleChipButton` reference at `FilterPanel.tsx:432-443` for the exact chip-button shape) wired to a Library-only filter value, off by default (D-11).

**Played-as ToggleGroup shape** — direct structural analog for the paste modal's side selector (lines 283-291, read in full):
```tsx
<ToggleGroup type="single" value={filters.playedAs} onValueChange={...} variant="outline" size="sm" data-testid="filter-played-as" className="w-full">
  <ToggleGroupItem value="either" data-testid="filter-played-as-either" className="min-h-11 sm:min-h-0 flex-1 text-sm">Either</ToggleGroupItem>
  <ToggleGroupItem value="white" data-testid="filter-played-as-white" className="min-h-11 sm:min-h-0 flex-1 text-sm">White</ToggleGroupItem>
  <ToggleGroupItem value="black" data-testid="filter-played-as-black" className="min-h-11 sm:min-h-0 flex-1 text-sm">Black</ToggleGroupItem>
</ToggleGroup>
```
Copy this exact `min-h-11 sm:min-h-0 flex-1 text-sm` treatment for the two-item (White/Black, no "Either") paste-modal side selector, per UI-SPEC § Interaction Contract 5.

---

### `frontend/src/components/results/LibraryGameCard.tsx` (component, request-response)

**Analog:** itself — the empty `ml-auto shrink-0` platform slot (lines 795-825, read in full)

```tsx
const platformIconAndLink = (
  <span className="ml-auto shrink-0 flex items-center gap-1.5 text-muted-foreground">
    <PlatformIcon platform={game.platform} className="h-4 w-4" />
    {gameUrl ? ( <Tooltip content={linkLabel}><a href={gameUrl} ...>...</a></Tooltip> ) : null}
  </span>
);
```
`PlatformIcon` (`frontend/src/components/icons/PlatformIcon.tsx:39-43`) returns `null` for `platform === 'pgn'` (not in `PLATFORM_ICONS`), and `gameUrl` is null with no `platform_url` — confirming D-13's claim the slot renders empty today. Insert the badge conditionally, e.g.:
```tsx
{game.platform === 'pgn' && (
  <Badge variant="outline" className="text-sm" data-testid={`library-pasted-badge-${game.game_id}`}>
    Pasted
  </Badge>
)}
```
placed inside/alongside the existing `ml-auto shrink-0` span per UI-SPEC's exact contract. `variant="outline"` + explicit `className="text-sm"` is mandatory (stock `Badge` base class is `text-xs`, `badge.tsx:8`).

---

### `app/services/normalization.py` (service, transform)

**Analog:** `normalize_flawchess_game()` (same file, ~lines 590-700, read in full)

**Function shape to copy (signature, PGN parse, error branches):**
```python
try:
    game = chess.pgn.read_game(io.StringIO(pgn_text))
except Exception:
    sentry_sdk.set_context("flawchess_normalize", {"game_uuid": game_uuid})
    sentry_sdk.capture_exception()
    return None

if game is None:
    return None  # unparseable PGN — expected 422 case, no Sentry capture

nodes = list(game.mainline())
if not nodes:
    return None  # no moves — expected 422 case
```
D-04/D-07 (roadmap) drop the `[%clk]`-for-both-colors gate (the `clock_present`/`_clock_presence_by_color` block, visible at ~line 620) entirely — a pasted PGN is untimed by definition, no clock check needed.

**WR-02 pattern to preserve** (starting side-to-move derivation, do NOT assume White):
```python
clock_present = [node.clock() is not None for node in nodes]
white_has_clock, black_has_clock = _clock_presence_by_color(
    clock_present, start_white_to_move=game.board().turn
)
```
The `game.board().turn` derivation matters generally for `[SetUp]`/`[FEN]`-rooted PGNs (also relevant to D-16's root-FEN hash normalization) — keep this pattern even though the clock gate itself is dropped.

**Termination fallback pattern** (board-derived, bounded, avoid unbounded header string — CR-02 fix, copy verbatim):
```python
if termination_header is not None and termination_header in _FLAWCHESS_TERMINATION_HEADER_MAP:
    termination = _FLAWCHESS_TERMINATION_HEADER_MAP[termination_header]
    termination_raw = termination_header
else:
    if board.is_checkmate():
        termination = "checkmate"
    elif (board.is_stalemate() or board.is_insufficient_material()
          or board.is_fifty_moves() or board.is_repetition(3)):
        termination = "draw"
    else:
        termination = "unknown"
    termination_raw = termination
```

**Return-shape pattern** (`NormalizedGame` construction, ~lines 665-700) — same dataclass, `platform="pgn"` instead of `"flawchess"`, `platform_game_id` = the new D-16 SHA-256 hex digest instead of `game_uuid`, `platform_url=None`.

**No precedent for the D-16 hash itself** — `normalize_flawchess_game` takes a caller-supplied `game_uuid` (client-minted, non-deterministic), explicitly flagged in CONTEXT.md as NOT reusable. Build the hash fresh: normalize mainline SAN (strip move numbers/whitespace) + a canonicalized root FEN (piece placement + side-to-move + castling rights, per CONTEXT.md's discretion note — drop halfmove/fullmove counters and en passant field), `hashlib.sha256(...).hexdigest()`.

---

### `app/services/store_paste_game_service.py` (service, CRUD, new file)

**Analog:** `app/services/store_bot_game_service.py` (read lines 1-80; orchestration shape documented in its own module docstring)

**Module docstring / orchestration shape to copy** (lines 1-9):
```python
"""Store-on-finish service for POST /bots/games (Phase 167, STORE-01/03/05/06).

Orchestrates: server-side rating derivation (D-05/D-06/D-07) -> PGN-only
normalization (normalize_flawchess_game) -> the existing hot-lane persistence
path (import_service._flush_batch, D-09) -> a game-id lookup (Pitfall 2, no id
in _flush_batch's return) -> a post-insert PGN header stamp + targeted UPDATE
... -> a single commit (D-10). The service owns the transaction boundary;
_flush_batch itself never commits (WR-05)."""
```
The paste-save service follows the identical shape: normalize (new `normalize_pasted_game`) -> `_flush_batch` (`app/services/import_service.py`) -> game-id lookup -> single commit. Difference from the bot-game precedent: **D-17 requires a pre-insert hash lookup** (query by `(user_id, platform='pgn', platform_game_id=hash)` before calling `_flush_batch` — on a hit, skip normalize/flush entirely and return the existing `game_id`; D-18 requires an in-place `user_color` UPDATE on a hash hit, not a re-insert).

**Platform constant convention** (line 26-27):
```python
# Platform constant — the one value this service ever writes/looks up (D-04/D-17).
_FLAWCHESS_PLATFORM = "flawchess"
```
Copy this convention with `_PASTE_PLATFORM = "pgn"`.

**Counter-example warned against by CONTEXT.md D-11 — do NOT copy:** `app/services/library_service.py:868`
```python
library_platform = platform if platform is not None else ["chess.com", "lichess", "flawchess"]
```
`"pgn"` must never be added to this substitution list.

---

### `app/routers/imports.py` (router, request-response)

**Analog:** `enqueue_tier1` (same file, ~lines 373-398, read in full)

```python
@router.post("/eval/tier1/{game_id}", response_model=EnqueueTier1Response)
async def enqueue_tier1(
    game_id: int,
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> EnqueueTier1Response:
    """... IDOR guard (T-118-06, ASVS V4): returns 404 when the game does not
    exist OR belongs to a different user. Never 403 ...
    Tier-1 is an explicit per-game request available to guests for their OWN
    games (QUEUE-08 guest gate opened for tier-1 only)."""
    game = await session.get(Game, game_id)
    if game is None or game.user_id != user.id:
        raise HTTPException(status_code=404, detail="Game not found")

    inserted = await enqueue_tier1_game(game_id=game_id, user_id=user.id)
    status = "enqueued" if inserted else "already_queued"
    return EnqueueTier1Response(status=status, game_id=game_id)
```
The new "Analyze full game" endpoint (e.g. `POST /imports/paste`) doesn't need the IDOR game-id guard shape (there's no existing game_id — it creates one), but MUST reuse `current_active_user` (guest-permitting per D-08/QUEUE-08 — confirm the dependency used elsewhere in this router already permits guests for tier-1) and should call `enqueue_tier1_game` directly at the end of the save orchestration rather than requiring a second round-trip HTTP call from the frontend.

---

### `app/repositories/query_utils.py` (config/utility, CRUD)

**Analog:** itself (lines 22-31, read in full)

```python
# ---------------------------------------------------------------------------
# Default platform exclusion (single source — CONTEXT D-02, Phase 167)
# ---------------------------------------------------------------------------
# Flawchess bot-practice games must stay invisible to every default analytics
# population (STORE-07) while remaining reachable by any caller that passes an
# explicit platform list including "flawchess" (e.g. library_service's
# get_library_games opt-in, D-03). This is the ONE central seam — do not
# scatter per-router platform checks.
DEFAULT_EXCLUDED_PLATFORMS = ("flawchess",)
```
Change to `DEFAULT_EXCLUDED_PLATFORMS = ("flawchess", "pgn")`, extending the existing comment with the D-05/D-11 rationale (pasted games are frequently not the user's own).

**Application seam** (line 246, do not duplicate elsewhere):
```python
stmt = stmt.where(Game.platform.notin_(DEFAULT_EXCLUDED_PLATFORMS))
```

---

### `tests/repositories/test_query_utils.py` (test, CRUD)

**Analog:** itself — existing `DEFAULT_EXCLUDED_PLATFORMS` proof (lines ~20-57, read in full)

```python
from app.repositories.query_utils import (
    DEFAULT_EXCLUDED_PLATFORMS,
    ...
)
...
        assert "flawchess" in DEFAULT_EXCLUDED_PLATFORMS
        assert isinstance(DEFAULT_EXCLUDED_PLATFORMS, tuple)
```
This is the "existing test proving a platform is excluded" pattern requested. Extend with `assert "pgn" in DEFAULT_EXCLUDED_PLATFORMS`, and add a red-if-removed integration-style test (insert a `platform='pgn'` game, call `apply_game_filters` with no explicit platform, assert it's absent) mirroring whatever integration test already proves `'flawchess'` exclusion end-to-end (search the same test file / `tests/repositories/` for a `apply_game_filters`-level flawchess-exclusion test to copy the fixture shape from — SC-5 requires exactly this "goes red if removed" proof).

---

## Shared Patterns

### Modal shell (Dialog/DialogContent/form/DialogFooter)
**Source:** `frontend/src/components/feedback/FeedbackModal.tsx` (full file)
**Apply to:** `PasteModal.tsx` — Dialog composition, outside-dismiss draft guard, draft-clear-on-close, inline error `role="alert"`, disabled/pending button states.

### Tier-1 enqueue mutation
**Source:** `frontend/src/hooks/useEnqueueGame.ts` (full file)
**Apply to:** the "Analyze full game" save+enqueue flow — reuse `useTier1EnqueueForGame()`'s mutate-time-argument shape verbatim once the paste-save call returns a `game_id`, and reuse `invalidateAfterTier1Enqueue`'s query-key invalidation list.

### Toggle-group two/three-item chip
**Source:** `frontend/src/components/filters/FilterPanel.tsx:283-291` (Played-as toggle)
**Apply to:** paste modal's side selector (`ToggleGroup`/`ToggleGroupItem`, `min-h-11 sm:min-h-0 flex-1 text-sm` override — mandatory per the `text-[0.8rem]` `size="sm"` trap documented in UI-SPEC).

### PGN normalization + `_flush_batch`/single-commit orchestration
**Source:** `app/services/normalization.py:590-700` (`normalize_flawchess_game`) + `app/services/store_bot_game_service.py` (full orchestrator)
**Apply to:** `normalize_pasted_game()` + new `store_paste_game_service.py` — same normalize → `_flush_batch` (never commits, WR-05) → post-insert lookup → single commit shape; `_flush_batch`'s existing Stage 5 already computes `ply_count`/`result_fen`/Zobrist `game_positions` rows for any newly inserted game, pasted games included, no new work needed there.

### Central platform-exclusion seam
**Source:** `app/repositories/query_utils.py:22-31`
**Apply to:** every repository consumer via `apply_game_filters` — no per-router platform checks; add `'pgn'` in exactly one place.

### IDOR-guarded / guest-permitting router pattern
**Source:** `app/routers/imports.py:373-398` (`enqueue_tier1`)
**Apply to:** the new paste-save router endpoint — same `current_active_user` dependency (guest-permitting per QUEUE-08), 404-never-403 discipline if any lookup-by-id is added (e.g. hash-hit reuse path).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Client-side sniff/state-machine logic (bare-FEN vs PGN vs error, in `PasteModal.tsx` or a helper) | utility | transform | No existing "sniff one textarea into two formats" logic in the codebase — build directly from CONTEXT.md's measured chess.js 1.4 behavior matrix and UI-SPEC § Interaction Contract 4/D-21 landmine (discard `Chess()` instance on any `loadPgn` throw) |
| D-16 hash function (SAN + canonical root-FEN → SHA-256) | utility | transform | `normalize_flawchess_game`'s `game_uuid` is caller-supplied and non-deterministic — explicitly not reusable (CONTEXT.md). No deterministic-hash precedent exists elsewhere in the codebase for `platform_game_id` synthesis; implement fresh per CONTEXT.md's discretion notes on SAN/FEN canonicalization |
| Hash-hit reuse + in-place `user_color` update (D-17/D-18) | service | CRUD | No existing "lookup before insert, update in place on collision" precedent in any normalize/store service — closest partial analog is the `uq_games_user_platform_game_id` constraint itself (`app/models/game.py:48-50`) but no service currently pre-checks it before writing |

## Metadata

**Analog search scope:** `frontend/src/components/`, `frontend/src/hooks/`, `frontend/src/pages/Analysis.tsx`, `frontend/src/App.tsx`, `frontend/src/lib/analysisUrl.ts`, `app/services/`, `app/routers/imports.py`, `app/repositories/query_utils.py`, `app/models/game.py`, `tests/repositories/test_query_utils.py`
**Files scanned:** ~15 (targeted reads guided by CONTEXT.md/UI-SPEC.md file:line anchors, no blind directory sweep needed — the phase docs already carry a verified seven-row reuse-anchor table)
**Pattern extraction date:** 2026-08-08
