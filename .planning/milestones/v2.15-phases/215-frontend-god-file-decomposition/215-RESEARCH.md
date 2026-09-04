# Phase 215: Frontend God-File Decomposition - Research

**Researched:** 2026-09-03
**Domain:** React 19 + TypeScript frontend refactoring — function-size/complexity remediation
with zero behavior change, plus a new eslint complexity gate (the frontend twin of Phase 214)
**Confidence:** HIGH (every numeric baseline below is a tool-verified measurement from this
session; the per-file seam maps are `[VERIFIED]` structural reads, not full line-by-line reads
of all 8,859 combined lines — flagged where a claim rests on a grep survey rather than a full
read)

## A load-bearing correction to the phase framing — `workerPool.ts` HAS a direct test file

The phase text (ROADMAP.md, reproduced in the task prompt) states, for `workerPool.ts`:
"**NONE** — every importer's test `vi.mock`s the module" and instructs its plan to "write
characterization tests for `createWorkerPool` ... BEFORE touching it." This is **incorrect**.
`[VERIFIED, this session]`:

```
$ find frontend/src/lib/engine/__tests__ -iname "workerPool*"
frontend/src/lib/engine/__tests__/workerPool.test.ts   (2,686 lines)
$ npx vitest run src/lib/engine/__tests__/workerPool.test.ts
Test Files  1 passed (1)
     Tests  109 passed (109)
```

This file directly imports and calls `createWorkerPool` from `../workerPool` (not mocked) 100+
times across `describe` blocks literally named `createWorkerPool: grade() dispatch`,
`createWorkerPool: watchdog (D-06)`, `createWorkerPool: grade cache (Phase 194 CACHE-01..04,
INJECT-05)`, `createWorkerPool: lifecycle`, `createWorkerPool: whenReady() (Phase 213 D-01)`,
`createWorkerPool: markPoolFailed`, `createWorkerPool: progressPort wiring`, and
`createWorkerPool: shared Stockfish wasm source` — i.e. dispatch order, watchdog re-arm/
respawn, grade cache, and the pool-ready promise are **already** the exact four things the
ROADMAP asks a from-scratch characterization test to cover. It fakes the global `Worker`
constructor via `vi.stubGlobal('Worker', ...)` with a hand-rolled `MockWorker` class
(`postMessage`/`terminate`/`simulateMessage`/`simulateError`), and fakes `MessageChannel` with
a synchronous `MockMessagePort` double — this IS the "how a Worker is faked here" analog the
research questions asked me to find (see Test Oracle section below); no separate analog file
needed.

**Consequence for planning:** `workerPool.ts` has the **strongest**, not the weakest, test
oracle among the four in-scope files (109 dedicated tests vs. 85 for `useBotGame.ts`/`Analysis`
and 16 for `Openings.tsx`'s untested-elsewhere sidebar/drawer). The ROADMAP's own ordering
principle — "wave 2 one plan per file in test-oracle-strength order" — therefore points to
`workerPool.ts` running **early**, not last as the ROADMAP's own "Expected shape" prose
suggests. The mandatory "characterization tests BEFORE touching it" step is largely already
satisfied; the planner's job is to read `workerPool.test.ts`'s existing `describe` blocks
against the 18-closure breakdown below and add tests only for closures/branches not already
covered (I did not enumerate a full coverage matrix this session — that is real remaining work,
just narrower than "write it all from scratch"). I checked whether this is a fluke duplicate
file or genuinely wired into the default `npm test` run: it has no `.skip`/`.only`, uses the
standard `// @vitest-environment jsdom` pragma, and `src/lib/engine/__tests__/` is not in any
`addopts`-style exclude list in `package.json`/`vite.config.ts` (there is no vitest exclude
config at all — see Environment section) — it runs by default.

## Summary

Four frontend modules (`Analysis.tsx` 4,370 lines, `useBotGame.ts` 1,662, `workerPool.ts`
1,451, `Openings.tsx` 1,376) breach CLAUDE.md's function-size rules — one god function each,
all confirmed today with a fresh eslint measurement matching the ROADMAP's own table exactly
except one count (see "Baseline — use this session's numbers" below). This is a pure structural
refactor: no rendered DOM, hook dependency array, engine message protocol, or TanStack query
key may change; existing vitest suites are the sole behavior oracle (any file may gain tests,
none may lose or weaken one). Unlike Phase 214 (backend, no visual surface), this phase changes
render trees for two pages, so it carries a HUMAN-UAT step the backend phase did not need.

The four files split along genuinely different seams. `Analysis.tsx`'s `Analysis()` (549-4370,
62 hooks) is a **data-then-render accumulator**: five clearly separable computation clusters
(engine setup, URL/route param seeding, engine-line reconciliation, gem-sweep/marker
resolution, board-arrow computation) feed one 585-line JSX return — extraction targets are
`useXyzData`-style hooks per cluster, exactly the seam CLAUDE.md names, and the ROADMAP's own
example path (`hooks/analysis/useAnalysisEngineLines.ts`) matches the reconciliation cluster
precisely. `useBotGame.ts`'s `useBotGame()` (506-1662) is a **stateful orchestrator**: clock/
timing, persistence/snapshot, bot-engine dispatch (the 112-logic-line/238-raw-line `runBotTurn`
arrow at 1366), move-commit, and draw-offer are five separable groups behind one
`UseBotGameState` return object (a named interface at line 223 — its field identity, not just
its shape, must survive). `workerPool.ts`'s `createWorkerPool()` (596-1442) is 18 closures over
three pieces of shared mutable state (`slots`, `pending`, `gradeCache`) — a **closure-factory**
that splits along its own already-comment-delimited stages (init/watchdog/dispatch/handleLine/
lifecycle), same shape as `eval_apply.py::_classify_and_fill_oracle` in Phase 214.
`Openings.tsx`'s `OpeningsPage()` (114-1376) is a **duplicated-markup** case: the desktop
sidebar (`SidebarLayout`, lines ~180-816) and the mobile drawer (`MobileFilterDrawer`, lines
~1220-1360+) each render an independent, near-identical `<FilterPanel>` block with duplicated
`ToggleGroup` piece-filter markup — the textbook case frontend/CLAUDE.md's "always apply
changes to mobile too... search for duplicated markup" rule is written for.

**Primary recommendation:** land the tooling plan first (eslint `complexity`/`max-depth`/
`max-statements` as `error`, not `warn` — `npm run lint` has no `--max-warnings 0` flag, so a
`warn`-severity rule never fails CI), then order the four file plans by test-oracle strength:
`useBotGame.ts` (167 tests across its 5 test modules) and `workerPool.ts` (109 tests, already
exists) can run in either order early; `Analysis.tsx` (85 tests, but a much larger/riskier
render-tree split) next; `Openings.tsx` (only 16 tests, and none touch the sidebar/drawer split
target at all) needs its own characterization test written from scratch and should run last or
with the most caution.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Analysis page data orchestration (`Analysis.tsx`) | Browser/Client (React component) | — | Pure client-side state/effect orchestration over already-fetched TanStack Query data and in-browser engine workers; no new SSR/API work |
| Bot-game session state (`useBotGame.ts`) | Browser/Client (hook) | — | Clock, move history, and engine dispatch all live in the browser tab; persistence goes through `useStoreBotGame`/`botPendingStore`, already separate modules this phase does not touch |
| Engine worker pool (`workerPool.ts`) | Browser/Client (Web Worker orchestration) | — | Manages `Worker` instances and UCI message dispatch entirely client-side; no server round-trip |
| Openings page data orchestration + render (`Openings.tsx`) | Browser/Client (React component) | — | Client-side filter/sidebar state over TanStack Query data; the split adds no new query, only reorganizes existing render/state code |

This phase touches only the Browser/Client tier — no SSR, CDN, or Backend/Database capability
is in scope (the backend twin was Phase 214). `App.tsx`, the next-tier god files
(`TrainReveal.tsx`, `EvalChart.tsx`, etc.), and every backend file are explicitly out of scope.

## Locked Decisions (from ROADMAP.md Phase 215 — no CONTEXT.md exists for this phase)

Per the task framing, no `/gsd-discuss-phase` was run for this phase; the ROADMAP.md phase
section (reproduced verbatim in the task prompt, and independently re-read from
`.planning/ROADMAP.md` this session — text matches exactly) is the locked-decision surface.
Key points the planner MUST honor verbatim (do not re-litigate):

- **Zero behavior change.** Rendered DOM (every `data-testid`, every `data-umami-event`), hook
  dependency arrays (including intentionally-missing deps — the `eslint-disable` comment moves
  with the code), the engine message protocol, and TanStack Query keys are unchanged. Existing
  tests are the oracle and pass untouched; tests may only be ADDED.
- **Split seams**: React components → extract data shaping into a `useXyzData` hook; split
  desktop/mobile renderers past ~40 LOC of logic each; handler arrows → named functions;
  closure factories → one function per stage. **NOT** "split to fit a signature": no context
  objects with fewer than three fields and one reader, no "handlers" hook bundling unrelated
  callbacks by shared deps.
- **In scope**: the four files above only. Moving cohesive hook/component groups into sibling
  files is the expected mechanism. Renaming the public entry points (`Analysis`, `OpeningsPage`,
  `useBotGame`, `createWorkerPool`) is NOT in scope.
- **Out of scope**: the next tier of large components (`TrainReveal.tsx`, `EvalChart.tsx`,
  `LibraryGameCard.tsx`, `TrainSolveScreen.tsx`, `VariationTree.tsx`, `App.tsx`); fixing any of
  the 28 pre-existing `react-hooks/*` warnings (a behavior change); any change to what the UI
  computes or renders, including "obvious" fixes spotted during the split (capture as seeds/
  quick tasks); backend files (done in Phase 214).
