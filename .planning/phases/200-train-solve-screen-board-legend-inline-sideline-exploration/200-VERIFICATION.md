---
phase: 200-train-solve-screen-board-legend-inline-sideline-exploration
verified: 2026-08-01T16:00:00Z
status: human_needed
score: 13/13 must-haves verified (DOM/behavior half); 1 pixel-layout item outstanding
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Run the 200-04-PLAN.md end-of-phase browser pass (15 steps, desktop then Chrome DevTools 375px device toolbar) against a live dev server: legend glyph colors/shapes match the board arrows; hover (desktop) / tap (mobile) spotlight; no yellow anywhere for a played inaccuracy; the Also fine row; stepping into a line then dropping a piece starts exploration with the correct seeded move list; the exploration engine card + move list fit the 375px column without page-level horizontal scroll and the move list scrolls on its own; Solution restores the pristine reveal; Next clears leftover state; Analyze + browser-back restores the pristine reveal."
    expected: "All 15 steps pass with no layout breakage, no clipped/illegible text, and tap targets are comfortably hittable at 375px."
    why_human: "jsdom has no layout engine — it cannot detect overflow, measure composited font size, or verify real tap-target size. This is exactly the residual WINDOWS.md entry #3 (kind unrun-verify, phase 200), which the phase's own plan classifies as non-blocking for execution but mandatory before the squash-merge to main."
---

# Phase 200: Train Solve Screen — Board Legend & Inline Sideline Exploration Verification Report

**Phase Goal:** Make the post-solve reveal board self-explanatory instead of an unreadable stack of overlapping arrows, and let a user explore "why didn't my move work" without ever leaving the Train solve screen — frontend-only, no backend or puzzle-pool change.

