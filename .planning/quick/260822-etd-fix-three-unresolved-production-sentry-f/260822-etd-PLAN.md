---
phase: quick-260822-etd
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/lib/engine/workerPool.ts
  - frontend/src/lib/engine/__tests__/workerPool.test.ts
  - frontend/src/lib/swUpdate.ts
  - frontend/src/lib/__tests__/swUpdate.test.ts
  - frontend/src/main.tsx
  - frontend/src/hooks/usePushCapability.ts
  - frontend/src/hooks/__tests__/usePushCapability.test.tsx
  - CHANGELOG.md
autonomous: true
requirements: [FLAWCHESS-9G, FLAWCHESS-91, FLAWCHESS-9P]

estimate:
  tokens: 90000
  raw_tokens: 60000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "A grading watchdog whose timer fires far past its wall-clock deadline (page/tab suspension) re-arms instead of killing the slot: no `stop` posted, no Sentry capture, request left in flight, slot still dispatchable."
    - "A grading watchdog that fires roughly on time still kills the slot exactly as today (posts `stop`, marks dead, one static Sentry capture, resolves empty)."
    - "Suspend re-arms are bounded, so a genuinely wedged worker on a repeatedly suspended page still reaches the kill path."
    - "A rejecting `reg.update()` can never escape as an unhandled promise rejection; `InvalidStateError` is swallowed silently, anything else reaches Sentry."
    - "The VAPID queryFn cannot resolve `undefined` for any 2xx body shape — a malformed body resolves `null` (the existing 'push unconfigured' path) and produces no QueryCache Sentry capture."
  artifacts:
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/lib/swUpdate.ts
    - frontend/src/lib/__tests__/swUpdate.test.ts
    - frontend/src/hooks/usePushCapability.ts
    - frontend/src/hooks/__tests__/usePushCapability.test.tsx
  key_links:
    - "`sendGo` stamps `armedAtMs` / resets the re-arm counter -> `fireWatchdog` reads both to choose re-arm vs kill."
    - "`main.tsx` interval + visibilitychange + focus listeners all call the SAME extracted, try/catch-wrapped checker from `frontend/src/lib/swUpdate.ts`."
    - "`usePushCapability` queryFn -> global `QueryCache.onError` in `frontend/src/lib/queryClient.ts` (the Sentry path this fix must stop feeding)."
---

<objective>
Fix three unresolved production frontend Sentry issues, one per task, one commit each.

- FLAWCHESS-9G — Stockfish grading watchdog false-fires on page/tab suspension and permanently shrinks the worker pool.
- FLAWCHESS-91 — `checkForSwUpdate` leaks an unhandled promise rejection on the benign WebKit `InvalidStateError: newestWorker is null`.
- FLAWCHESS-9P — `usePushCapability`'s queryFn can resolve `undefined` on a malformed 2xx body, which TanStack Query turns into a thrown `["push","vapid-key"] data is undefined`.

Purpose: stop three recurring false-positive error reports and, for 9G, stop a real throughput regression (a spurious watchdog fire kills a pool slot for the rest of the session).
Output: three behavior fixes, each with a load-bearing regression test that goes RED when the fix is reverted, plus a `CHANGELOG.md` entry.

Scope discipline: frontend only, these three defects only. No backend changes, no unrelated refactors.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@CLAUDE.md
@frontend/src/lib/engine/workerPool.ts
@frontend/src/lib/engine/__tests__/workerPool.test.ts
@frontend/src/main.tsx
@frontend/src/hooks/usePushCapability.ts
@frontend/src/lib/queryClient.ts
</context>

<key_facts>
Verified during planning — do not re-derive:

