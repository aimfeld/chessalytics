---
phase: quick-260901-oxh
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/hooks/useFastForward.ts
  - frontend/src/hooks/__tests__/useFastForward.test.ts
  - frontend/src/components/board/ChessBoard.tsx
  - frontend/src/pages/Analysis.tsx
autonomous: true
requirements: [QUICK-260901-oxh]

estimate:
  tokens: 70000
  raw_tokens: 70000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "A fast-forward run steps every FAST_FORWARD_STEP_MS (200ms) and each intermediate piece slide completes before the next position commits — no half-travelled, visually skipped moves."
    - "Pressing fast-forward moves a piece immediately; the run no longer opens with a full step of dead time."
    - "While a run is in flight, none of the four live engines (Stockfish free run, Maia, FlawChess Engine, Stockfish grading) dispatches a search for the replayed positions."
    - "While a run is in flight, the background gem sweep does not dispatch, despite liveEnginesBusy going false."
    - "The three engine card header switches keep their visual state during a run — no 'engine off' placeholder appears and no switch flips to unchecked."
    - "The three engine Workers / the FlawChess provider are NOT torn down and re-created by a run."
    - "The left (FlawChess/Maia) eval bar HOLDS its last live fraction for the duration of a run instead of falling to the sigmoid midpoint, and resumes live tracking on landing."
    - "A terminal position (checkmate/draw) still wins over any held fraction, so landing on a mate fills the left bar to the winner rather than showing a stale hold."
    - "Normal single-step navigation (back/forward/move-list/scrub) still animates at react-chessboard's 300ms default."
  artifacts:
    - frontend/src/hooks/useFastForward.ts
    - frontend/src/hooks/__tests__/useFastForward.test.ts
    - frontend/src/components/board/ChessBoard.tsx
    - frontend/src/pages/Analysis.tsx
  key_links:
    - "FAST_FORWARD_ANIMATION_MS is DERIVED from FAST_FORWARD_STEP_MS — one knob, so the two can never drift apart again (drift is this bug)."
    - "useFastForward.onRunningChange -> Analysis `fastForwardRunning` state -> (a) the four engine hooks' `fen` inputs, (b) ChessBoard.animationDurationInMs, (c) useGemSweep.enabled, (d) the left eval bar's hold-last-live freeze."
    - "Suppression is applied to engine `fen` inputs ONLY, never to `enabled` — `enabled` owns Worker lifecycle."
    - "leftEvalBarWhiteFraction precedence chain: terminalWhiteFraction -> held fraction (run only) -> live fraction -> neutral. Terminal must stay first."
---

<objective>
Fix three independent defects in the analysis-board fast-forward replay (shipped in
quick 260831-s4y): moves are visually skipped because the 150ms cadence aborts
react-chessboard's 300ms animation at ~50% travel; the run opens with a full step of
dead time; and the per-ply live-engine storm (four engines whose 150ms rapid-step
debounce resonates with the cadence) delays the timer callbacks, producing the uneven
move-sound rhythm.

Purpose: make the replay actually read as playing through the moves.
Output: a 200ms cadence with a derived 170ms run-scoped board animation, a synchronous
first step, live-engine + gem-sweep suppression for the duration of a run, and a left
eval bar that holds its last live value through a run instead of falling to the
midpoint (the one visible cost the suppression would otherwise introduce).

Tracer-first decomposition does not apply here (`--no-tracer` semantics): every layer
this touches already exists and is proven in production. This is a defect fix inside
shipped wiring, so a thin end-to-end slice would add no information. The three tasks
below are ordered lowest-layer-first (hook -> board prop -> page wiring) so each one's
gate is meaningful on its own.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@frontend/CLAUDE.md
@frontend/src/hooks/useFastForward.ts
@frontend/src/hooks/__tests__/useFastForward.test.ts
</context>

<diagnosis_deviations>
**STATUS: both deviations reviewed and APPROVED by the developer. They are now part of
the specification, not open questions.** Do not "fix" either one back toward the
original diagnosis wording — the reasoning below is why the diagnosis was wrong, and it
must survive into the code comments so the next reader does not re-litigate it.

Two places where a literal reading of the diagnosis would be wrong. Both were verified
against the code during planning; implement the corrected form and keep the reasoning
in the code comments.