**Verified:** 2026-08-01
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria, cross-referenced with LEGEND-*/EXPLORE-* requirements)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Every reveal line box carries a small arrow glyph in its move's exact board-arrow color before the title; a coincidence-merged box renders one glyph in the best-move blue (LEGEND-01) | ✓ VERIFIED | `frontend/src/components/train/TrainReveal.tsx` `LineBoxHeader` renders `ArrowGlyphIcon` fed by `trainGlyphColor(...)` (`frontend/src/lib/trainArrows.ts:209-247` region); `ArrowGlyphIcon.tsx` reuses `buildArrowPath` (board geometry) and takes `color` only from that call, no literal. Merged-box single-glyph asserted in `TrainReveal.test.tsx` ("a coincidence-merged played==best box renders exactly ONE glyph button"). |
| 2 | Hovering (desktop) / tapping (mobile, 375px) a sidebar glyph hides every other arrow/badge, restoring on release/tap-away (LEGEND-02, LEGEND-06) | ✓ VERIFIED (DOM/state) / pixel half PENDING | `applyTrainSpotlight` (`trainArrows.ts:371-...`) is a pure, unit-tested filter; wired in `TrainSolveScreen.tsx`'s `spotlitOverlay` memo, applied only in the pristine-reveal ternary arm. `useIsDesktop` (1024px, matches Tailwind `lg`) drives the desktop-hover vs mobile-tap split. WR-01 code-review defect (first mobile tap swallowed) is fixed and regression-tested (`TrainReveal.test.tsx` "mobile: the FIRST tap on a glyph sets the spotlight..."). Real-viewport tap-target ergonomics and hover feel are the deferred pixel half — see Human Verification. |
| 3 | No yellow anywhere on the reveal surface; inaccuracy renders as good (arrow/badge/step-highlight/header glyph); eval badge still discloses the drop (LEGEND-03) | ✓ VERIFIED | `toDisplayQuality` (`trainArrows.ts:209`) collapses `inaccuracy`→`good` and is consumed at all five sites: `QUALITY_ARROW_COLOR`, the fine-move arrow loop, `markerForQuality`, `TRAIN_STEP_HIGHLIGHT`, and `TrainReveal`'s `CardHeader` `MoveQualityIcon`. Grep gates confirm `MOVE_QUALITY_INACCURACY`/`MOVE_HIGHLIGHT_SQUARE` are gone from `trainArrows.ts` code but still present/used in `theme.ts` and at least one non-Train consumer (prohibition honored — the Analysis board/Move Stats/eval chart keep the tier). A played mistake/blunder still emits its own color and `severity` marker (regression-tested). |
| 4 | Compact "Also fine" row lists exactly the drawn green alternatives, no stepper/eval, participates in the spotlight as one entry (LEGEND-04) | ✓ VERIFIED | `alsoFineMoves` pushed inside the same `cappedFineMoves.forEach` that draws the arrow (`trainArrows.ts`), so 1:1 with the board by construction; unit test asserts `alsoFineMoves.length === arrows.filter(layerKey.startsWith('good-')).length`. `TrainReveal.tsx` renders `train-reveal-also-fine`/`train-reveal-glyph-also-fine` as a non-Card `text-sm` row wired into the same spotlight state. |
| 5 | The spotlight filter and the recolor live in the pure `trainArrows.ts` builder, unit-tested (LEGEND-05) | ✓ VERIFIED | `applyTrainSpotlight`, `trainGlyphColor`, `toDisplayQuality`, `alsoFineMoves` derivation all live in `trainArrows.ts`; `frontend/src/lib/__tests__/trainArrows.test.ts` has 50+ cases covering merged-box, null/empty, ordering, malformed-UCI, collapse, cap, and the WR-02 shared-target-square regression. |
| 6 | Post-solve, moving a piece anywhere (including from a stepped line, whose prefix seeds the move list) starts exploration immediately, no toggle, no second board (EXPLORE-01, EXPLORE-02) | ✓ VERIFIED | `TrainSolveScreen.tsx`'s `handlePieceDrop` post-verdict branch (strictly after the `guess === null` and `moveApplied`/`verdict === null` guards — Pitfall 3 preserved) calls `exploration.start(lineStep?.prefixUci ?? [], uci)` / `exploration.playMove(uci)`. `TrainLineStep.prefixUci` / `TrainRevealStep.prefixUci` are threaded with a replay round-trip test proving the seeded prefix reconstructs the exact stepped FEN. |
| 7 | The moment exploration starts, boxes give way to a Stockfish engine-lines card + move list (no Maia, no FlawChess card); solution arrows clear; Solution exits; Analyze unchanged; clean teardown; works at 375px (EXPLORE-03, -04, -05, -06, -07) | ✓ VERIFIED (DOM/state) / EXPLORE-07 pixel half PENDING | `TrainReveal.tsx`'s `isExploring && exploration` ternary swaps sections 4/4a/Also-fine for `TrainExplorationPanel` (`EngineLines` imported verbatim, zero diff on `EngineLines.tsx` since merge-base; grep confirms no `MaiaCard`/`FlawChessEngineLines` reference). `boardArrows`/`boardMarkers` gain an `exploration.isExploring` empty arm. Solution button visibility-gated (`lineStep !== null \|\| exploration.isExploring`) and `handleShowSolution` calls `exploration.reset()`. A second, independent `useStockfishEngine` instance is proven distinct from the grading Worker and terminated on Solution/puzzle-transition (real `terminated` flag assertions on distinct stubbed Worker objects). `analysisUrl.ts`/`trainRevealCache.ts`/both engine hooks show zero diff across the phase's commits. EXPLORE-07's DOM half (same responsive shell, no separate mobile markup) is asserted; the pixel half is the deferred browser pass. |

