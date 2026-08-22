---
phase: 208-analysis-fen-pgn-paste
plan: 01
subsystem: ui
tags: [react, typescript, chess.js, radix-ui, tailwind]

requires: []
provides:
  - "/analysis reachable from the desktop header nav and the mobile More drawer, deliberately absent from the bottom bar (D-09/D-10)"
  - "sniffPastedInput() — pure FEN/PGN format sniffer with full header extraction, D-21 truncation-safe"
  - "PasteModal — the paste dialog with its four-state (empty/fen/pgn/error) machine, side selector, and ephemeral player-info wiring"
  - "PlayerBar.rightSlotContent — reusable freed-clock-slot content prop for any future untimed/ephemeral player row"
affects: [208-02, 208-03, 208-04]

actuals:
  tokens: 14700
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Sniff-then-branch parsing: attempt the stricter format (loadPgn) first, discard the instance unread on throw, fall through to the looser format (bare FEN) — never read state off a thrown-on parser instance"
    - "Ephemeral React state (pastedHeaders) standing in for a fetched-row shape (gameData) at render sites, rather than synthesizing a fake row object"

key-files:
  created:
    - frontend/src/lib/pastedGame.ts
    - frontend/src/lib/pastedGame.test.ts
    - frontend/src/components/analysis/PasteModal.tsx
    - frontend/src/components/analysis/__tests__/PasteModal.test.tsx
  modified:
    - frontend/src/App.tsx
    - frontend/src/App.test.tsx
    - frontend/src/pages/Analysis.tsx
    - frontend/src/components/board/PlayerBar.tsx

key-decisions:
  - "Mirrored the Paste trigger + CardHeader onto the mobile/mid Moves tab (movesTab), not just the desktop movesCard the plan's Task 1 text named — movesCard is desktop-only per its own code comment, so the plan's D-19 mobile-reachability claim would have been false without this. Approved by the coordinator post-checkpoint, citing UI-SPEC truth E1 and CLAUDE.md's mobile-parity rule."
  - "Added an optional PlayerBar.rightSlotContent prop (not in Task 2's file list) to render the pasted game's Result/Date in the freed clock slot, since D-07 (untimed) leaves clockSeconds always null there and UI-SPEC required that exact slot reused rather than a new row."
  - "onLoad's second parameter (userColor) was added to PasteModalProps in Task 1 itself, ahead of Task 2's side selector, so the interface didn't need reshaping mid-plan."

patterns-established:
  - "sniffPastedInput's two-instance discipline: a detection-only Chess() whose history() is never read, then a second freshly-constructed instance for the real result — the concrete fix for the D-21 landmine, reusable anywhere else chess.js's loadPgn needs a throw-safe wrapper"

requirements-completed: [PASTE-01, PASTE-02, PASTE-03, PASTE-08, PASTE-09]

coverage:
  - id: D1
    description: "Pasting a bare FEN loads it as a free-play root with zero network requests and no ?fen=/?line= URL mutation"
    requirement: "PASTE-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/pastedGame.test.ts#sniffs a bare FEN as kind: fen"
        status: pass
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/PasteModal.test.tsx#submitting a valid FEN calls onLoad with the sniffed result and closes the modal"
        status: pass
    human_judgment: true
    rationale: "The zero-network-request and URL-unchanged guarantees, and the actual on-board rendering, are only proven by a real browser session — the automated tests cover the data path (sniff -> onLoad -> loadMainLine) but not the live DOM/network observation UAT performed at the tracer checkpoint."
  - id: D2
    description: "Pasting a PGN loads its full mainline and headers (names/ratings/result/date reach the PlayerBar), honors a [SetUp]/[FEN] root including Black-to-move, parses headerless movetext, and drops RAVs/NAGs/comments without error"
    requirement: "PASTE-02"
    verification:
      - kind: unit
        ref: "frontend/src/lib/pastedGame.test.ts (18 tests covering mainline length, SetUp/FEN root, Black-to-move, RAV/NAG/comment dropping, header coercion, non-ASCII round-trip)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/PasteModal.test.tsx#valid PGN: side selector defaults to White, both footer buttons render"
        status: pass
    human_judgment: false
  - id: D3
    description: "One textarea handles both formats with no toggle; malformed input renders the locked inline error rather than a partial/blank/crashed board"
    requirement: "PASTE-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/pastedGame.test.ts#rejects a PGN whose Nth move is illegal, WITHOUT leaking the parsed prefix"
        status: pass
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/PasteModal.test.tsx#malformed input: Load disabled, the exact locked error literal renders with role=\"alert\""
        status: pass
    human_judgment: false
  - id: D4
    description: "/analysis is reachable from the desktop header and mobile More drawer, clickable at zero games, highlights when active, and the mobile bottom bar stays byte-identically 5 entries"
    requirement: "PASTE-08"
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx (describe.each nav lock state — /analysis (Phase 208), 3 tests x 3 profile states)"
        status: pass
      - kind: unit
        ref: "frontend/src/App.test.tsx#desktop and bottom-bar nav sequences agree everywhere EXCEPT /analysis (Phase 208, D-09)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every interactive element the modal introduces carries a data-testid; the modal body is a <form> with its own testid distinct from DialogContent; nothing renders below the 14px text-sm floor"
    requirement: "PASTE-09"
    verification:
      - kind: unit
        ref: "frontend/src/components/analysis/__tests__/PasteModal.test.tsx#renders with the paste-modal and paste-form testids, and the form testid differs from the DialogContent testid"
        status: pass
      - kind: other
        ref: "grep -c text-xs frontend/src/components/analysis/PasteModal.tsx frontend/src/components/analysis/__tests__/PasteModal.test.tsx -> 0 for both"
        status: pass
    human_judgment: true
    rationale: "The two backstop truths (side-selector meta line and result/date slot fitting at a real 375px viewport with a long name) are viewport measurements per UI-SPEC's own note — not assertable from unit tests, routes to human verification."

