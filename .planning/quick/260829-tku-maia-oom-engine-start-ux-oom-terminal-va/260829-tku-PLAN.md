---
phase: quick-260829-tku
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/lib/engine/engineAssetProgress.ts
  - frontend/src/hooks/useEngineAssets.ts
  - frontend/src/lib/engine/maiaWorkerHost.ts
  - frontend/src/components/bots/EngineReadyGate.tsx
  - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
  - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
  - CHANGELOG.md
autonomous: true
requirements: [TKU-01]

estimate:
  tokens: 50000
  raw_tokens: 50000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "When the Maia worker dies from memory exhaustion, `EngineReadyGate` renders a dedicated out-of-memory terminal state whose body tells the user to close other tabs and apps, NOT the existing body that attributes the failure to an interrupted download."
    - "The out-of-memory terminal state still renders exactly one button, Retry, reusing the existing `btn-engine-retry` testid, and clicking it behaves exactly as it does in the generic failed state (clears the store back to idle and calls `onRetry`)."
    - "A generic (non-memory) engine failure — a load failure, an inference failure, an unclassified failure, or a Stockfish pool failure — still renders the existing `engine-gate-failed` copy and Retry, byte-for-byte unchanged."
    - "The terminal-failure Sentry capture reports `engine_failure: 'oom'` when the failure was classified as memory exhaustion, and keeps reporting `engine_failure: 'download'` for every other failure so existing dashboard filters keep working."
    - "Every Sentry message string emitted by the gate remains a fixed literal with no interpolated variables (CLAUDE.md grouping rule)."
    - "`markEngineAssetsRetrying()` clears the recorded failure kind, so a retried-then-differently-failed session never shows stale out-of-memory copy."
    - "`markEngineAssetFailed(id)` called with no failure kind (the Stockfish pool and `useStockfishEngine` call sites) compiles unchanged and produces today's behavior."
    - "No upfront memory detection, no ORT arena tuning, and no WebGPU/backend-selection change is made anywhere (that is SEED-158, explicitly out of scope)."
  artifacts:
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/hooks/useEngineAssets.ts
    - frontend/src/components/bots/EngineReadyGate.tsx
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - CHANGELOG.md
  key_links:
    - "`maiaWorkerHost.ts::failAllLeasesAndDropWorker(err)` is the ONLY place a Maia terminal failure reaches the asset store. Its `err.message` is the raw worker text (built at the `msg.type === 'error'` site as `new Error(msg.message)`), which is exactly the input `classifyMaiaWorkerError()` is written against. Classify there, or the kind never reaches the store."
    - "`classifyMaiaWorkerError()` already exists in `frontend/src/lib/maiaWorkerErrors.ts` and already returns `'oom'` for the real prod string. Reuse it; do NOT write a second pattern list — the module's own doc comment records why a duplicate classifier is the bug it was created to prevent."
    - "The failure kind must live at SNAPSHOT level next to `status`, not inside a per-asset `EngineAssetEntry`. The gate branches on `assets.status === 'failed'`, which is snapshot-level; splitting the two across levels lets them disagree."
    - "`useEngineAssetStatus()` must keep returning a bare primitive. It exists precisely so `Analysis.tsx` bails out via `Object.is` on progress ticks; returning an object from it would resubscribe the 3,600-line page to every download chunk (the G-213-35 regression)."
    - "`resetEngineAssetsForTests()` must clear the new field too, or a failure kind leaks across tests in the same file and produces order-dependent green."
---

<objective>
Give the Maia out-of-memory engine-start failure its own terminal state in
`EngineReadyGate`, so an iPad user who ran out of memory is told to free memory
instead of being told the download broke, and fix the Sentry tag that currently
labels every such failure as a download failure.

Purpose: a real user (FLAWCHESS Sentry, 2026-08-29, iOS 18.7 Mobile Safari) hit
`no available backend found. ERR: [wasm] RangeError: Out of memory` from
onnxruntime while creating the inference session on `/analysis`. The model bytes
were already cached, so the download was never the problem. The gate blamed the
download anyway, the user retried twice against a device that had no memory to
give, and gave up. The classification that would have said so already exists in
`maiaWorkerErrors.ts` — its result is used for a Sentry tag and then thrown away.