**Score:** 7/7 roadmap success criteria hold at the DOM/unit-test level; 1 pixel-rendering item (LEGEND-06/EXPLORE-07's 375px browser pass) is honestly deferred, not silently dropped or fabricated.

### Requirement Traceability (13 IDs)

| Req ID | REQUIREMENTS.md status | Verified in code | Notes |
|--------|------------------------|-------------------|-------|
| LEGEND-01 | Complete | ✓ | Glyph-per-box + Card/CardHeader restructure (200-01), fifth recolor site (200-02). |
| LEGEND-02 | Complete | ✓ | Spotlight wiring + desktop/mobile split (200-01); WR-01 fix confirmed in working tree (`onFocus`/`onBlur` gated `isDesktop ? ... : undefined` at both the line-box Card and the Also-fine row, `TrainReveal.tsx:806-816,937-941`). |
| LEGEND-03 | Complete | ✓ | `toDisplayQuality` at all 5 sites (200-02); non-leak prohibition honored (grep + tests). |
| LEGEND-04 | Complete | ✓ | `alsoFineMoves` derived in the same loop as the drawn arrows (200-02). |
| LEGEND-05 | Complete | ✓ | All pure-builder logic unit-tested in `trainArrows.test.ts`. |
| LEGEND-06 | Complete (per REQUIREMENTS.md) | ⚠️ DOM half verified; pixel half UNRUN | See Human Verification — the 375px browser pass has not been run. Marking "Complete" in REQUIREMENTS.md is a step ahead of the operator-confirmed pixel check the phase's own plan requires before squash-merge; flagged as a human-verification gap here, not a code gap. |
| EXPLORE-01 | Complete | ✓ | `useTrainExploration` extend-never-restart semantics (200-03), proven by hook tests. |
| EXPLORE-02 | Complete | ✓ | `prefixUci` threading + replay round-trip test (200-03). |
| EXPLORE-03 | Complete | ✓ | **Cross-checked per the task brief:** plan 200-03's own objective text scopes EXPLORE-03 to only "the board half (solution arrows clear)" — confirmed by `git diff dfd6ba69~1..bfaae116 -- TrainReveal.tsx`, which shows ONLY the additive `prefixUci` field (13 lines), no swap-in UI change. The swap-in card + move list (the half that actually discharges "the reveal boxes give way to a Stockfish engine-lines card plus a move list") lives entirely in plan 200-04's `TrainExplorationPanel` in `TrainReveal.tsx` (verified present: `EngineLines` import, `TrainExplorationLine`, the `isExploring` ternary). So the Complete marking is truthful only because BOTH plans landed; if 200-04 had not shipped, EXPLORE-03 would still be incomplete despite 200-03's own summary claiming it as "requirements-completed". |
| EXPLORE-04 | Complete | ✓ | D-11 visibility gate + `exploration.reset()` in `handleShowSolution` (200-03). |
| EXPLORE-05 | Complete | ✓ | Second independent `useStockfishEngine`, distinct-Worker + termination tests (200-03). |
| EXPLORE-06 | Complete | ✓ | Zero diff on `analysisUrl.ts`, `trainRevealCache.ts`, and both engine hooks confirmed via `git diff --stat` from the phase's first commit to HEAD. |
| EXPLORE-07 | Complete (per REQUIREMENTS.md) | ⚠️ DOM half verified; pixel half UNRUN | Same as LEGEND-06 — the DOM structure (same `flex-col`/`lg:flex-row` shell, no separate mobile markup) is asserted by component tests, but the 375px browser pass itself has not been run. |

No orphaned requirements — REQUIREMENTS.md's 13 phase-200 IDs match the 13 IDs declared across the four plans' frontmatter exactly.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `frontend/src/lib/trainArrows.ts` | `applyTrainSpotlight`, `trainGlyphColor`, `toDisplayQuality`, `alsoFineMoves`, `markerOwners` | ✓ VERIFIED | All present, exported, unit-tested. |
| `frontend/src/components/icons/ArrowGlyphIcon.tsx` | Glyph reusing board arrow geometry | ✓ VERIFIED | Uses `buildArrowPath`; no literal color. |
| `frontend/src/hooks/useIsDesktop.ts` | Shared 1024px matchMedia gate | ✓ VERIFIED | Matches Tailwind `lg`; SSR/jsdom-safe fallback. |
| `frontend/src/hooks/useTrainExploration.ts` | Free-play chain state, no content-keyed reset | ✓ VERIFIED | No `useEffect` resetting `index`/`moves` on `startFen` change; regression-tested. |
| `frontend/src/components/train/TrainExplorationLine.tsx` | Fully controlled move list | ✓ VERIFIED | `grep -c useState` = 0; index arrives as a prop. |
| `frontend/src/components/train/TrainReveal.tsx` | Card/CardHeader boxes, Also-fine row, exploration swap | ✓ VERIFIED | All present and wired (see Key Link table). |
| `frontend/src/components/train/TrainSolveScreen.tsx` | Spotlight state, `displayFen`, second engine, D-11 gate | ✓ VERIFIED | All present and wired. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `TrainSolveScreen` spotlight state | `ChessBoard` arrows/markers | `applyTrainSpotlight` applied only in pristine-reveal ternary arm | WIRED | `lineStep !== null` arm untouched (Pitfall 1 preserved). |
| `TrainReveal` glyph/Card | `onSpotlightChange` → `TrainSolveScreen` state | pointer/focus/click handlers, desktop-gated | WIRED | WR-01 fixed: `onFocus`/`onBlur` now `isDesktop`-gated. |
| `TrainLineStepper.prefixUci` | `TrainReveal.handleLineStep` → `TrainRevealStep.prefixUci` → `TrainSolveScreen.lineStep` → `exploration.start` | prefix threading | WIRED | Round-trip replay test proves correctness. |
| `handlePieceDrop` post-verdict branch | `exploration.start`/`playMove` | guarded strictly after `guess`/`moveApplied`/`verdict` checks | WIRED | Guard order confirmed unchanged in source. |
| `exploration.isExploring` | second `useStockfishEngine({ fen, enabled })` | Worker lifecycle | WIRED | Distinct Worker objects proven; termination proven on Solution + puzzle transition. |
| `EngineLines.onMoveClick` | `exploration.playLine` | PV click-to-play | WIRED | `TrainReveal.tsx` `TrainExplorationPanel`. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| WR-01 regression (mobile first-tap not swallowed) | `npx vitest run trainArrows.test.ts TrainReveal.test.tsx -t "WR-01|WR-02"` | 3 passed | ✓ PASS |
| Full targeted phase-200 test set | `npx vitest run src/lib/__tests__/trainArrows.test.ts src/components/train/__tests__/ src/hooks/__tests__/useTrainExploration.test.ts` | 252 passed (12 files) | ✓ PASS |
| Production build (tsc -b + vite) | `npm run build` | exit 0, no errors | ✓ PASS |
| Dead-export/dependency scan | `npm run knip` | clean | ✓ PASS |

### Anti-Patterns Found

None in the phase's changed files. No `TBD`/`FIXME`/`XXX` markers, no unreferenced `TODO`/`HACK`/`PLACEHOLDER`, no `dangerouslySetInnerHTML`, no stub returns. The two WINDOWS.md entries carried forward from Phase 190 (#1, #2) are pre-existing and out of this phase's scope.

### Code Review Resolution (200-REVIEW.md)

Both Warning-level findings (WR-01: ungated `onFocus`/`onBlur` swallowing the first mobile tap; WR-02: `applyTrainSpotlight` marker-filter leaking a foreign move's badge on a shared target square) are fixed in commit `6926d0dc`, confirmed present in the current working tree:
- WR-01: `TrainReveal.tsx:814-815` (`onFocus: isDesktop ? ... : undefined`) and `:939-940` (Also-fine row, same pattern).
- WR-02: `TrainRevealOverlay.markerOwners` (`trainArrows.ts:179`) populated in the same push pass as the marker itself; `applyTrainSpotlight` filters markers by ownership, not square membership.

Both fixes carry regression tests that assert genuine behavior (not symbol presence) — confirmed by direct read of the test bodies (`TrainReveal.test.tsx` "mobile: the FIRST tap on a glyph sets the spotlight..." dispatches a real `focus` then `click` sequence and asserts the spotlight ends ON; `trainArrows.test.ts` "does not leak another move's badge when two candidate moves share a target square" constructs the exact shared-square scenario and asserts each spotlight target gets only its own badge). Both pass when run in isolation.

The one Info-level finding (IN-01, `useIsDesktop` has no dedicated unit test) was explicitly Accepted, not fixed — non-blocking by design, and does not affect any must-have.

### Human Verification Required

**1. 375px browser pass (LEGEND-06 pixel half, EXPLORE-07 pixel half, plus the rest of the 15-step checklist)**

**Test:** Run `200-04-PLAN.md`'s "Human Verification Required" 15-step browser pass: desktop card hover/keyboard-focus spotlight, a forced-inaccuracy puzzle showing no yellow, stepping into a line then dragging a piece to start exploration with the correct seeded move list, PV-click-to-play, Solution exit, Next transition cleanliness, Analyze + browser-back, then repeating the mobile-relevant steps at exactly 375px in Chrome DevTools (glyph tap targets, tap-toggle/tap-away/tap-switch, the exploration card and move list fitting the column without page-level horizontal scroll, PV rows legible and unclipped).

**Expected:** All 15 steps pass with no layout breakage, no clipped/illegible text at 375px, and comfortably hittable tap targets.

**Why human:** jsdom has no layout engine — it reports zero-sized boxes, cannot detect overflow, and `fireEvent.click` passes regardless of a 4px tap target; rendered font size and composited color after the Tailwind cascade are likewise unobservable there. This is the exact, honestly-recorded gap from `WINDOWS.md` entry #3 (`kind: unrun-verify`) — the executor did not fabricate a pass, and per the plan's own decision this is non-blocking for execution but IS a mandatory pre-squash-merge item.

### Gaps Summary

No code gaps. All 13 requirement IDs have real, wired, tested implementations in the current working tree; the two code-review Warnings are genuinely fixed and regression-tested (not just documented as fixed); the guard-order and engine-isolation invariants central to this phase's risk profile hold under direct source inspection. The sole open item is the operator-run 375px browser pass (WINDOWS.md #3), which the phase's own plan explicitly scoped as a non-blocking, end-of-phase, pre-squash-merge human check — it has not been run yet, so LEGEND-06 and EXPLORE-07's REQUIREMENTS.md "Complete" marking is one step ahead of full verification. This routes the phase to `human_needed` rather than `passed`; it does not indicate a defect.

---

_Verified: 2026-08-01_
_Verifier: Claude (gsd-verifier)_
