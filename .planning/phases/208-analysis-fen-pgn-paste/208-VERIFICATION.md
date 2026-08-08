---
phase: 208-analysis-fen-pgn-paste
verified: 2026-08-08T19:13:00Z
status: human_needed
score: 32/32 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 31/32
  gaps_closed:
    - "After 'Analyze full game' persists the row, the app navigates to /analysis?game_id=N and the board renders that saved game (D-15) — no silently-wrong position is shown"
  gaps_remaining: []
  regressions: []
deferred: []
behavior_unverified_items: []
human_verification:
  - test: "UI-SPEC backstop E3: with the modal open on a Valid-PGN paste whose White/Black header names are realistically long, confirm the side-selector meta line ('White: {name} ({elo}) · Black: {name} ({elo})') truncates each name individually at a 375px viewport without breaking the toggle's 50/50 item widths."
    expected: "Per-name truncation applies; the White/Black ToggleGroupItems stay equal-width; nothing overflows or wraps the modal."
    why_human: "Viewport-rendering measurement — UI-SPEC records this as verification:backstop (not assertable from unit tests); routes to insufficient_spec -> human_needed per the spec's own note."
  - test: "UI-SPEC backstop E6: with an ephemeral pasted-PGN player-info row showing a long truncating player name plus the '{Result} · {Date}' content in the freed clock slot, confirm both fit on the same PlayerBar row at 375px."
    expected: "The result/date text and the truncated name coexist on one row with no overflow, wrap, or clipping."
    why_human: "Same as above — a viewport measurement, not assertable from unit tests; UI-SPEC explicitly routes this to human_needed."
  - test: "208-04 D4 cross-surface check: on Library, enable the 'Pasted' chip and confirm pasted games appear on BOTH the Games and Flaws tabs; then navigate to Openings, Endgames, and GlobalStats without resetting filters and confirm no 'Pasted' chip renders on any of the three, and no pasted game influences any number shown there."
    expected: "Pasted games visible on both Library tabs when the chip is on; zero visual or numeric trace of pasted games on Openings/Endgames/GlobalStats."
    why_human: "Requires a live browser session against a running dev server with real pasted-game data; the unit/integration suite proves the same containment at the code level (D-14 zero-match greps, backend route assertions) but the plan's own SUMMARY flags this as unexercised by the autonomous worktree execution."
  - test: "CR-01 fix confirmation: view /analysis?game_id=OLD, paste a different PGN, click 'Analyze full game' directly (without first clicking 'Load'), and confirm the board/move-list update to the new game after the URL becomes /analysis?game_id=NEW. Also try browser back/forward between two already-saved games while remaining on /analysis."
    expected: "Board/move-list update to the new game, matching the URL and the already-correct PlayerBar/eval chart/flaw panel. No stale prior-game position lingers."
    why_human: "The regression is now covered by 2 automated tests (frontend/src/pages/__tests__/Analysis.test.tsx, describe 'Analysis same-page game switch (Phase 208 CR-01)') which this verification independently re-ran and additionally confirmed red-if-removed by reverting the fix locally and observing both new tests fail with the exact 'board keeps showing the old game' symptom, then restoring the fix and re-confirming green. This item is kept as a live-browser confirmation of that automated result before ship, per the coordinator's request, not because the fix is unverified in code."
---

# Phase 208: Paste a FEN or PGN on /analysis — Verification Report

**Phase Goal:** Give `/analysis` a door in from outside — a nav item, a Paste button, a modal
with one sniffed textarea that loads a bare FEN as a free-play root or a full PGN's mainline
plus headers, persisting nothing until an explicit "Analyze full game" saves the game as
`platform='pgn'` (always excluded from analytics) and enqueues it through the existing tier-1
eval path. Frontend + backend, no migration, no new eval infrastructure.

**Verified:** 2026-08-08T19:13:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (previous report: `gaps_found`, 31/32, commit `bffbb4506`)

## Re-verification Summary

Two commits landed since the initial report, both re-verified against the live code (not
trusted from commit messages):