**DEV-1 (APPROVED) — suppress the engines' `fen` input, NOT their `enabled` flag.**
The diagnosis says "gate `engineEnabled` / `maiaEnabled` / `flawChessEnabled` on
`!fastForward.isRunning`". Taken literally that is wrong twice over:

1. `enabled` owns Worker lifecycle. `useStockfishEngine.ts:356-602` is a
   `useEffect` gated on `enabled` whose cleanup does `worker.postMessage('stop')` +
   `worker.terminate()` and resets `isReady`; `useFlawChessEngine.ts:172-250` is the
   same pattern for the whole MCTS provider + pool ("created once per enabled-lifetime");
   `useMaiaEngine.ts:328-384` releases its shared-worker lease. Flipping `enabled` for
   the duration of a run would tear down and re-initialise three engines per
   fast-forward press — strictly more main-thread work than the searches being
   suppressed, i.e. the opposite of the fix.
2. Those three identifiers are also the user-facing switch states, read by
   `checked={engineEnabled}` (Analysis.tsx:3833), `checked={flawChessEnabled}` (:3514)
   and the `!engineEnabled ? (…)` / `!flawChessEnabled ? (…)` card placeholders
   (:3530, :3638, :3847). Reassigning them would flip the switches and swap the cards
   to their "engine off" state mid-replay.

Correct lever: every one of these hooks documents `fen: string | null` as
"null keeps the engine idle (no analyze/go sent)" — `useStockfishEngine.ts:63`,
`useMaiaEngine.ts:54`, and `useFlawChessEngine`'s dispatch guard
(`!debouncedFen || !enabled || !pool || !queue`, useFlawChessEngine.ts:331). Passing
`null` for `fen` while leaving `enabled` untouched suppresses the search and keeps the
Worker warm. That is the mechanism to use.

**DEV-2 (APPROVED) — a fourth engine is in scope.** `useStockfishGradingEngine`
(Analysis.tsx:1335) is a second independent Stockfish worker carrying the identical
`if (sinceLast > RAPID_STEP_DEBOUNCE_MS) { fire immediately }` branch
(useStockfishGradingEngine.ts:334, same 150ms constant at :60). It resonates with the
200ms cadence exactly like the three named ones, so leaving it out would leave the
sound-rhythm cause partly unfixed. It gets the same `fen: … ? position : null`
treatment. This is an extension of the diagnosis, not a reinterpretation of it —
if the developer wants it out of scope it is a one-line revert.
</diagnosis_deviations>

<accepted_costs>
Deliberate, comment them where they land; do not "fix" them.

- **Landing move animates at 300ms, not 170ms.** `stop()` runs in the same tick as the
  final `goToNode`, so React commits the arrival position and `fastForwardRunning:
  false` together; ChessBoard's animation prop is already back to `undefined` when the
  library's position effect reads it. A fuller arrival slide is desirable.
- **A single-ply run never suppresses anything.** With the synchronous first step, a
  run whose target is `cursor + 1` calls `start()` -> `tick()` -> `goToNode` -> `stop()`
  inside one handler, so `true` then `false` batch to a net no-op. That run is
  behaviourally identical to pressing Forward once, which is right.
- **NOT accepted — the left eval bar drop is fixed, see `<left_eval_bar_freeze>`.** The
  only remaining live-surface cost during a run is the grey 2nd-best arrow, which
  disappears and returns on landing. Everything else on the game-mode board is
  precomputed: the RIGHT ("SF") bar reads `gameOverlay.evalCp` from
  `gameData.eval_series`, and the blue best-move arrow plus the gem badges come from
  stored data (see the comment block at Analysis.tsx:1797-1798).
- **Touch devices are unaffected by the animation constant.** `showAnimations` is false
  when `'ontouchstart' in window` (ChessBoard.tsx:397), so the duration is moot there;
  the cadence and engine-suppression fixes still apply.
</accepted_costs>

<left_eval_bar_freeze>
Developer-required addition (chosen explicitly after the cost was surfaced). The left
eval bar must FREEZE at its last live value for the duration of a run rather than fall
to the sigmoid midpoint.

**Why this is not cosmetic polish:** the midpoint does not read as "no data", it reads
as "equal position" — actively wrong information. And shipping a new visual glitch
inside the very feature being fixed for looking glitchy defeats the task.

