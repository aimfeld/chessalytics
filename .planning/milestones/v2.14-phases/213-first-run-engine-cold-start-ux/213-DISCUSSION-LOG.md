# Phase 213: First-Run Engine Cold Start — Asset-Check Gate & Download Progress UI - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-28
**Phase:** 213-first-run-engine-cold-start-ux
**Areas discussed:** Ready-gate trigger & prefetch scope, Cold-start book & warmup threshold, Progress UI shape & placement, Failure & terminal states

---

## Cold-start book & warmup threshold

The user opened by challenging the premise: *"Let's just start the game if the engine assets
are downloaded, without warming the engine. Do we even need an engine warmup process, what's
the reason we do this?"* This reframed the area before any options were presented.

Investigation (`maia-worker.js:125-215`) established that two different things are called
"warm":

1. `pool.warm()` / `queue.warm()` (`useBotGame.ts:1310-1311`) — not inferences. They forward
   to `ensureSpawned()` / `ensureLease()`: spawn the worker, start the asset load.
2. `await analyze(WARMUP_FEN, [WARMUP_ELO])` (`maia-worker.js:197`) — a real dummy inference,
   but present for **failure detection, not latency**. WebGPU compiles compute shaders
   lazily, so a broken session passes `create()` and only throws on the first real
   `analyze()`. Hence its "KEEP this call" comment. It already runs inside `initSession`,
   before the worker posts `ready`.

Conclusion presented: the WASM path has no lazy-shader-compile failure mode, so a WASM warmup
buys only latency — and a pre-game warmup *relocates* that cost from the bot's clock to the
user's wait rather than removing it. At the 3+0 minimum (180s) one cold inference is noise.

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — drop warmup entirely | Ready = the worker's existing `ready` message. WebGPU keeps its in-create warmup as a failure detector only. No WASM warmup, no `<1s` threshold, no policy-free book fallback. Supersedes the seed's conditional-warmup lock. | ✓ |
| Yes, but keep a background warm-up | Start at `ready`, fire one throwaway `policy()` in the background so the first real move is warm. Costs nothing on the user's wait but adds a code path and an extra inference on a phone. | |

**User's choice:** Drop warmup entirely.
**Notes:** Collapses three items from SEED-155 at once — the `<~1s` conditional-warmup rule,
the "measure cold first-inference on a weak device" planning task, and the entire finding-4
opening-book fork (`resolveBookMove` calling `policy()` is only a problem if the game starts
before the engine is usable). Accepted asymmetry: WebGPU reaches `ready` *after* its warmup,
WASM before — so WASM is faster to ready. Not equalized.

---

## Ready-gate trigger & prefetch scope

First presentation of this area was rejected by the user for clarification. Two questions
were unclear:

- *"Does this question make sense after the decision to remove warmup?"* — Answered: yes,
  unchanged. The gate exists because of the **download**, not the warmup; a user who looks
  away during a 30-180s download and returns to a running clock is the exact defect Phase
  170 D-02 prevents. What dropping warmup *did* change was the balance between the options:
  it closed the "cached but slow" hole that made a timer attractive.
- *"What is adaptive prefetch?"* — Answered: start downloading the model before the user
  asks for a game, skipping the early start when `navigator.connection.saveData` is set or
  `effectiveType` is poor. Same loader, earlier trigger; the cost is spending 45.7 MB of
  someone's mobile data on the chance they play.

Questions were then re-framed and re-asked.

### Gate rule

| Option | Description | Selected |
|--------|-------------|----------|
| Cache-miss based | Gate iff bytes actually had to be downloaded. Deterministic, no timer, trivially testable. Residual gap: a cached-asset phone still spends 1-3s parsing weights and auto-starts. | ✓ |
| Elapsed-wait threshold (~2s) | Named constant; ready within it → go live silently, slower → gate. Most honest reading of "did the user actually wait", covers the slow-parse case, but adds a timer and a constant to tune. | |
| Always gate a fresh game | Every game starts with an explicit tap, uniform with resume. No threshold, no branch — at the cost of a permanent extra tap on the warm repeat case. | |

**User's choice:** Cache-miss based.

### Prefetch scope

| Option | Description | Selected |
|--------|-------------|----------|
| Defer entirely | Ship readiness + gate + owned loader + progress UI + avatars. Prefetch becomes its own seed, informed by real wait-time data. | ✓ |
| In-phase, /bots mount trigger | Fetch when the persona grid mounts, skipping on `saveData` / slow `effectiveType`. Same loader, earlier trigger. | |
| In-phase, guest-creation trigger | Earliest candidate (`loginAsGuest`, `useAuth.ts:146`). Best fix for the reported scenario, but downloads 45.7 MB for users who may never open /bots. | |

**User's choice:** Defer entirely.

### In-flight fetch lifetime

| Option | Description | Selected |
|--------|-------------|----------|
| Keep running to completion | Fetch outlives the component and lands in the HTTP cache. A partial download is worthless, so aborting means restarting from zero. | ✓ |
| Abort on leaving /bots | `AbortController` on unmount; alive across persona switches within /bots. Doesn't burn a phone's data for a page the user left. | |
| You decide | Planner picks based on loader structure. | |

**User's choice:** Keep running to completion.

---

## Progress UI shape & placement

Grounding presented: Analysis shows `EngineLinesSkeleton` (no progress) in three slots;
`Bots.tsx:563` renders `ResumeGate` on `resume !== null && !game.live`; no `progress`
primitive exists in `components/ui/`.

### Container