- `frontend/src/lib/engine/workerPool.ts` (865 lines). `PoolWorkerSlot` is declared around line 128 and already carries `watchdogTimer`. `clearSlotWatchdog` ~470, `fireWatchdog` ~486, `armStopWatchdog` ~515, `fireStopWatchdog` ~534, `sendGo` ~547 (arms the grading watchdog on its last line), `createSlot` ~652 (slot literal to extend). Constants live in a `Tunable constants` block with long explanatory doc comments — `GRADING_WATCHDOG_TIMEOUT_MS = 60_000` (~line 91) and `STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS = 10_000` (~line 107). Match that comment style.
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` (1761 lines) already has the harness: `vi.mock('@sentry/react', () => ({ captureException: vi.fn() }))`, `MockWorker` with `simulateMessage`/`simulateError`, `stubWorkerCtor()`, `driveInit(worker)`, `stubDesktopSizing(6)` (→ 4 slots), and a `describe('createWorkerPool: watchdog (D-06)')` block (~line 516) using `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(...)`. A `let settled = false; promise.then(() => { settled = true })` pattern is already used at ~line 728. REUSE all of this — do not build a second harness.
- Vitest fake timers here also fake `Date`, and `vi.setSystemTime` is an established convention in this repo (`frontend/src/hooks/__tests__/useBotGame.test.ts:744,1650,1899`).
- `frontend/src/main.tsx` is NOT unit-testable: it calls `createRoot(document.getElementById("root")!).render(<App/>)` at module scope, so importing it renders the whole app. It already imports `* as Sentry from "@sentry/react"` (line 4).
- `pushApi.getVapidPublicKey()` (`frontend/src/api/client.ts:305`) is typed `Promise<VapidPublicKeyResponse>` where `VapidPublicKeyResponse = { application_server_key: string }` (`frontend/src/types/push.ts:25`). The backend can only return that shape or a 404 — the observed `undefined` comes from a non-conforming 2xx body (extension/proxy stub).
- eslint here uses `tseslint.configs.recommended` (NOT type-checked), so `@typescript-eslint/no-unnecessary-condition` is off: runtime narrowing of a statically-`string` value lints clean.
- `npm test` is already `vitest run`. Knip runs in CI; every new export must be imported somewhere (test files count as importers).
- `CHANGELOG.md` `## [Unreleased]` already has a `### Fixed` subsection (~line 49).
</key_facts>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Make the grading watchdog suspend-aware (FLAWCHESS-9G)</name>
  <files>frontend/src/lib/engine/workerPool.ts, frontend/src/lib/engine/__tests__/workerPool.test.ts</files>
  <behavior>
Write these tests FIRST, inside the existing `describe('createWorkerPool: watchdog (D-06)')` block, reusing its `beforeEach`/`afterEach` and helpers. Tests 1 and 3 MUST be RED against the current code.

- Test 1 (RED pre-fix) — "a watchdog timer that fires far past its deadline is treated as page suspension: re-armed, not killed":
  create the pool, `pool.grade(TEST_FEN, ['e7e5'])`, `driveInit(createdWorkers[0])`, track settlement with `let settled = false; gradePromise.then(() => { settled = true })`.
  Jump the clock WITHOUT running timers: `vi.setSystemTime(Date.now() + GRADING_WATCHDOG_TIMEOUT_MS * 2)`, then `await vi.advanceTimersByTimeAsync(GRADING_WATCHDOG_TIMEOUT_MS)` to fire it.
  Assert: `Sentry.captureException` not called; `worker.messages` does NOT contain `'stop'`; `settled` is `false`.
  Then prove the slot is still alive and still owns the request: `worker.simulateMessage('info depth 14 multipv 1 score cp 5 nodes 1000 pv e7e5')`, `worker.simulateMessage('bestmove e7e5')`, `await gradePromise` → result `.size` is 1 and `.has('e7e5')` (do not assert an exact cp value).