**Where the drop comes from.** `leftEvalBarWhiteFraction` (Analysis.tsx:2848-2849) is
`terminalWhiteFraction ?? (flawChessEnabled ? fcWhiteFraction : maiaWhiteFraction)`.
Both `fcWhiteFraction` (:2830-2834, from `flawChessEngine.rankedLines[0]`) and
`maiaWhiteFraction` (:2814-2819, from `maia.expectedScoreAtSelectedElo`) fall back to a
bare `0.5` when their source is absent — and their sources are exactly the hooks Task 3
suppresses. That fallback IS the drop.

**Chosen shape: hold the last LIVE fraction continuously, not a snapshot at run start.**
Say so in the comment, with these reasons:
  1. A snapshot on the rising edge would depend on render/effect ordering between the
     capture and the engine hooks clearing their own state — the engine hooks are
     declared at lines 691/894/917 and would clear before a capture effect down at
     ~2850 in a later commit. A continuous hold has no such ordering coupling.
  2. If a run starts while the engine had not yet resolved the current position, a
     snapshot would freeze the `0.5` placeholder — the exact value being avoided. A
     continuous hold keeps the last genuinely-known value instead.
  3. Nothing has to "release" the hold on landing: the held value is only ever READ
     while `fastForwardRunning` is true, so landing releases it by construction.

**Required precedence — do not reorder.** `terminalWhiteFraction` must keep winning
over the held value, so landing on a checkmate or draw fills the bar to the real result
rather than showing a stale hold. Note in the comment that `terminalEval` is
`terminalPositionEval(position)` (:1914) — a pure function of the FEN, engine-independent
— so it stays live throughout a run and is safe at the head of the chain.

**The right bar needs none of this.** `rightEvalBarEvalCp`/`Mate`/`Depth` (:2860-2874)
read `gameOverlay.evalCp` etc., precomputed from `gameData.eval_series` in game mode.
Leave that block untouched.
</left_eval_bar_freeze>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: 200ms cadence, derived animation constant, synchronous first step, run-state callback</name>
  <files>frontend/src/hooks/useFastForward.ts, frontend/src/hooks/__tests__/useFastForward.test.ts</files>
  <behavior>
    - `start()` calls `goToNode` with the first ply SYNCHRONOUSLY, before any timer runs.
    - After that first synchronous step, each subsequent ply lands one `FAST_FORWARD_STEP_MS` advance later.
    - A run targeting three plies ahead: 1 call at `start()`, then one per advance, three total, `isRunning` false after the third.
    - `FAST_FORWARD_ANIMATION_MS` is strictly less than `FAST_FORWARD_STEP_MS` (assert the relation, not the literals — the point of deriving it).
    - `onRunningChange` receives `true` when a multi-step run begins and `false` exactly once when it ends, whether it ended by landing, by foreign-navigation cancellation, or by `stop()`.
    - Re-entrant `start()` inside one commit still spawns only one timer chain (the `runningRef` guard must survive the reordering).
    - Foreign navigation still cancels: after a rerender with a `currentNodeId` the hook never commanded, further advances fire no `goToNode` and `onRunningChange(false)` has fired.
    - Unmount mid-run still fires no further `goToNode`.
    - `enabled: false` still makes `start()` inert — no synchronous `goToNode`.
  </behavior>
  <action>
Raise `FAST_FORWARD_STEP_MS` from 150 to 200 and add the derived animation constant
beside it. Derive, do not hand-write two numbers — the two values drifting apart is the
defect being fixed:

  - keep `export const FAST_FORWARD_STEP_MS = 200;`
  - add a module-private `FAST_FORWARD_ANIMATION_HEADROOM_MS = 30;`
  - add `export const FAST_FORWARD_ANIMATION_MS = FAST_FORWARD_STEP_MS - FAST_FORWARD_ANIMATION_HEADROOM_MS;`

Document on both constants (this is a bug-fix site, so the root CLAUDE.md
comment-bug-fixes rule applies): the previous 150ms cadence was half
react-chessboard v5's 300ms default `animationDurationInMs`, so the library's
position effect — keyed on `[position]` only — snapped `currentPosition` to the still
pending `waitingForAnimationPosition` and restarted, aborting every slide at roughly
half travel. That is the "skipped moves" symptom. State that the animation duration
must stay strictly below the step so a slide always completes, and that the headroom
constant is the margin.

