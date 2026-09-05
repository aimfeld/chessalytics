---
quick_id: 260905-p0t
status: complete
completed: 2026-09-05
requirements: [SEED-163-2a, SEED-163-2b, SEED-163-2c, SEED-163-2d]
---

# Quick task 260905-p0t: analytics default Human + Rated (SEED-163 group 2) — Summary

Openings, Endgames and Stats now default to Human + Rated on a fresh load (matching
the percentile benchmark cohort), the Library keeps FlawChess bot games and pasted
PGNs reachable via a new backend bypass flag regardless of that default, the Library
filter panel discloses the exemption in one line, and a named empty state explains
when the new default alone empties an otherwise non-empty population.

## Tasks and commits

### Task 1 — Library-only native-game bypass in apply_game_filters (2b)

Commit: `9950344a6` — `feat(260905-p0t): Library-only native-game bypass in apply_game_filters`

- Added keyword-only `native_games_bypass_opponent_and_rated: bool = False` to
  `apply_game_filters` (`app/repositories/query_utils.py`). Opponent-type and rated
  predicates are now composed into one `and_(...)` condition; when the flag is set,
  that condition is wrapped as `or_(Game.platform.in_(DEFAULT_EXCLUDED_PLATFORMS),
  <condition>)`. When no opponent/rated predicate is active, nothing is emitted (no
  bare platform OR-clause).
- Set the flag `True` at exactly the two Library call sites:
  `library_repository.query_filtered_games` and `library_repository.query_flaws`.
  `_filtered_games_base` (Library analytics counters) is untouched, per plan.
- New test file `tests/repositories/test_native_games_bypass.py` (5 cases): bypass
  returns chess.com+flawchess under Human/Rated; bypass=False returns only
  chess.com (red-if-OR-wrapper-removed); `platform=None` never leaks a native game
  regardless of the flag; the Pasted-chip platform list returns the pgn row under
  the flag; the bypass is unconditional (still fires under `opponent_type='bot'`).

**Gate commands run:**
- `uv run pytest tests/repositories/test_native_games_bypass.py -x -q` → 5 passed
- `uv run pytest tests/repositories/test_query_utils.py tests/repositories/test_pasted_platform_exclusion.py tests/test_library_repository.py tests/repositories/test_library_repository.py tests/services/test_library_service.py tests/services/test_library_include_pasted.py tests/test_openings_repository.py -q` → 206 passed
- `uv run ruff format app/ tests/ && uv run ruff check . --fix && uv run ty check app/ tests/ scripts/` → all clean
- `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` → OK, 1031 functions, no breaches

### Task 2 — Analytics defaults flip to Human + Rated, plus Library disclosure hint (2a + 2c)

Commit: `e132eff14` — `feat(260905-p0t): analytics defaults flip to Human + Rated, plus Library disclosure hint`

- `DEFAULT_FILTERS` (`frontend/src/components/filters/FilterPanel.tsx`) now reads
  `rated: true` / `opponentType: 'human'`, with comments explaining the new
  meaning and citing SEED-163 2a. `FilterState`'s inline comments for both fields
  updated to describe the new default.
- **Probe fix (load-bearing):** `FlawsTab.tsx`'s `UNFILTERED_PROBE_FILTERS` now
  also overrides `rated: null` (was only `opponentType: 'both'`) so the
  "does the user have ANY engine-analyzed games" probe stays truly
  filter-independent under the new narrowing default.
