# Phase 215: Frontend God-File Decomposition - Pattern Map

**Mapped:** 2026-09-03
**Files analyzed:** ~15 new/modified files (4 god files + their expected extraction targets +
tooling config/docs)
**Analogs found:** 14 / 15 (one, the sonarjs npm script, has no analog since nothing like it
exists yet — documented under "No Analog Found")

## File Classification

| New/Modified File (expected) | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/hooks/analysis/useAnalysisEngineLines.ts` (extracted from `Analysis.tsx`) | hook | transform (data-shaping) | `src/hooks/useFastForward.ts` | exact |
| `src/hooks/analysis/useAnalysisRouteSeeding.ts` (extracted) | hook | event-driven (effects reacting to URL) | `src/hooks/useLiveMoveFlaw.ts` (memo-shaped) + inline `useAnalysisLayoutMode` (effect-shaped, `Analysis.tsx:292`) | role-match |
| `src/hooks/analysis/useAnalysisGemMarkers.ts` (extracted) | hook | transform | `src/hooks/useGemSweep.ts` | exact |
| `src/hooks/analysis/useAnalysisBoardArrows.ts` (extracted) | hook | transform | `src/hooks/useLiveMoveFlaw.ts` | exact |
| `src/components/analysis/PlayerBar.tsx` (extracted, non-hook helper) | component | request-response (pure render) | existing `src/components/analysis/*` files (already `react-refresh/only-export-components: off`) | exact (directory override already covers it) |
| `src/hooks/useBotGameClock.ts` (extracted from `useBotGame.ts`) | hook | event-driven (timers/refs) | `src/hooks/useFastForward.ts` (ref + interval pattern) | role-match |
| `src/hooks/useBotGameEngineDispatch.ts` (extracted) | hook | event-driven (worker dispatch) | `src/hooks/useFlawChessEngine.ts` | exact |
| `src/hooks/useBotGameSnapshot.ts` (extracted) | hook | transform / persistence | `src/lib/botGameSnapshot.ts` (already pure, tested) + `src/hooks/useStoreBotGame.ts` | exact |
| `src/hooks/useBotGameDrawOffer.ts` (extracted) | hook | event-driven | `src/hooks/useFastForward.ts` (small self-contained state hook) | role-match |
| `src/lib/engine/workerPoolWatchdog.ts` (extracted from `workerPool.ts`) | utility (closure-factory stage) | event-driven (timers over shared state) | `src/lib/engine/maiaQueue.ts` | exact (closure-factory-over-shared-state shape) |
| `src/lib/engine/workerPoolDispatch.ts` (extracted) | utility | event-driven (message parsing) | `src/lib/engine/maiaQueue.ts` | exact |
| `src/lib/engine/workerPoolLifecycle.ts` (extracted) | utility | event-driven (spawn/respawn) | `src/lib/engine/maiaWorkerHost.ts` | exact |
| `src/components/openings/OpeningsDesktopSidebar.tsx` (extracted from `Openings.tsx`) | component | request-response | `src/pages/openings/StatsTab.tsx` | exact |
| `src/components/openings/OpeningsMobileDrawers.tsx` (extracted) | component | request-response | `src/pages/openings/StatsTab.tsx` | exact |
| `src/hooks/openings/useOpeningsChartData.ts` (extracted) | hook | transform | `src/pages/openings/useOpeningsHandlers.ts` (data/handler hook already in this exact directory) | exact |
| `src/pages/__tests__/Openings.render.test.tsx` (new characterization test) | test | request-response (render) | `src/pages/__tests__/Analysis.test.tsx` | exact |
| `frontend/eslint.config.js` (baseline override block, modified) | config | — | existing 3 `files:[...]/rules:{...}` blocks in the same file | exact |
| `frontend/package.json` (`lint:cognitive` script, modified) | config | — | existing `"lint": "eslint ."` script | exact |
| `docs/dev-tooling.md` (new frontend tooling entries) | config/docs | — | existing `check_function_size.py`/`complexipy` entries (lines 17-19) | exact |

## Pattern Assignments

### Extracted `useXyzData` hooks (Analysis.tsx clusters)

**Analog:** `frontend/src/hooks/useFastForward.ts`

**File header / JSDoc convention** (lines 1-17):
```typescript
/**
 * useFastForward — animated replay to the next notable main-line ply
 * (Quick 260831-s4y).
 *
 * Single directional command (D-03: no rewind counterpart). ...
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeId } from '@/hooks/useAnalysisBoard';
```
Every extracted hook must open with a docblock naming what it does, WHY it's a separate hook
(not folded into the caller), and cross-references to the phase/decision that shaped it — this
convention is universal across `hooks/*.ts` in this codebase, not optional boilerplate.

**Options-object + named-return-interface convention** (lines 34-90, `UseFastForwardOptions`):
```typescript
export interface UseFastForwardOptions {
  enabled: boolean;
  mainLine: readonly NodeId[];
  currentNodeId: NodeId | null;
  currentPly: number | null;
  stopPlies: ReadonlySet<number>;
  goToNode: (id: NodeId) => void;
  onRunStateChange: (running: boolean) => void; // callback escape hatch, not returned state
}
```
Each cluster hook this phase extracts (`useAnalysisEngineLines`, `useAnalysisGemMarkers`,
`useAnalysisBoardArrows`) should take a single typed `options` object (all the cluster's reads)
and return either a typed result object or, per `useBotGame.ts`'s convention below, a named
interface — never a bare positional-args signature. Comments should explain WHY a value is
passed as a callback vs. returned state when call-order constraints force it (see the
`onRunStateChange` comment in the real file, lines ~57-64, explaining hook-ordering).

**Constants extracted to named module-level consts with justification comments** (lines 22-33):
```typescript
const FAST_FORWARD_STEP_MS = ...;
export const FAST_FORWARD_ANIMATION_MS = FAST_FORWARD_STEP_MS - FAST_FORWARD_ANIMATION_HEADROOM_MS;
```
Matches CLAUDE.md's "no magic numbers" rule — every extracted hook's tunable constant gets a
name and a comment explaining the derivation, not a bare literal.

---

### Extracted URL/effect-seeding hook (Analysis route-param cluster)

**Analog:** `frontend/src/pages/Analysis.tsx:292-312` (`useAnalysisLayoutMode`, currently a
LOCAL, non-exported function inside `Analysis.tsx` — the exact shape to promote to a sibling
file for the route-seeding cluster):
```typescript
function useAnalysisLayoutMode(): AnalysisLayoutMode {
  const compute = (): AnalysisLayoutMode => { ... };
  const [mode, setMode] = useState<AnalysisLayoutMode>(compute);
  useEffect(() => {
    const mqMobile = window.matchMedia(...);
    const mqMid = window.matchMedia(...);
    const update = () => setMode(compute());
    mqMobile.addEventListener('change', update);
    mqMid.addEventListener('change', update);
    return () => {
      mqMobile.removeEventListener('change', update);
      mqMid.removeEventListener('change', update);
    };
  }, []);
  return mode;
}
```
Pattern: a plain function (not exported, not `.tsx`) computing initial state via a lazy
`useState` initializer, syncing via one effect with matching cleanup. The route-seeding
extraction (13 `useEffect`s including the 6 with pre-existing `eslint-disable-next-line
react-hooks/exhaustive-deps` comments) must move each effect body AND its disable comment as an
atomic unit — see Shared Patterns below.

---

### Extracted transform hooks (gem-sweep / board-arrows)

**Analog:** `frontend/src/hooks/useGemSweep.ts` (JSDoc header lines 1-40) and
`frontend/src/hooks/useLiveMoveFlaw.ts` (lines 1-40, full file is small — a `useMemo`-based
pure transform hook)

**Core pattern** (`useLiveMoveFlaw.ts`, memo-shaped hook):
```typescript
import { useMemo } from 'react';
import type { SquareMarker } from '@/components/board/ChessBoard';
import { classifyLiveSeverity, evalToExpectedScore, sideToMoveFromFen } from '@/lib/liveFlaw';

const MOVE_HIGHLIGHT_SEVERITY: Record<FlawSeverity, string> = { ... };

export interface LiveMoveFlaw {
  squareMarkers: SquareMarker[];
  lastMoveHighlightColor: string | undefined;
}
```
This is the template for `useAnalysisGemMarkers`/`useAnalysisBoardArrows`: pure derivation from
already-computed inputs (engine results, node state) via `useMemo`, returning a small typed
interface, no internal `useState`/`useEffect` of its own when the transform is pure. Contrast
with `useGemSweep.ts`, which DOES own effects/state because it drives its own dedicated engine
hook calls — use that shape only if the extracted cluster genuinely needs its own engine
instance (per research: gem-sweep cluster does not need this, since `Analysis.tsx` already runs
the grading engine and just needs the resolved values reshaped).

---

### `useBotGame.ts` extracted stateful sub-hooks (clock, engine dispatch, snapshot, draw offer)

**Analog for engine-dispatch cluster:** `frontend/src/hooks/useFlawChessEngine.ts`

**Imports pattern** (lines 17-23):
```typescript
import { useRef, useState, useCallback, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { mctsSearch } from '@/lib/engine/mctsSearch';
import { createWorkerPool, computePoolSize, type WorkerPool } from '@/lib/engine/workerPool';
import { createMaiaQueue, type MaiaQueue } from '@/lib/engine/maiaQueue';
import { DEFAULT_POLICY_TEMPERATURE } from '@/lib/engine/policyTemperature';
import type { EngineSnapshot, SearchBudget, EngineProviders, RankedLine } from '@/lib/engine/types';
```
`useBotGameEngineDispatch` must import `createWorkerPool`/`createMaiaQueue` from the SAME
paths `useFlawChessEngine.ts` uses — these are the exact `vi.mock('@/lib/engine/workerPool')`
targets; do not introduce a re-derived or aliased import path (see Shared Patterns: vi.mock
path survival).

**Error handling** — Sentry capture inside a hook effect (grep confirms `useFlawChessEngine.ts`
calls `Sentry.captureException` on abort/spawn failure paths); every extracted `useBotGame.ts`
sub-hook that owns a `try/catch` around an engine call must preserve the existing
`Sentry.captureException` call site verbatim (do not drop it during the move — this is exactly
the "manual fetch/catch must call Sentry" rule in `frontend/CLAUDE.md`).

**Analog for the persistence/snapshot cluster:** `frontend/src/lib/botGameSnapshot.ts` (already
a pure, tested module) + `frontend/src/hooks/useStoreBotGame.ts` — `useBotGameSnapshot` should
be a thin hook-level orchestration wrapper calling these existing pure functions, matching how
`useFlawChessEngine.ts` wraps `mctsSearch` (a pure function) in hook-level state/effect glue.

**Ref-indirection pattern to preserve** (Pitfall 4 from RESEARCH.md) — `useBotGame.ts` line
~564, `runBotTurnRef.current = runBotTurn`, is the "always call the latest closure" idiom.
Grep `frontend/src/hooks/useBotGame.ts` for `Ref\.current = ` before splitting `runBotTurn` out
into `useBotGameEngineDispatch` — any effect/callback currently reading `runBotTurnRef.current`
must keep reading through the ref, not the extracted hook's return value directly.

---

### `workerPool.ts` closure-factory stage extraction

**Analog:** `frontend/src/lib/engine/maiaQueue.ts` (closure/module-level state, not a React
hook — matches the target shape of `workerPoolWatchdog.ts`/`workerPoolDispatch.ts`/
`workerPoolLifecycle.ts`) and `frontend/src/lib/engine/maiaWorkerHost.ts` for the
spawn/respawn/lifecycle stage specifically (its docstring explicitly frames itself as the
"singleton that owns Worker spawn/respawn/death").

**Imports/header pattern** (`maiaQueue.ts` lines 1-45, extensive JSDoc explaining WHY this is
a plain module and not a hook — "Not a React hook — plain module, no UI wiring"):
```typescript
import * as Sentry from '@sentry/react';
import { maskAndSoftmaxUci } from '@/lib/maiaEncoding';
import { acquireMaiaWorker } from './maiaWorkerHost';
import type { MaiaAnalyzeResult, MaiaWorkerLease } from './maiaWorkerHost';
```

**Explicit-state-object pattern (the RESEARCH.md-recommended shape for `workerPool.ts`'s
split)**: each extracted stage module (`workerPoolWatchdog.ts` etc.) should export functions
taking an explicit state parameter (e.g. `PoolState` bundling `slots`/`pending`/`gradeCache`)
as their first argument — mirroring how `maiaQueue.ts`'s functions close over/pass explicit
queue state rather than hidden globals, and matching Phase 214's own `eval_apply.py::
_classify_and_fill_oracle` precedent (backend twin, same "pipeline stage functions over one
explicit state object" seam). Per RESEARCH.md: this state object legitimately has more than
3 fields and multiple readers, so it does NOT trip the "no context object with <3 fields and
one reader" anti-pattern the ROADMAP forbids.

**Public API surface that must NOT move** (verified `vi.mock` consumers): `createWorkerPool`,
`isLowPowerDevice`, `computePoolSize` stay top-level exports of `workerPool.ts` itself — only
the 18 UNEXPORTED internal closures move to sibling files, called from inside
`createWorkerPool`'s body. See Shared Patterns for the exact `vi.mock` factory shapes this
constrains.

**Test double convention (for any new characterization tests added, not a full rewrite)**:
`frontend/src/lib/engine/__tests__/workerPool.test.ts` lines 1-70 — `vi.stubGlobal('Worker', ...)`
with a hand-rolled `MockWorker` class (`postMessage`/`terminate`/`simulateMessage`/
`simulateError`) and a `syncThenable<T>()` helper making `ensureStockfishWorkerUrl().then(...)`
resolve synchronously so assertions right after `pool.grade()`/`pool.warm()` need no `await`.
Any new test for a moved closure (e.g. `handleLine`'s branches) extends THIS file using these
existing helpers — do not hand-roll a second `MockWorker`.

---

### `Openings.tsx` extracted sidebar/drawer components

**Analog:** `frontend/src/pages/openings/StatsTab.tsx`

**Imports pattern** (lines 1-16):
```typescript
import { BookMarked, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoPopover } from '@/components/ui/info-popover';
import { LoadError } from '@/components/ui/load-error';
import { OpeningStatsSection, type OpeningStatsSectionDescriptor } from '@/components/stats/OpeningStatsSection';
import { ScoreChart } from '@/components/charts/ScoreChart';
import { EVAL_BASELINE_PAWNS_WHITE, EVAL_BASELINE_PAWNS_BLACK } from '@/lib/openingStatsZones';
import { sanArrayToPgn } from '@/lib/pgn';
import type { OpeningWDL, MostPlayedOpeningsResponse, BookmarkPhaseEntryItem } from '@/types/stats';
```

**Props interface style** (lines 17-38): a single `type XxxProps = { ... }` object listing
every piece of derived state and every `onXxx` callback the extracted component needs — no
default exports of non-component values, matches `react-refresh/only-export-components`
requirements for `.tsx` files outside the three overridden directories.

**Extraction-target sibling for shared handlers**: `frontend/src/pages/openings/
useOpeningsHandlers.ts` (lines 1-60) — ALREADY handles a chunk of the 14 handlers the seam map
lists (`handleOpenChartBookmarkGames`, `handleOpenGames`, `handleOpenMoves`, `handleOpenFinding`,
`handleOpenFindingGames`, `handleLoadBookmark`, `handleReorder`). Read this file's full export
list FIRST before deciding what remains to extract from `Openings.tsx` itself (RESEARCH.md Open
Question 1) — do not re-extract handlers already here. Its shape (a single `useOpeningsHandlers`
hook taking one `UseOpeningsHandlersParams` object, returning a named `OpeningsNavHandlers`
interface) is the template for any NEW handler-bundling hook this phase adds.

**Shared testid-suffix fragment pattern** (Pitfall 3 in RESEARCH.md — the desktop/mobile
`<FilterPanel>` duplication): parameterize the shared extraction by a `testIdSuffix` prop so
`filter-piece-filter` (desktop) and `filter-piece-filter-sidebar` (mobile) both survive from
ONE component. No existing analog in this codebase for a testid-suffix-parameterized shared
fragment — this is new pattern within the established props-interface convention above, not a
copy of an existing file.

---

### `Openings.render.test.tsx` — new render-level characterization test

**Analog:** `frontend/src/pages/__tests__/Analysis.test.tsx` (provider/router/query-mock setup,
lines 1-60+) — the ONLY full-page-render test analog in the codebase (`Openings.statsBoard.
test.tsx` deliberately avoids a full-page render, per its own header comment: "Full-page render
of Openings would require mocking 15+ hooks... making the test fragile").

**Provider wrapping pattern** (`Analysis.test.tsx` imports, lines 18-24):
```typescript
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
```
`Openings.render.test.tsx` needs the same `MemoryRouter` + `QueryClientProvider` +
`TooltipProvider` wrapper stack. Per `Openings.statsBoard.test.tsx`'s own comment, expect to
mock 15+ hooks (`useUserProfile`, `useNextMoves`, `useOpeningsPositionQuery`,
`usePositionBookmarks`, `useMostPlayedOpenings`, etc.) — budget for this being the largest
single new file this phase writes. Assert desktop-sidebar and mobile-drawer testid presence
(toggle viewport/matchMedia the same way `Analysis.tsx`'s own `useAnalysisLayoutMode` is
exercised, if any existing test stubs `matchMedia` — grep `Analysis.test.tsx` for
`matchMedia` before writing a new stub).

**Mock-state object convention** (`Analysis.test.tsx` lines 40-58): a single mutable
`engineState` object mutated per-test, referenced by a `vi.mock(...)` factory returning
getters over it — reuse this shape for any Openings query mocks rather than per-test
`vi.mocked(...).mockReturnValueOnce(...)` chains, for consistency with the existing large
test files.

---

### ESLint flat-config baseline override block (tooling plan)

**Analog:** `frontend/eslint.config.js`, three existing blocks (verbatim):
```js
{
  files: ['src/components/ui/**/*.{ts,tsx}'],
  rules: { 'react-refresh/only-export-components': 'off' },
},
{
  files: ['src/components/filters/**/*.{ts,tsx}'],
  rules: { 'react-refresh/only-export-components': 'off' },
},
{
  files: ['src/components/analysis/**/*.{ts,tsx}'],
  rules: { 'react-refresh/only-export-components': 'off' },
},
```
The tooling plan's baseline-ignore block for the 51 pre-existing `complexity` breaches follows
this exact shape: one new block, `files: [<51 paths>], rules: { complexity: 'off' }` (or
per-severity relaxation), placed after the existing three. Each file's own wave-2 plan deletes
its path from this array as its completion proof.

**Package.json script pattern** (`frontend/package.json`, existing `scripts` block):
```json
"lint": "eslint .",
```
`lint:cognitive` is a new sibling script, NOT folded into `lint` (per ROADMAP: report-only,
separate invocation): `"lint:cognitive": "eslint --config eslint.config.sonarjs.mjs ."` or
equivalent — follow the same flat, no-argument-passthrough style as the existing `lint` entry.

---

## Shared Patterns

### `vi.mock('@/lib/engine/workerPool', ...)` module-path survival
**Source:** `frontend/src/hooks/__tests__/useBotGame.test.ts:176`, `useFlawChessEngine.test.ts`
(~line 60), `useGemSweep.test.ts` (~line 100), `frontend/src/pages/__tests__/
Analysis.test.tsx:83`
**Apply to:** any plan touching `workerPool.ts`, `useBotGame.ts`, `Analysis.tsx`, `useGemSweep.ts`
```typescript
// useBotGame.test.ts:176
vi.mock('@/lib/engine/workerPool', () => ({ createWorkerPool: () => mockCreateWorkerPool() }));
// useFlawChessEngine.test.ts (~60)
vi.mock('@/lib/engine/workerPool', () => ({
  createWorkerPool: () => mockCreateWorkerPool(),
  computePoolSize: () => mockComputePoolSize(),
}));
// useGemSweep.test.ts / Analysis.test.tsx
vi.mock('@/lib/engine/workerPool', () => ({ isLowPowerDevice: () => lowPowerDevice /* or false */ }));
```
Rule: keep `createWorkerPool`/`isLowPowerDevice`/`computePoolSize` as top-level exports of
`workerPool.ts` itself (backed internally by calls into whatever sibling modules the 18
closures move to). Never relocate one of these three names to a sibling file without updating
all four mock factories in the SAME plan.

### `useEffect`/`useMemo`/`useCallback` dependency-array + disable-comment atomicity
**Source:** `frontend/src/pages/Analysis.tsx` lines 1057/1072/1083/1124/1154/2849 (disable
comments) paired with effects at 1058/1073/1084/1125/1155/2850
**Apply to:** every extracted hook from `Analysis.tsx`
```typescript
// eslint-disable-next-line react-hooks/exhaustive-deps -- <original reason, copied verbatim>
useEffect(() => { ... }, [/* same array, byte-identical */]);
```
Move the comment immediately above the effect it guards, in the same commit as the effect body.
The app-wide `react-hooks/exhaustive-deps` count (25) and `react-hooks/refs` count (3) are a
hard gate — verify via `npx eslint --no-inline-config -f json src` before/after each plan.

### `data-testid` / `data-umami-event` inventory identity
**Source:** frontend/CLAUDE.md "Browser Automation Rules" + ROADMAP Pitfall 3
**Apply to:** all four files
```bash
grep -o 'data-testid="[^"]*"' <file> | sort > before.txt   # capture pre-split
grep -o 'data-umami-event="[^"]*"' <file> | sort >> before.txt
# after the split, across ALL files the markup moved to:
grep -o 'data-testid="[^"]*"' src/pages/Openings.tsx src/components/openings/*.tsx | sort > after.txt
diff before.txt after.txt   # must be empty
```

### Sentry capture in extracted engine/effect code
**Source:** root `CLAUDE.md` "Error Handling & Sentry (backend)" section's frontend twin,
`frontend/CLAUDE.md` lines 19-26, and the real `Sentry.captureException` call sites already
present in `useFlawChessEngine.ts`/`workerPool.ts`
**Apply to:** `useBotGameEngineDispatch.ts`, `workerPoolWatchdog.ts`/`workerPoolDispatch.ts`/
`workerPoolLifecycle.ts`
```typescript
import * as Sentry from '@sentry/react';
// ...
} catch (error) {
  Sentry.captureException(error, { tags: { source: 'engine' } });
  // never drop this when moving the surrounding try/catch to a sibling file
}
```
Do NOT add a NEW `Sentry.captureException` inside a component that only uses TanStack Query —
`frontend/src/lib/queryClient.ts`'s global `QueryCache.onError` already covers that path
(`frontend/CLAUDE.md` line 23); this only applies to manual engine/worker error handling.

### Docs register for the tooling plan (backend twin)
**Source:** `docs/dev-tooling.md` lines 17-19 (backend `check_function_size.py`/`complexipy`
entries) and root `CLAUDE.md` lines 156-161 (function-size paragraph)
```markdown
- **`scripts/check_function_size.py`** — AST nesting-depth + logic-LOC gate (no ruff stable
  rule covers nesting depth; ...). `uv run python scripts/check_function_size.py app/
  --fail-over-depth 4 --fail-over-loc 200`; ...
- **`complexipy`** — Sonar cognitive-complexity metric ... not gated in CI ...
```
Write the frontend entries (`npm run lint`'s new `complexity`/`max-depth`/`max-statements`
rules; `npm run lint:cognitive`) immediately below these two, same terse register: name the
tool, the exact command, what it gates vs. reports-only, and why (the "ESLint already ships
stable rules, no custom-script gap" finding from RESEARCH.md's Don't-Hand-Roll table). Then add
one cross-reference sentence to each of `CLAUDE.md`'s function-size paragraph and
`frontend/CLAUDE.md`, mirroring how the backend line already points at `docs/dev-tooling.md`.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `frontend/eslint.config.sonarjs.mjs` (or equivalent `lint:cognitive` config wiring) | config | — | No prior eslint config in this repo adds a SEPARATE, non-gating config file behind its own script; the closest precedent is Phase 214's `complexipy` (a wholly separate Python tool, not an eslint plugin) — use RESEARCH.md's own verified scratch-config recipe (Architecture Patterns section) as the concrete starting point instead of a codebase analog. |

## Metadata

**Analog search scope:** `frontend/src/hooks/`, `frontend/src/hooks/__tests__/`,
`frontend/src/pages/openings/`, `frontend/src/pages/__tests__/`, `frontend/src/lib/engine/`,
`frontend/src/lib/engine/__tests__/`, `frontend/eslint.config.js`, `frontend/package.json`,
`docs/dev-tooling.md`, root `CLAUDE.md`, `frontend/CLAUDE.md`
**Files scanned:** ~25 read/grepped this session (see individual excerpts above); RESEARCH.md's
own structural surveys of the four in-scope files reused rather than re-read
**Pattern extraction date:** 2026-09-03

## PATTERN MAPPING COMPLETE

**Phase:** 215 - Frontend God-File Decomposition
**Files classified:** ~19 (4 god files + ~11 expected extraction targets + 1 new test file +
3 tooling/config/docs files)
**Analogs found:** 14 / 15 (one tooling-config file has no codebase analog, documented above)

### Coverage
- Files with exact analog: 12
- Files with role-match analog: 3
- Files with no analog: 1 (eslint sonarjs config — RESEARCH.md's own verified recipe substitutes)

### Key Patterns Identified
- Every extracted hook in this codebase opens with a JSDoc block explaining WHY it's separate
  (not just what it does), takes a single typed options object, and returns either a small
  typed interface (pure `useMemo`-shaped hooks like `useLiveMoveFlaw`) or a named exported
  interface (stateful hooks like `useBotGame`'s `UseBotGameState`) — never bare positional args.
- Closure-factories over shared mutable state (`workerPool.ts`) split into sibling plain-module
  files taking an explicit state object as their first parameter, mirroring
  `maiaQueue.ts`/`maiaWorkerHost.ts` and Phase 214's `eval_apply.py` backend precedent — never
  a class, never a second package directory.
- `vi.mock('@/lib/engine/workerPool', ...)` has FOUR different partial-shape consumers; the
  single highest-risk shared invariant across all wave-2 plans is keeping `createWorkerPool`/
  `isLowPowerDevice`/`computePoolSize` as top-level exports of the unchanged module path.
- `frontend/src/pages/openings/useOpeningsHandlers.ts` already owns a meaningful chunk of the
  handler cluster the RESEARCH.md seam map lists — read it before extracting anything new from
  `Openings.tsx`'s handler section.

### File Created
`/home/aimfeld/Projects/Python/flawchess/.planning/phases/215-frontend-god-file-decomposition/215-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. Planner can now reference analog patterns in PLAN.md files.