Make the first step synchronous. In `start()`, replace the opening
`setTimeout(tick, FAST_FORWARD_STEP_MS)` with a direct `tick()` call, leaving `tick`'s
own self-rescheduling tail to drive every later step. Every existing invariant must
survive unchanged and is worth a brief comment at the reordered site:
  - `runningRef.current = true` is still assigned BEFORE `tick()` runs, so the
    double-click guard still rejects a second `start()` in the same commit;
  - `expectedNodeIdRef` is still seeded to `currentNodeId` before `tick()` and is still
    written by `tick` immediately BEFORE each `goToNode` — it remains the sole
    cancellation signal (D-05);
  - `planRef` is still assigned before `tick()` reads it, so the snapshot semantics
    described in the `RunPlan` doc comment are unchanged;
  - the `landed` check still stops on arrival, which for a one-ply target now happens
    inside `start()` itself.

Add an optional `onRunningChange?: (running: boolean) => void` to
`UseFastForwardOptions`, documented as the ordering escape hatch for a consumer that
must read the run state ABOVE the line where this hook is called. Hold it in an
`onRunningChangeRef` refreshed by a bare `useEffect`, mirroring the existing `tickRef`
precedent in this file, so `stop`'s identity stays stable (it feeds `tick`'s deps and
the cancellation effect's deps). Invoke it alongside every `setIsRunning` — `true` in
`start()`, `false` in `stop()` — and note in the return-type doc that `isRunning`
remains the hook's own copy of the same value.