- Test 2 (guard, green both before and after) — "a near-on-time fire still kills the slot": same setup but jump only `10_000` before advancing. Rationale to put in a test comment: under fake-timer semantics the observed elapsed is either exactly `GRADING_WATCHDOG_TIMEOUT_MS` or `GRADING_WATCHDOG_TIMEOUT_MS + 10_000`, both below the `* GRADING_WATCHDOG_SUSPEND_FACTOR` threshold, so this must take today's kill path. Assert `'stop'` posted, exactly one `Sentry.captureException` with message `'Stockfish worker pool: grading watchdog timeout'`, and the promise resolves with an empty Map.
- Test 3 (RED pre-fix) — "suspend re-arms are bounded": loop `MAX_WATCHDOG_SUSPEND_REARMS + 1` times, each iteration `vi.setSystemTime(Date.now() + GRADING_WATCHDOG_TIMEOUT_MS * 2)` then `await vi.advanceTimersByTimeAsync(GRADING_WATCHDOG_TIMEOUT_MS)`. Assert that after the first `MAX_WATCHDOG_SUSPEND_REARMS` iterations `settled` is still `false` and Sentry has zero calls, and that the final iteration takes the kill path (exactly one capture, promise resolves empty).
  </behavior>
  <action>
Import `MAX_WATCHDOG_SUSPEND_REARMS` and `GRADING_WATCHDOG_SUSPEND_FACTOR` into the test file alongside the existing `GRADING_WATCHDOG_TIMEOUT_MS` import so the tests are expressed in the constants, never in bare numbers.

Then implement in `frontend/src/lib/engine/workerPool.ts`:

1. Add two exported constants next to `GRADING_WATCHDOG_TIMEOUT_MS` in the tunable-constants block, each with a doc comment in the surrounding style naming the failure mode it guards (a backgrounded mobile tab suspends the page AND its workers; on resume the elapsed `setTimeout` fires immediately even though the worker never received CPU, and today that permanently kills a healthy slot). Name them `GRADING_WATCHDOG_SUSPEND_FACTOR` (value `1.5`, the multiple of the timeout past which a fire is attributed to suspension rather than a wedged worker) and `MAX_WATCHDOG_SUSPEND_REARMS` (value `3`, the per-dispatch cap that keeps a genuinely wedged worker on a repeatedly suspended page from re-arming forever). No bare numbers anywhere else.
2. Extend `PoolWorkerSlot` with `armedAtMs: number` (wall-clock stamp of the moment the grading watchdog was armed; only meaningful while a grading watchdog is in flight) and `watchdogSuspendRearms: number` (suspend re-arms consumed by the current dispatch). Document both in the same one-line-comment style as the existing fields. Initialize them to `0` in the `createSlot` slot literal.
3. In `sendGo`, on the line that arms the timer, also set `slot.armedAtMs = Date.now()` and reset `slot.watchdogSuspendRearms = 0`. A fresh dispatch is the only place the counter resets.
4. At the top of `fireWatchdog` (after the existing `slot.watchdogTimer = null`), add the suspension branch before anything else runs:
   compute `const elapsedMs = Date.now() - slot.armedAtMs;` and if `elapsedMs > GRADING_WATCHDOG_TIMEOUT_MS * GRADING_WATCHDOG_SUSPEND_FACTOR && slot.watchdogSuspendRearms < MAX_WATCHDOG_SUSPEND_REARMS`, then increment `slot.watchdogSuspendRearms`, re-stamp `slot.armedAtMs = Date.now()`, re-arm `slot.watchdogTimer = setTimeout(() => fireWatchdog(slot), GRADING_WATCHDOG_TIMEOUT_MS)`, and `return`. No `stop` post, no `dead`, no `isReady` change, no Sentry capture, no resolve. Keep this a single guard clause (nesting depth 1) and let everything below it stay byte-identical to today's kill path.
5. Add a bug-fix comment at that branch naming FLAWCHESS-9G: what broke (4 events over 20 days, 3 of 4 on mobile browsers, all on /analysis), why it is a false positive (page freeze, not a wedged worker), and the cost of the old behavior (`dead` is never cleared until `terminate()`, so one spurious fire permanently shrinks the pool for the rest of the session).