| Option | Description | Selected |
|--------|-------------|----------|
| One dialog, two states | Non-dismissible `Dialog` mirroring `ResumeGate` — "Downloading engine… [bar]" then a "Ready — Start game" button wired to `confirmLive()`. Direct sibling of the existing ResumeGate branch. | ✓ |
| Inline on SetupScreen | Progress on the setup screen so the download overlaps with choosing settings. Splits the gate away from `confirmLive()`. | |
| Board overlay, not a dialog | Translucent panel over the board; keeps the board visible but diverges from precedent and needs its own focus handling. | |

**User's choice:** One dialog, two states.

### Readout

| Option | Description | Selected |
|--------|-------------|----------|
| Bar + percent + MB + asset name | "Maia model — 42% (19.2 / 45.7 MB)". MB explains *why* it's slow. | |
| Bar + percent + asset name | "Maia model — 42%". Cleaner, less numeric noise. | ✓ |
| Bar + asset name only | Minimal; relies on bar fill alone. | |

**User's choice:** Bar + percent + asset name.

### Multi-asset display

| Option | Description | Selected |
|--------|-------------|----------|
| One aggregate bar + changing subtext | Single byte-weighted bar, subtext names the asset in flight. Honest — Maia is ~86% of the bytes. | ✓ |
| Per-asset rows, each with a bar | More transparent but visually heavier and over-weights the 7.3 MB Stockfish. | |
| You decide | Planner picks. | |

**User's choice:** One aggregate bar + changing subtext.

### Analysis-board placement

| Option | Description | Selected |
|--------|-------------|----------|
| Inside the existing skeleton slots | Augment `EngineLinesSkeleton` at `analysis-engine-loading` / `analysis-flawchess-loading` and the Maia panel. No new layout; respects the desktop + mobile mirror. | ✓ |
| One shared banner above the board | Single page-level progress banner. One place to look, but duplicates per-card state. | |
| Both | Banner plus in-card progress. Most informative, most redundant. | |

**User's choice:** Inside the existing skeleton slots.

---

## Failure & terminal states

Grounding presented: no WASM-SIMD detection exists anywhere in the codebase;
`maiaWorkerHost` already fires per-lease `onFatal`; the canonical `LoadError` component's
mandated copy ("Please try again in a moment") is wrong for a permanently incapable device.

### Capability check

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — SIMD probe before fetch | `WebAssembly.validate()` of a tiny SIMD module before the 45.7 MB fetch. Today a device that can never run Maia downloads the whole model on mobile data before failing. New work. | ✓ |
| No — let the worker fail and report | Rely on the existing `onFatal` path. Less code, but burns 45.7 MB to learn what a 20-line check knows up front. | |

**User's choice:** SIMD probe before fetch.

### Terminal-state taxonomy

| Option | Description | Selected |
|--------|-------------|----------|
| Two states: unsupported vs failed | "Unsupported device" (no retry, points at what still works) vs "Engine failed to start" (retry offered). Two genuine populations; offering Retry on the first is a lie. | ✓ |
| One generic terminal state with retry | Single message + Retry regardless of cause. Traps the no-SIMD user in a loop that can never succeed. | |
| One generic terminal state, no retry | Never lies, but forces a page reload on a recoverable OOM/worker-death. | |

**User's choice:** Two states.
**Notes:** Aligns with the recorded "Maia iOS: two failure populations" finding — iOS <16.4
has no WASM SIMD (Maia can never run) and is a different case from real low-memory OOM.

### Download failure

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-retry once, then manual | One silent retry covers the transient drop; a second failure surfaces a Retry button. Each retry restarts from zero (no resumable partial). | ✓ |
| Manual Retry button only | Never re-spends a phone's data without consent. | |
| Auto-retry with backoff | Most resilient on flaky mobile, but can silently burn 90+ MB and makes the wait unbounded. | |

**User's choice:** Auto-retry once, then manual.

### Telemetry

| Option | Description | Selected |
|--------|-------------|----------|
| Umami: gate shown + wait duration | Real wait times are "what the browser knows and the DB cannot". No data exists today beyond one user's report. | ✓ |
| Umami: abandoned during wait | The bounce signal this phase exists to fix. | ✓ |
| Sentry: terminal failure only | Unsupported-device / worker-death / download-failed, with device context. | ✓ |
| No new instrumentation | Ship and judge by whether reports stop. | |

**User's choice:** All three.

---

## Claude's Discretion

- The avatar resize pipeline: how 128px variants are produced, where the 512×512 sources
  live so Vite's glob does not bundle them, whether the glob moves from `eager` to lazy.
  Outcome locked (D-18), mechanism open.
- Where the readiness surface physically lands — `maiaWorkerHost` already has `whenReady()`
  and `onFatal`, so this is forwarding through `MaiaQueue` / `WorkerPool`, not new machinery.
- Exact UI copy for the two terminal states, subject to the "do not reuse `LoadError` copy"
  constraint.

## Deferred Ideas

- Adaptive prefetch (`saveData` / `effectiveType`-aware early model fetch) — its own seed,
  informed by the wait-duration telemetry this phase adds.
- Bullet time controls — noted that under bullet the dropped warmup would have to return,
  since there is no clock room to warm mid-game. Own scope, per SEED-155.
- INT8 model shrink, server-side engine option, ONNX response compression — all already
  out of scope in SEED-155, reaffirmed.

## Todos reviewed, not folded

Three `todo.match-phase` hits, all keyword false positives: an invalid-Tailwind chart axis
label fix, Phase 172 deferred gem-sweep review findings, and bitboard storage for partial
position queries. None relate to this phase.