Rework the existing tests rather than bumping the constant. The first-step reordering
changes the call/advance ledger of most cases, so re-derive each one: a `goToNode`
assertion that used to follow the first `advanceTimersByTime` now belongs immediately
after `act(() => result.current.start())`, and each test needs one fewer advance.
Keep the file's fake-timer discipline exactly as its header describes — `act(() =>
vi.advanceTimersByTime(...))`, never a bare testing-library `waitFor` on a
timer-driven transition. Keep the five `nextStopPly` cases as they are (pure helper,
unaffected). Add coverage for the new surface: the synchronous first step, the
`FAST_FORWARD_ANIMATION_MS < FAST_FORWARD_STEP_MS` relation, and the
`onRunningChange` true/false sequence for both the landing and the cancellation exit.
  </action>
  <verify>
    <automated>cd frontend && npm test -- --run src/hooks/__tests__/useFastForward.test.ts</automated>
  </verify>
  <done>The hook steps at 200ms with a derived sub-step animation constant, fires its first `goToNode` synchronously from `start()`, reports run-state transitions through `onRunningChange`, and every reworked test passes with the double-click, cancellation, and unmount invariants still asserted.</done>
</task>

<task type="auto">
  <name>Task 2: run-scoped board animation duration through ChessBoard</name>
  <files>frontend/src/components/board/ChessBoard.tsx, frontend/src/pages/Analysis.tsx</files>
  <action>
Add an optional `animationDurationInMs?: number` to `ChessBoardProps`, named to match
the react-chessboard option it forwards to so the passthrough is obvious. Document that
omitting it keeps the library's own 300ms default, and that it exists so the analysis
board can shorten the slide for the duration of a fast-forward run.

Forward it verbatim into the `options` useMemo as `animationDurationInMs` and add it to
that memo's dependency array. Passing `undefined` is safe and is the intended default
path: the library applies its 300ms fallback as a destructuring default in
`ChessboardProvider` (node_modules/react-chessboard/dist/index.js:4852), which fires on
`undefined`, and the props reach it via a plain `...options` spread. Note in the
comment that this pairs with the existing `showAnimations` line — on touch devices
animations are off entirely, so the duration is inert there.

In Analysis.tsx, declare the lifted run state with the other engine switch states,
immediately after `const [flawChessEnabled, setFlawChessEnabled] = useState(true);`
(~line 611):

  `const [fastForwardRunning, setFastForwardRunning] = useState(false);`

Explain in a comment WHY the state is lifted here rather than read off
`fastForward.isRunning`: the `useFastForward` call sits at ~line 1771 because it needs
`evalChartPly` (~line 1677), which is itself far below the engine hooks at lines 691 /
894 / 917 / 1335 that must read the run state. Hooks cannot be reordered around that,
so the hook pushes its run state upward through `onRunningChange` instead of the page
pulling it downward. State the two things this shape must not become: a circular
dependency (it is not one — the setter flows down, the value flows up, and
`useFastForward` reads none of the engines) and a render loop (it is not one — each
transition is a one-shot `true`/`false` write from an event handler or a timer
callback, never from render).

Wire `onRunningChange: setFastForwardRunning` into the existing `useFastForward({...})`
call. Keep `fastForward.start` / `fastForward.canFastForward` wired to `BoardControls`
exactly as they are (Analysis.tsx:3276-3277) and prefer `fastForwardRunning` — the
single lifted value — everywhere else on the page.

Pass the run-scoped duration at the single `<ChessBoard>` call site
(Analysis.tsx:3112), importing `FAST_FORWARD_ANIMATION_MS` from `@/hooks/useFastForward`:

  `animationDurationInMs={fastForwardRunning ? FAST_FORWARD_ANIMATION_MS : undefined}`

The `undefined` branch is load-bearing and must be commented: normal single-step
navigation has to keep the library's 300ms default, so the shortened slide applies only
while a run is in flight. Add the accepted-cost note from this plan at the same site —
because `stop()` commits in the same tick as the final `goToNode`, the landing move
animates at the 300ms default, which is the desirable arrival behaviour rather than an
oversight. This board node is shared by the desktop stage and the mobile row (only one
renders at a time), so there is exactly one call site to change.
  </action>
  <verify>
    <automated>cd frontend && npm run build && npm test -- --run src/components/board/__tests__/BoardControls.test.tsx src/pages/__tests__/Analysis.test.tsx</automated>
  </verify>
  <done>`npm run build` type-checks the new optional prop across every ChessBoard caller (Bots.tsx and the test stubs are untouched because the prop is optional), the analysis board receives `FAST_FORWARD_ANIMATION_MS` only while `fastForwardRunning` is true, and the BoardControls plus Analysis suites pass.</done>
</task>

<task type="auto">
  <name>Task 3: suppress live engines and the gem sweep for the duration of a run, and freeze the left eval bar</name>
  <files>frontend/src/pages/Analysis.tsx</files>
  <action>
Suppress the live engine searches for the duration of a run by nulling their `fen`
input only. Read `<diagnosis_deviations>` DEV-1 above before editing: `enabled` owns
Worker/provider lifecycle and must not be touched, and the three `*Enabled` switch
states must keep their values because the card UI reads them.

Apply the identical shape at all four hook call sites, leaving each `enabled:` argument
exactly as it is today:

  - `useStockfishEngine` (~line 691): `fen: engineEnabled && !fastForwardRunning ? position : null`
  - `useMaiaEngine` (~line 894): currently passes `fen: position` unconditionally and
    gates only via `enabled`; change to `fen: fastForwardRunning ? null : position`
  - `useFlawChessEngine` (~line 917): `fen: flawChessEnabled && !fastForwardRunning ? position : null`
  - `useStockfishGradingEngine` (~line 1335): `fen: gradingEnabled && !fastForwardRunning ? position : null` (DEV-2)

Write one shared explanation at the first site and cross-reference it from the other
three. It must record: each of these hooks carries a 150ms `RAPID_STEP_DEBOUNCE_MS`
with a `sinceLast > RAPID_STEP_DEBOUNCE_MS` fire-immediately branch
(useStockfishEngine.ts:41/:277-286, useMaiaEngine.ts:45, useFlawChessEngine.ts:33,
useStockfishGradingEngine.ts:60/:334); `setTimeout` is never early, so at a 200ms
cadence `sinceLast` always exceeds the window and the immediate branch wins on every
replayed ply, deterministically. At this cadence the suppression is load-bearing, not
an optimisation — that per-ply engine load is what delays the replay's own timer
callbacks and makes the move sounds arrive unevenly. Also record the DEV-1 reason the
lever is `fen` and not `enabled`, and the DEV-2 reason grading is included. Do NOT
change `RAPID_STEP_DEBOUNCE_MS` in any engine hook — the fix is suppression during a
run, not retuning the debounce.

Leave `gemGrading` (~line 2216) alone. Its own `fen` is already gated
(`needParentGemGrade ? parentFen : null`) and `needParentGemGrade` requires
`gemC1 !== null`, which is derived from live Maia output that this change suppresses,
so it should go idle transitively. If manual verification shows it still dispatching
during a run, extend the same `fen`-null pattern to it — never its `enabled`.

Close the sweep trap. Suppressing the live engines drives `liveEnginesBusy`
(~line 2106) to false, which is precisely the signal `useGemSweep` treats as
permission to run — so the fix as written would unleash the background sweep during the
replay, exactly when the main thread must stay quiet. Add `&& !fastForwardRunning` to
the `enabled` condition of the `useGemSweep({...})` call (~line 2132). Comment that
the sweep is structurally inert for an analyzed game (Phase 175 demoted it to a
fallback-only path via `!gameHasStoredBestMoveData`), but an UNANALYZED game has an
empty fast-forward stop set, so a run there travels all the way to the terminal ply
with the sweep live — which is the case this guard exists for. `enabled` on
`useGemSweep` is a dispatch gate, not a Worker-lifecycle gate, so DEV-1 does not apply
here; the diagnosis calls for this guard at this exact call site.

Freeze the left eval bar. Read `<left_eval_bar_freeze>` above first — it carries the
rationale, the chosen shape, and the precedence rule, all of which belong in the code
comment. Rework the small derived block at Analysis.tsx:2811-2851:

  - Make the two source fractions express "no live data" as `null` instead of silently
    collapsing to `0.5`: `maiaWhiteFraction` returns null when
    `maia.expectedScoreAtSelectedElo === null`, and `fcWhiteFraction` returns null when
    `topLine` is undefined. Keep the existing side-to-move conversion and the
    `noUncheckedIndexedAccess` narrowing on `topLine` exactly as they are (narrow via
    the ternary, never a non-null assertion).
  - Derive one `liveLeftWhiteFraction: number | null = flawChessEnabled ? … : …`.
  - Add a `useRef<number | null>(null)` holding the last live fraction, declared in this
    same derived block rather than up beside `fastForwardRunning` — all three of its
    inputs are local here, so keeping the whole freeze mechanism in one readable place
    beats splitting it across 2,200 lines. Update it from a `useEffect` keyed on
    `[fastForwardRunning, liveLeftWhiteFraction]` that writes only when NOT running and
    the live value is non-null. Write it in an effect, not during render, so a
    StrictMode/concurrent double-render cannot make the hold path order-dependent.
  - Rebuild the consumer as an explicit precedence chain, terminal first:
    `terminalWhiteFraction ?? (fastForwardRunning ? heldRef.current : null) ?? liveLeftWhiteFraction ?? EVAL_BAR_NEUTRAL_FRACTION`.
  - Extract the bare `0.5` these expressions currently repeat into a named
    `EVAL_BAR_NEUTRAL_FRACTION` module constant (root CLAUDE.md forbids magic numbers,
    and these are the exact expressions being rewritten). Reuse it for
    `terminalWhiteFraction`'s draw case too.

`leftEvalBarNode` (:2965-2976) passes `evalCp={null} evalMate={null} depth={0}`, so the
fraction is the bar's only live input and freezing it freezes the bar completely — no
companion depth or eval readout can go stale underneath it. Leave that JSX unchanged,
and leave `leftEvalBarAccent` / `leftEvalBarTestId` unchanged (they key off
`flawChessEnabled`, which this task does not touch).

Do not refactor Analysis.tsx beyond these edits. The file is 4,194 lines and already
over the root CLAUDE.md size limits, but a broad refactor is explicitly out of scope
for this task; keep the diff minimal and targeted. Also leave
HorizontalMoveList.tsx:72's smooth `scrollIntoView` untouched, and do not add any
adaptive or variable cadence.

Then run the full frontend gate. `npm run build` is required, not optional: a shared
prop type changed in Task 2 and neither lint nor test type-checks (esbuild strips
types). Fix anything the gate surfaces, including knip complaints about the newly
exported `FAST_FORWARD_ANIMATION_MS` if it ends up unimported.
  </action>
  <verify>
    <automated>cd frontend && npm run lint && npm test -- --run && npm run build</automated>
  </verify>
  <done>All four live engine hooks receive a null `fen` while `fastForwardRunning` is true with their `enabled` arguments untouched, the gem sweep is disabled for the duration of a run, the left eval bar holds its last live fraction through a run with `terminalWhiteFraction` still first in the precedence chain, the three engine switch states and their card UI are unchanged, and `npm run lint && npm test -- --run && npm run build` all pass clean.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| (none crossed) | Every change is client-side render/timer/animation state inside an already-authenticated analysis page. No new network call, no new user input parsing, no new persisted state, no backend file touched. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-oxh-01 | Denial of Service | Fast-forward timer chain in `useFastForward.start`/`tick` | low | mitigate | The synchronous first step must not weaken the `runningRef` re-entrancy guard (a second chain would double main-thread load per press). Task 1's behavior block asserts the re-entrant `start()` case explicitly. |
| T-oxh-02 | Denial of Service | `useGemSweep` unleashed by `liveEnginesBusy` going false | medium | mitigate | Task 3 adds `!fastForwardRunning` to the sweep's `enabled` condition — this is the named trap, not a hypothetical. |
| T-oxh-03 | Denial of Service | Engine Worker teardown/respawn per fast-forward press | medium | mitigate | DEV-1: suppress via the `fen` input, never the `enabled` flag, so no Worker or MCTS provider is destroyed and re-initialised by a replay. |
| T-oxh-04 | Spoofing | Left eval bar hold-last-live freeze | low | mitigate | A held fraction presents a past evaluation in the position of a current one. Bounded to the duration of a run (read only while `fastForwardRunning`), and `terminalWhiteFraction` keeps first precedence so a decisive arrival is never masked by a hold. This is strictly less misleading than the midpoint it replaces, which reads as "equal position". |
| T-oxh-SC | Tampering | npm/pip/cargo installs | n/a | accept | No package is added, removed, or upgraded by this task; `package.json` and the lockfile are not in `files_modified`. Package-legitimacy gate does not apply. |
</threat_model>

<verification>
- `cd frontend && npm run lint && npm test -- --run && npm run build` — all three clean.
- No backend file changes, so no backend gate step is required for this task.
- Read back the diff and confirm: `enabled:` arguments of `useStockfishEngine`,
  `useMaiaEngine`, `useFlawChessEngine`, and `useStockfishGradingEngine` are byte-identical
  to `main`; `RAPID_STEP_DEBOUNCE_MS` is unchanged in all four engine hooks;
  `HorizontalMoveList.tsx` is untouched.
- Confirm `FAST_FORWARD_ANIMATION_MS` is written as an expression over
  `FAST_FORWARD_STEP_MS`, not as a second literal.
- Confirm `terminalWhiteFraction` is still the FIRST term of the
  `leftEvalBarWhiteFraction` precedence chain, ahead of the held fraction, and that the
  right-bar block (`rightEvalBarEvalCp`/`Mate`/`Depth`) is byte-identical to `main`.
</verification>

<success_criteria>
- Fast-forward replays at 200ms per ply with every intermediate piece slide completing.
- The first move of a run happens immediately on press.
- No live engine search and no gem-sweep dispatch occurs for a replayed position.
- The engine card switches and card bodies look identical before, during, and after a run.
- The left eval bar holds steady through a run instead of snapping to the midpoint, and
  still fills correctly when the run lands on a checkmate or draw.
- Single-step navigation animation is unchanged from today.
- Frontend lint, tests, and build all pass.
</success_criteria>

<human_uat>
Not gating; run after the automated gate passes. On `/analysis?game_id=…` for an
analyzed game with several flaws, press fast-forward from the root: a piece should move
at once, every intermediate piece should visibly arrive on its destination square, and
the move sounds should land on an even beat. Watch the LEFT (brown FlawChess) eval bar
across the whole run: it should sit still at its pre-run level, not jump to the middle.
Then fast-forward into a game that ends in checkmate and confirm the left bar fills to
the winner on arrival rather than holding the stale level. Repeat on an UNANALYZED game
(empty stop set, so the run travels to the final ply) and confirm the rhythm holds there
too — that is the case the gem-sweep guard exists for.
</human_uat>

<output>
Create `.planning/quick/260901-oxh-fast-forward-cadence-animation-and-engin/260901-oxh-SUMMARY.md` when done
</output>