- **Depends on**: nothing — Phase 214 is squash-merged to `main` (`ccf783be8`) per `.planning/
  STATE.md`, `[VERIFIED, read this session]`.
- **Complexity tooling lands first** (wave 1): eslint core rules `complexity`/`max-depth`/
  `max-statements` in `npm run lint` (zero new deps); `eslint-plugin-sonarjs`'s
  `cognitive-complexity` behind a separate `npm run lint:cognitive` script (report-only, not
  gating CI yet); document both in `docs/dev-tooling.md`, reference from both CLAUDE.md files.
- **Gates per plan**: `npm run lint`, `npm run build` (`tsc -b` — lint/vitest do NOT
  type-check), `npm run knip`, and the file's own test-module subset green before/after; full
  frontend gate + backend gate at the phase's pre-merge gate. Extraction invariants (a)-(d) from
  the ROADMAP (dep arrays, `vi.mock` path survival, `react-refresh/only-export-components` file
  boundaries, testid/umami inventory identity) are hard constraints, not suggestions.
- **Oracle strengthening**: `workerPool.ts`'s plan should verify (not necessarily fully
  rewrite — see correction above) characterization coverage before touching it, with a mandatory
  two-way mutation proof. `Openings.tsx`'s plan MUST add a render-level characterization test
  (desktop + mobile, mocked queries, testid presence) before splitting the sidebar/drawer —
  this file's need for a NEW test is real; `workerPool.ts`'s is much smaller than framed.
- **Visual HUMAN-UAT** after each page plan (Analysis, Openings) — desktop + mobile width smoke,
  with the standing memory rule that the analysis board INTENTIONALLY shows opponent gems
  (position-scoped `best_move_tier`) — a split that "fixes" that is a regression, not a fix.

## Baseline — use this session's numbers, one discrepancy vs. the ROADMAP's "~35 files"

