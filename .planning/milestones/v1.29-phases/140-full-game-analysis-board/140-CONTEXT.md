# Phase 140: Full-Game Analysis Board - Context

**Gathered:** 2026-06-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Refine the existing v1.29 `/analysis` board (Phases 136–139, already shipped) into a
full-game analysis board:

- Collapse the game-card and flaw-card entry points into a single page-opening **Analyze**
  button that loads the whole game at `/analysis?game_id=X&ply=Y`.
- Relocate the `EvalChart` (with slider) below the board; slider scrubs the main game line
  and parks at the fork when a sideline is active.
- Move list height matched to the board; board controls below the move list.
- Inline missed/allowed tactic tags in the move list that expand stored PVs as navigable
  sidelines (two-level nesting: game line → PV line → PV sub-sideline).
- `TacticModeOverlay` becomes contextual (driven by the active PV node, not URL at load).
- No new backend schema/endpoints (milestone D-4); mobile has a stacked equivalent.

**This phase is unusually pre-decided.** The behavioral/architectural decisions are locked in
`.planning/notes/analysis-board-fullgame-refinement.md` and the visual/interaction contract is
locked in the approved `140-UI-SPEC.md`. The decisions below are the remaining edge cases that
those two documents did not cover, plus two explicit corrections to the UI-SPEC.

**Out of scope:** Openings "Analyze position" (`?fen=` free-play single position from Phase
138-03) stays as-is. No backend changes. No new analysis algorithms.

</domain>

<decisions>
## Implementation Decisions

### Expanded-PV state lifetime
- **D-01:** Expanding a PV sideline (or sub-sideline) from an inline tag is **ephemeral,
  in-memory** state. The URL carries only `game_id` + `ply`; a refresh returns to the collapsed
  main line. The expanded 2-level tree is NOT URL-encoded. (The `?fen=` free-play variation
  state remains URL-encoded as in Phase 137 — unchanged.)

### Move-list flaw markers
- **D-02:** Two distinct marker types in the move list:
  - **Tactic flaws** (`missed_tactic_motif` / `allowed_tactic_motif` set on the `FlawMarker`):
    render the inline **Missed / Allowed pill chip** per the UI-SPEC. Clicking expands the
    stored PV on-demand (`tactic-lines`) as a Level-1 sideline.
  - **Non-tactic blunder/mistake flaws** (severity `blunder` or `mistake`, no motif): render a
    **distinct blunder vs mistake icon** marker on the row. **Blunder and mistake are visually
    distinguished** (two treatments).
- **D-03:** **Inaccuracies get NO marker** — scope matches the existing `blunder | mistake`
  severity filter.
- **D-04:** The blunder/mistake icon has **no special click behavior**. Clicking anywhere on a
  move row navigates the board to that move like any move node (normal node-click). The icon is
  purely a visual severity marker. (Only the tactic pill chips have the expand-PV behavior.)

### Eval-chart slider sync
- **D-05:** Clicking a **main-line** move navigates the board, the move-list highlight, **and the
  eval-chart slider position** (three-way sync). On any **sideline** the slider parks at the fork
  ply, disabled/dimmed (`opacity-40`, tooltip "Return to main game line to scrub") per the
  UI-SPEC — re-enabled on returning to the main line.
  - **§-amendment (2026-08-05, `/gsd-fast`): the sideline parking is REVERSED.** The slider is now
    always enabled, and scrubbing from a sideline navigates the board to the scrubbed main-line
    ply. Two reasons: (1) `goToNode` only moves the current-node pointer, so the sideline survives
    in the variation tree and is one move-list click away — nothing is lost by scrubbing out of it;
    (2) the disable was only half-enforced, because the mobile touch-scrub overlay
    (`EvalChart.tsx`) was never gated by `sliderDisabled`, so on a phone a sideline left the chart
    looking tappable while the parent silently swallowed every tap. The `sliderDisabled` prop and
    the "Return to main game line to scrub" tooltip are removed from `EvalChart` (no other caller
    used them). The fork-ply parking of `syncPly` (Quick 260627-mt8) is KEPT — it is still the
    correct resting position and now doubles as the natural start point for the drag. This
    supersedes the D-05 sentence above and the corresponding lines in 140-UI-SPEC.md
    (`Slider parked/dimmed` token row, copy table) and 140-VALIDATION.md.

### Unified Analyze button (CORRECTION to UI-SPEC)
- **D-06:** The page-opening **Analyze** button is shown on **analyzed games only**
  (`analysis_state === 'analyzed'`). It replaces the analyzed-card `Explore` + `Analyze position`
  pair (and the flaw-card `Explore` + `Game` modal pair). **Icon = `Search`** (lucide), not
  `Activity`. Opens `/analysis?game_id=X&ply=Y`.
- **D-07:** **Un-analyzed games keep the existing path unchanged** — the `Cpu`-icon "Analyze"
  button in `NoAnalysisState.tsx` (`btn-analyze-game-{gameId}`) that fires the tier-1 full-game
  analysis request. There is **no free-play fallback** for un-analyzed games via the new button.
- **D-08:** These two decisions **supersede** the UI-SPEC lines that say the Analyze button is
  "always enabled", uses the `Activity` icon, and "navigates to free-play mode" for un-analyzed
  games. The UI-SPEC's `data-testid` and copy ("Analyze" label, `aria-label="Analyze game"`) for
  the page-opening button still apply; only the icon, enable-condition, and un-analyzed behavior
  change. The planner should treat the UI-SPEC as authoritative **except** where D-06/D-07
  override it.