Explicit non-goal, state it in one line of that comment: `fireStopWatchdog` / `armStopWatchdog` semantics are deliberately left unchanged — a slot in `'stopping'` has already been sent `stop` and its request is being abandoned, and no production Sentry event points at that path. Do not touch `clearSlotWatchdog`.
  </action>
  <verify>
    <automated>cd frontend &amp;&amp; npx vitest run src/lib/engine/__tests__/workerPool.test.ts</automated>
    <human-check>Before committing, revert ONLY the `fireWatchdog` suspension branch and confirm tests 1 and 3 go RED, then restore it.</human-check>
  </verify>
  <done>All workerPool tests pass. A late-firing watchdog re-arms silently up to `MAX_WATCHDOG_SUSPEND_REARMS` times and keeps the slot dispatchable; an on-time fire and an over-budget re-arm both still kill the slot and capture to Sentry exactly once. Committed as a single `fix(...)` commit.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Extract and harden the service-worker update check (FLAWCHESS-91)</name>
  <files>frontend/src/lib/swUpdate.ts, frontend/src/lib/__tests__/swUpdate.test.ts, frontend/src/main.tsx</files>
  <behavior>
`main.tsx` is not unit-testable (module-scope `createRoot(...).render(<App/>)`), so take option (a) from the brief: extract the checker into `frontend/src/lib/swUpdate.ts` and test it there. The extraction is cheap and `main.tsx` keeps only the wiring.

Tests in `frontend/src/lib/__tests__/swUpdate.test.ts` (jsdom, `vi.mock('@sentry/react', () => ({ captureException: vi.fn() }))` per the workerPool convention; stub `navigator.serviceWorker.getRegistration` with `vi.stubGlobal`/`Object.defineProperty`):

- (RED pre-fix, once the checker is extracted un-hardened) `reg.update()` rejecting with a `DOMException`-shaped `InvalidStateError` → `await expect(check()).resolves.toBeUndefined()` and `Sentry.captureException` NOT called. A rejected promise from this fire-and-forget function IS the production unhandled rejection, so `.resolves` is the load-bearing assertion.
- An unexpected error (e.g. `new TypeError('boom')`) → the promise still resolves, and `Sentry.captureException` is called exactly once with `{ tags: { source: <the chosen source tag> } }`.
- `getRegistration()` itself rejecting is caught the same way (the try must cover both awaits).
- No registration (`getRegistration()` resolves `undefined`) → resolves, no capture, no throw.
- Debounce preserved: a second call within `SW_UPDATE_DEBOUNCE_MS` does not call `getRegistration` again; and a call whose `update()` threw still consumed the debounce slot (assert the immediately-following call is a no-op). Pin the current behavior — do not change it.
  </behavior>
  <action>
Create `frontend/src/lib/swUpdate.ts` containing, moved verbatim from `main.tsx` except where noted:

- `export const SW_UPDATE_INTERVAL_MS` and `SW_UPDATE_DEBOUNCE_MS` with their existing comments.
- `export function createSwUpdateChecker(): () => Promise<void>` — a factory closing over `lastUpdateCheckMs` (a factory, not a module-scoped variable, so each test starts from clean debounce state). Body: the existing debounce guard, then `try { const reg = await navigator.serviceWorker.getRegistration(); await reg?.update(); } catch (error) { ... }`.
- Catch body: return early for the expected condition, otherwise `Sentry.captureException(error, { tags: { source: 'sw-update' } })`. Detect the expected condition with a small module-private helper that duck-types the name rather than using `instanceof DOMException` (realm-fragile, and jsdom/WebKit differ): treat a non-null object whose `name` is `'InvalidStateError'` as expected. Keep the literal in a named constant.
- Rationale to record in the doc comment: swallowing everything would hide real regressions, so only the known-benign WebKit condition is swallowed (CLAUDE.md "skip expected failures"); anything else is a genuine bug and still reaches Sentry, now as a `handled: yes` capture instead of a global unhandled rejection.
- Bug-fix comment at the catch naming FLAWCHESS-91: 3 events over 29 days, all Mobile Safari/iOS, mechanism `auto.browser.global_handlers.onunhandledrejection` with `handled: no`, caused by wiring an unawaited async function straight into `setInterval`/`addEventListener`; `newestWorker is null` is benign (`update()` called while the registration momentarily has no worker, mid-unregister/mid-replace).

