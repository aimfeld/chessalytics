---
phase: 200
slug: train-solve-screen-board-legend-inline-sideline-exploration
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
# No Wave 0 scaffold is required — the vitest infrastructure and every consumed test file
# either already exists or is created test-first by its own tdd="true" task.
wave_0_complete: true
created: 2026-08-01
---

# Phase 200 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

This phase is frontend-only. Every task lives in the `frontend/` workspace; no backend
test, migration, or pytest run is in scope.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.7 + @testing-library/react, jsdom 29 |
| **Config file** | none dedicated — vitest reads `frontend/vite.config.ts`; each test file opts into the DOM with a `// @vitest-environment jsdom` docblock |
| **Quick run command** | `cd frontend && npx vitest run <path…>` (single or few files) |
| **Full suite command** | `cd frontend && npm test -- --run` (`npm test` is already `vitest run`; the extra `--run` the plans author is redundant but harmless) |
| **Estimated runtime** | quick ~3s · full suite ~25s (measured 2026-08-01: 205 files / 2975 tests, 24.6s wall) |

**Type checking is a separate gate.** `npm run lint` and `npm test` do NOT type-check —
Vite/vitest strip types with esbuild. `cd frontend && npm run build` (`tsc -b && vite build`)
is the only tsc gate, and it is mandatory in this phase: 200-03 task 1 widens the shared
`TrainLineStep` / `TrainRevealStep` interfaces with `prefixUci`, and 200-01/200-02/200-04
change `TrainLineStepperProps`, `TrainRevealOverlay` and `TrainRevealProps`. Every plan
already carries `npm run build` in its acceptance criteria. `npm run knip` (dead
exports/deps) is likewise in CI and is gated per-task where props or imports are removed.

---

## Sampling Rate