- **Disclosure hint (2c):** a `NativeGamesHint` component (gated on the same
  `showPastedChip` flag as the Pasted chip) renders
  `data-testid="filter-native-games-hint"` with the exact copy "FlawChess bot
  games and pasted games are always shown here." below the Platform chip grid.
  Extracted to its own component (not an inline `{show && (...)}`) to avoid
  pushing `FilterPanel`'s eslint `complexity` past its per-file baseline.
  **Deviation from plan text (CLAUDE.md precedence):** used `text-sm` instead
  of the plan-suggested `text-xs` — frontend/CLAUDE.md's text-sm floor applies
  (this is a static disclosure line, not a hover/tap tooltip, so the `text-xs`
  exception doesn't apply).
- Added coverage in `PastedChip.test.tsx`: `DEFAULT_FILTERS.rated`/`opponentType`
  assertions, hint renders under `LibraryFilterPanel`, hint absent from a bare
  `FilterPanel`.
- Existing frontend suite already passed unchanged (no test encoded the old
  defaults in a way that broke) — the "known candidates to inspect" from the
  plan all remained green.

**Gate commands run:**
- `cd frontend && npm test -- --run` → 3900 passed (then 3906 after Task 3's added file)
- `cd frontend && npm run lint` → clean (one `complexity` breach on first pass,
  fixed via the `NativeGamesHint` extraction — see Deviations)
- `cd frontend && npm run build` → clean, tsc build passed

### Task 3 — Named empty state for filtered-to-zero analytics population, changelog, seed status (2d)

Commit: `599cedfd7` — `feat(260905-p0t): named empty state for filtered-to-zero analytics population`

- `frontend/src/hooks/useGameCount.ts`: `useGameCount()` (shared `['gameCount']`
  query, replaces the inline query previously in `Openings.tsx`) plus
  `useGameCountValue()`, a convenience wrapper returning `number | null` directly
  — added to keep `?.`/`??` derivation out of pages already at their eslint
  `complexity` per-file baseline (see Deviations).
- `frontend/src/components/ui/no-human-rated-games-state.tsx`: exports
  `shouldShowNoHumanRatedGames(filters, totalGames)` (true only when
  `totalGames > 0` AND the current filters equal `DEFAULT_FILTERS` under
  `FILTER_DOT_FIELDS`) and `NoHumanRatedGamesState({ totalGames })`
  (`data-testid="empty-no-human-rated-games"`, title "No rated games against
  humans", the exact interpolated subtitle from the plan). `totalGames` accepts
  `number | null` and coalesces internally, so callers don't need `?? 0` inline.
- Wired into `openings/GamesTab.tsx` (inside the existing `filtersMatchNothing`
  branch), `Endgames.tsx` (ahead of the `categories.length === 0` branch, gated
  on `total_games === 0`), and `GlobalStats.tsx` (when both `by_time_control`
  and `by_color` are empty).
- New test file `no-human-rated-games-state.test.tsx`: predicate true/false
  cases (defaults+count, count 0, count null, a diverging filter field) and
  component tests (testid + count rendered, null-count fallback to 0).
- `CHANGELOG.md`: added a `### Changed` bullet under `[Unreleased]` covering the
  whole group.
- `.planning/seeds/SEED-163-analytics-population-excludes-bot-games.md`: frontmatter
  `status: complete`, section 2 heading marked SHIPPED with quick-task id `260905-p0t`.

**Gate commands run:**
- `cd frontend && npm test -- --run` → 3906 passed (after fixing two Endgames test
  files that needed a `useGameCount` mock — see Deviations)
- `cd frontend && npm run lint` → clean (two `complexity` breaches on first pass
  in `Endgames.tsx`/`GlobalStats.tsx`, fixed via extraction — see Deviations)
- `cd frontend && npm run build` → clean
- `uv run pytest -n auto -x` → 4516 passed, 19 skipped (pre-existing skips)
- `grep -n "empty-no-human-rated-games" frontend/src/pages/openings/GamesTab.tsx frontend/src/pages/Endgames.tsx frontend/src/pages/GlobalStats.tsx frontend/src/components/ui/no-human-rated-games-state.tsx | grep -c .` → `1` (nonzero — the testid is defined once in the shared component and consumed via the `NoHumanRatedGamesState` import in the three pages, not re-declared per page)

## Full pre-merge gate (final confirmation)

Re-ran the complete CLAUDE.md pre-merge gate after all three tasks:

```
uv run ruff format app/ tests/ scripts/ analysis/          → 469 files left unchanged
uv run ruff check . --fix                                   → All checks passed!
uv run ty check app/ tests/ scripts/                         → All checks passed!
uv run --project analysis --with ty ty check analysis/      → All checks passed!
uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200
                                                              → OK: 1031 functions scanned, no breaches
uv run pytest -n auto -x                                     → 4516 passed, 19 skipped
( cd frontend && npm run lint && npm test -- --run && npm run build )
                                                              → lint clean, 3906 tests passed, build clean
```

No formatter/autofix step modified any file on this final pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `FlawsTab.tsx` unfiltered probe would have silently become rated-only**
- **Found during:** Task 2, following the plan's explicit "Probe fix (load-bearing)" instruction.
- **Issue:** `UNFILTERED_PROBE_FILTERS` only overrode `opponentType: 'both'`; with the
  new `rated: true` default it would have started filtering to rated-only games.
- **Fix:** Added `rated: null` to the override, extended the comment.
- **Files modified:** `frontend/src/pages/library/FlawsTab.tsx`
- **Commit:** `e132eff14`

**2. [Rule 3 - Blocking] `FilterPanel.tsx` eslint `complexity` breach (25 > 24) after adding the 2c hint**
- **Found during:** Task 2 verify (`npm run lint`).
- **Issue:** An inline `{showPastedChip && (...)}` block for the disclosure hint
  pushed `FilterPanel`'s cyclomatic complexity from 24 to 25.
- **Fix:** Extracted the hint into a standalone `NativeGamesHint` component
  (its own function, so its internal branch doesn't count toward `FilterPanel`'s
  complexity). No behavior change.
- **Files modified:** `frontend/src/components/filters/FilterPanel.tsx`
- **Commit:** `e132eff14`

**3. [Rule 3 - Blocking] `Endgames.tsx` (56→60) and `GlobalStats.tsx` (21→28) eslint `complexity` breaches after wiring the empty state**
- **Found during:** Task 3 verify (`npm run lint`). Both pages were already
  exactly at their eslint per-file `complexity` baseline (`eslint.config.js`
  overrides: 56 and 21 respectively — CLAUDE.md: "the override region is a
  historical snapshot from Phase 215, not an escape hatch for new code"), so
  any inline branch addition broke the gate.
- **Fix:** Moved all new branching out of the two page components into small
  standalone functions/components: `computeGlobalStatsNoHumanRatedGames` +
  `renderGlobalStatsContent` (GlobalStats.tsx), `shouldShowEndgamesNoHumanRatedGames`
  + `EndgamesTailEmptyState` (Endgames.tsx), plus `useGameCountValue()` in
  `useGameCount.ts` to hide the `data?.count ?? null` optional-chain/nullish-coalescing
  derivation, and moving the `totalGames ?? 0` fallback into
  `NoHumanRatedGamesState` itself. Net effect: both files pass lint with room to
  spare (no baseline widened).
- **Files modified:** `frontend/src/pages/Endgames.tsx`, `frontend/src/pages/GlobalStats.tsx`,
  `frontend/src/hooks/useGameCount.ts`, `frontend/src/components/ui/no-human-rated-games-state.tsx`,
  `frontend/src/pages/openings/GamesTab.tsx` (call-site simplified to match the
  new `totalGames: number | null` signature)
- **Commit:** `599cedfd7`

**4. [Rule 3 - Blocking] Two Endgames test files broke on `useGameCountValue`'s `useQuery` call**
- **Found during:** Task 3 verify (`npm test -- --run`) — 12 failures across
  `Endgames.overallPerformance.test.tsx` and `Endgames.readinessGate.test.tsx`
  with "No QueryClient set, use QueryClientProvider to set one".
- **Issue:** Both test files render `EndgamesPage` directly (no
  `QueryClientProvider`) and mock every hook that touches TanStack Query; the
  newly-added `useGameCountValue()` call was unmocked.
- **Fix:** Added `vi.mock('@/hooks/useGameCount', () => ({ useGameCountValue: () => 10 }))`
  to both test files, matching the existing mocking pattern for
  `useEvalCoverage`/`useReadiness` in the same files.
- **Files modified:** `frontend/src/pages/__tests__/Endgames.overallPerformance.test.tsx`,
  `frontend/src/pages/__tests__/Endgames.readinessGate.test.tsx`
- **Commit:** `599cedfd7`

**5. [Rule 3 - Blocking] New `no-human-rated-games-state.test.tsx` cross-test testid collision**
- **Found during:** Task 3 verify (`npm test -- --run`) — `getByTestId` found
  multiple elements because two `render()` calls in the same test file left
  prior output mounted (no `cleanup()`).
- **Fix:** Added `afterEach(cleanup)` from `@testing-library/react`, matching
  the convention used in `PastedChip.test.tsx` and other component tests.
- **Files modified:** `frontend/src/components/ui/__tests__/no-human-rated-games-state.test.tsx`
- **Commit:** `599cedfd7`

None of these deviations changed the plan's product behavior or scope — all were
mechanical fixes required to keep the plan's own verify gates green (Rules 1 and 3).

## Blocked / deviations

None. All three tasks completed with every specified verify command passing.

## Known Stubs

None.

## Threat Flags

None — the implementation matches the plan's threat model exactly (one bypass
flag on `apply_game_filters`, scoped to the two Library call sites; three
client-side render branches; no new endpoints, auth paths, or schema changes).

## Self-Check: PASSED

All files listed in `files_modified` (plus the two Endgames test files fixed as
Rule-3 deviations) exist on disk; all three task commit hashes (`9950344a6`,
`e132eff14`, `599cedfd7`) are present in `git log`.