In `main.tsx`: delete the moved constants and the inline `checkForSwUpdate`, import `createSwUpdateChecker` and `SW_UPDATE_INTERVAL_MS` from `@/lib/swUpdate`, and create the checker once (`const checkForSwUpdate = createSwUpdateChecker();`) inside the existing `if ("serviceWorker" in navigator)` block so all three call sites (`setInterval`, `visibilitychange`, `focus`) share one debounce slot exactly as today. Leave the `controllerchange` reload block untouched. Do not change the surrounding explanatory comment about Android freezing backgrounded PWAs — move it with the code it describes.
  </action>
  <verify>
    <automated>cd frontend &amp;&amp; npx vitest run src/lib/__tests__/swUpdate.test.ts</automated>
    <human-check>Before committing, remove the try/catch and confirm the `InvalidStateError` test goes RED, then restore it.</human-check>
  </verify>
  <done>`swUpdate.test.ts` passes. `main.tsx` wires the three call sites to the extracted checker, and no rejection path from `getRegistration()`/`update()` can escape. Committed as a single `fix(...)` commit.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Validate the VAPID response shape, changelog, and run the frontend gate (FLAWCHESS-9P)</name>
  <files>frontend/src/hooks/usePushCapability.ts, frontend/src/hooks/__tests__/usePushCapability.test.tsx, CHANGELOG.md</files>
  <behavior>
Tests in `frontend/src/hooks/__tests__/usePushCapability.test.tsx` (jsdom, `renderHook` + `QueryClientProvider`). Two mocks are required: `vi.mock('@/lib/push', ...)` returning `isPushSupported: () => true` and `readPermission: () => 'default'` (jsdom has no PushManager, so the query would otherwise be disabled), and `vi.mock('@/api/client', ...)` preserving the real module via `importActual` and overriding `pushApi.getVapidPublicKey` (mirrors `frontend/src/hooks/__tests__/useReadiness.test.tsx`). Keep `axios` real.

The wrapper's `QueryClient` MUST be built with `new QueryCache({ onError: onErrorSpy })` — that spy stands in for the production global capture in `frontend/src/lib/queryClient.ts` and is the load-bearing assertion.

- (RED pre-fix) 2xx body `{}` → `waitFor` until `isResolved`, then `vapidPublicKey` is `null`, `available` is `false`, and `onErrorSpy` was NOT called.
- (RED pre-fix) 2xx body `''` (empty string — the exact shape from the triage, where `''.application_server_key` is `undefined`) → same assertions.
- 2xx body `{ application_server_key: '' }` → `null`, `available` false, no capture.
- Happy path `{ application_server_key: 'BKxyz' }` → `vapidPublicKey` is `'BKxyz'` and `available` is `true`.
- 404 (an `AxiosError` carrying `response.status === 404`) → `null`, no capture. The existing D-12 branch must be untouched.
- A genuine failure (500 `AxiosError`, or a plain `Error`) → still rethrown: `onErrorSpy` IS called.
  </behavior>
  <action>
In `frontend/src/hooks/usePushCapability.ts`, add a module-private runtime shape guard above the hook, e.g. `function readVapidKey(response: unknown): string | null` that returns `null` unless `response` is a non-null object whose `application_server_key` is a non-empty string. Take `unknown` so the statically-typed `VapidPublicKeyResponse` argument is assignable with no cast, and so a `null`/string/HTML body cannot throw on property access. Keep nesting at depth 1 (guard clause then a single return).

