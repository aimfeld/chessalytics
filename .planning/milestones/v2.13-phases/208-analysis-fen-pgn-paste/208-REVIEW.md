---
status: issues_found
phase: 208-analysis-fen-pgn-paste
reviewed: 2026-08-08T18:47:35Z
depth: standard
files_reviewed: 27
files_reviewed_list:
  - app/repositories/game_repository.py
  - app/repositories/query_utils.py
  - app/routers/imports.py
  - app/routers/library.py
  - app/schemas/imports.py
  - app/schemas/normalization.py
  - app/services/library_service.py
  - app/services/normalization.py
  - app/services/store_paste_game_service.py
  - frontend/src/api/client.ts
  - frontend/src/App.tsx
  - frontend/src/components/analysis/PasteModal.tsx
  - frontend/src/components/board/PlayerBar.tsx
  - frontend/src/components/filters/FilterPanel.tsx
  - frontend/src/components/filters/LibraryFilterPanel.tsx
  - frontend/src/components/results/LibraryGameCard.tsx
  - frontend/src/hooks/useEnqueueGame.ts
  - frontend/src/hooks/useLibrary.ts
  - frontend/src/hooks/usePasteGame.ts
  - frontend/src/hooks/useStats.ts
  - frontend/src/lib/pastedGame.ts
  - frontend/src/pages/Analysis.tsx
  - frontend/src/types/api.ts
  - tests/repositories/test_pasted_platform_exclusion.py
  - tests/repositories/test_query_utils.py
  - tests/routers/test_imports_paste.py
  - tests/services/test_library_include_pasted.py
  - tests/services/test_normalize_pasted_game.py
  - tests/services/test_store_paste_game_service.py
  - frontend/src/App.test.tsx
  - frontend/src/components/analysis/__tests__/PasteModal.test.tsx
  - frontend/src/components/filters/__tests__/PastedChip.test.tsx
  - frontend/src/components/results/__tests__/LibraryGameCardPastedBadge.test.tsx
  - frontend/src/hooks/__tests__/usePasteGame.test.tsx
  - frontend/src/lib/pastedGame.test.ts
findings:
  critical: 1
  warning: 2
  info: 0
  total: 3
---

# Phase 208: Code Review Report

**Reviewed:** 2026-08-08T18:47:35Z
**Depth:** standard
**Files Reviewed:** 27 source files (+ 8 test files read for coverage adequacy)
**Status:** issues_found

## Summary