duration: ~55min (including a paused human-verify checkpoint after the Task 1 tracer)
completed: 2026-08-08
status: complete
---

# Phase 208 Plan 01: Paste-a-FEN-or-PGN tracer Summary

**One textarea on `/analysis` that sniffs a bare FEN or a full PGN via chess.js, loads either onto the board with zero persistence, and a new `/analysis` main-nav entry the page never had before.**

## Performance

- **Duration:** ~55 min (includes a paused tracer checkpoint between Task 1 and Task 2 for human sign-off, per plan design)
- **Tasks:** 3 (1 tracer + 1 TDD-flagged expansion + 1 test/sweep)
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- `/analysis` is now reachable from the desktop header nav and the mobile More drawer (deliberately absent from the bottom bar — D-09), clickable with zero imported games (D-10), and highlights when active
- `sniffPastedInput()` sniffs pasted text into `empty | fen | pgn | error`, honoring the D-21 "never read a thrown-on chess.js instance" landmine, dropping RAVs/NAGs/comments natively via `history()`, adopting a `[SetUp]`/`[FEN]` root (including Black-to-move), and normalizing BOM/CRLF/NBSP/typographic-quote input before parsing
- `PasteModal` renders the four-state UI (empty/fen/pgn/error), a White/Black side selector defaulting to White (D-06) with a per-name-truncating parsed-header meta line, and a secondary "Analyze full game" button (no-op click — Plan 03 wires the request) ahead of "Load" in DOM order
- Pasting a bare FEN seeds a free-play root through the same board API the `?fen=` URL-seeding effect uses — zero network requests, no `?fen=`/`?line=` write-back (D-03)
- Pasting a PGN loads its mainline at the parsed root, orients the board to the selected side, and renders ephemeral (unsaved) player info — names, ratings, and "Result · Date" in the always-null clock slot — without any saved game row existing
- 28 new automated tests (18 sniff-helper unit tests, 10 modal component tests) plus 9 new/updated `App.test.tsx` nav-surface assertions; full frontend suite (225 files, 3384 tests) green

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "paste a FEN on /analysis" — one path only** (tracer) - `3438dc272` (feat)
2. **Task 2: Expand the slice to PGN — mainline, headers, side selector, ephemeral player info** (tdd) - `9636804be` (test), `e1d6f9502` (feat)
3. **Task 3: Modal + nav test coverage, and the 375px / testid / type-floor sweep** - `0d606a92c` (test)

## Files Created/Modified

