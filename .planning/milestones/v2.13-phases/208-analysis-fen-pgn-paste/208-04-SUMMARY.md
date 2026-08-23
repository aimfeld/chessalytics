---
phase: 208-analysis-fen-pgn-paste
plan: 04
subsystem: api
tags: [fastapi, sqlalchemy, react, typescript, tanstack-query, tailwind]

# Dependency graph
requires:
  - phase: 208-02
    provides: "'pgn' added to DEFAULT_EXCLUDED_PLATFORMS and ANALYTICS_INCLUDED_PLATFORMS — the single analytics-exclusion seam this plan's opt-in routes through"
provides:
  - "resolve_library_platforms() + LIBRARY_GAMES_BASE_PLATFORMS in library_service.py — per-surface (games vs analytics) default population resolution with an additive include_pasted opt-in"
  - "include_pasted query param on all five platform-filterable /library/* routes"
  - "FilterState.includePasted + FilterPanel's showPastedChip prop — the Library-only 'Pasted' chip, contained so it cannot leak into Openings/Endgames/GlobalStats/Insights"
  - "LibraryGameCard's 'Pasted' text badge for platform='pgn' games"
  - "CHANGELOG.md Unreleased entry for the whole phase-208 paste feature"
affects: []

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 13470
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-surface default-population resolver (resolve_library_platforms) instead of a single shared default — Games tab and analytics surfaces (flaw-stats/flaws/flaw-comparison/tactic-comparison) each have their own correct base, and the additive opt-in composes over either one without duplicating the exclusion logic in query_utils.py"
    - "Sibling-boolean containment for a Library-only filter field (FilterState.includePasted) instead of widening a shared enum/constant (Platform, PLATFORMS) that other pages also read — read on the wire from exactly one function (buildLibraryParams)"

key-files:
  created:
    - tests/services/test_library_include_pasted.py
    - frontend/src/components/filters/__tests__/PastedChip.test.tsx
    - frontend/src/components/results/__tests__/LibraryGameCardPastedBadge.test.tsx
  modified:
    - app/services/library_service.py
    - app/routers/library.py
    - frontend/src/components/filters/FilterPanel.tsx
    - frontend/src/components/filters/LibraryFilterPanel.tsx
    - frontend/src/hooks/useLibrary.ts
    - frontend/src/hooks/useStats.ts
    - frontend/src/api/client.ts
    - frontend/src/components/results/LibraryGameCard.tsx
    - CHANGELOG.md

key-decisions:
  - "app/routers/library.py's five routes and app/services/library_service.py's five entry points each gained a keyword-only include_pasted: bool = False forwarded through resolve_library_platforms — no repository signature changed, matching D-12's 'no backend plumbing beyond the opt-in' scope"
  - "frontend/src/api/client.ts (not in this plan's files_modified) needed an include_pasted param on buildFilterParams and each of the five libraryApi getter signatures — without it the wire param this plan's backend half added would never reach the network request. Documented as a Rule 3 deviation below."
  - "frontend/src/hooks/useStats.ts (not in this plan's files_modified) had two hand-built FilterState object literals that failed to typecheck once includePasted became a required field. Fixed by spreading DEFAULT_FILTERS as their base instead of listing every key by hand, which also satisfies the acceptance criterion that no non-Library hook names includePasted explicitly. Documented as a Rule 3 deviation below."
  - "Platform grid switches from grid-cols-2 to grid-cols-3 only when showPastedChip is true, keeping Openings/Endgames/GlobalStats' two-chip layout pixel-identical"
  - "FILTER_DOT_FIELDS was left untouched (not extended with includePasted) — toggling the Pasted chip does not light the Library tabs' modified-dot indicator. Not required by the plan's acceptance criteria; flagged here rather than expanded as unrequested scope."

patterns-established:
  - "A Library-only FilterState field is threaded on the wire from exactly one function (buildLibraryParams) and rendered from exactly one call site (LibraryFilterPanel's showPastedChip=true) — both are single seams a future audit can grep for to prove containment, mirroring the project's DEFAULT_EXCLUDED_PLATFORMS single-seam convention on the backend"

requirements-completed: [PASTE-05, PASTE-09]