1. **`ff6b96f4f`** (CR-01 fix) — `frontend/src/pages/Analysis.tsx`'s three one-shot boolean
   seeding guards (`hasLoadedMainLine`, `hasNavigatedToInitialPly`) are replaced by two
   identity-keyed refs (`seededKey`, `navigatedInitialPlyKey`) storing `'game:<gameId>' | 'line'
   | 'fen'`. Read the actual diff (`git show bffbb4506:...` vs HEAD) rather than trusting the
   commit description — confirmed:
   - The game-mode seeding effect now keys on `game:${gameId}` and reseeds whenever `gameId`
     changes on the same mounted page, closing the exact CR-01 repro (view game A, paste +
     "Analyze full game" for game B, board previously stayed on A).
   - Free play (`?line=`/`?fen=`) preserves **once-ever** semantics: both effects still bail
     the moment *any* key is set (`seededKey.current !== null`), so the documented
     `game_id > fen > line` precedence is byte-for-byte unchanged — a same-page switch away from
     free play was never the bug and isn't touched.
   - The initial-ply-navigation effect now depends on `mainLine` **identity**, not `.length`,
     which specifically fixes the equal-move-count case the coordinator called out (two games
     with the same ply count previously shared a `.length` that never changed, so the second
     game's entry-ply navigation silently never fired).
   - The `seededKey.current !== key` gate on that same effect is the anti-deadlock guard: during
     the window between `navigate()` firing and the new game's data actually arriving, `gameId`
     already reads as game B while `mainLine` still holds game A's nodes. Without the gate, this
     effect would fire on the `gameId` change alone, mark `navigatedInitialPlyKey.current =
     'game:B'` against A's stale tree, and then never re-run once B's data genuinely seeds
     (because the `mainLine` dependency changes but the key-already-recorded check would now
     short-circuit). Traced this through by hand against the effect ordering and confirm it
     cannot deadlock a legitimate first seed: on initial mount, `seededKey.current` starts
     `null`, so the very first `game:${gameId}` write always succeeds unconditionally.
   - `handlePasteSaved` (`Analysis.tsx:2645-2648`) deliberately does **not** reset either ref —
     confirmed by reading the current function body; the key change (`gameId` differing from
     whatever `seededKey.current` currently holds) is itself sufficient to re-arm the seeding
     effect, exactly as the commit description claims.
   - **Independently reproduced the red-if-removed claim**, not just read it: checked out the
     pre-fix `Analysis.tsx` from `bffbb4506` over the current file, ran
     `npm test -- --run src/pages/__tests__/Analysis.test.tsx -t "CR-01"` — both new regression
     tests failed, one with `Expected: "d4"` / `Received: "1.e41.e4"` (game A's move persisting
     after navigating to game B), matching the coordinator's description exactly. Restored the
     fixed file (`git diff` confirms byte-identical to HEAD afterward) and re-ran the full file:
     **68/68 passed.**
2. **`f2dc4c080`** (WR-02 fix) — `app/repositories/game_repository.py:140` now types
   `update_game_user_color`'s `user_color` parameter as `Color` (imported from
   `app.schemas.normalization`, confirmed at line 13) instead of bare `str`. `uv run ty check`
   on the touched files reports zero errors.

Both fixes are genuine, not cosmetic. The gate re-run the coordinator reported was not
re-executed in full (per instruction), but the specific regression test file was re-run directly
(`68 passed`) and the backend `ty check` was re-run on the touched files (clean).

## Goal Achievement

### Observable Truths