The backend half of this phase (identity-hash reuse-or-insert, the `DEFAULT_EXCLUDED_PLATFORMS`/`resolve_library_platforms` exclusion seam, the SC-7 post-commit-enqueue non-propagating handler, and the IDOR-scoped repository functions) is solid: the reuse/race-guard transaction shape is correct, `get_pasted_game_by_identity`/`update_game_user_color` are properly scoped by `user_id`, the analytics-exclusion single-seam discipline is genuinely honored (proven red-if-removed by the phase's own tests), and the Library `include_pasted` opt-in is correctly contained to Library surfaces only (D-14). I could not construct a working IDOR, double-commit, or analytics-leak scenario against this code.

The defect is in `frontend/src/pages/Analysis.tsx`'s interaction between D-20 ("the paste trigger stays visible in every mode, including `?game_id=` game mode") and the page's existing one-shot board-seeding machinery, which was written under the pre-208 invariant "a page is exactly one of {game / line / fen}, never more." Phase 208 breaks that invariant (a single mounted `Analysis` instance can now transition from a real saved game to a pasted ephemeral position, or from one saved game to another via post-save navigation) without updating the one-shot guards that assumed it. This produces a genuinely reproducible "board shows one game while the URL/side panels say another" state — exactly the class of failure D-21/SC-3 were written to prevent elsewhere in this same phase.

## Critical Issues

### CR-01: Post-save navigation to `?game_id=N` does not reload the board when triggered from within an existing game-mode session

**File:** `frontend/src/pages/Analysis.tsx:911, 949-954, 2610-2613`
**Issue:**

`hasLoadedMainLine` (`useRef(false)`, line 911) is a **single ref shared across all three board-seeding effects** (game mode at 949-954, `?line=` at 963-969, `?fen=` at 975-980), each of which sets it to `true` the first time it fires and never resets it. The comment at line 958 states the assumption this was designed under: *"a page is exactly one of the three, never more."*

Phase 208 breaks that assumption. Repro:

1. Load `/analysis?game_id=OLD` (a real saved game). On mount, the effect at 949-954 fires once, sets `hasLoadedMainLine.current = true`, and calls `loadMainLine(gameData.moves, STARTING_FEN)` for OLD.
2. Per D-20, the Paste trigger stays visible here. Paste a new, different PGN and click **"Analyze full game" directly** (a normal, arguably the primary, user action — nothing requires first clicking "Load"; `handleAnalyzeFullGame` in `PasteModal.tsx` never calls `onLoad`/`loadMainLine`, only `savePastedGame` then `onSaved`).
3. On success, `handlePasteSaved` (2610-2613) calls `navigate(buildGameAnalysisUrl(gameId))`, changing the URL to `/analysis?game_id=NEW`. `AnalysisRoute`/`Analysis` is not remounted by this navigation (same `<Route path="/analysis">`, no `key` change) — `hasLoadedMainLine.current` survives, still `true`.
4. `gameId` (derived reactively from `searchParams`) becomes `NEW`; the `gameData` query for `NEW` fetches and resolves. `showPlayerBars`, the eval chart, and the flaw-tags panel all read `gameData` directly and correctly update to `NEW`'s info.
5. The effect at 949-954 is guarded by `hasLoadedMainLine.current`, which is still `true` from step 1 — it returns early and **never calls `loadMainLine` for the new game's moves.**

Result: the URL reads `/analysis?game_id=NEW`, the player names/eval chart/flaw panel all describe `NEW`, but the chessboard and move list keep displaying whatever position was last on screen for `OLD` — a directly observable "wrong game" state reached through the exact flow D-20 was written to support (pasting without navigating away first). This is the same class of failure ("real-looking but wrong… the silently wrong position") that D-21/SC-3 explicitly call out as forbidden elsewhere in this phase's own design docs, now reintroduced through a different code path.

**Fix:** Track seeding per `gameId` instead of a single ever-fired boolean, e.g.:
```tsx
const seededForKeyRef = useRef<string | null>(null); // 'game:<id>' | 'line' | 'fen'

useEffect(() => {
  if (!isGameMode || gameData?.moves == null) return;
  const key = `game:${gameId}`;
  if (seededForKeyRef.current === key) return;
  seededForKeyRef.current = key;
  loadMainLine(gameData.moves, STARTING_FEN);
}, [gameData?.moves, isGameMode, gameId]);
```
or, simpler and more local to this phase: have `handlePasteSaved` explicitly reset `hasLoadedMainLine.current = false` before navigating, so the pre-existing game-mode effect re-arms itself for the new `gameId`. Either fix must be verified against a live paste-while-in-game-mode UAT (this scenario is not covered by any of the phase's automated tests — `PasteModal.test.tsx` and the router tests never render `Analysis.tsx` with a pre-existing `gameId` before invoking `onSaved`).

## Warnings

### WR-01: Pasting (Load) a new PGN while viewing a real `?game_id=` game leaves `gameData`-derived panels stale and can produce misleading navigation

**File:** `frontend/src/pages/Analysis.tsx:3016 (showPlayerBars), 3143-3192 (evalChart), 3204+ (tagsPanel), 2591-2599 (handlePasteLoad)`
**Issue:** `handlePasteLoad` (2591-2599) calls `loadMainLine(result.sans, result.rootFen)` directly when a paste result is `kind: 'pgn'`, correctly updating the board/move-tree immediately — this half works. But it does **not** touch `gameData`, and nothing else in the component reacts to `pastedHeaders` becoming non-null: the eval chart (`evalChart`, gated purely on `evalChartReady && gameId != null && gameData?.eval_series/...`), the flaw-tags panel (`tagsPanel`, gated on `evalChartReady && gameData`), and PV-chip navigation (`pvNodeIds`/`activePvKeys`, both `isGameMode ? … : undefined`) continue rendering **the original game's** analysis data unconditionally.

`loadMainLine` (`useAnalysisBoard.ts:390-426`) always restarts its node-ID counter at 0 for the newly-loaded mainline. Since the original real game's tree was also built starting at ID 0 (`loadMainLine(gameData.moves, STARTING_FEN)`), IDs from the two games numerically alias each other. Concretely: if the original game has a flaw marker at node id 15 and the pasted game has ≥16 plies, clicking that (still-rendered, stale) flaw-tag chip calls `goToNode(15)` against the **new** tree, silently landing on an unrelated position in the pasted game while the tag/panel still describes the original game's flaw. `goToNode` (`useAnalysisBoard.ts:367-381`) does not crash on this (it only no-ops for a genuinely absent id), so the failure mode is silent misdirection, not an error.

This is reachable through the same D-20-sanctioned flow as CR-01 (paste while already in `?game_id=` mode), just via "Load" instead of "Analyze full game," and is not covered by any test in this phase (no test renders `Analysis.tsx` in game mode and then exercises the paste-Load path).

**Fix:** When `pastedHeaders` becomes non-null while `isGameMode` was already true, clear/suppress the `gameData`-sourced eval chart, flaw-tags panel, and PV navigation (the same way the "bare free play" reset branch already clears `liveFlawByNode`/`gemByNode`) rather than leaving them rendering the previous game's data over a different board position. At minimum, gate `evalChart`/`tagsPanel`/`pvNodeIds` on `pastedHeaders == null` in addition to their existing conditions.

### WR-02: `update_game_user_color`'s `user_color` parameter is typed `str`, not the project's `Color` Literal

**File:** `app/repositories/game_repository.py` (new function `update_game_user_color`, ~line 130-155 per the diff)
**Issue:** CLAUDE.md's Coding Guidelines are explicit: *"Never use bare `str` for fields with a fixed set of values — use `Literal[...]`... This applies to both schemas and service/repository function parameters."* The new repository function is declared:
```python
async def update_game_user_color(
    session: AsyncSession, *, game_id: int, user_id: int, user_color: str
) -> None:
```
while the caller (`store_paste_game_service.store_pasted_game`) passes `request.user_color`, which is correctly typed `Color` (`Literal["white", "black"]`) on `SavePastedGameRequest`. The narrower type is silently widened to `str` at the repository boundary — `ty check` doesn't flag it because `Literal["white","black"]` is structurally assignable to `str`, but it defeats the type-safety guarantee CLAUDE.md requires at exactly the kind of service/repository boundary the rule calls out, and would allow a future caller to pass an arbitrary string (e.g. a typo `"White"`) without a static-analysis error, only a runtime `CHECK` constraint failure (if one exists) or a silently-wrong `user_color` value.

**Fix:**
```python
from app.schemas.normalization import Color

async def update_game_user_color(
    session: AsyncSession, *, game_id: int, user_id: int, user_color: Color
) -> None:
```

---

_Reviewed: 2026-08-08T18:47:35Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