coverage:
  - id: D1
    description: "A platform='pgn' game is absent from both Library tabs (Games and Flaws) by default; the include_pasted opt-in reveals it additively on Games (chess.com/lichess/flawchess all still show) without ever admitting flawchess bot games on the Flaws/analytics surfaces"
    requirement: "PASTE-05"
    verification:
      - kind: unit
        ref: "tests/services/test_library_include_pasted.py::TestResolveLibraryPlatforms"
        status: pass
      - kind: integration
        ref: "tests/services/test_library_include_pasted.py::TestIncludePastedThroughRouter::test_library_games_hides_then_reveals_pasted"
        status: pass
      - kind: integration
        ref: "tests/services/test_library_include_pasted.py::TestIncludePastedThroughRouter::test_library_flaws_pasted_opt_in_excludes_flawchess"
        status: pass
    human_judgment: false
  - id: D2
    description: "The shared FilterState.platforms array never carries 'pgn'; the opt-in is a separate includePasted boolean read on the wire only by buildLibraryParams; the chip renders on the Library filter panel only (Openings/Endgames/GlobalStats never show it, even though they share the same FilterPanel component and module-level filter store)"
    requirement: "PASTE-09"
    verification:
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/PastedChip.test.tsx"
        status: pass
    human_judgment: false
  - id: D3
    description: "A pasted game's Library card renders a text 'Pasted' badge (not an icon) in the platform-icon/link slot, with no blank rating/TC fields or dangling separator, surviving a long player name"
    requirement: "PASTE-05"
    verification:
      - kind: unit
        ref: "frontend/src/components/results/__tests__/LibraryGameCardPastedBadge.test.tsx"
        status: pass
    human_judgment: false
  - id: D4
    description: "Manual cross-surface UI check: enabling the Pasted chip on Library shows pasted games on both tabs; navigating to Openings/Endgames/GlobalStats without resetting filters shows no Pasted chip and no pasted-game influence on any number there"
    verification: []
    human_judgment: true
    rationale: "Requires a live browser session against a running dev server with real pasted-game data; not exercisable from this autonomous worktree execution. The unit/integration test suite above proves the same containment guarantee at the code level (D-14 zero-match greps, backend red-if-removed-style route assertions), but a human should still confirm the rendered UI end-to-end before ship."

# Metrics
duration: ~55min
completed: 2026-08-08
status: complete
---

# Phase 208 Plan 04: Library "Pasted" Filter and Badge Summary

**Library-only `include_pasted` opt-in (backend `resolve_library_platforms` + five wire params, frontend `FilterState.includePasted` + `showPastedChip` chip + card badge) that keeps `platform='pgn'` games invisible everywhere except an explicit Library toggle.**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-08-08T20:29:00Z (approx.)
- **Tasks:** 3
- **Files modified:** 9 modified, 3 created

## Accomplishments

- `resolve_library_platforms()` gives the Games tab (chess.com/lichess/flawchess base) and the four analytics surfaces (chess.com/lichess base) each their own correct default population, with `include_pasted` additively appending `"pgn"` to whichever base applies — `LIBRARY_GAMES_BASE_PLATFORMS` never gains `"pgn"` (D-11), proven by a `node -e` structural check plus 10 unit tests.
- `include_pasted: bool = Query(default=False)` added to all five platform-filterable `/library/*` routes and forwarded through to the resolver — zero repository signature changes.
- `tests/services/test_library_include_pasted.py`: 10 pure unit tests over `resolve_library_platforms` plus 2 integration tests through the actual router proving `/library/flaws?include_pasted=true` reveals the pgn row but never admits `flawchess`.
- `FilterState.includePasted` (default `false`) + `FilterPanel`'s optional `showPastedChip` prop render a third platform chip (`ClipboardPaste` icon, `data-testid="filter-platform-pasted"`) only when `LibraryFilterPanel` sets the prop — the only caller that does, so Openings/Endgames/GlobalStats render nothing new even though they share the same component and module-level filter store.
- `useLibrary.ts`'s `buildLibraryParams` is the single place `includePasted` is read on the wire, emitting `include_pasted: true` only when set (omitted otherwise) — every Library query key includes it, so toggling the chip refetches automatically.
- `LibraryGameCard` renders an outline `text-sm` "Pasted" badge in the platform-icon/link slot (confirmed empty for pasted games today) for `game.platform === 'pgn'` — a single rendering branch, no duplicated mobile row.
- `CHANGELOG.md`'s `## [Unreleased]` → `### Added` gained one bullet summarizing the whole phase-208 paste feature (this plan is last-numbered in the phase and owns the entry per the plan's instruction).