Change the queryFn to `queryFn: async (): Promise<string | null> => { ... return readVapidKey(await pushApi.getVapidPublicKey()); ... }` — the explicit return type plus the guard make the function provably incapable of resolving `undefined`. Leave the `catch` block exactly as it is: the 404 branch still returns `null`, everything else still rethrows. Do NOT widen or otherwise edit `VapidPublicKeyResponse` in `frontend/src/types/push.ts`.

Add a bug-fix comment at the guard naming FLAWCHESS-9P: 2 events over 13 days, `/library/games`, Firefox/Linux; TanStack Query throws `<queryHash> data is undefined` when a queryFn resolves `undefined`; the backend cannot produce that (`app/routers/push.py` returns a Pydantic model or a 404), so the trigger is a 2xx whose body is not the expected JSON object (a browser extension or intermediary stub), and `''.application_server_key` yields `undefined` rather than throwing. Note that a malformed body now takes the same "push unconfigured" path as the 404 (D-12 / UI-SPEC E6) instead of feeding the global `QueryCache.onError` capture.

Then add one terse, user-facing bullet under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md` covering all three fixes together — e.g. analysis on mobile no longer permanently loses an engine worker when the tab is backgrounded and returned to, and two harmless browser conditions (a service-worker update check on iOS, a blocked push-key request) no longer surface as errors. No issue IDs, no internal function names, no em-dash pileup.

Finally run the full frontend gate (the build is required — `npm run lint`/`npm test` do not type-check, and Task 1 changed a shared interface).
  </action>
  <verify>
    <automated>cd frontend &amp;&amp; npm run lint &amp;&amp; npm test -- --run &amp;&amp; npm run build</automated>
    <human-check>Before committing, revert the `readVapidKey` call in the queryFn and confirm the `{}` and `''` tests go RED with the TanStack "data is undefined" error, then restore it.</human-check>
  </verify>
  <done>The full frontend gate is green (lint, all tests, `tsc -b` + vite build). A malformed 2xx VAPID body resolves `null` with no Sentry capture; 404 and genuine-error behavior are unchanged. `CHANGELOG.md` has the `### Fixed` bullet. Committed as a single `fix(...)` commit.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser → API (`GET /push/vapid-public-key`) | Pre-existing. This change only makes the client stricter about the response shape it accepts. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-260822-01 | Information disclosure | Sentry captures added/kept in `swUpdate.ts` and `workerPool.ts` | low | mitigate | Messages stay static with no interpolated user/position data (existing CLAUDE.md Sentry grouping rule); the new capture passes the caught error only. |
| T-260822-02 | Tampering | `usePushCapability` VAPID key handling | low | mitigate | A non-conforming 2xx body (extension/proxy stub) is now rejected as "unconfigured" instead of flowing onward as an unvalidated value. |

No package-manager installs in this task, so no package-legitimacy gate applies.
</threat_model>

<verification>
- `cd frontend && npm run lint && npm test -- --run && npm run build` all green (Task 3).
- Each of the three fixes has at least one test that goes RED when only that fix is reverted (per-task human-check).
- No backend file modified: `git diff --name-only main -- app/ tests/ alembic/` is empty.
</verification>

<success_criteria>
- Three commits, one per defect, each with its test.
- `slot.dead` is no longer set by a watchdog fire that happened long after its deadline, and the re-arm is bounded.
- `checkForSwUpdate` cannot produce an unhandled rejection from any of its three call sites.
- The VAPID queryFn cannot resolve `undefined`.
- `CHANGELOG.md` `### Fixed` bullet present.
</success_criteria>

<output>
Create `.planning/quick/260822-etd-fix-three-unresolved-production-sentry-f/260822-etd-SUMMARY.md` when done.
</output>