- **After every task commit:** the task's own `<automated>` command (the quick run in the map below) — ~2-3s
- **After every plan wave:** `cd frontend && npx vitest run src/lib/__tests__/trainArrows.test.ts src/components/train/__tests__/` plus `cd frontend && npm run lint && npm run build`
- **Before `/gsd-verify-work`:** `cd frontend && npm test -- --run` green, plus `npm run lint && npm run knip && npm run build`
- **Max feedback latency:** ~5 seconds (heaviest per-task command measured at 3.2s wall — `trainArrows` + `TrainReveal` + `TrainSolveScreen`, 82 tests)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 200-01-01 | 01 | 1 | LEGEND-01, LEGEND-02, LEGEND-05 | T-200-01 | Engine-derived SAN reaches the glyph button's `aria-label` and the box title as React children/attributes only; no `dangerouslySetInnerHTML` | unit + component (tracer, TDD) | `cd frontend && npx vitest run src/lib/__tests__/trainArrows.test.ts src/components/train/__tests__/TrainSolveScreen.test.tsx` | ✅ | ⬜ pending |
| 200-01-02 | 01 | 1 | LEGEND-01 | T-200-01 | `CardHeader` renders `box.title` and the eval label as React children (auto-escaped) | component | `cd frontend && npx vitest run src/components/train/__tests__/TrainLineStepper.test.tsx src/components/train/__tests__/TrainReveal.test.tsx src/components/train/__tests__/TrainSolveScreen.test.tsx` | ✅ | ⬜ pending |
| 200-01-03 | 01 | 1 | LEGEND-02, LEGEND-06 | T-200-02 | The document-level `pointerdown` tap-away listener is registered only while `!isDesktop && spotlightKey !== null` and always removed in the effect cleanup | component | `cd frontend && npx vitest run src/components/train/__tests__/TrainReveal.test.tsx src/components/train/__tests__/TrainSolveScreen.test.tsx` | ✅ | ⬜ pending |
| 200-02-01 | 02 | 2 | LEGEND-03, LEGEND-05 | T-200-06 | The inaccuracy→good collapse is presentation-only: `classifyTrainMoveQuality`, `classifyLiveSeverity` and the `move_quality` POSTed to `solvePuzzle` are untouched | unit (TDD) | `cd frontend && npx vitest run src/lib/__tests__/trainArrows.test.ts` | ✅ | ⬜ pending |
| 200-02-02 | 02 | 2 | LEGEND-04, LEGEND-01, LEGEND-05, LEGEND-06 | T-200-04, T-200-05 | Also-fine SAN tokens render as React children; the row mounts only behind the existing `showResultRow` / `verdictLanded` gate | unit + component (TDD) | `cd frontend && npx vitest run src/lib/__tests__/trainArrows.test.ts src/components/train/__tests__/TrainReveal.test.tsx src/components/train/__tests__/TrainSolveScreen.test.tsx` | ✅ | ⬜ pending |
| 200-03-01 | 03 | 3 | EXPLORE-02 | — | N/A — pure interface widening (`prefixUci` on both step types) | component (TDD) | `cd frontend && npx vitest run src/components/train/__tests__/TrainLineStepper.test.tsx` | ✅ | ⬜ pending |
| 200-03-02 | 03 | 3 | EXPLORE-01, EXPLORE-02, EXPLORE-04 | T-200-10 | An exploration drop never calls `gradeMove`, `solvePuzzle` or `setMoveApplied` — gated by the "exactly one `solvePuzzle` call across two exploration drops" test | hook + component (TDD) | `cd frontend && npx vitest run src/hooks/__tests__/useTrainExploration.test.ts src/components/train/__tests__/TrainSolveScreen.test.tsx` | ❌ → `useTrainExploration.test.ts` created test-first by this TDD task | ⬜ pending |
| 200-03-03 | 03 | 3 | EXPLORE-03 (board half), EXPLORE-05, EXPLORE-06 | T-200-07, T-200-08 | `explorationFen` is `puzzle.fen` replayed through chess.js-validated moves, never user text; exactly one exploration Worker exists and every exit path terminates it | component | `cd frontend && npx vitest run src/components/train/__tests__/TrainSolveScreen.test.tsx` | ✅ | ⬜ pending |
| 200-04-01 | 04 | 4 | EXPLORE-03 | T-200-11 | SAN tokens render as React children; a malformed UCI breaks the replay loop instead of throwing | component (TDD) | `cd frontend && npx vitest run src/components/train/__tests__/TrainExplorationLine.test.tsx` | ❌ → `TrainExplorationLine.test.tsx` created test-first by this TDD task | ⬜ pending |
| 200-04-02 | 04 | 4 | EXPLORE-03 | T-200-12 | Engine-supplied PV UCIs are replayed through `playLine`'s `try/catch`, which truncates the chain on the first illegal move rather than corrupting board state | component | `cd frontend && npx vitest run src/components/train/__tests__/TrainReveal.test.tsx src/components/train/__tests__/TrainSolveScreen.test.tsx` | ✅ | ⬜ pending |
| (end-of-phase) | 04 | — | EXPLORE-07, LEGEND-06 | — | N/A — operator browser pass, no code | manual, **non-blocking** (see Manual-Only Verifications) | — | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Sampling continuity:** every one of the 10 executable tasks carries an `<automated>`
command, so there is no window of three consecutive tasks lacking automated feedback. The
375px browser pass is not a task — by the user's plan-time decision it is a non-blocking
end-of-phase item in `200-04-PLAN.md`, run before the squash-merge rather than pausing
execution. Both plan-04 tasks are therefore autonomous.

---

## Wave 0 Requirements

**Existing infrastructure covers all phase requirements.** vitest + @testing-library/react +
jsdom are installed and in CI; `src/lib/__tests__/trainArrows.test.ts`,
`src/components/train/__tests__/TrainReveal.test.tsx`,
`src/components/train/__tests__/TrainSolveScreen.test.tsx` and
`src/components/train/__tests__/TrainLineStepper.test.tsx` all already exist and are green
(measured 2026-08-01). No framework install, no shared fixture file, and no stub scaffold
is needed.