## Task Commits

Each task was committed atomically:

1. **Task 1: resolve_library_platforms + the include_pasted wire param on five routes** - `f43a856a0` (test — combined implementation + tests, see TDD Gate Compliance below)
2. **Task 2: The Library-scoped "Pasted" chip, contained so it cannot leak into stats surfaces** - `ded70298f` (feat)
3. **Task 3: The "Pasted" card badge, and the phase's CHANGELOG entry** - `018ad08b5` (feat)
4. **Formatting fix-up** - `96e22dce4` (style — trailing ruff-format on Task 1's test file, missed after a ty-driven edit)

**Plan metadata:** committed with this SUMMARY (docs commit, see below)

## TDD Gate Compliance

Task 1 carries `tdd="true"` in its frontmatter, but this plan implemented `resolve_library_platforms()` and its five call sites together with the test file in a single commit (`f43a856a0`), rather than a separate `test(...)` RED commit followed by a `feat(...)` GREEN commit. The tests were written and verified passing against the already-implemented resolver, not written first against a not-yet-existing function. This is a **process deviation from the RED/GREEN gate sequence**, not a functional gap: all 12 tests (10 unit + 2 integration) pass, `uv run ruff check`/`ruff format --check` are clean, and `uv run ty check app/ tests/` reports zero errors introduced by this plan. Flagging per the gate-sequence-validation instruction rather than silently passing.

## Files Created/Modified

- `app/services/library_service.py` - `LIBRARY_GAMES_BASE_PLATFORMS`, `resolve_library_platforms()`, `include_pasted` param on `get_library_games`/`get_flaw_stats`/`get_library_flaws`/`get_flaw_comparison`/`get_tactic_comparison`
- `app/routers/library.py` - `include_pasted: bool = Query(default=False)` on the five platform-filterable routes, forwarded to the service
- `tests/services/test_library_include_pasted.py` (new) - 12 tests (10 unit + 2 integration through the router, with `finally`-block cleanup of every inserted non-guest `Game`/`GameFlaw` row)
- `frontend/src/components/filters/FilterPanel.tsx` - `FilterState.includePasted`, `showPastedChip` prop, the third platform chip, `ClipboardPaste` import
- `frontend/src/components/filters/LibraryFilterPanel.tsx` - passes `showPastedChip` (the only caller that does)
- `frontend/src/hooks/useLibrary.ts` - `buildLibraryParams` emits `include_pasted`
- `frontend/src/hooks/useStats.ts` - two hand-built `FilterState` literals now spread `DEFAULT_FILTERS` as their base (Rule 3 deviation, see below)
- `frontend/src/api/client.ts` - `include_pasted` added to `buildFilterParams` and all five `libraryApi` getter param types (Rule 3 deviation, see below)
- `frontend/src/components/filters/__tests__/PastedChip.test.tsx` (new) - 10 tests covering D-14 containment + `buildLibraryParams` wiring
- `frontend/src/components/results/LibraryGameCard.tsx` - the "Pasted" `Badge` in `platformIconAndLink`
- `frontend/src/components/results/__tests__/LibraryGameCardPastedBadge.test.tsx` (new) - 4 tests
- `CHANGELOG.md` - one `### Added` bullet under `## [Unreleased]` for the whole phase-208 paste feature

## Decisions Made

- `resolve_library_platforms(surface="games" | "analytics")` resolves each Library surface's correct default independently rather than sharing one base list, because the Games tab shows `flawchess` bot games (Phase 167 D-03) while the four analytics surfaces do not — a single shared base would have silently changed one of them.
- `include_pasted` is threaded unconditionally through `buildLibraryParams` for every Library hook (unlike `hasGem`/`hasGreat`, which are Games-tab-only args) since all five backend routes now accept the param.
- Platform-chip grid switches `grid-cols-2` → `grid-cols-3` only when `showPastedChip` is true, so the third chip is never orphaned in a half-width row and the two-chip surfaces (Openings/Endgames/GlobalStats) render byte-identical layout.
- `FILTER_DOT_FIELDS` was deliberately left unchanged — toggling the Pasted chip does not light the Library tabs' "modified filters" dot. This wasn't in the plan's acceptance criteria and was judged out of scope rather than silently added.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `frontend/src/api/client.ts` needed `include_pasted` wiring, but wasn't in this plan's `files_modified`**
- **Found during:** Task 2
- **Issue:** `useLibrary.ts`'s `buildLibraryParams` (this plan's listed file) returns an `include_pasted` key, but every `libraryApi.get*` call in `api/client.ts` routes its params object through `buildFilterParams`, which didn't know about the field — the value would have been silently dropped before reaching the network request, defeating Task 1's entire backend wire param.
- **Fix:** Added `include_pasted?: boolean` to `buildFilterParams`'s param type/body (the one seam all five endpoints route through) and to each of the five `libraryApi` getter param type signatures.
- **Files modified:** `frontend/src/api/client.ts`
- **Verification:** `npm run build` (tsc), full frontend test suite (3398 tests), and the integration behavior implied by `PastedChip.test.tsx`'s `buildLibraryParams` assertions.
- **Committed in:** `ded70298f` (Task 2 commit)