Reproduced the ROADMAP's own measurement command exactly (`eslint --no-inline-config --rule
'complexity: ["warn", 15]' --rule 'max-depth: ["warn", 4]' --rule 'max-statements: ["warn",
100]' --rule 'max-lines-per-function: ["warn", {"max": 200, "skipBlankLines": true,
"skipComments": true}]' -f json src`, excluding `.test.`/`__tests__` paths) `[VERIFIED: eslint
10.4.1, this session]`:

| Rule | Threshold | Non-test breaches | Distinct files | ROADMAP claim |
|------|-----------|-------------------:|----------------:|----------------|
| `complexity` | 15 | **68** | **51** | "68 functions in ~35 files" |
| `max-statements` | 100 | **1** (`Analysis`, 213 statements) | 1 | matches exactly |
| `max-depth` | 4 | **0** | 0 | matches exactly |
| `max-depth` | (all 6 hits are in `src/lib/__tests__/reminderSlotState.test.ts`, a test file) | — | — | — |
| `max-lines-per-function` | 200 | **32** | 32 | matches exactly |
| `max-lines-per-function` | 100 | **94** | — | matches exactly |

The 68-function count matches the ROADMAP exactly; the **51-file** count does not match its
"~35 files" — I get 51 distinct non-test files with at least one `complexity` breach (full list
captured this session, includes e.g. `App.tsx`, `VariationTree.tsx`, `TrainReveal.tsx`,
`EvalChart.tsx`, and the four in-scope files themselves). Use **68 functions / 51 files** as the
app-wide `complexity` baseline the tooling plan bakes into `pyproject.toml`'s frontend analog
(the `eslint.config.js` override block) — the ROADMAP's "~35" was hedged with a tilde and should
not be treated as exact.

Per-function detail for the four in-scope files `[VERIFIED, this session]` — exactly matches
the ROADMAP's own table:

```
src/hooks/useBotGame.ts:506       max-lines-per-function  'useBotGame' 544 lines (max 200)
src/lib/engine/workerPool.ts:596  max-lines-per-function  'createWorkerPool' 418 lines (max 200)
src/pages/Analysis.tsx:549        max-lines-per-function  'Analysis' 2037 lines (max 200)
src/pages/Analysis.tsx:549        max-statements          'Analysis' 213 statements (max 100)
src/pages/Analysis.tsx:549        complexity               'Analysis' complexity 176 (max 15)
src/pages/Analysis.tsx:1640       complexity               arrow fn complexity 16
src/pages/Analysis.tsx:2321       complexity               arrow fn complexity 19
src/pages/Analysis.tsx:2390       complexity               arrow fn complexity 27
src/pages/Analysis.tsx:3169       complexity               arrow fn complexity 18
src/pages/Analysis.tsx:3338       (not complexity-flagged — a plain non-hook render helper)
src/pages/Openings.tsx:114        max-lines-per-function  'OpeningsPage' 1088 lines (max 200)
src/pages/Openings.tsx:114        complexity               'OpeningsPage' complexity 64 (max 15)
```

`react-hooks/exhaustive-deps` app-wide: **25** non-test breaches across 12 files, 6 inside
`Analysis.tsx` (lines 1058, 1073, 1084, 1125, 1155, 2850 — matching disable comments one line
above at 1057, 1072, 1083, 1124, 1154, 2849 `[VERIFIED: grep, this session]`), 1 inside
`Openings.tsx` (line 232, `chartToggleVersion`, an *unnecessary*-dependency warning, not
missing). `react-hooks/refs`: 3, all in `App.tsx:840-842` (out of scope). Every number matches
the ROADMAP's table exactly except the file-count-for-`complexity` correction above.

**Cognitive complexity (sonarjs), measured this session — see Package Legitimacy Audit for how
this was run without touching a tracked file:**

| File | Cognitive-complexity breaches | Detail |
|------|-------------------------------:|--------|
| `Analysis.tsx` | 4 | line 549 (`Analysis`, 201 vs 15 — note: HIGHER relative overage than cyclomatic's 176 vs 15, same function), line 1640 (17), line 1782 (16 — **not** flagged by cyclomatic `complexity` at all), line 2390 (18) |
| `useBotGame.ts` | 0 | no function exceeds cognitive complexity 15, including the 112-logic-line `runBotTurn` arrow |
| `workerPool.ts` | 1 | line 896 (`handleLine`, 16 — **not** flagged by cyclomatic `complexity`/`max-statements` at all; only caught by `max-lines-per-function`'s file-level flag) |
| `Openings.tsx` | 1 | line 114 (`OpeningsPage`, 35 vs 15) |
| App-wide (non-test) | **41** breaches across **34** files | `[VERIFIED, this session]` |

Cognitive and cyclomatic complexity disagree on which functions are hot inside these files —
sonarjs flags `Analysis.tsx:1782` (`flawMarkerByNodeId` useMemo) and `workerPool.ts:896`
(`handleLine`) that eslint's own `complexity` rule does not catch at all, and does NOT flag
`Analysis.tsx:2321`/`3169`/`3338` that cyclomatic does. **Recommendation: run both metrics; a
function flagged by only one is still worth the planner's attention**, not just the ones on
both lists.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `eslint-plugin-sonarjs` | npm | 65 published versions; latest `4.2.0` published ~1 month before this session `[VERIFIED: npm view, this session]` | 4,115,741/week `[VERIFIED: gsd-tools seam, this session]` | `github.com/SonarSource/SonarJS` (maintainers are `@sonarsource.com` addresses) | `[OK]` | Approved — no `checkpoint:human-verify` needed |

`gsd_run query package-legitimacy check --ecosystem npm eslint-plugin-sonarjs` returned:
```json
{"name": "eslint-plugin-sonarjs", "verdict": "OK", "signals": {"exists": true,
"publishedAt": "2026-07-14T13:21:32.656Z", "weeklyDownloads": 4115741,
"repoUrl": "git+https://github.com/SonarSource/SonarJS.git", "deprecated": false,
"postinstall": null, "ecosystem": "npm"}, "reasons": []}
```
`[VERIFIED: gsd-tools seam, this session]`. Peer dependency `eslint: '^8.0.0 || ^9.0.0 ||
^10.0.0'` matches this project's `eslint@10.4.1` `[VERIFIED: npm view eslint-plugin-sonarjs
peerDependencies, this session]`. Its own `typescript` peer range is `>=5 <6.1.0`, and the
project's `typescript` devDependency is `~6.0.3` — inside range `[VERIFIED: npm view, this
session]`.

**How I verified it works under this project's exact ESLint 9/10 flat config + typescript-eslint
without leaving a trace**: `npm install --no-save eslint-plugin-sonarjs@4.2.0` inside
`frontend/` (this DID add 9 packages to `node_modules/` but left `package-lock.json` and
`package.json` byte-identical — confirmed with `git status --porcelain` before and after,
clean both times), wrote a scratch flat-config file (`frontend/eslint.config.sonarjs-scratch.mjs`,
untracked, deleted at the end of the session — `git status --porcelain` clean after cleanup)
extending `tseslint.configs.recommended` plus `{ plugins: { sonarjs }, rules: {
'sonarjs/cognitive-complexity': ['warn', 15] } }`, and ran `npx eslint --no-inline-config
--config eslint.config.sonarjs-scratch.mjs -f json src`. It ran clean (exit 0, no crash) and
produced the 41-breach/34-file baseline above. Then `npm uninstall eslint-plugin-sonarjs
--no-save` and restored `package-lock.json` from a pre-install backup as a belt-and-braces
step (the uninstall alone left it clean, confirmed by `git status --porcelain`). **The plugin's
default `cognitive-complexity` threshold is already 15** `[VERIFIED: rule meta `defaultOptions:
[15]`, this session]` — exactly CLAUDE.md's own target, so the config only needs
`'sonarjs/cognitive-complexity': ['warn', 15]` (or `'error'`, matching whatever severity the
core rules get — see the "must be error, not warn" finding below).

**`audit-ci` does NOT object.** Installing the plugin surfaced 6 new `npm audit` findings
(1 low/2 moderate/3 high — `browserslist`, `fast-uri`, `nanoid`, `qs`, `postcss-selector-
parser`, `@humanfs/node`), all transitive **dev**-dependency shifts unrelated to sonarjs's own
13 direct deps (verified: sonarjs's `dependencies` list is `typescript, semver,
jsx-ast-utils-x, lodash.merge, functional-red-black-tree, @eslint-community/regexpp, minimatch,
yaml, scslre, ts-api-utils, bytes, builtin-modules, globals` — none of the 6 vulnerable packages
are in that list; they are ambient dev-tree transitives that resolution reshuffling surfaced).
`npx audit-ci --config audit-ci.jsonc` still passed clean (`0/0/0/0/0`, exit 0) with the plugin
installed `[VERIFIED, this session]` **because `frontend/audit-ci.jsonc` sets `"skip-dev":
true`** `[VERIFIED: frontend/audit-ci.jsonc:9, read this session]` — dev-dependency
vulnerabilities are out of scope for this gate entirely, so sonarjs's dependency footprint
cannot break CI's vulnerability gate regardless of what shows up in a bare `npm audit`.

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none — `eslint-plugin-sonarjs` cleared `[OK]`.

No other new dependency is introduced by this phase; the three eslint core rules
(`complexity`, `max-depth`, `max-statements`) and `max-lines-per-function` ship with
`eslint@10.4.1`, already a devDependency.

## Standard Stack

### Core (already in the project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| eslint | 10.4.1 `[VERIFIED: npx eslint --version, this session]` | `complexity`/`max-depth`/`max-statements` core rules — the `C901`/`ruff PLR0912`/`PLR0915` analogs | Already the project's linter; zero new dependency; already runs in CI (`npm run lint`, `.github/workflows/ci.yml:141`) |

### Supporting (new dev dependency)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| eslint-plugin-sonarjs | 4.2.0 `[VERIFIED]` | Sonar cognitive-complexity metric (`sonarjs/cognitive-complexity`, default threshold already 15) — the `complexipy` analog | Run via a dedicated `npm run lint:cognitive` script, NOT inside `npm run lint`; report-only, before/after counts recorded per file |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| eslint core `complexity`/`max-depth`/`max-statements` | A custom AST script (the backend's `check_function_size.py` approach) | Unlike ruff, ESLint already ships stable rules for cyclomatic complexity, nesting depth, AND statement count — no equivalent of ruff's "no stable PLR1702" gap exists on the frontend side; a custom script would be pure duplication |
| `eslint-plugin-sonarjs` | Reimplementing Sonar's cognitive-complexity spec | Same reasoning as Phase 214's `complexipy` choice — a multi-week reimplementation of a published, actively-maintained algorithm for no benefit |
| `eslint-plugin-sonarjs` | `eslint-plugin-complexity` or a raw AST walker | sonarjs is the actual tool CLAUDE.md's "cognitive complexity ≤15" language references (it names the same metric family Phase 214 used `complexipy` for); reusing the vendor whose algorithm the project already adopted server-side keeps the two gates conceptually aligned |

**Installation** (do not run — the tooling plan's job):
```bash
npm install --save-dev eslint-plugin-sonarjs@4.2.0
```

**Version verification performed this session**: `npm view eslint-plugin-sonarjs version` →
`4.2.0`; 65 published versions; peer ranges checked against `eslint@10.4.1` and
`typescript@~6.0.3`, both compatible.

## Architecture Patterns

### ESLint flat-config mechanics — verified this session, not assumed

**1. `max-statements` counts per function, nested functions counted separately** (the direct
frontend analog of the research question "does `PLR0915` count nested function bodies
separately — it does per function"). Verified with a disposable scratch file inside
`frontend/src/` (deleted immediately after, `git status --porcelain` clean):
```js
function outer() {
  function inner() {
    const s1 = 1; const s2 = 1; const s3 = 1;
  }
  const a = 1;
  const b = 2;
}
```
`npx eslint --no-inline-config --rule 'max-statements: ["error", 2]'` reports **both**
`outer` (3 statements: the `inner` FunctionDeclaration counts as ONE statement toward `outer`,
plus `const a`/`const b`) and `inner` (3 statements: its own three `const`s) as separate
breaches — `inner`'s body statements are NOT folded into `outer`'s count `[VERIFIED, this
session]`. This matches ruff's `PLR0915` behavior exactly (per Phase 214's research) and means
CLAUDE.md's "excluding the returned JSX tree" carve-out DOES hold for `max-statements` — a JSX
return is a single `ReturnStatement` node regardless of how deep the tree is, so it counts as 1
statement, not N.

**2. `npm run lint` has NO `--max-warnings 0` flag** `[VERIFIED: frontend/package.json:11,
read this session — `"lint": "eslint ."`]`, and CI runs exactly that script
`[VERIFIED: .github/workflows/ci.yml:141, read this session]`. **A `warn`-severity rule
therefore never fails CI or the local lint gate.** The tooling plan MUST set
`complexity`/`max-depth`/`max-statements` to `'error'`, not `'warn'`, or the whole point of the
gate is defeated (this differs from the research prompt's phrasing suggesting the answer needs
confirming — confirmed: `'error'` is required).

**3. Per-file relaxation via a `files: [...]` override block is the established, already-used
convention in this exact config** `[VERIFIED: frontend/eslint.config.js, read this session]` —
three existing blocks already do this for `react-refresh/only-export-components`:
```js
{
  files: ['src/components/ui/**/*.{ts,tsx}'],
  rules: { 'react-refresh/only-export-components': 'off' },
},
```
The tooling plan's baseline-ignore block for the 51 pre-existing `complexity` breaches (and any
`max-lines-per-function`/`max-statements` breaches, though only `Analysis.tsx` breaches
`max-statements`) should follow this exact shape — either one block per file (mirroring the
backend's `per-file-ignores` table) or a single block with a `files` glob array covering all 51
paths and `complexity: ['warn', N]` overridden per-severity if a graduated relaxation is wanted.
Given ESLint flat config merges rule keys by later-block-wins-per-matched-file (not a numeric
override list like ruff's `per-file-ignores`), the cleanest mechanism proven by this file's own
existing pattern is `files: [<the 51 paths>], rules: { complexity: 'off' }` in ONE new block —
simpler than 51 separate blocks, and each file's own split-plan deletes its path from that one
array as proof of completion (analogous to deleting one `pyproject.toml` line in Phase 214,
just one array entry instead of one table entry).

**4. `sonarjs/cognitive-complexity`'s default threshold is already 15**
`[VERIFIED: rule meta, this session — see Package Legitimacy Audit]` — no threshold argument is
even strictly required, though passing `15` explicitly documents intent.

### Seam map — `Analysis.tsx` (`Analysis()`, 549-4370)

Grep-derived structural survey `[VERIFIED: line numbers and hook call sites from `grep -n`,
this session; a handful of representative bodies spot-read directly and quoted below — this is
NOT a full line-by-line read of all ~3,800 lines, and the planner's own read during the plan
should confirm group boundaries before committing to an extraction]`. `Analysis()` already
composes several extracted hooks — `useAnalysisBoard`, `useStockfishEngine`,
`useStockfishGradingEngine` (used twice, lines 1400 and 2313), `useMaiaEngine`,
`useFlawChessEngine`, `useEngineAssetStatus`, `useMaiaEloDefault`, `useGameOverlay`,
`useLiveMoveFlaw`, `useFastForward`, `useGemSweep`, plus a locally-defined
`useAnalysisLayoutMode` (line 292) — so the convention (a `useXyzData` hook per concern, colocated
in `@/hooks/`) is already established; this phase extends it rather than inventing it.

| Cluster | Approx. lines | State/refs/memos/effects | Reads | Writes/returns | Extraction target |
|---------|---------------|---------------------------|-------|-----------------|---------------------|
| Engine setup | 738-1005 | `engine` (`useStockfishEngine`), `maia`, `flawChessEngine`, `pinnedEloForMover`, `temperature`, `extraRootMoves`, `injectedForPositionRef` | route/URL params, engine gate state | engine handles consumed by every later cluster | already mostly hook-composed; low split value, leave largely in place |
| URL/route param seeding | 550-577, 999-1290 (13 `useEffect`s incl. the 6 exhaustive-deps-suppressed ones at 1057/1072/1083/1124/1154/2849) | `lineSans`, `rootFenSeed`, `urlOrientation`, `seededKey`/`navigatedInitialPlyKey`/`pasteHandoffConsumed` refs, `initialTactic` | `searchParams`, `location` | seeds board state via `loadMainLine`/`goToNode`/`insertPvLine` (imperative calls into `useAnalysisBoard`) | candidate `useAnalysisRouteSeeding` hook — the 6 disable comments MUST move with their effects verbatim (see Extraction Invariants) |
| Engine-line reconciliation | 1400-1742 | `grading`, `evalLookup`, `gradedCandidateUcis`, `reconciledTieBreakUci`, `reconciledBestUci`, `reconciledBestSan`, `reconciledStockfishLine`, `reconciledBestEval`, `reconciledRankedLines`, `flawChessRankedLinesForVerdict`, `reconciledPvLines`, `qualityBySan`, `qualityBySanWithGem` (line 1640, cyclomatic 16) | `engine`/`flawChessEngine` results, `position` | consumed by move-quality UI (`EngineLines`, `MaiaHumanPanel`, quality bars) | matches the ROADMAP's own example `hooks/analysis/useAnalysisEngineLines.ts` almost exactly — this is the single cleanest, highest-value extraction in the file |
| Gem-sweep / marker resolution | 823-885, 1592-2576 | `storedTierByPly`, `storedBestGoodByPly`, `gemByNode`, `gemC1`, `sweepCandidates`, `sweepResolvedPlies`, `sweep` (`useGemSweep`), `gemGrading` (`useStockfishGradingEngine` #2, line 2313, the useEffect at 2321 is cyclomatic 19), `resolveMarkerFor`, `moveListMarkers` (line 2390, cyclomatic **27**, the worst non-`Analysis` offender in the file) | `currentNodeId`, `liveFlaw`, engine grading results | `Map<NodeId, FlawMarkerEntry>` consumed by `VariationTree`/move list | candidate `useAnalysisGemMarkers` hook — `moveListMarkers`'s 27-complexity body is the single highest-value split target after the reconciliation cluster |
| Board-arrow computation | 2576-3261 | `sidelineNodeColors`, `pvSidelineArrows`, `qualityHoverArrows`, `nextMoveArrow`, `engineArrows`, `boardSquareMarkers` (line 3169, cyclomatic 18) | reconciled lines, `gameOverlay`, `liveFlaw` | `BoardArrow[]` props passed to the chessboard | candidate `useAnalysisBoardArrows` hook |
| Board sizing | 3041-3169 | `boardStageRef`, `boardWidth`, `boardStageHeight`, a `useEffect` resize handler at 3049 | DOM `ResizeObserver`/layout | board container width/height props | small, self-contained — candidate `useBoardStageSize` hook if extracted, or leave inline (only ~120 lines) |
| Move-list scroll/tag sync | 2901-2988 | `tagCommandedPly`, `tagCommandSeq`, `moveListTopAlignSeq`, `heldLeftWhiteFraction` | user tag/scroll interactions | imperative scroll commands to `VariationTree` | small UI-state cluster; likely stays with the render section unless it grows |
| `playerBar` render helper | 3338-3419ish | none (pure function of props/derived values, NOT a hook) | `pastedHeaders`, `gameData`, `playerClocks` | JSX fragment | **not** a hook candidate — extract as a small `<PlayerBar>` sub-component (`.tsx`, since it returns JSX) or leave as a local closure; it is called twice (top/bottom) inside the return, which is exactly why it exists as a helper already |
| Engine-gate handlers | 4094-4105 | `closeEngineGate`, `handleEngineGateRetry` (`useCallback`s) | gate state | gate close/retry | small; can move with the engine-setup cluster or stay local |

**The 5 flagged arrow handlers by line, confirmed by direct read**: 1640
(`qualityBySanWithGem`, a `useMemo` — reconciliation cluster), 2321 (`useEffect`, gem-sweep
cluster — "when the parent grade completes, run C2 and RESOLVE the node"), 2390
(`moveListMarkers`, a `useMemo` — gem-sweep cluster, the worst offender), 3169
(`boardSquareMarkers`, a `useMemo` — board-arrow cluster), 3338 (`playerBar`, a **plain
non-hook arrow function**, not caught by any hook-ordering constraint since it isn't a hook at
all — freely extractable as a component).

### Seam map — `useBotGame.ts` (`useBotGame()`, 506-1662)

`[VERIFIED: grep -n` structural survey plus direct reads of the return statement (1634-1662)
and the `UseBotGameState` interface declaration site (line 223), this session]`. The hook's
return type is a **named interface**, not an inferred object shape:
```ts
export interface UseBotGameState { /* ... */ }
```
`[VERIFIED: src/hooks/useBotGame.ts:223, read this session]`, and the function signature is
`export function useBotGame(...): UseBotGameState` `[VERIFIED: line 506/510]`. Any split must
keep every field on this interface identical — field identity (not just runtime shape) matters
because TypeScript consumers destructure by name.

| Cluster | Approx. lines | Key members | Extraction target |
|---------|---------------|--------------|---------------------|
| Init/resume | 506-693 | `restored` (`initFromResume`), `chessRef`, `clockBaseRef`, `viewedPlyRef`/`liveGamePlyRef`, `outcomeRef`, `moveHistory`/`viewedPly`/`activeColor` state | stays in the top-level hook body — this is the constructor-shaped setup every other cluster depends on |
| Clock/turn timing | 528-540, 768-871 | `turnStartedAtRef`, `pausedAtRef`, `chargeableElapsedMs`, `resetTurnAnchor`, `flagIfOutOfTime`, `whiteClockMs`/`blackClockMs` | candidate `useBotGameClock` — self-contained, reads/writes only clock refs and state, called by `commitMove`/`runBotTurn` |
| Bot engine dispatch | 570-577, 1366-1604 (`runBotTurn`, the 112-logic-line arrow) | `poolRef` (`createWorkerPool`), `queueRef` (`createMaiaQueue`), `abortControllerRef`, `selectBotMove`, `selectBookMove`, `styleBookWeighting` | candidate `useBotGameEngineDispatch` — this is the single highest-value split (largest function in the file); calls into `workerPool.ts`'s `createWorkerPool` and MUST use the module-level import, not a re-derived path, if `workerPool.ts` is also split in this phase (order matters — see Ordering section) |
| Persistence/snapshot | 594-644, 783-871 | `buildSnapshot`, `finalizeGame`, `hasLeftBookRef`, `hasFiredLowTimeRef`, `movesSinceLastDeclineRef`, `enqueuePendingStore` (external, `@/lib/botPendingStore`) | candidate `useBotGameSnapshot` — note `botGameSnapshot.test.ts`/`botPendingStore.test.ts` already test the pure functions this cluster calls; only the hook-level orchestration around them is new surface |
| Move commit | 890-1041 | `commitMove`, `attemptMove`, `viewPly` | stays close to the init cluster — these mutate `chessRef` directly and are called from many places |
| Draw offer | 371-405 (module-level `resolveBotDrawOfferUpdate`, `styleNameFor`), 1094-1122 | `offerDraw`, `acceptBotDraw`, `declineBotDraw`, `botDrawOfferRef`, `movesSinceOwnOfferRef`, `movesSinceLastDeclineRef` | candidate `useBotGameDrawOffer` — cleanly separable, narrow read/write surface |
| Lifecycle | 1122-1182, 1604-1634 | `newGame`, several `useEffect`s (1182, 1206, 1254, 1288, 1335, 1604, 1610, 1625) | stays with init/return — ties multiple clusters together at mount/unmount |

**vi.mock consumers of this hook's dependencies** — see Test Oracle section below for the exact
`workerPool` mock shapes; `useBotGame.test.ts` mocks `createWorkerPool` only (not
`isLowPowerDevice`/`computePoolSize`), so a `workerPool.ts` split that moves `createWorkerPool`
out of the top-level module without a re-export would break this mock silently.

### Seam map — `workerPool.ts` (`createWorkerPool()`, 596-1442)

`[VERIFIED: grep -n` structural survey of every top-level `function`/`export function`
declaration, this session]`. The function is organized into clearly stage-delimited inner
`function` declarations sharing three closure-captured state pieces: `slots: PoolWorkerSlot[]`,
`pending: QueuedGradeRequest[]`, `gradeCache` (from `createGradeCache()`, already a standalone
factory at line 481 — this one is ALREADY extracted, a precedent for the rest).

| Stage | Functions (in file order) | Shared state touched | Notes |
|-------|---------------------------|------------------------|-------|
| Pool bookkeeping | `markPoolReady` (657), `markPoolFailed` (681) | `poolReady`, `poolFailed` | tiny, could merge into lifecycle stage |
| Watchdog | `clearSlotWatchdog` (692), `rearmGradingWatchdog` (706), `fireWatchdog` (725), `armStopWatchdog` (828), `fireStopWatchdog` (847), `armInitWatchdog` (985), `fireInitWatchdog` (991) | per-`slot.watchdogTimer`, `slot.watchdogSuspendRearms`/`watchdogLivenessRearms` | the largest single stage by function count (7); the comment at 691-699 explicitly says `clearSlotWatchdog` exists so call sites "cannot drift apart" — an EXTRACTION CANDIDATE explicitly designed for reuse already |
| Dispatch | `sendGo` (860), `dispatchNext` (885), `handleLine` (896, cognitive complexity 16 — the sonarjs-only finding above) | `slots`, `pending` | `handleLine` is the UCI message parser — highest individual-function complexity in the file by the cognitive metric |
| Slot lifecycle | `noLiveSlotRemains` (974), `replaceDeadSlot` (1024), `drainPending` (1074), `createSlot` (1090), `runSpawnConstructionLoop` (1169), `ensureSpawned` (1202) | `slots`, `spawned`/`spawnInFlight`/`spawnGeneration`, `resolvedSharedUrl` | spawn/respawn machinery; `createSlot` constructs the actual `Worker` and wires `MessageChannel`/`progressPort` |
| Public API | `grade` (1236), `stopAll` (1345), `terminate` (1371), `warm` (1411), `whenReady` (1430), the final `return { ... }` (1442) | all of the above | the object literal returned at 1442 IS the `WorkerPool` interface surface — its field names must not change |

**Design for extraction without changing the public `WorkerPool` interface**: each stage's
inner functions close over `slots`/`pending`/`gradeCache` directly rather than taking them as
parameters. Two viable approaches, in order of risk: (1) **leave the closures as inner
functions but reorganize them into named regions with a comment banner per stage** (lowest
risk, addresses `max-lines-per-function` not at all — this does NOT reduce `createWorkerPool`'s
418-line count, so it doesn't satisfy success criterion 0/1); (2) **extract each stage's
functions into a sibling module as pure functions taking an explicit `PoolState` object**
(`{ slots, pending, gradeCache, ...flags }`) as their first argument, called from
`createWorkerPool`'s closures — this DOES reduce the god function's line count and matches
CLAUDE.md's "pipeline orchestrator → one function per stage" seam, but risks becoming "split to
fit a signature" if the `PoolState` object ends up as a large grab-bag threaded through every
call. Given the ROADMAP explicitly rejects context objects "with fewer than three fields and
one reader" (this one would have far more than 3 fields AND multiple readers, so it does NOT
trip that anti-pattern test) — **recommend approach 2, one sibling module per stage**
(`workerPoolWatchdog.ts`, `workerPoolDispatch.ts`, `workerPoolLifecycle.ts`), matching the
"sibling `.py` files, not a package" convention Phase 214 established for the backend (this
project already uses flat sibling `.ts` files elsewhere, e.g. `stockfishWorkerSource.ts`/
`maiaQueue.ts` alongside `workerPool.ts` in the same directory — no package convention to
break here either).

**Public exports consumed by mocks** (the names that MUST stay resolvable at the
`@/lib/engine/workerPool` path, whether by staying in the file or via re-export) `[VERIFIED:
grep -rn "vi.mock.*workerPool"`, this session, exact factory bodies read]`:
`createWorkerPool` (mocked by `useBotGame.test.ts`, `useFlawChessEngine.test.ts`),
`isLowPowerDevice` (mocked by `Analysis.test.tsx`, `useGemSweep.test.ts`), `computePoolSize`
(mocked by `useFlawChessEngine.test.ts`). The 18 internal closures inside `createWorkerPool`
are NOT independently imported/mocked anywhere — they are pure implementation detail, free to
move to sibling files as long as `createWorkerPool` itself still assembles and returns the same
`WorkerPool` shape from the same `@/lib/engine/workerPool` module path.

### Seam map — `Openings.tsx` (`OpeningsPage()`, 114-1376)

`[VERIFIED: grep -n` structural survey plus direct reads of lines 583-627 (desktop filter
panel) and 1240-1270 (mobile filter panel), this session]`. `pages/openings/` already holds 4
extracted hooks (`useDeepLinkHighlight.ts`, `useOpeningsHandlers.ts`, `useSidebarState.ts`,
`useTabReset.ts` — all imported and used at lines 151/157/165) and 4 extracted tab components
(`ExplorerTab.tsx`, `GamesTab.tsx`, `InsightsTab.tsx`, `StatsTab.tsx`) — the extraction
convention already exists in this exact directory; this phase extends it, matching the
ROADMAP's own hinted path `components/openings/OpeningsSidebar.tsx`.

**The concrete duplication** (frontend/CLAUDE.md's "search for duplicated markup" rule,
applied): both the desktop sidebar panel content (`desktopFilterPanelContent`, lines 583-623,
consumed inside `SidebarLayout` at line 856) and the mobile drawer (inside the first
`MobileFilterDrawer`, lines ~1220-1263) render:
```tsx
// Source: frontend/src/pages/Openings.tsx:616-621 (desktop) — byte-identical
// props to lines 1257-1262 (mobile), only the wrapping ToggleGroup testids differ
// ('filter-piece-filter' vs 'filter-piece-filter-sidebar')
<FilterPanel
  filters={localFilters}
  onChange={setLocalFilters}
  visibleFilters={['timeControl', 'platform', 'opponent', 'opponentStrength', 'rated', 'recency']}
  hideReset