All 32 truths from the initial report, re-stated with truth #32 updated to reflect the fix.
Truths 1-31 are unchanged from the initial verification (re-spot-checked where the CR-01/WR-02
diff could plausibly have touched them — it did not: `handlePasteLoad`, `showPlayerBars`, and
every other truth-1-31 code path are untouched by both commits).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Pasting a bare FEN loads that position on `/analysis` as a free-play root (PASTE-01) | ✓ VERIFIED | `handlePasteLoad` (`Analysis.tsx:2621-2628`, unchanged) calls `loadMainLine([], result.fen)` for `kind:'fen'` |
| 2 | A bare-FEN paste issues zero network requests and leaves `window.location.search` unchanged (PASTE-01) | ✓ VERIFIED (code-level; runtime UAT'd at the tracer checkpoint per 208-01-SUMMARY) | No `navigate`/URL-mutation call reachable from the `fen` branch |
| 3 | Pasting a PGN loads its full mainline; header names/ratings/result/date reach the PlayerBar (PASTE-02) | ✓ VERIFIED | `pastedGame.test.ts` (18 tests, pass); `Analysis.tsx`'s `showPlayerBars`/`playerBar` fire on `pastedHeaders != null` |
| 4 | `[SetUp]`/`[FEN]` PGN adopts the header FEN as root, incl. Black-to-move (PASTE-02) | ✓ VERIFIED | `pastedGame.test.ts` |
| 5 | Headerless movetext parses; RAVs/NAGs/comments dropped without error (PASTE-02) | ✓ VERIFIED | `pastedGame.test.ts` |
| 6 | One textarea, no format-toggle control (PASTE-03) | ✓ VERIFIED | `PasteModal.tsx` |
| 7 | Malformed input renders the exact D-22 error, board left unchanged (PASTE-03) | ✓ VERIFIED | `PasteModal.tsx:38` `PARSE_ERROR_MESSAGE`, `PasteModal.test.tsx` |
| 8 | A PGN with an illegal Nth move loads ZERO moves — the D-21 landmine (PASTE-03) | ✓ VERIFIED | `pastedGame.ts` two-instance discipline; `pastedGame.test.ts` |
| 9 | `/analysis` in desktop header nav + mobile More drawer (PASTE-08) | ✓ VERIFIED | `App.tsx:92`; `App.test.tsx` |
| 10 | `BOTTOM_NAV_ITEMS` still exactly 5 entries, none `/analysis` (PASTE-08) | ✓ VERIFIED | `App.tsx:97-103` |
| 11 | `/analysis` clickable at zero imported games (PASTE-08) | ✓ VERIFIED | `App.tsx:139` `IMPORT_EXEMPT_ROUTES` |
| 12 | `/analysis` renders active treatment on `pathname === '/analysis'` (PASTE-08) | ✓ VERIFIED | `App.tsx:153` |
| 13 | Every modal interactive element carries `data-testid`; modal body is a `<form>` with its own testid (PASTE-09) | ✓ VERIFIED | `PasteModal.tsx` — `paste-modal` vs `paste-form` |
| 14 | No element below the 14px `text-sm` floor (PASTE-09) | ✓ VERIFIED | `grep -c 'text-xs'` on paste-introduced files is 0 |
| 15 | Empty/whitespace/headers-only-zero-moves all resolve correctly (PASTE-02 edge) | ✓ VERIFIED | `pastedGame.test.ts` |
| 16 | Input normalization (BOM/CRLF/NBSP/typographic quotes) before parsing (PASTE-02 edge) | ✓ VERIFIED | `pastedGame.test.ts` |
| 17 | Non-ASCII header names round-trip unmangled (PASTE-02 edge) | ✓ VERIFIED | `pastedGame.test.ts` |
| 18 | `sniffPastedInput` is a pure function, no module-level mutable state (PASTE-03 edge) | ✓ VERIFIED | `pastedGame.test.ts` |
| 19 | `/analysis` last in `NAV_ITEMS`, ADMIN_NAV_ITEM still rightmost (PASTE-08 edge) | ✓ VERIFIED | `App.tsx:92` |
| 20 | `platform='pgn'` excluded from every default `apply_game_filters()` population, red-if-removed (PASTE-05) | ✓ VERIFIED | `tests/repositories/test_pasted_platform_exclusion.py` (4 tests, pass) |
| 21 | Every `Platform` member has an explicit disposition, disjoint tuples (PASTE-05) | ✓ VERIFIED | `test_every_platform_has_an_analytics_disposition` |
| 22 | D-16 hash: header-independent, root-sensitive, 64-hex-char (PASTE-05/06) | ✓ VERIFIED | `TestPastedGameIdentityHash` |
| 23 | `canonical_root_fen` drops halfmove/fullmove/ep, keeps 3 fields | ✓ VERIFIED | `TestCanonicalRootFen` |
| 24 | `normalize_pasted_game`: no `[%clk]` gate, `platform='pgn'`, all TC fields None, rated=False | ✓ VERIFIED | `TestNormalizePastedGame` |
| 25 | `normalize_pasted_game` never stores an unrecognized `[Termination]` header verbatim (CR-02 closure) | ✓ VERIFIED | Board-derived fallback, length-bound test |
| 26 | Pressing "Analyze full game" persists exactly ONE `platform='pgn'` row with `user_color` from the selector, enqueues tier-1 (PASTE-04) | ✓ VERIFIED | `store_pasted_game`; `test_store_paste_game_service.py`/`test_imports_paste.py` |
| 27 | Row owner is server-derived, never body-supplied (PASTE-04) | ✓ VERIFIED | `test_foreign_owner_field_in_body_is_ignored` |
| 28 | Re-pasting reuses the existing row, updates `user_color` in place (now via the `Color` Literal, WR-02 closed), no duplicate on a simulated race (PASTE-06) | ✓ VERIFIED | `game_repository.py:139-141` (`user_color: Color`); `test_reposting_identical_pgn_reuses_row`, `test_preexisting_identical_row_resolves_without_integrity_error` |
| 29 | Every persisted pasted row has `full_evals_completed_at` set or an `eval_jobs` row; post-commit enqueue failure returns `enqueue_failed` (200, not 500) and heals on resubmit, incl. for guests (PASTE-07) | ✓ VERIFIED | `store_paste_game_service.py` step-6 non-propagating `except`; both enqueue-failure tests |
| 30 | `PasteModal` disables both buttons while saving ("Analyzing…"), re-enables on failure, surfaces `enqueue_failed` distinctly (PASTE-09) | ✓ VERIFIED | `PasteModal.tsx:239` `isSaving ? 'Analyzing…' : ...`; `PasteModal.test.tsx` |
| 31 | Pasted games hidden from both Library tabs by default; "Pasted" chip reveals them additively; never leaks to Openings/Endgames/GlobalStats (PASTE-05 Library half / D-11..D-14) | ✓ VERIFIED | `resolve_library_platforms`/`LIBRARY_GAMES_BASE_PLATFORMS`; `include_pasted` on 5 routes; `test_library_include_pasted.py`/`PastedChip.test.tsx` |
| 32 | After a successful save, the app navigates to `/analysis?game_id=N` for the saved game, and the board reflects that game — no `?fen=`/`?line=` write-back at any point; a same-page switch between two saved games (any cause: paste-and-save, browser back/forward) reseeds correctly, including when the two games have equal move counts (D-15, PASTE-04/09, CR-01) | ✓ **VERIFIED (was FAILED — CR-01 now fixed)** | `Analysis.tsx`'s `seededKey`/`navigatedInitialPlyKey` identity-keyed refs (see Re-verification Summary above for the full trace); 2 new regression tests in `frontend/src/pages/__tests__/Analysis.test.tsx` (`describe('Analysis same-page game switch (Phase 208 CR-01)')`) independently re-run and pass; the fix independently confirmed red-if-removed by this verification (reverted locally, both tests failed with the exact `"1.e41.e4"` stale-board symptom, then restored to a clean `git diff` and re-confirmed 68/68 green) |

**Score:** 32/32 truths verified, 0 failed, 0 present-but-behavior-unverified.

**Note on the initial report's arithmetic:** the initial report stated "30/32" in its score line
but its own table showed 31 rows VERIFIED and only 1 (#32) FAILED — that was a counting error in
the initial report, not a re-scoped truth set. Corrected here: previous score was 31/32, now
32/32.

### Required Artifacts

Unchanged from the initial report — all 10 previously-listed artifacts remain ✓ VERIFIED; the
CR-01/WR-02 diffs touch existing files (`Analysis.tsx`, `game_repository.py`) without adding or
removing any artifact.

### Key Link Verification

All links from the initial report remain ✓ WIRED, with one link's status flipped:

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `Analysis.tsx` (`handlePasteSaved`) | board re-seed on new `gameId` | `seededKey`/`navigatedInitialPlyKey` identity-keyed re-arming | ✓ **WIRED (was NOT WIRED)** | The key-based guards re-arm automatically whenever `gameId` changes on the same mounted page — no explicit reset needed in `handlePasteSaved`, confirmed by reading the current effect bodies and by the passing regression tests |

All other links (`PasteModal.tsx`→`pastedGame.ts`, `Analysis.tsx`→`useAnalysisBoard.ts`,
`App.tsx` nav wiring, `routers/imports.py`→`store_paste_game_service.py`,
`store_paste_game_service.py`→`eval_queue_service.py`, `PasteModal.tsx`→`usePasteGame.ts`,
`LibraryFilterPanel.tsx`→`FilterPanel.tsx`, `useLibrary.ts`→`library.py` routes) are unaffected
by this round's two commits and remain ✓ WIRED as previously verified.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| PASTE-01 | 01 | Bare FEN → free-play root, no DB write, no URL change | ✓ SATISFIED | Truths 1-2 |
| PASTE-02 | 01 | PGN mainline+headers, SetUp/FEN root, headerless, RAV/NAG dropped | ✓ SATISFIED | Truths 3-5, 15-17 |
| PASTE-03 | 01 | One textarea, sniffed, malformed → inline error | ✓ SATISFIED | Truths 6-8, 18 |
| PASTE-04 | 01, 03 | Save + tier-1 enqueue; paste-and-look persists nothing | ✓ **SATISFIED (was PARTIALLY SATISFIED)** | Truths 26-27, 30, 32 — the post-save navigation now reliably reloads the board |
| PASTE-05 | 02, 04 | Never in any `apply_game_filters()` consumer, red-if-removed test | ✓ SATISFIED | Truths 20-21, 31 |
| PASTE-06 | 03 | Re-paste reuses the existing row | ✓ SATISFIED | Truth 28 |
| PASTE-07 | 03 | Saved-but-unanalyzed pasted game is not left pending | ✓ SATISFIED | Truth 29 |
| PASTE-08 | 01 | Nav item on two surfaces, bottom bar unchanged, comments on both arrays | ✓ SATISFIED | Truths 9-12, 19 |
| PASTE-09 | 01, 03, 04 | testids, `<form>`, 14px type floor, 375px | ✓ SATISFIED (code-level); 2 backstop items routed to human verification | Truths 13-14, 30 |

No orphaned requirements.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` debt markers in either commit's touched files
(`frontend/src/pages/Analysis.tsx`, `app/repositories/game_repository.py`).

The phase's code review (`208-REVIEW.md`) findings, re-assessed:

- ✅ **CR-01 (Critical) — CLOSED.** Fixed by `ff6b96f4f`. Independently re-verified in code (see
  Re-verification Summary) and by reverting the fix locally and confirming the two new
  regression tests fail with the exact symptom the review predicted, then restoring and
  re-confirming green.
- ⚠️ **WR-01 (Warning) — still open, deliberately out of scope for this closure.** Using "Load"
  (not "Analyze full game") while already in `?game_id=` mode still leaves the `gameData`-derived
  eval chart / flaw-tags panel / PV navigation stale and pointing at the wrong game via aliased
  node IDs (confirmed still present: `evalChart`/`tagsPanel` gate on `evalChartReady`/`gameData`
  only, not on `pastedHeaders`). **Classification confirmed unchanged: non-blocking.** It still
  does not correspond to an explicit `must_haves.truths` entry in any plan — D-20 requires the
  trigger stay *visible* in game mode, and none of the four plans' truths assert that *using
  Load* (as opposed to *Analyze full game*, which CR-01 covered) from game mode leaves other
  panels consistent. It shares CR-01's root cause family (stale `gameData`-derived state after a
  same-page paste) but is a strictly narrower, silent-misdirection risk (wrong flaw-chip target),
  not a "board shows the wrong game" defect. Recommend a human decision on whether it needs its
  own follow-up plan, but it does not block this phase's goal achievement.
- ✅ **WR-02 (Warning) — CLOSED.** Fixed by `f2dc4c080`. `update_game_user_color` now types
  `user_color: Color` (confirmed at `game_repository.py:140`, `Color` imported from
  `app.schemas.normalization` at line 13). `ty check` on the touched files reports zero errors.

### Human Verification Required

### 1. UI-SPEC backstop E3 — side-selector meta-line truncation at 375px

**Test:** Open the paste modal, paste a PGN with a realistically long White/Black header name, view at a 375px viewport.
**Expected:** Each name truncates individually in the `"White: {name} ({elo}) · Black: {name} ({elo})"` meta line; the White/Black toggle stays 50/50 width.
**Why human:** Viewport rendering measurement, explicitly marked `verification: backstop` in UI-SPEC — not assertable from unit tests.

### 2. UI-SPEC backstop E6 — player-info result/date slot fit at 375px

**Test:** Load a pasted PGN with a long player name; view the PlayerBar's freed clock slot at 375px.
**Expected:** The truncated name and the `"{Result} · {Date}"` text both fit on one row with no overflow.
**Why human:** Same as above — a viewport measurement UI-SPEC itself routes to human verification.

### 3. Library cross-surface containment (208-04's own flagged D4 item)

**Test:** On Library, enable "Pasted"; confirm pasted games show on both Games and Flaws tabs. Navigate to Openings/Endgames/GlobalStats without resetting filters; confirm no "Pasted" chip and no pasted-game influence on any number.
**Expected:** Full containment — visible only on Library, invisible everywhere else.
**Why human:** Requires a live browser session with real data; the code-level containment (zero-match greps, route-level tests) is proven, but the plan's own SUMMARY explicitly flags this as unexercised end-to-end.

### 4. CR-01 fix confirmation (kept per coordinator's request, not because the fix is unverified in code)

**Test:** View `/analysis?game_id=OLD`, paste a different PGN, click "Analyze full game" directly (no prior "Load" click), confirm the board after navigating to `/analysis?game_id=NEW`. Also spot-check browser back/forward between two already-saved games while staying on `/analysis`.
**Expected:** Board/move-list update to `NEW` (or whichever game is navigated to), matching the URL and the already-correct PlayerBar/eval chart/flaw panel.
**Why human:** The fix is proven in code and by 2 automated regression tests this verification independently re-ran and confirmed red-if-removed. This item remains a live-browser sanity check before ship, per the coordinator's explicit instruction to keep it in place.

### Gaps Summary

No gaps remain. The one blocking gap from the initial report (CR-01) is closed and independently
re-verified — both by reading the fix's reasoning against the actual code (confirming no
deadlock on first seed and no change to the `game_id > fen > line` free-play precedence) and by
locally reverting the fix and observing the two new regression tests fail with the exact
predicted symptom before restoring and re-confirming green. WR-02 is also closed. WR-01 remains
open by deliberate scope decision, confirmed non-blocking (no corresponding `must_haves.truths`
entry, and it is a narrower stale-panel/misdirection risk rather than a wrong-board defect).

Four items remain for human/live-browser verification, none of which are new gaps: two UI-SPEC
`verification: backstop` viewport measurements (E3, E6) that were never assertable from unit
tests, one cross-surface containment check the phase's own Plan 04 SUMMARY already flagged as
unexercised by the autonomous execution, and a final live-browser confirmation of the now-fixed
CR-01 behavior, kept in place per the coordinator's explicit request.

---

_Verified: 2026-08-08T19:13:00Z_
_Verifier: Claude (gsd-verifier)_