### Game modal deletion
- **D-09:** The flaw-card `Game` modal path is deleted entirely (Dialog/Drawer + inline
  `LibraryGameCard` + `useLibraryGame` + related imports), per the UI-SPEC and refinement note.

### Claude's Discretion
- **On-demand PV fetch UX:** The exact loading/error affordance when clicking a tactic pill chip
  (spinner-on-chip vs other) is left to the planner. Requirement: a loading state must be shown
  during the `tactic-lines` fetch, and the error/empty case must follow the CLAUDE.md `isError`
  pattern, surfacing the existing copy "Tactic line not available for this flaw."
- **Blunder vs mistake icon glyph/color:** the specific icons/colors are the planner's call,
  drawn from `theme.ts` semantic colors (never hard-coded). Two visually distinct treatments.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source of truth (locked decisions)
- `.planning/notes/analysis-board-fullgame-refinement.md` — locked behavioral/architectural
  decisions (entry consolidation, loading model, layout, slider behavior, 2-level nesting,
  contextual overlay, key files, hardest parts).
- `.planning/phases/140-full-game-analysis-board/140-UI-SPEC.md` — approved visual/interaction
  contract (layout, colors, inline chip spec, testids, copy, mobile stacking). **Authoritative
  EXCEPT where D-06/D-07/D-08 above override it** (Analyze button icon/enable-condition/un-analyzed
  behavior).

### Requirements / roadmap
- `.planning/ROADMAP.md` Phase 140 — goal + 5 success criteria.
- `.planning/REQUIREMENTS.md` D-4 — no schema, no migration, no new backend endpoints; analysis
  state lives in the URL.

### Key code files (from the refinement note)
- `frontend/src/pages/Analysis.tsx` — page shell, URL parsing, mode wiring.
- `frontend/src/hooks/useAnalysisBoard.ts` — branching move tree (needs 2-level nesting).
- `frontend/src/components/analysis/VariationTree.tsx` — move list (inline tags + nesting + markers).
- `frontend/src/components/analysis/TacticModeOverlay.tsx` — contextual activation.
- `frontend/src/components/library/EvalChart.tsx` — relocated below board (reused unmodified).
- `frontend/src/components/results/LibraryGameCard.tsx` — unified `Analyze` button (analyzed card).
- `frontend/src/components/library/FlawCard.tsx` — unified `Analyze`, drop `Game` modal.
- `frontend/src/components/library/NoAnalysisState.tsx` — existing un-analyzed `Cpu` Analyze
  button (UNCHANGED — D-07).
- `frontend/src/lib/analysisUrl.ts` — add `?game_id&ply` builder.
- `frontend/src/hooks/useLibrary.ts` — `useTacticLines` (per-tag PV fetch), `FlawMarker` shape.
- `frontend/src/types/library.ts` — `FlawMarker` (`severity`, `missed/allowed_tactic_motif`),
  `FlawSeverity = 'inaccuracy' | 'mistake' | 'blunder'`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `EvalChart` (`components/library/EvalChart.tsx`): reused unmodified on the analysis page;
  also stays in `LibraryGameCard` as the inline preview + ply selector that seeds the Analyze URL.
- `NoAnalysisState.tsx`: already provides the un-analyzed `Cpu` Analyze (request-analysis) button
  — D-07 means it is untouched.
- `TacticModeOverlay` (Phase 139): exports `buildRootArrows` / `buildPvArrow`; reused, only the
  show/hide condition becomes contextual.
- `useTacticLines` (`useLibrary.ts`): per-flaw stored-PV fetch, keyed by `game_id/ply`.

### Established Patterns
- `analysis_state === 'analyzed'` gates analyzed-vs-unanalyzed card rendering (LibraryGameCard,
  LibraryGameCardList) — the gate for showing the new Search Analyze button (D-06).
- `FlawMarker` already distinguishes severity and tactic motifs — no backend change needed to
  drive D-02 markers.
- Semantic colors live in `theme.ts` (`TAC_MISSED`/`TAC_ALLOWED`, etc.); never hard-code.
- `isError` ternary branch pattern (CLAUDE.md) for the on-demand PV fetch failure.

### Integration Points
- New data dependency for `/analysis`: a game-by-id fetch (moves, `eval_series`, `flaw_markers`,
  `phase_transitions`) — reuse the existing hook/endpoint `LibraryGameCard` already uses; no new
  backend (D-4).
- `useAnalysisBoard` must NOT modify `useChessGame.ts` (independent hook, different contract).

</code_context>

<specifics>
## Specific Ideas

- Layout follows the chess.com / lichess convention: board left, eval chart with slider directly
  below it, move list right at board height, controls below the move list.
- Source separation (lichess-like): the eval chart shows the game's **stored** per-ply evals; the
  live WASM engine (EvalBar + EngineLines) covers the **current** node. The slider parks (does
  not scrub the sideline) so the two sources never conflict.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. (Openings `?fen=` free-play and the backward-compat
`?game_id&flaw_ply` tactic-only URL are explicitly out of scope / unchanged, not deferred ideas.)

</deferred>

---

*Phase: 140-full-game-analysis-board*
*Context gathered: 2026-06-27*