/>
```
`[VERIFIED: frontend/src/pages/Openings.tsx:616-621 and :1257-1262, read this session — exact
text quoted]`. The `ToggleGroup` piece-filter block immediately above each `<FilterPanel>` is
ALSO duplicated with parallel but distinct testids (`filter-piece-filter`/`-mine`/`-opponent`/
`-both` desktop vs. `filter-piece-filter-sidebar`/`-mine-sidebar`/`-opponent-sidebar`/
`-both-sidebar` mobile) `[VERIFIED: lines 594-609 vs. 1240-1252, read this session]` — **any
extraction MUST preserve both testid sets exactly** (they are DIFFERENT strings by design, not
an accidental duplication to collapse — collapsing them would change the DOM contract the
ROADMAP explicitly forbids touching).

| Cluster | Approx. lines | Extraction target |
|---------|---------------|---------------------|
| Filter/sidebar state | 144-235 | already thin — `useFilterStore`, `useDebounce`, `useSidebarState` are already hooks; local state (`localChartEnabled`, `localMatchSides`, `localFilters`) stays close to the handlers that mutate it |
| Query data derivation | 235-388 | `nextMoves`, `boardArrows`, `gamesQuery`, `gameCountData`, `chartBookmarks`, `bookmarkMetricsRequest`, `bookmarkPhaseEntryData`, `bookmarkPhaseEntryByHash`, `timeSeriesRequest`, `tsData`, `wdlStatsMap` — 8 `useMemo`s plus 3 `useQuery`-family hooks | candidate `useOpeningsChartData` hook (data-shaping, matches the ROADMAP's own named seam) |
| Handlers | 388-791 (14 `useCallback`s) | `handleChartEnabledChange`, `handleDesktopFiltersApply`, `openBookmarkDialog`, `handleBookmarkSave`, `handleDesktopSidebarOpenChange`, `openFilterSidebar`, `handleFilterSidebarOpenChange`, `handleMobileFiltersApply`, `openBookmarkSidebar`, `handleBookmarkSidebarOpenChange`, `handleLocalChartEnabledChange`, `handleLocalMatchSideChange`, `handleLoadBookmarkFromSidebar`, `handleLoadBookmarkFromDesktopSidebar`, `handleAnalyzePosition` | `pages/openings/useOpeningsHandlers.ts` ALREADY EXISTS — confirm whether it already owns some of these or is a distinct, older extraction; if distinct, this is the natural home for the rest |
| Desktop sidebar render | ~180-816 (`SidebarLayout`, `desktopFilterPanelContent`/`Footer`) | candidate `components/openings/OpeningsDesktopSidebar.tsx`, matching the ROADMAP's own hinted path |
| Mobile drawer render | ~1220-1360+ (two `MobileFilterDrawer` blocks: filter, bookmarks) | candidate `components/openings/OpeningsMobileDrawers.tsx` — extracting BOTH drawers together avoids re-deriving the shared `ToggleGroup`+`FilterPanel` fragment twice; consider a single shared `<OpeningsFilterFields testIdSuffix="" | "-sidebar">` sub-component consumed by both desktop content and the mobile drawer, which would also REDUCE the duplication (a legitimate bonus per Phase 214's own precedent of consolidating duplicate logic surfaced by a split) |
| `chartToggleVersion` dep | line 232 | the pre-existing "unnecessary dependency" warning — leave untouched (fixing it is explicitly out of scope; a split must not accidentally resolve it as a side effect either) |

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cyclomatic complexity / statement-count / nesting-depth gate | A custom AST-walking script (unlike the backend, no gap exists) | eslint core `complexity`/`max-depth`/`max-statements` (already the project's linter) | ESLint ships stable rules for all three metrics — there is no ruff-`PLR1702`-style "no stable rule" gap on the frontend side that would justify a custom script |
| Cognitive complexity (nesting-weighted) | A custom Sonar-cognitive-complexity implementation | `eslint-plugin-sonarjs`'s `cognitive-complexity` rule (default threshold already 15) | Same algorithm family CLAUDE.md's ≤15 target names; SonarSource-maintained, 4.1M weekly downloads, `[OK]` legitimacy verdict |
| Worker/message-channel faking for a characterization test | A new hand-rolled `MockWorker` from scratch | `workerPool.test.ts`'s existing `MockWorker`/`MockMessagePort`/`stubWorkerCtor`/`stubMessageChannel` helpers (already in the file) | Duplicating this ~150-line fake would diverge from the existing, working double; any new characterization tests for closures not yet covered should extend this same file using its existing helpers |
| Desktop/mobile filter-field markup | A second hand-written copy of the `ToggleGroup`+`FilterPanel` block for a new sibling component | Extract ONE shared fragment/sub-component parameterized by testid suffix, consumed by both desktop and mobile call sites | The two existing copies are already near-identical (same props, only testids differ) — a split that copies rather than shares would make the file WORSE, not better, and violates the phase's own "consolidation is a legitimate bonus" allowance |

**Key insight:** unlike Phase 214 (where a real tooling gap — no stable ruff nesting-depth rule
— justified one small custom script), this phase has **zero** tooling gaps: ESLint's stable
rule set already covers everything CLAUDE.md's function-size rule needs, and sonarjs already
covers cognitive complexity. The only genuinely new code this phase's wave 1 writes is
config (the eslint override block) and docs — no new script.

## Test Oracle Per File

`[VERIFIED, this session — every count below is a fresh `npx vitest run` on the exact file(s),
not a stale/estimated figure]`:

| File | Test module(s) | Test count | Runtime | Private/internal symbols exercised directly |
|------|------------------|-----------:|--------:|-----------------------------------------------|
| `Analysis.tsx` | `pages/__tests__/Analysis.test.tsx` | 85 | 6.99s wall (5.25s tests) | none imported by name — behavior asserted through rendered DOM/testids only |
| `useBotGame.ts` | `hooks/__tests__/useBotGame.test.ts` (85, per file grep), `pages/__tests__/Bots.test.tsx` (33), `hooks/__tests__/useStoreBotGame.test.ts` (22), `lib/__tests__/botGameSnapshot.test.ts` (13), `lib/__tests__/botPendingStore.test.ts` (12) — **167 total run together** | 167 | 4.07s wall | `UseBotGameState` fields asserted by name via the hook's return value in RTL `renderHook`-style tests |
| `workerPool.ts` | `lib/engine/__tests__/workerPool.test.ts` — **directly imports and calls `createWorkerPool`, NOT mocked** (see the load-bearing correction at the top of this document) | **109** | 1.23s wall | `enqueue`, `dequeueHighestPriority`, `computePoolSize`, `createWorkerPool`, plus 13 named constants (`DESKTOP_POOL_MIN`, `GRADING_WATCHDOG_TIMEOUT_MS`, etc.) all imported directly from `../workerPool` |
| `Openings.tsx` | `pages/__tests__/Openings.statsBoard.test.tsx` — **stats board ONLY**, confirmed no other test file imports `OpeningsPage` at all (`grep -rln "OpeningsPage\|from '@/pages/Openings'"` across `src/**/*.test.*` returns zero matches) | 16 | 0.88s wall | none — DOM/testid assertions only, and only for the stats-board region |

**Thin-seam flags requiring characterization work before the split (ROADMAP's own mandate)**:
- **`Openings.tsx` is genuinely thin** — the sidebar/drawer split target (the actual duplication
  this phase wants to fix) has ZERO existing test coverage. The ROADMAP's mandate to add a
  render-level characterization test (desktop + mobile layout, mocked queries, testid presence)
  BEFORE splitting is correct and necessary here, unlike for `workerPool.ts`.
- **`workerPool.ts` is NOT thin** — see the load-bearing correction. The planner should still do
  a focused coverage check (does an existing test exercise each of the 18 closures at least
  once, especially `handleLine`'s branches and the `replaceDeadSlot`/`runSpawnConstructionLoop`
  respawn path?) rather than writing a parallel test suite from scratch.
- **`Analysis.tsx`'s 85 tests assert only through rendered output**, not through any extracted
  helper's name — this means a split is SAFE from an import-breakage perspective (nothing
  `vi.mock`s an internal `Analysis.tsx` symbol by path) but the tests give no direct signal
  about which internal computation produced a wrong value; a regression could show up as a
  wrong number/testid several hooks downstream of its actual cause. Recommend the mutation-test
  gate here too, even though the ROADMAP only names it explicitly for `workerPool.ts`/
  `Openings.tsx`.
- **`useBotGame.ts`'s 167-test oracle is the strongest of the four (highest test-to-file-size
  ratio)** and, per `UseBotGameState`'s named-interface return shape, any extraction that keeps
  the interface's field set intact is well-guarded.

**Timeout-sensitivity check** (memory rule: heavy frontend tests have TWO independent ceilings
— Vitest's default `testTimeout` and testing-library's default 1000ms `waitFor`). `[VERIFIED,
this session]`: no `vitest.config.ts`/`test:` block exists anywhere in the project — Vitest runs
with its stock defaults (5000ms `testTimeout`) and each `.test.tsx`/`.test.ts` file opts into
jsdom per-file via a `// @vitest-environment jsdom` pragma (confirmed at the top of
`Analysis.test.tsx`), not via global config. `Analysis.test.tsx` (2,831 lines, 85 tests) runs in
5.25s of actual test time — **~62ms average per test**, nowhere near either the 5000ms
per-test ceiling or the 1000ms `waitFor` ceiling today. Not currently timeout-sensitive, but a
split that meaningfully increases per-test render cost (e.g. wrapping more providers) should
re-check this; it is not a live risk at today's baseline.