Output: a `failureKind` field threaded from the Maia worker host through the
asset store and `useEngineAssets` into a new `oom` terminal variant of the gate,
a corrected `engine_failure` Sentry tag, tests, and a changelog entry.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@frontend/CLAUDE.md
@frontend/src/lib/maiaWorkerErrors.ts
@frontend/src/lib/engine/engineAssetProgress.ts
@frontend/src/hooks/useEngineAssets.ts
@frontend/src/components/bots/EngineReadyGate.tsx
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: Thread the failure kind from the Maia worker host to a new oom terminal state in the gate</name>
  <files>
    frontend/src/lib/engine/engineAssetProgress.ts,
    frontend/src/hooks/useEngineAssets.ts,
    frontend/src/lib/engine/maiaWorkerHost.ts,
    frontend/src/components/bots/EngineReadyGate.tsx,
    frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
  </files>
  <read_first>
    frontend/src/lib/maiaWorkerErrors.ts (the whole file — `MaiaFailureKind`, `classifyMaiaWorkerError`, and the doc comment explaining why a second classifier must never be written),
    frontend/src/lib/engine/engineAssetProgress.ts lines 112-165 (the singleton state block and the `refreshSnapshot`/`notifyListeners`/`commit` split) and lines 294-380 (`markEngineAssetsUnsupported`, `markEngineAssetFailed`, `resetEngineAssetForRefetch`, `markEngineAssetsRetrying`) and lines 442-451 (`resetEngineAssetsForTests`),
    frontend/src/hooks/useEngineAssets.ts lines 31-104 (`EngineAssetsState`, the `useMemo` body, and `useEngineAssetStatus`'s primitive contract),
    frontend/src/lib/engine/maiaWorkerHost.ts lines 540-627 (the `msg.type === 'error'` branch and `failAllLeasesAndDropWorker`),
    frontend/src/components/bots/EngineReadyGate.tsx lines 109-150 (the Sentry message constants, `TerminalVariant`, `TERMINAL_COPY`) and lines 242-333 (the D-17 capture effect and the terminal-state render branch)
  </read_first>
  <behavior>
    This task is the one end-to-end path, wired through every layer it touches,
    driven by a single new test in `EngineReadyGate.test.tsx`:

    - Given `markEngineAssetFailed('maia-model', 'oom')` on the real store,
      the gate (both `surface="bots"` and `surface="analysis"`) renders the new
      out-of-memory testid, its title, and a body that tells the user to close
      other tabs and apps; it does NOT render the `engine-gate-failed` testid.
    - That same render still exposes exactly one button, found by the existing
      `btn-engine-retry` testid, and clicking it calls `onRetry` once and clears
      the terminal state (identical to the existing failed-state assertion at
      `EngineReadyGate.test.tsx` line 322).
    - That same render captures exactly one Sentry exception whose tags include
      `source: 'engine-ready-gate'` and `engine_failure: 'oom'`, and whose
      message is a fixed literal (no device string, no worker text).
  </behavior>
  <action>
Wire the failure classification through all four layers. Work outward from the
store so each layer compiles against the one below it.

1. `frontend/src/lib/engine/engineAssetProgress.ts`
   - Import the type only: `import type { MaiaFailureKind } from '@/lib/maiaWorkerErrors';`.
     Reuse that union rather than declaring a parallel one — it is the exact
     output type of the classifier that produces these values. Add a short doc
     note that the store is engine-generic while the classifier is Maia-specific,
     and that Stockfish call sites therefore pass nothing.
   - Add `failureKind: MaiaFailureKind | null` to `EngineAssetsSnapshot`, backed
     by a new module-level `let currentFailureKind: MaiaFailureKind | null = null;`
     declared beside `currentStatus`. Include it in `refreshSnapshot()`'s object
     literal and in `cachedSnapshot`'s initializer, so the field can never be
     absent from a snapshot.
   - Widen the signature to `markEngineAssetFailed(id: EngineAssetId, failureKind?: MaiaFailureKind): void`.
     The parameter is OPTIONAL so the three existing call sites keep compiling
     and keep today's behavior untouched. Inside, set
     `currentFailureKind = failureKind ?? currentFailureKind;`. Document that
     precedence explicitly: a classified failure wins, and a later UNclassified
     failure (say the Stockfish pool giving up on a device that is already out of
     memory) must not erase a classification the gate is about to read. The only
     exit from a terminal failure is Retry, which clears the field, so there is
     no stale-state window.
   - In `markEngineAssetsRetrying()`, reset `currentFailureKind = null;` before
     `commit()`, alongside the existing `currentStatus = 'idle'`. Same reset in
     `resetEngineAssetsForTests()`.
   - Leave `markEngineAssetsUnsupported()`, `reportEngineAssetProgress()` and
     `resetEngineAssetForRefetch()` alone: the unsupported branch is checked
     first by the gate, and the other two are not failure transitions.

2. `frontend/src/hooks/useEngineAssets.ts`
   - Add `failureKind: MaiaFailureKind | null` to `EngineAssetsState` and return
     `snapshot.failureKind` from the `useMemo` body. It is read straight off the
     snapshot, so it needs no derivation.
   - Do NOT touch `useEngineAssetStatus()`. It must keep returning a bare
     primitive so `Analysis.tsx` continues to bail out on progress ticks.

3. `frontend/src/lib/engine/maiaWorkerHost.ts`
   - Add `classifyMaiaWorkerError` to the existing
     `import { captureMaiaWorkerError, type MaiaErrorSource } from '@/lib/maiaWorkerErrors';`.
   - In `failAllLeasesAndDropWorker(err)`, pass the classification through:
     `markEngineAssetFailed('maia-model', classifyMaiaWorkerError(err.message));`.
     Keep the surrounding `getEngineAssetsSnapshot().status !== 'unsupported'`
     guard exactly as it is. Add a bug-fix comment at the call site (CLAUDE.md
     rule) recording that the classification used to stop at the Sentry tag, so
     a session-init memory exhaustion reached the user as download-failure copy.

4. `frontend/src/components/bots/EngineReadyGate.tsx`
   - Widen `TerminalVariant` to `'unsupported' | 'failed' | 'oom'` and add an
     `oom` entry to `TERMINAL_COPY` with `testId: 'engine-gate-oom'`. Copy, in
     the surrounding style, no em-dashes, no jargon:
     title `'Your device ran out of memory'`;
     body `'The engine files downloaded fine, but your device did not have enough free memory to start the engine. Close your other browser tabs and apps to free some up, then try again.'`
     Add a comment on the entry explaining why this variant keeps Retry while
     `unsupported` does not: freeing memory is something the user can actually
     do, and on the analysis surface `onRetry` is a full page reload, which also
     releases the failed attempt's wasm heap.
   - Pick the variant in the terminal branch (currently
     `const variant: TerminalVariant = assets.status;`): keep `'unsupported'`
     when the status says so, otherwise choose `'oom'` when
     `assets.failureKind === 'oom'` and `'failed'` in every other case
     (`'load'`, `'inference'`, and `null`).
   - Change the Retry footer condition from `variant === 'failed'` to
     `variant !== 'unsupported'`, so both failure variants render the same
     single Retry button under its existing `btn-engine-retry` testid. Do not
     add a second button or a second testid.
   - Add `const SENTRY_MESSAGE_OOM = 'Engine cold start: device ran out of memory starting the engine';`
     beside the two existing message constants, and a matching named constant
     pair for the tag values so the tag strings are not bare literals at the
     call site. In the D-17 capture effect, keep the single
     `failedCapturedRef`-guarded branch and select message + tag together from
     the same variant decision as the render: memory exhaustion reports the new
     message with tag `'oom'`; every other failure keeps the existing message
     and the existing `'download'` tag value verbatim, so current Sentry
     dashboard filters keep matching. Both messages stay fixed literals with no
     interpolation. Extend the effect's dependency array to include the failure
     kind alongside `assets.status`.
   - Refactor the variant decision into one small helper if the component body
     grows awkward, but do not restructure the four-state render.

5. `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx`
   - Add the end-to-end test described in `<behavior>`, driving the REAL store
     (the file's existing convention — it never mocks `useEngineAssets`). Follow
     the existing `describe.each([['bots'], ['analysis']] as const)` pattern so
     both mount surfaces are asserted explicitly rather than one being assumed.
     Reuse the file's existing `Sentry.captureException` mock and the
     `expect.objectContaining` assertion shape already used at line 464.
  </action>
  <verify>
    <automated>( cd frontend && npx vitest run src/components/bots/__tests__/EngineReadyGate.test.tsx )</automated>
  </verify>
  <done>
    `markEngineAssetFailed('maia-model', 'oom')` renders the out-of-memory
    title, body, and a working Retry button on both surfaces, and captures a
    single Sentry exception tagged `engine_failure: 'oom'` with a fixed message.
    The whole `EngineReadyGate.test.tsx` file passes, including its pre-existing
    generic-failed, unsupported, telemetry, and auto-close tests.
  </done>
</task>

<task type="auto">
  <name>Task 2: Cover the store transitions and lock the generic-failure path against regression</name>
  <files>
    frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts,
    frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
  </files>
  <read_first>
    frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts lines 1-40 (imports and the `beforeEach` reset) and lines 286-345 (the existing `markEngineAssetFailed` and `markEngineAssetsRetrying` describes whose patterns these tests must follow),
    frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx lines 308-340 (the existing failed-state test) and lines 448-476 (the two existing Sentry terminal-capture tests)
  </read_first>
  <action>
Broaden coverage around the new field. Do not duplicate
`frontend/src/lib/maiaWorkerErrors.test.ts`, which already covers classification
of the raw prod string into `oom`/`load`/`inference` — these tests are about
transport and rendering, not pattern matching.

In `engineAssetProgress.test.ts`, extend the existing
`markEngineAssetFailed` describe (do not start a parallel one):
- Calling it WITH a kind records that kind on the snapshot alongside
  `status: 'failed'`, and does not disturb the asset's prior byte progress.
- Calling it WITHOUT a kind leaves the recorded kind null and reproduces
  today's behavior, which is what the Stockfish pool and `useStockfishEngine`
  call sites rely on.
- A classified failure followed by an unclassified one on a DIFFERENT asset
  keeps the classification (the precedence rule documented in Task 1).

In the existing `markEngineAssetsRetrying` describe:
- Retrying after a classified failure clears the kind back to null while the
  existing status/byte/seen-flag assertions in that describe still hold.

In `EngineReadyGate.test.tsx`:
- Add a regression test asserting that a failure classified `'load'` (and
  separately, one with no kind at all) still renders the pre-existing
  `engine-gate-failed` testid, its unchanged title and body, and its Retry
  button — this is the guard that the new branch did not swallow the generic
  path. Assert the body text through the existing `engine-gate-failed` testid
  rather than by asserting the absence of the new copy.
- Update the existing Sentry failed-state test (line 464) so it pins the
  generic path to the `'download'` tag value explicitly, making a future silent
  retag a test failure rather than a dashboard mystery.
  </action>
  <verify>
    <automated>( cd frontend && npx vitest run src/lib/engine/__tests__/engineAssetProgress.test.ts src/components/bots/__tests__/EngineReadyGate.test.tsx src/lib/maiaWorkerErrors.test.ts )</automated>
  </verify>
  <done>
    All three test files pass. The store's recorded failure kind is asserted on
    set, on absent-argument, on precedence, and on retry-clear; the generic
    failed variant and its `'download'` Sentry tag are pinned by explicit
    assertions.
  </done>
</task>

<task type="auto">
  <name>Task 3: Run the frontend pre-merge gate and record the user-facing change</name>
  <files>CHANGELOG.md</files>
  <read_first>
    CHANGELOG.md (the `## [Unreleased]` section and the bullet style of the entries directly under it)
  </read_first>
  <action>
Run the frontend half of CLAUDE.md's pre-merge gate and fix whatever it reports.
`npm run lint` and `npm test` do NOT type-check (esbuild strips types), and this
change widens an exported interface (`EngineAssetsState`) and a widely-imported
function signature (`markEngineAssetFailed`), so `npm run build` is mandatory
here, not optional. Knip also runs in CI and fails on dead exports, so confirm
every new export is actually imported somewhere.

If any step reports a problem in a file this plan already touched, fix it in
place. If it reports a pre-existing problem in an untouched file, do not fix it
inside this task — note it in the summary instead.

Then append one user-facing bullet under `## [Unreleased]` in `CHANGELOG.md`,
matching the surrounding bullet style: an engine that cannot start because the
device is out of memory now says so and tells the user to free memory, instead
of blaming the download. Keep it to one line, no em-dashes.
  </action>
  <verify>
    <automated>( cd frontend && npm run lint && npm run build && npm run knip && npm test -- --run )</automated>
  </verify>
  <done>
    Lint, the TypeScript build, knip, and the full frontend vitest suite all
    pass, and `CHANGELOG.md` has a one-line `## [Unreleased]` bullet describing
    the new out-of-memory message.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Web Worker to main thread | `maia-worker.js` posts a `type: 'error'` message whose `message` field is attacker-uninfluenced third-party runtime text, but is still untrusted string data crossing into the host. |
| Browser to Sentry | The gate's terminal-failure capture sends a message, tags, and a device context off-device. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-tku-01 | Information disclosure | `EngineReadyGate` Sentry capture | low | mitigate | Messages stay fixed literals and tag values stay a closed set of two (`'oom'`, `'download'`) derived from `MaiaFailureKind`; the raw worker string is never routed into the gate's message, tag, or copy. It continues to reach Sentry only via `captureMaiaWorkerError`'s existing `contexts.maia`. |
| T-tku-02 | Tampering | `markEngineAssetFailed` failure kind | low | accept | The kind is a value from a three-member union produced by an in-process classifier; it selects between two static copy blocks and is never rendered as data, so no injection surface exists. |
| T-tku-03 | Denial of service | Retry on the out-of-memory variant | low | accept | Retry on an out-of-memory device may fail again, which is why the copy tells the user to free memory first. Retry is user-initiated only, with no auto-retry loop added, so no additional resource pressure is introduced beyond what today's generic failed state already allows. |

No package-manager installs are introduced by this plan, so no package legitimacy gate applies.
</threat_model>

<verification>
- `( cd frontend && npm run lint && npm run build && npm run knip && npm test -- --run )` passes.
- `markEngineAssetFailed('maia-model', 'oom')` renders `engine-gate-oom` with the
  free-memory guidance and exactly one `btn-engine-retry` button, on BOTH the
  `bots` and `analysis` surfaces.
- An unclassified or `'load'`-classified failure still renders `engine-gate-failed`
  with its existing title and body, unchanged.
- The gate's terminal Sentry captures use fixed literal messages, tag
  `engine_failure: 'oom'` for the memory case and `engine_failure: 'download'`
  for every other failure.
- `git diff --stat` touches only the seven files in `files_modified`. No change
  to backend, to ORT/WebGPU backend selection, or to any memory-detection code
  (SEED-158 stays out of scope).
</verification>

<success_criteria>
- All eight `must_haves.truths` hold.
- The frontend pre-merge gate is green.
- `CHANGELOG.md` carries a one-line `## [Unreleased]` bullet for the change.
- The one classification implementation in `maiaWorkerErrors.ts` remains the
  only one in the codebase.
</success_criteria>

<output>
Create `.planning/quick/260829-tku-maia-oom-engine-start-ux-oom-terminal-va/260829-tku-SUMMARY.md` when done
</output>