- `frontend/src/lib/pastedGame.ts` — `sniffPastedInput()`, `MAX_PASTED_INPUT_LENGTH`, `PasteParseResult`, `PastedGameHeaders`
- `frontend/src/lib/pastedGame.test.ts` — 18 unit tests (sniff outcomes, D-21 landmine, header coercion, RAV/NAG/comment dropping, non-ASCII round-trip, normalization, length cap, purity)
- `frontend/src/components/analysis/PasteModal.tsx` — the paste dialog: textarea, four-state machine, side selector, footer
- `frontend/src/components/analysis/__tests__/PasteModal.test.tsx` — 10 component tests through the rendered DOM
- `frontend/src/App.tsx` — `/analysis` added to `NAV_ITEMS` (last entry), `IMPORT_EXEMPT_ROUTES`, `isActive`; WR-07-style divergence comments on `NAV_ITEMS`/`BOTTOM_NAV_ITEMS`
- `frontend/src/App.test.tsx` — 4 pre-existing order/count assertions updated for the new nav entry, 1 rewritten to assert the intentional desktop/mobile-bottom-bar divergence, 1 new `describe.each` block (3 tests x 3 nav-lock states) for `/analysis` reachability
- `frontend/src/pages/Analysis.tsx` — Paste trigger in both the desktop `movesCard` header and the mobile/mid `movesTab` header (new), `handlePasteLoad`, `pastedHeaders` state, `showPlayerBars`/`playerBar` widened for the ephemeral-paste case, `formatPastedResultDate`
- `frontend/src/components/board/PlayerBar.tsx` — new optional `rightSlotContent` prop, rendered only when `clockSeconds` is null

## Decisions Made