## Behavior-Preservation Hazards

### `vi.mock('@/lib/engine/workerPool', ...)` — the exact per-consumer mock shape

`[VERIFIED: exact factory bodies read this session]` — four different test files mock this
module path with FOUR DIFFERENT partial shapes:
- `useBotGame.test.ts:176`: `{ createWorkerPool: () => mockCreateWorkerPool() }` — only
  `createWorkerPool`.
- `useFlawChessEngine.test.ts` (~line 60): `{ createWorkerPool: () => mockCreateWorkerPool(),
  computePoolSize: () => mockComputePoolSize() }` — two exports.
- `useGemSweep.test.ts` (~line 100): `{ isLowPowerDevice: () => lowPowerDevice }` — only
  `isLowPowerDevice`.
- `Analysis.test.tsx:83`: `{ isLowPowerDevice: () => false }` — only `isLowPowerDevice`.

Because `vi.mock` with a factory REPLACES THE ENTIRE MODULE NAMESPACE for that import path in
that test file, **any name a real component imports from `@/lib/engine/workerPool` that is NOT
present in that test's mock factory becomes `undefined` at import time** — this is a silent
failure mode (not necessarily a thrown error immediately, depending on how the undefined value
is used) rather than a compile error, since these are plain object literals, not
`vi.importActual`-wrapped partial mocks. **Concretely**: if a split moves `isLowPowerDevice` out
of `workerPool.ts` into a sibling file and `Analysis.tsx`/`useGemSweep.ts` update their import
to the new path, their existing `vi.mock('@/lib/engine/workerPool', ...)` calls become
dead-code mocks of a module nothing imports from anymore — harmless but pointless — while the
NEW sibling module needs its own `vi.mock` entry, or the test breaks (real `isLowPowerDevice`
runs, which reads `navigator.hardwareConcurrency`/`matchMedia`, not obviously wrong in jsdom but
different from the intentionally-stubbed value the test asserts against). **Rule: the simplest,
lowest-risk choice is to keep `createWorkerPool`, `isLowPowerDevice`, and `computePoolSize` as
top-level exports of `workerPool.ts` itself (implemented by calling into whatever sibling
modules the internal closures move to), and only move the 18 internal, unexported closures.**
This avoids touching any of the four `vi.mock` call sites at all.