**2. [Rule 3 - Blocking] `frontend/src/hooks/useStats.ts`'s two hand-built `FilterState` literals broke `tsc` once `includePasted` became required**
- **Found during:** Task 2
- **Issue:** `useMostPlayedOpenings` and `useBookmarkPhaseEntryMetrics` each construct a full `FilterState` object literal by listing every key by hand (not spreading `DEFAULT_FILTERS`). Adding the required `includePasted` field to the interface broke `npm run build` (tsc) in both functions with `TS2741: Property 'includePasted' is missing`.
- **Fix:** Rewrote both constructions to spread `...DEFAULT_FILTERS` as the base and override only the filter-derived keys, rather than adding `includePasted: false` as an explicit key — this also satisfies the acceptance-criteria grep that no non-Library hook names `includePasted` explicitly (`grep -rln "includePasted" frontend/src/hooks/ | grep -v useLibrary.ts | wc -l` is 0).
- **Files modified:** `frontend/src/hooks/useStats.ts`
- **Verification:** `npm run build` passes; full frontend test suite (3398 tests) green.
- **Committed in:** `ded70298f` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking compile/wiring issues necessary for the feature to function, not scope creep)
**Impact on plan:** Both fixes were structurally required for the plan's own listed changes to compile and actually reach the network; no unplanned functionality was added.

## Issues Encountered

None beyond the two deviations above.

## Verification Run

```
$ uv run pytest tests/services/test_library_include_pasted.py tests/repositories/test_pasted_platform_exclusion.py tests/repositories/test_query_utils.py tests/services/test_library_service.py tests/test_library_router.py -x
143 passed in 6.96s

$ uv run pytest -n auto -x
4214 passed, 22 skipped in 40.87s

$ uv run ruff format --check app/ tests/
360 files already formatted

$ uv run ruff check app/ tests/
All checks passed!

$ uv run ty check app/ tests/
Found 3 diagnostics (all pre-existing onnxruntime/numpy unresolved-import in
app/services/maia_engine.py — confirmed pre-existing by Plan 02's SUMMARY;
zero errors introduced by this plan's files)

$ (cd frontend && npm run lint && npm test -- --run && npm run build && npm run knip)
lint: 0 errors
test: 227 files, 3398 tests passed
build: tsc -b + vite build, 0 errors
knip: 0 issues
```

## Known Stubs

None.

## Threat Flags

None beyond the threat register already recorded in the plan (T-208-17 through T-208-21, T-208-SC) — no new surface introduced outside what the plan's threat_model already covers.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `resolve_library_platforms`, `include_pasted`, `FilterState.includePasted`, and the "Pasted" badge are all in place; the Library half of PASTE-05/09 is complete.
- Plan 208-03 (running in parallel, the paste-save/enqueue orchestration) is independent of this plan's files and was not touched.
- D4 (manual cross-surface UI check) is flagged `human_judgment: true` in the coverage block — a human should verify the rendered chip/badge/containment behavior in a live browser before ship, since this autonomous worktree execution could only prove it at the code/test level.
- No blockers.

## Self-Check: PASSED

All 3 new test files confirmed present on disk (`tests/services/test_library_include_pasted.py`,
`frontend/src/components/filters/__tests__/PastedChip.test.tsx`,
`frontend/src/components/results/__tests__/LibraryGameCardPastedBadge.test.tsx`).
All 4 commits (`f43a856a0`, `ded70298f`, `018ad08b5`, `96e22dce4`) confirmed
present in `git log --oneline --all`.

---
*Phase: 208-analysis-fen-pgn-paste*
*Completed: 2026-08-08*