- **Mirrored the move-list header trigger onto the mobile/mid Moves tab, not just desktop.** `movesCard` (the CardHeader the plan's Task 1 text names) is desktop-only per its own existing code comment ("movesCard is desktop-only — mid/mobile show the move tree in the Moves tab"). `movesTab` (the mid/mobile equivalent) had no header at all before this plan. Without adding one there, D-19's "mobile reachability verified... the header is visible" claim and UI-SPEC truth E1 ("at 375px the compact movelist CardHeader renders icon + label...") would both be false on mobile. Flagged as an open question at the Task 1 checkpoint; the coordinator approved keeping it exactly as implemented, citing E1 and CLAUDE.md's mobile-parity mandate.
- **Added `PlayerBar.rightSlotContent`** (not in Task 2's stated file list) so the ephemeral pasted game's `"{Result} · {Date}"` can reuse the freed clock slot per UI-SPEC § Interaction Contract 6, rather than opening new vertical space or synthesizing a fake `gameData` object.
- **Board orientation on paste is applied directly** (`setBoardFlipped(userColor === 'black')` inside `handlePasteLoad`), independent of the existing one-shot `autoOrientation` effect — a paste can happen more than once per session (D-20: the trigger stays visible in every mode), and the one-shot effect's `hasAutoFlipped` ref would silently ignore every paste after the first.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Mirrored the Paste trigger onto the mobile/mid Moves tab**
- **Found during:** Task 1
- **Issue:** The plan's Task 1 action text points only at desktop `movesCard`'s `CardHeader`, which is provably desktop-only (existing code comment). D-19/D-20 and UI-SPEC truth E1 both require the trigger reachable at 375px.
- **Fix:** Added a matching `CardHeader` (same `moveListHeaderContent`, same `data-testid="analysis-movelist-header"`/`"analysis-btn-paste"`) to the mobile/mid `movesTab` TabsContent, reusing the mutually-exclusive-render testid pattern this file already uses for `analysis-page`.
- **Files modified:** `frontend/src/pages/Analysis.tsx`
- **Verification:** `frontend/src/App.test.tsx` and `frontend/src/pages/__tests__/Analysis.test.tsx` unaffected/passing; manual reasoning confirmed only one of `movesCard`/`movesTab` mounts per layout branch, so the shared testid is safe.
- **Committed in:** `3438dc272` (Task 1 commit) — flagged at the Task 1 checkpoint, explicitly approved by the coordinator before Task 2 began.

**2. [Rule 2 - Missing critical functionality] Added `PlayerBar.rightSlotContent` prop**
- **Found during:** Task 2
- **Issue:** UI-SPEC § Interaction Contract 6 requires the ephemeral pasted game's Result/Date to render in `PlayerBar`'s freed clock slot; `PlayerBar`'s existing prop contract had no way to inject that content, and `PlayerBar.tsx` was not in Task 2's `<files>` list.
- **Fix:** Added an optional `rightSlotContent?: ReactNode` prop, rendered only when `clockSeconds === null` (a real game's clock always wins).
- **Files modified:** `frontend/src/components/board/PlayerBar.tsx`
- **Verification:** `frontend/src/components/board/__tests__/PlayerBar.test.tsx` (8 pre-existing tests) still green.
- **Committed in:** `e1d6f9502` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 2 — missing critical functionality the plan's own `<action>`/`<must_haves>` text required but under-specified the file boundary for)
**Impact on plan:** Both were necessary to satisfy this plan's own locked truths (E1, § Interaction Contract 6); no scope creep beyond what PASTE-08/PASTE-02 already demanded.

## Issues Encountered

- **TDD RED-phase tests passed immediately, not on the first run after implementation.** Task 2 is `tdd="true"`, but its `<action>` text for `pastedGame.ts` (full header population, coercion, RAV/NAG handling) was in substance already implemented by Task 1's tracer — the tracer built the complete sniff helper up front rather than a stub, since Task 1's own acceptance criteria already required PGN header extraction. The new `pastedGame.test.ts` assertions Task 2 calls for (RAV/NAG/comment dropping, missing-WhiteElo, unknown-date placemarker, headerless-movetext, non-ASCII round-trip) therefore passed against Task 1's code with zero new production changes — committed anyway as `test(208-01)` (`9636804be`) to preserve the gate-sequence shape (a `test(...)` commit before the `feat(...)` commit), with this note recorded per the TDD Gate Compliance guidance rather than silently treated as a pass. The GREEN-phase commit (`e1d6f9502`) carries the genuinely new code: `PasteModal`'s side selector/secondary button and `Analysis.tsx`'s ephemeral player-info wiring, neither of which existed before Task 2.
- **Task 3's directory-wide `text-xs` acceptance-criteria grep also matches pre-existing, CLAUDE.md-exempted files.** `grep -rc 'text-xs' frontend/src/components/analysis/` literally matches `EngineLines.tsx`, `FlawChessEngineLines.tsx`, `ProseSpan.tsx`, and `UnifiedMovePopover.tsx` — none touched by this plan, all carrying their own comments documenting the CLAUDE.md hover/tooltip `text-xs` exception. Interpreted the check as scoped to this plan's own files (matching the action text's "Fix anything the sweep finds in PasteModal.tsx / Analysis.tsx" instruction) — confirmed zero `text-xs` in `PasteModal.tsx` and its test file instead of touching unrelated pre-existing code out of scope.

## TDD Gate Compliance

Task 2 (`tdd="true"`) gate sequence: a `test(...)` commit (`9636804be`) exists before a `feat(...)` commit (`e1d6f9502`) — satisfies the mechanical gate-sequence check. **Caveat:** the RED-phase tests in that `test(...)` commit passed immediately against Task 1's already-complete `pastedGame.ts` implementation (see Issues Encountered above) — there was no observed test failure between the `test` and `feat` commits for that specific file. The `feat` commit's actual new code (`PasteModal.tsx` side selector/secondary button, `Analysis.tsx` ephemeral wiring) has no dedicated unit-test-first cycle in Task 2 by plan design — that coverage lands in Task 3's `PasteModal.test.tsx` (10 tests, all passing against the already-implemented code, since Task 3 is a plain `type="auto"` task, not TDD-flagged).

## Known Stubs

- **`PasteModal`'s "Analyze full game" button is a no-op click handler.** This is an INTENTIONAL, plan-documented stub: Task 2's `<action>` text explicitly states "In this plan the secondary button's click handler is not yet wired to a request — Plan 03 owns that; give it a no-op handler and leave it enabled." The button renders, is enabled, and carries the correct `data-testid`/variant/copy — only the `POST /imports/paste` + tier-1 enqueue wiring is deferred to Plan 03 (D-04/D-08).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `sniffPastedInput`, `PasteParseResult`, and `PastedGameHeaders` (all exported from `frontend/src/lib/pastedGame.ts`) are ready for Plan 03 to consume when wiring `handleAnalyzeFullGame`'s real request.
- `PasteModal`'s `onLoad(result, userColor)` signature already carries the `userColor` Plan 03's save request needs (`user_color` field) — no interface change anticipated there.
- No blockers for Plan 02 (backend `platform='pgn'` exclusion) or Plan 03 (persist + enqueue) — both are independent of this plan's frontend-only surface per the phase's Multi-Source Coverage Audit.
- The two UI-SPEC backstop truths (side-selector meta-line fit and result/date-slot fit at 375px with a realistically long name) remain `verification: backstop` per the plan — not assertable from unit tests, routed to human UAT (see coverage D1/D5 above).

---
*Phase: 208-analysis-fen-pgn-paste*
*Completed: 2026-08-08*

## Self-Check: PASSED

All 8 claimed created/modified files verified present on disk; all 4 claimed commit hashes (`3438dc272`, `9636804be`, `e1d6f9502`, `0d606a92c`) verified present in `git log`.