### `react-refresh/only-export-components` — file-boundary decision, not optional

`[VERIFIED: frontend/eslint.config.js, read this session]` — three existing override blocks
turn this rule off for `src/components/ui/**`, `src/components/filters/**`, and
`src/components/analysis/**` (the last one specifically because `TacticModeOverlay`-adjacent
files already co-export helper functions alongside components, per its own comment "Analysis
board overlay exports non-component arrow builders and orientation helpers alongside the
TacticModeOverlay component ... Phase 139"). **Consequence for this phase**: any NEW file this
phase creates under `src/components/analysis/**` (e.g. a `<PlayerBar>` extraction from
`Analysis.tsx`'s `playerBar` helper) automatically inherits the existing relaxation — no new
override needed. A new file under `src/hooks/analysis/**` or `src/hooks/` generally is a `.ts`
file (hooks only, no JSX) and never triggers this rule regardless. A new file under
`src/components/openings/**` (the ROADMAP's own suggested path for `OpeningsSidebar.tsx`) has
**no existing override** — if that new component file needs to co-export a constant or a
non-component helper (unlikely for a pure render split, but possible if the shared
`ToggleGroup`+`FilterPanel` fragment consolidation from the Openings seam map is done as an
exported helper rather than a component prop), the plan must either keep it component-only or
add a fourth override block, following the exact pattern of the three existing ones.

### Rules-of-hooks ordering — extracted hooks must preserve call order

Every cluster identified in the seam maps above calls multiple hooks in a fixed sequence inside
the god function's body. React's rules of hooks require the SAME hooks to run in the SAME order
on every render — extracting a cluster into `useAnalysisEngineLines(...)` etc. is safe (the
extracted hook still runs unconditionally, in the same relative position, once per render of
the parent), but the planner must not introduce a NEW conditional around the extracted hook
call itself (e.g. `if (isGameMode) { const x = useAnalysisEngineLines(...) }` is illegal;
`useAnalysisEngineLines({ isGameMode, ... })` and branching INSIDE the hook is fine, matching
how `useStockfishGradingEngine` is already called twice with an `enabled` flag rather than
conditionally invoked, at `Analysis.tsx:1400` and `:2313`).

### `noUncheckedIndexedAccess` — every extracted `Map`/array access needs the same narrowing

`[VERIFIED: frontend/tsconfig.app.json:27, read this session — `"noUncheckedIndexedAccess":
true`]`. Several clusters above manipulate `Map<NodeId, ...>`/array structures
(`moveListMarkers`, `boardSquareMarkers`, `flawMarkerByNodeId`) — when these are extracted into
a sibling hook, `npm run build` (`tsc -b`) will re-verify the same `T | undefined` narrowing
CLAUDE.md's own frontend rule requires; this is not new work, just a reminder that
`npm run lint`/`npm test` do NOT type-check (per the phase's own gate list) and `npm run build`
is the only step that would catch a narrowing regression introduced by a copy-paste split.

## Ordering and Wave Structure

**Wave 1 (tooling, blocks everything else)**: eslint `complexity`/`max-depth`/`max-statements`
as `'error'` with a baseline `files: [...51 paths...], rules: { complexity: 'off' }` override
block (or per-file, planner's choice — the ROADMAP explicitly allows either); `max-lines-per-
function` report-only (never added to the enforced rule set, just run ad hoc for before/after
counts); `eslint-plugin-sonarjs` behind `npm run lint:cognitive`, not gating; docs in
`docs/dev-tooling.md` and both CLAUDE.md files.

**Wave 2 (one plan per file — all four touch `eslint.config.js`'s baseline override array, so
they merge sequentially, matching Phase 214's own wave-2 pattern for `pyproject.toml`'s
`per-file-ignores` table)**. Recommended order, by test-oracle strength AND independent risk,
correcting the ROADMAP's own suggested order given the `workerPool.ts` finding above:

1. **`useBotGame.ts`** — 167-test oracle (the widest of the four), a single well-typed return
   interface, five cleanly separable clusters, no render-tree change (a hook, not a page) so no
   HUMAN-UAT needed for this file specifically (though `Bots.tsx`'s consuming page should still
   get a quick manual smoke since it's the primary consumer).
2. **`workerPool.ts`** — 109-test oracle ALREADY EXISTS (the correction above), self-contained
   (no React rendering concerns at all), and `useBotGame.ts`'s dispatch cluster imports
   `createWorkerPool` — doing this file second, right after `useBotGame.ts`, means
   `useBotGame.ts`'s plan doesn't need to coordinate with an in-flight `workerPool.ts` split
   (do `useBotGame.ts` against the STABLE pre-split `workerPool.ts`, then split `workerPool.ts`
   next since its public surface — `createWorkerPool`/`isLowPowerDevice`/`computePoolSize` —
   isn't changing regardless of internal reorganization, per the hazard section above).
3. **`Analysis.tsx`** — 85-test oracle, largest file, highest complexity (176 cyclomatic on the
   god function itself), likely needs 2 plans as the ROADMAP itself suggests (data/hooks
   extraction, then render/handler split) given its ~2,000 logic-LOC size; needs HUMAN-UAT
   (library-game, paste, tactic modes; desktop + mobile).
4. **`Openings.tsx`** — last, both because its 16-test oracle is thinnest (needs a NEW
   characterization test written before the split, real prerequisite work) and because it is
   the one file among the four with a genuine, unaddressed markup-duplication bug-shaped issue
   (not just a size problem) that benefits from having the other three files' extraction
   patterns already established as precedent. Needs HUMAN-UAT (sidebar + drawer open, desktop +
   mobile).

**Wave 3 (closeout)**: phase-wide measurement (eslint with the baseline array emptied for these
four files, sonarjs before/after, `max-lines-per-function` before/after, testid/umami inventory
diff, `react-hooks/*` warning-count diff — must be exactly 25/3/3 unchanged), narrow or retire
the CONCERNS.md "Large God files" entry.

## Common Pitfalls

### Pitfall 1: A `warn`-severity new rule silently does nothing
**What goes wrong:** the tooling plan adds `complexity`/`max-depth`/`max-statements` as `'warn'`
(the ROADMAP's own baseline-measurement command uses `warn` for reconnaissance purposes) and
ships it that way.
**Why it happens:** the ROADMAP's verbatim measurement command literally says `["warn", 15]` —
easy to carry that severity into the real config by copy-paste.
**How to avoid:** the MEASUREMENT command uses `warn` deliberately (so it doesn't exit non-zero
and abort the reconnaissance); the SHIPPED config must use `'error'`, confirmed by this
session's finding that `npm run lint` has no `--max-warnings` flag.
**Warning signs:** `npm run lint` exits 0 even though the four in-scope files still breach the
new rules.

### Pitfall 2: Assuming `workerPool.ts` needs a test suite built from nothing
**What goes wrong:** the plan spends its first task writing a parallel characterization test
suite duplicating `workerPool.test.ts`'s existing 109 tests, instead of extending it.
**Why it happens:** the ROADMAP's own phase text says the oracle is "NONE."
**How to avoid:** read `src/lib/engine/__tests__/workerPool.test.ts` FIRST; it already covers
dispatch, watchdog, grade cache, and `whenReady()`. Extend it with tests for any specific
closure/branch not already exercised, using its existing `MockWorker`/`MockMessagePort`
helpers.

### Pitfall 3: Collapsing the desktop/mobile testid duplication in `Openings.tsx`
**What goes wrong:** while extracting the shared `ToggleGroup`+`FilterPanel` fragment, a
well-meaning cleanup makes both call sites use the SAME testids (`filter-piece-filter` for
both, dropping the `-sidebar` suffix), reasoning "they're the same component now."
**Why it happens:** the fragment consolidation IS a legitimate bonus this phase allows, but
the desktop/mobile testid PAIRS are an intentional browser-automation contract (two different
DOM nodes exist simultaneously in some layouts — a drawer can be present in the DOM even when
visually hidden depending on the underlying primitive), not an accidental duplication.
**How to avoid:** parameterize the shared fragment by a `testIdSuffix` prop; run the
before/after `data-testid` inventory diff (`grep -o 'data-testid="[^"]*"' src/pages/Openings.tsx
| sort`) and require it to be IDENTICAL, not merely "still present."

### Pitfall 4: Moving `runBotTurn` without its `runBotTurnRef` indirection
**What goes wrong:** `useBotGame.ts` stores `runBotTurn` in a ref
(`runBotTurnRef.current = runBotTurn`, pattern visible from the `useRef<...>` declaration at
line 564) — likely to let another closure call the LATEST version without becoming a dependency
of an effect. A split that turns `runBotTurn` into a hook-returned callback without preserving
this ref-based "always call the latest closure" pattern could reintroduce a stale-closure bug
this pattern exists to prevent.
**Why it happens:** the ref indirection is easy to miss when only skimming the `useCallback`
signature.
**How to avoid:** grep for `runBotTurnRef` usage across the whole file before touching
`runBotTurn`; preserve whatever effect/callback currently reads `runBotTurnRef.current` rather
than `runBotTurn` directly.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | The recommended per-file relaxation mechanism (one `files: [...51 paths]` block rather than 51 individual blocks) is the "cleanest" choice, not a hard requirement — the ROADMAP explicitly leaves this to the planner's judgment. | ESLint flat-config mechanics | Low — either mechanism satisfies the gate; a planner preferring per-file blocks (matching Phase 214's per-line `pyproject.toml` table more closely) loses nothing but verbosity |
| A2 | The seam-map cluster boundaries (e.g. exactly which lines belong to "gem-sweep/marker resolution" vs. "board-arrow computation" in `Analysis.tsx`) are derived from a grep-based structural survey, not a full line-by-line read of the ~2,000 logic-LOC function body. Boundaries are directionally correct but may shift by a handful of lines once the planner reads the full function. | Seam map — Analysis.tsx | Medium — an extraction plan built directly on these exact line ranges without the planner's own confirming read risks moving a variable's producer and consumer into different hooks |
| A3 | `workerPool.test.ts`'s 109 tests are assumed to give adequate coverage for a safe split of all 18 closures; I did not build a line-by-line coverage matrix (e.g. via `vitest run --coverage` scoped to this one file) confirming every closure/branch is hit. | Test Oracle — workerPool.ts | Medium — the file's plan should still run `npx vitest run src/lib/engine/__tests__/workerPool.test.ts --coverage` and inspect line coverage on `workerPool.ts` before trusting the oracle fully; a gap here would surface as a silent split-time regression the existing suite can't catch |
| A4 | The `Openings.tsx` `desktopFilterPanelContent`/mobile-drawer duplication is exactly two call sites (one `<FilterPanel>` each); I did not exhaustively check whether the desktop `SidebarLayout` panel config (line 856) or any other render path renders a THIRD copy. | Seam map — Openings.tsx | Low — grep for `<FilterPanel` across the file (2 hits confirmed this session) makes a third hidden call site unlikely, but not impossible if one is behind a dynamic import or conditional spread not caught by a literal-tag grep |

## Open Questions

1. **Does `pages/openings/useOpeningsHandlers.ts` already own some of the 14 handlers listed
   in the Openings seam map, or is it a distinct, older extraction covering different
   handlers?**
   - What we know: the file exists, is imported, and the naming strongly suggests handler
     extraction is already partially done in this codebase.
   - What's unclear: I did not read `useOpeningsHandlers.ts`'s contents this session (budget
     constraint) — the plan's own read should confirm overlap before deciding what's left to
     extract from `Openings.tsx` itself.
   - Recommendation: the `Openings.tsx` plan's first task should read this file to avoid
     re-extracting something already extracted.

2. **How much of `Analysis.tsx`'s 2,037 logic-LOC body is safely splittable vs. genuinely
   needs to stay co-located** (e.g. because two clusters share a ref or a piece of derived state
   neither can compute alone)?
   - What we know: the five clusters identified above are reads/writes I could trace from
     variable names and comment context; several clusters (engine-line reconciliation, gem-sweep)
     clearly consume each other's outputs in sequence.
   - What's unclear: whether extracting each into a SEPARATE hook (rather than, say, two
     of the five into one combined hook) avoids excessive prop-drilling between the extracted
     hooks and the render body — this is a judgment call the ROADMAP explicitly reserves for
     the planner ("likely two plans, hooks/data extraction then render/handler split").
   - Recommendation: the `Analysis.tsx` plan(s) should treat the 5-cluster table as a starting
     hypothesis, not a final design; expect it to collapse to 3-4 hooks in practice given how
     tightly the reconciliation and gem-sweep clusters are coupled (both read `currentNodeId`
     and both feed `moveListMarkers`).

3. **Does the sonarjs `cognitive-complexity` rule need `'error'` severity if it is never added
   to `npm run lint` at all** (the ROADMAP says report-only via a separate `npm run
   lint:cognitive` script)?
   - What we know: a standalone script invocation's own exit code (not eslint's rule severity)
     determines whether `npm run lint:cognitive` fails — `'warn'` vs `'error'` only matters if
     this script is later wired into a gate.
   - What's unclear: whether the planner wants `lint:cognitive` to exit non-zero at all (making
     it CI-checkable even while excluded from the main `lint` script) or to always exit 0 and
     just print a report.
   - Recommendation: use `'error'` severity regardless (so a future decision to gate it needs no
     config change, only a script wiring change) but do NOT add the script to `npm run lint` or
     `.github/workflows/ci.yml` this phase, per the ROADMAP's explicit "not yet" recommendation.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | frontend toolchain | ✓ | matches CI's `node-version: "24"` `[VERIFIED: .github/workflows/ci.yml, read this session]` | — |
| npm | package management | ✓ | — | — |
| eslint | tooling plan (core rules) | ✓ | 10.4.1 `[VERIFIED]` | — |
| eslint-plugin-sonarjs | tooling plan (cognitive complexity) | not yet installed — verified installable and functional this session, then cleanly removed | 4.2.0 confirmed compatible | if it ever failed `audit-ci` or dragged an unacceptable tree (it does neither, verified), the ROADMAP's own fallback is: drop it, record cyclomatic `complexity` only |
| Docker dev DB | not required — this phase touches no backend/DB code | n/a | n/a | n/a |

No missing dependency blocks this phase.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.7 (`[VERIFIED: package.json devDependencies]`) + `@testing-library/react` 16.3.2, jsdom 29.1.1 |
| Config file | none — no `vitest.config.ts`/`test:` block in `vite.config.ts`; each test file opts into jsdom via a per-file `// @vitest-environment jsdom` pragma `[VERIFIED, this session]` |
| Quick run command | `npx vitest run <path-to-test-file(s)>` |
| Full suite command | `npm test` (= `vitest run`) |

### Phase Requirements → Test Map

This phase has no REQ-IDs (none registered in a REQUIREMENTS.md; the ROADMAP's own numbered
Success Criteria 0-5 are the requirements). Mapping success criteria to their automated check:

| Success Criterion | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| 0 | `npm run lint` passes with new rules; four files have no remaining relaxation entries | static/lint | `npm run lint` (from `frontend/`) | ✓ (existing script) |
| 1 | No function in the four files exceeds 100 statements / cyclomatic 15 / depth 4 | static/lint | `npx eslint --no-inline-config --rule 'complexity: ["error",15]' --rule 'max-depth: ["error",4]' --rule 'max-statements: ["error",100]' src/pages/Analysis.tsx src/hooks/useBotGame.ts src/lib/engine/workerPool.ts src/pages/Openings.tsx` | ✓ (this session's own measurement command, reusable as-is) |
| 2 | Full frontend gate + backend gate pass; tests additions-only; `react-hooks/*` warning count unchanged | integration | `npm run lint && npm run build && npm run knip && npm test` (frontend) + backend pre-merge gate | ✓ |
| 2b | `react-hooks/*` warning count unchanged | static | `npx eslint --no-inline-config -f json src \| python3 -c "..."` counting `react-hooks/exhaustive-deps`+`react-hooks/refs` (this session's script — must print exactly 25+3=28 non-test) | ✓ (this session's own script, reusable) |
| 3 | testid/umami inventories identical per file; `git diff --stat` shows only deliberate extractions; no new `eslint-disable`/`@ts-ignore` beyond moved ones | manual + `git diff` | `grep -o 'data-testid="[^"]*"' <file> \| sort` and `grep -o 'data-umami-event="[^"]*"' <file> \| sort`, before/after diff | n/a (shell one-liner) |
| 4 | HUMAN-UAT smoke on Analysis + Openings (desktop + mobile) | manual | N/A — browser smoke per the ROADMAP's own checklist | n/a |
| 5 | CONCERNS.md "Large God files" entry retired/narrowed | manual doc edit | n/a | n/a |

### Sampling Rate
- **Per task commit:** the touched file's own test-module subset (`npx vitest run <modules>`)
  plus `npm run lint`/`npm run build` for that file.
- **Per wave merge:** full frontend gate (`npm run lint && npm run build && npm run knip &&
  npm test`).
- **Phase gate:** full frontend gate + full backend gate (`uv run pytest -n auto -x` etc., per
  root CLAUDE.md's pre-merge gate) green before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `frontend/src/pages/__tests__/Openings.render.test.tsx` (or similarly named) — a NEW
  render-level characterization test covering `OpeningsPage`'s desktop sidebar AND mobile
  drawer (mocked TanStack queries, testid presence for both layouts) — this is the one real
  test-infrastructure gap this phase has; write it BEFORE splitting `Openings.tsx`'s render
  tree, per the ROADMAP's own mandate.
- [ ] No other test-infrastructure gap — `useBotGame.ts`, `workerPool.ts`, and `Analysis.tsx`
  all have adequate existing suites (167/109/85 tests respectively); the framework itself
  (Vitest + RTL + jsdom) needs no new setup.

## Security Domain

This phase is a pure internal refactor of already-shipped client-side React code with no new
network call, no new endpoint, no new form input, no new auth/session code, and no schema
change. None of the OWASP ASVS categories are newly implicated by moving existing, already-
reviewed rendering/state logic between files with unchanged props/return shapes.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Unchanged — no auth code touched |
| V3 Session Management | No | Unchanged |
| V4 Access Control | No | Unchanged — no authorization logic touched |
| V5 Input Validation | No (pre-existing, unchanged) | Same TanStack Query hooks and API client calls at the same boundaries; this phase does not touch a request/response boundary or add a new user-input surface |
| V6 Cryptography | No | Unchanged |

The only security-adjacent risk in scope is **regression risk from the refactor itself** — a
split that silently drops a `Sentry.captureException` call (frontend/CLAUDE.md's manual-fetch
capture rule), changes a `data-umami-event` attribute (breaking outbound-link analytics, not a
security issue but a data-integrity one), or reorders effect timing enough to change what a
`vi.mock`-faked engine protocol receives. This is exactly what the Behavior-Preservation
Hazards section, the mutation-test gates, and "tests may only be added" collectively guard
against — a correctness/reliability concern captured elsewhere in this document, not a new
ASVS-category concern. No new package this phase adds (`eslint-plugin-sonarjs`) executes at
runtime in the shipped application — it is a devDependency consumed only by `eslint`, and its
`postinstall` field is `null` `[VERIFIED: gsd-tools seam signals, this session]`.

## Sources

### Primary (HIGH confidence — tool-verified this session)
- `npx eslint --no-inline-config --rule '...' -f json src` (app-wide and per-file, all four
  rules, all four in-scope files) — baseline counts, exactly reproducing and correcting the
  ROADMAP's own measurement command
- Disposable scratch file inside `frontend/src/` (`__scratch_stmt_test.ts`, deleted, `git
  status --porcelain` confirmed clean before and after) — `max-statements` nested-function
  counting behavior
- `npx vitest run <file(s)>` — timed, passing runs of `Analysis.test.tsx` (85), the 5-module
  `useBotGame` oracle (167), `workerPool.test.ts` (109), `Openings.statsBoard.test.tsx` (16)
- `npm install --no-save eslint-plugin-sonarjs@4.2.0` + a disposable scratch flat-config file
  (`frontend/eslint.config.sonarjs-scratch.mjs`, deleted; `npm uninstall ... --no-save` +
  `package-lock.json` restored from a pre-install backup; `git status --porcelain` confirmed
  clean both before install and after cleanup) — cognitive-complexity baseline, peer-dependency
  compatibility, `audit-ci` non-interference
- `npx audit-ci --config audit-ci.jsonc` — ran twice (with and without the scratch sonarjs
  install) to confirm `"skip-dev": true` neutralizes the dev-tree vulnerability noise
- `gsd_run query package-legitimacy check --ecosystem npm eslint-plugin-sonarjs` — legitimacy
  seam verdict
- `npm view eslint-plugin-sonarjs [version|peerDependencies|...]` — registry cross-check
- Direct `Read` of `frontend/src/pages/Analysis.tsx`, `frontend/src/hooks/useBotGame.ts`,
  `frontend/src/lib/engine/workerPool.ts`, `frontend/src/pages/Openings.tsx`,
  `frontend/src/lib/engine/__tests__/workerPool.test.ts` at the cited line ranges, plus a
  `grep -n` structural survey of every hook/function declaration in all four files — all quoted
  claims above are verbatim from these reads
- `grep -rn "vi.mock.*workerPool"` and direct reads of each factory body — exact per-consumer
  mock shapes
- Direct `Read` of `frontend/eslint.config.js`, `frontend/package.json`,
  `frontend/audit-ci.jsonc`, `frontend/tsconfig.app.json`, `frontend/vite.config.ts`,
  `.github/workflows/ci.yml`, `docs/dev-tooling.md`, `CLAUDE.md`, `frontend/CLAUDE.md`,
  `.planning/ROADMAP.md` (Phase 215 section), `.planning/STATE.md`,
  `.planning/codebase/CONCERNS.md`, and Phase 214's `214-RESEARCH.md`/`214-01-PLAN.md` (for the
  structural pattern this document mirrors)
- `time npm run lint` / `time npm run build` / `time npm run knip` — validation-architecture
  timing figures

### Secondary (MEDIUM confidence)
- None — every claim in this document is either a direct tool-run/file-read this session, or
  explicitly marked `[ASSUMED]`/logged in the Assumptions Log above.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — both tools (eslint core rules, eslint-plugin-sonarjs) verified
  installed/runnable this session with exact version numbers and peer-compatibility checks.
- Architecture/seam maps: HIGH for structural facts (line numbers, hook call sites, test
  counts, mock shapes — all directly grepped/read this session); MEDIUM for the specific
  cluster-boundary recommendations (A2 in Assumptions Log) — directionally correct, not a
  substitute for the planner's own full read of each function body.
- Pitfalls/hazards: HIGH — each is grounded in a specific verified fact (the `npm run lint`
  script content, the `vi.mock` factory bodies, the `UseBotGameState` interface, the
  `noUncheckedIndexedAccess` tsconfig flag), not general React-refactoring folklore.
- Test oracle: HIGH — every count is a fresh, passing `vitest run` from this session, including
  the load-bearing correction to the `workerPool.ts` oracle-strength claim.

**Research date:** 2026-09-03
**Valid until:** 30 days (stable frontend tooling; re-verify if `eslint`/`eslint-plugin-sonarjs`/
`vitest` receive a major version bump before planning executes, or if any in-scope file is
touched by an unrelated commit between now and plan execution)