Two test files do not exist yet, and neither is a Wave 0 dependency — each is created
test-first inside the `tdd="true"` task that consumes it, so the RED step is the file's
first commit:

- [ ] `frontend/src/hooks/__tests__/useTrainExploration.test.ts` — created by 200-03 task 2 (EXPLORE-01/02/04)
- [ ] `frontend/src/components/train/__tests__/TrainExplorationLine.test.tsx` — created by 200-04 task 1 (EXPLORE-03)

One infrastructure note that is a per-task obligation rather than a Wave 0 one: there is no
global `matchMedia` stub in this project (each test file installs its own, per the
`Bots.test.tsx` L221 precedent). 200-01 task 3 installs it in `TrainReveal.test.tsx` and
`TrainSolveScreen.test.tsx`, and `useIsDesktop` is specified to return `false` when
`window.matchMedia` is absent so an unstubbed file renders the mobile path instead of
throwing.

---

## Manual-Only Verifications

All of these live in the **non-blocking** "Human Verification Required" section at the end of
`200-04-PLAN.md`. By the user's plan-time decision this browser pass does not gate execution:
it runs after the phase wraps and before the squash-merge, with its outcome recorded in
VERIFICATION.md. They are the residue jsdom structurally cannot measure: real pixel layout,
tap-target size, and hover feel. Their DOM-shaped halves are already automated in the map
above.

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The reveal sidebar, legend glyphs, Also-fine row and exploration swap all lay out correctly in the below-board column at exactly 375px, with no horizontal page scroll | EXPLORE-07, LEGEND-06 | jsdom has no layout engine — it reports zero-sized boxes and cannot detect overflow | Chrome DevTools device toolbar at width 375px; run the 200-04 browser-pass steps 13-14 (repeat the desktop walkthrough in the below-board layout; confirm the exploration engine card and move list fit the column and the move list scrolls horizontally on its own once the line is long) |
| Glyph tap targets are physically large enough to hit accurately on touch; tap toggles, tap-elsewhere clears, tap-another switches; nothing requires hover | LEGEND-06 | Tap-target size is a rendered-pixel property; `fireEvent.click` passes regardless of a 4px target | 200-04 browser-pass step 13, on the 375px viewport |
| Desktop hover feel: hovering a whole card spotlights it and the board responds without flicker; keyboard tab reaches the same state | LEGEND-02 | The state transition is asserted in jsdom; perceived responsiveness and flicker are not observable there | 200-04 browser-pass steps 5-6 at default desktop width |
| No yellow remains anywhere on the reveal surface for a played inaccuracy — arrow, corner badge, header glyph or step highlight — while the eval badge still discloses the drop | LEGEND-03 | The constants are unit-asserted, but "no yellow pixel reaches the screen" across four composited layers is a visual claim | 200-04 browser-pass step 7 (find or force an inaccuracy-graded puzzle) |
| The exploration card's Stockfish PV rows are legible at 375px with nothing clipped or overflowing, and render identically to the Analysis page's engine card | EXPLORE-03 (A-11) | Rendered font size and overflow after the Tailwind cascade are not observable in jsdom | 200-04 browser-pass step 15 on the 375px viewport. `EngineLines` is reused verbatim with its inherited `text-xs` scale (user-approved exception, `EngineLines.tsx:88-91`), so this is a readability/layout check, not a type-scale gate |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — all 10 executable tasks carry a concrete vitest command; there is no manual task (the 375px browser pass is a non-blocking end-of-phase item, not a task)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify — every one of the 10 tasks has automated feedback, so the constraint holds trivially
- [x] Wave 0 covers all MISSING references — there are no `MISSING` markers; the two not-yet-existing test files are created test-first inside their own `tdd="true"` tasks
- [x] No watch-mode flags — every command is `npx vitest run …` or `npm test -- --run` (`npm test` = `vitest run`); `npm run test:watch` appears nowhere in the plan set
- [x] Feedback latency < 5s — measured: 2.3s for the heaviest per-task command, 3.2s wall including npx startup
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
