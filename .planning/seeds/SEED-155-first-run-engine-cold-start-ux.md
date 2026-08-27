---
id: SEED-155
status: active
planted: 2026-08-27
planted_during: /gsd-explore, triggered by a real first-time user (a friend, guest account,
  Android phone) reporting that the bot took a very long time to play its first move and that
  the persona images loaded slowly
trigger_when: next milestone with appetite for a first-run / onboarding track. The "game only
  starts when the engine is ready" decision below is LOCKED (2026-08-27), so this is a design
  decision awaiting a plan, not an open question awaiting a verdict
scope: medium — a new readiness surface on both engine providers, a fresh-game start gate on
  the existing confirmLive() seam, one owned model loader (streaming fetch + progress), an
  avatar resize, and one conditional spawn. No schema change, no new backend surface, no
  calibration risk. The deliberately-deferred server-side option is scoped separately at the
  bottom
supersedes: nothing
---

# First-run engine cold start — bot play and analysis board

## The report

A first-time visitor created a **guest** account on an **Android phone** and started a bot
game. Two symptoms: the bot took a very long time to make its first move, and the persona
images loaded slowly. Both trace to one cause.

## LOCKED DECISION (2026-08-27)

**The game does not start until the engine is downloaded and ready.** A bot game must never
run a clock against an engine that does not yet exist. This supersedes any design in which the
board goes live optimistically and the first move waits.

Consequences, all of which the plan must carry:

1. **Fresh games mount gated, like resumes do.** `useBotGame.ts:664` becomes readiness-gated
   rather than `resume === undefined`, reusing the existing `confirmLive()` seam
   (`useBotGame.ts:683`) instead of inventing a second start path. This generalizes Phase 170's
   own stated principle (*"nobody pays for the engine cold-start"*, `useBotGame.ts:65`) from
   the resume case to every case.

2. **Neither provider exposes readiness today — this is the main new surface.** `MaiaQueue`'s
   public interface (`frontend/src/lib/engine/maiaQueue.ts:57`) is `policy` / `warm` /
   `terminate`; its `leaseReady`, `whenReady()` and `onFatal()` are module-internal.
   `WorkerPool` (`frontend/src/lib/engine/workerPool.ts`) publishes `grade` / `stopAll` /
   `terminate` / `warm`. Both need a public readiness signal and a consumer-visible fatal hook
   before the gate can be written.

3. **Readiness is per-persona, not global.** Gating on "both engines up" would make a blend-0
   game wait on 7.3 MB of Stockfish it can never use (finding 3). Ready means Maia only when
   `blend <= 0`, Maia + Stockfish otherwise. This makes finding 3 a prerequisite of the gate,
   not an independent nice-to-have.

4. **Do not auto-start the moment it becomes ready — above a threshold.** If the game goes live
   by itself after a 60s download, a user who looked away returns to a clock already running:
   the same defect moved from the bot's clock onto theirs, which is exactly what Phase 170's
   ResumeGate exists to prevent (*"no away-time billed"*, D-02). Proposed rule: if ready within
   a short threshold (warm cache, the common repeat case) start immediately with no gate and no
   extra tap; if the user actually waited, show a ready-gate they tap to begin. Threshold value
   is open.

5. **A failure path becomes mandatory.** "Only start when ready" turns a dead worker into a game
   that never starts at all. `useMaiaEngine` already models this (`onFatal` / CR-03, SEED-113,
   Phase 172); the bot path needs an honest terminal error state rather than an indefinite
   spinner. This matters most for the device population that can **never** run Maia (no WASM
   SIMD) — for them the gate would otherwise hang forever.

6. **This settles the progress-bar question.** A blocking pre-game wait has to be legible, so
   the owned-fetch loader (finding 2) is now **required**, not optional. Prefetching is
   demoted to a pure optimization: it shortens or removes the gate, and is no longer needed to
   protect correctness.

7. **The analysis board is out of scope for the gate.** It loads the same model but has no
   clock, so it can keep loading progressively. It should still get the progress UI from
   finding 2, since it is the other place the cold start is visible.

## Measured first-run cost

Cold cache, first bot game. Measured 2026-08-27 against production and the working tree.

| Asset | Wire size | Notes |
|---|---|---|
| `public/maia/maia3_simplified.onnx` | **45.7 MB** | Served **uncompressed** — no `content-encoding` on the prod response. gzip -6 gives 41.8 MB, only 8.5%, because the weights are already fp16 |
| `public/maia/ort-wasm-simd-threaded.wasm` | 13.5 MB raw / 3.4 MB gzip | onnxruntime-web |
| `public/engine/stockfish-18-lite-single.wasm` | 7.3 MB | **Not needed for a beginner's game — see finding 3** |
| 24 persona avatars | 794 KB | `src/assets/personas/*.webp` |
| `public/openings.tsv` | 368 KB | ECO corpus for the opening book |

The Maia model alone is ~85% of it.

**Model shape** (verified with `onnx.load`): 210 initializers — 168 `FLOAT16`, 42 `INT64`;
45.4 MB of weights; opset 17. It is **already fp16**, so there is no free 2x shrink. Going
smaller means INT8, which moves the policy distribution and would invalidate the 24-persona
calibration fit. Deliberately out of scope here.

## Findings

### 1. A fresh bot game starts the clock before the engine exists (likely a real bug)

`frontend/src/hooks/useBotGame.ts:664`

    const [live, setLive] = useState(resume === undefined);

The `live: false` gate exists only for **resumed** games (Phase 170, D-01/D-02/D-03, behind
`ResumeGate`). A fresh game mounts `live: true`, so the turn-anchor and clock-tick effects run
from mount — through the entire cold-start download.

The hook's own header states the bot's clock is honest: *"On commit it is debited exactly the
real wall-clock time its turn consumed."* The shortest preset is **3+0 = 180s**
(`frontend/src/lib/botTimeControlPresets.ts:31`), and 45.7 MB at ~2 Mbps is ~183s. So on a weak
mobile link the bot can **flag before playing a move**, and at any plausible mobile speed it
burns a large fraction of its clock before move 1.

The fix seam already exists and is unused for fresh games: `confirmLive()`
(`useBotGame.ts:683`). Phase 170 already articulated the right principle for the resume path —
*"nobody pays for the engine cold-start"* (`useBotGame.ts:65`) — it simply was never applied to
a fresh game, because on a warm desktop cache the cold start is invisible.

NOT YET VERIFIED on a real device. Confirm before treating as a bug.

### 2. Download progress is unobservable today

`frontend/public/maia/maia-worker.js:141`

    session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['wasm'] });

ORT is handed a **path** and fetches the 45.7 MB internally, so the app cannot see bytes
in flight. Any progress UI requires owning the fetch: streaming reader, byte counter, then
hand `create()` the resulting buffer instead of a path. Same change applies to the WebGPU
branch at `maia-worker.js:189`.

### 3. Stockfish is 7.3 MB of pure waste in a beginner's first game

`HUMAN_BLEND = 0` (`frontend/src/lib/playStyle.ts:25`), and `RUNG_BLEND`
(`frontend/src/lib/personas/personaRegistry.ts:115-118`) maps rungs **800/1000/1200/1400** to
it. Per `selectBotMove`'s contract (D-01/D-03), `blend <= 0` makes exactly ONE `deps.policy()`
call and **never** calls `deps.search`/`mctsSearch`.

But the bring-up effect spawns both unconditionally (`useBotGame.ts:1310-1311`):

    pool.warm();    // Stockfish — never used at blend 0
    queue.warm();   // Maia — the one actually needed

So the beginner personas a first-timer is most likely to pick pull 7.3 MB that can never be
used, competing for bandwidth with the 45.7 MB that is on the critical path. The unconditional
`[]`-deps effect is load-bearing for other reasons (D-03 mechanism 1 — a resumed bot with 5s
left must not flag on a worker spawn), so gate the `pool.warm()` **call**, not the effect.

### 4. The opening book does not help cold start

`resolveBookMove` (`useBotGame.ts:457`) calls `policy(...)` — one Maia eval. Its docstring is
accurate that a book ply is near-instant and clock-cheap, but that is true only *after* the
45.7 MB has landed. The book buys clock time during the game; it buys nothing at cold start.

### 5. Avatars are ~9x oversampled

`src/assets/personas/*.webp` are **512x512** (verified by reading the VP8 headers), rendered
into a 58px circle (`AVATAR_PX`, `frontend/src/components/bots/PersonaCard.tsx:36`). 24 files,
~33 KB each, 794 KB total, eager-globbed at module load
(`frontend/src/lib/personas/personaAvatars.ts:56`, `eager: true`), no `loading="lazy"`.

Resizing to ~128px (comfortable for a 3x-DPR 58px circle) plus lazy-loading should cut this to
roughly 120 KB — an ~85% reduction. Regeneration path already exists:
`scripts/gen_persona_avatars.py` + `frontend/src/data/personaAvatarPrompts.md`.

## Already handled — do not re-solve

- **Cloudflare CDN is already in front of everything.** Verified in prod on 2026-08-27:
  `/maia/maia3_simplified.onnx` returns `cf-cache-status: HIT` (age 558313s ~ 6.5 days), and
  `/assets/*` returns `HIT` too. Avatars are content-hashed into `/assets/` by Vite's `?url`
  glob, so they are **already CDN-cached**. Putting the bot images "on Cloudflare" is a no-op;
  the win is resizing them.
- **HTTP caching is already tuned.** `deploy/Caddyfile:128` gives `/maia/*` and `/engine/*`
  `max-age=2592000` (30 days), deliberately not `immutable` because ORT resolves its own
  `.wasm`/`.mjs` names off `wasmPaths`. `/assets/*` is `immutable` for a year.
- **The ONNX is deliberately excluded from the SW precache.** `globIgnores: ['**/*.wasm',
  '**/*.html', '**/*.onnx']` (`frontend/vite.config.ts:105`) — it alone exceeds the iOS Cache
  API's ~50 MB limit. It therefore survives on the HTTP cache alone, which a phone can evict.

## Design direction

The prefetch-vs-progress-bar question dissolves on inspection: **the progress bar is the
prerequisite for both.** To show progress you must own the fetch (finding 2). Once you own the
fetch, starting it earlier is the same loader with an earlier trigger. So build one owned,
cancellable, progress-reporting model loader, and treat "when does it start" as a tunable
policy on top of it, not an architectural fork.

Trigger policy can then be adaptive, which also answers the metered-data objection to eager
prefetching: start eagerly on unmetered/wifi, and wait-and-show-progress when
`navigator.connection.saveData` is set or `effectiveType` is poor. Candidate trigger points,
earliest first: guest/account creation (`loginAsGuest`, `frontend/src/hooks/useAuth.ts:146` —
an explicit landing-page click, so it precedes /bots by a long way), /bots mount, persona
select, Start.

Sketch of the pieces, in dependency order (revised by the locked decision above):

1. **Publish a readiness signal (and a fatal hook) from `MaiaQueue` and `WorkerPool`.** Nothing
   else in the gate can be written until this exists. Consequence 2 above.
2. **Gate the fresh game on per-persona readiness** via `confirmLive()`, with the terminal
   error path for a dead/unsupported worker. Consequences 1, 3, 4, 5.
3. **Own the model fetch** — streaming reader + byte counter, buffer into
   `InferenceSession.create()` (finding 2). Required, because the gate's wait must be legible.
4. **Surface progress in the gate, and on the analysis board** (consequence 7).
5. **Skip `pool.warm()` for blend-0 personas** (finding 3) — folded into step 2, since the
   readiness definition already depends on it.
6. **Resize avatars to ~128px + `loading="lazy"`** (finding 5). Fully independent of the above;
   ship whenever.
7. **Prefetch, with an adaptive trigger** — now an optimization that shrinks the gate rather
   than a correctness measure. Lowest risk to defer.
8. **Enable compression on the ONNX response** — only ~8.5% (fp16). Lowest priority.

## Verify before planning

The whole diagnosis above assumes **bandwidth** is the binding constraint. That is well
supported by the byte counts but has NOT been confirmed on the actual device. Prior art warns
against assuming a single population: the Maia-on-iOS investigation mixed two independent
failure modes (no WASM SIMD, so Maia could never run at all, vs. genuine low-memory OOM). An
Android phone could similarly be hitting slow WASM instantiation or a memory-pressure path
that no amount of prefetching or progress UI would fix.

So the first task in any phase built from this seed: **measure on a real Android over mobile
data, cold cache** — separate timings for model fetch, ORT instantiation, session create, and
first move. If session-create dominates fetch, most of the plan above is aimed at the wrong
target.

## Explicitly deferred: server-side Maia for guest first moves

Considered and consciously postponed on 2026-08-27 in favour of measuring the cheap client-side
wins first. Recorded because it is cheaper than it looks and should not have to be rediscovered.

The backend **already runs Maia**: `app/services/maia_engine.py` with a pinned
`onnxruntime==1.20.1` (`pyproject.toml:45`, `maia-inference` group, opted into by the backend
Dockerfile). It currently exposes only `score_move()` — a single move's probability — but
`mask_and_softmax` already computes the full distribution, so a policy endpoint is a small
change. Crucially, beginner personas are blend 0 (finding 3), so serving a guest's first moves
needs **policy only** — no server-side Stockfish, no MCTS.

Revisit if, after the client-side work above ships, measured first-move latency on a real
device is still bad. Costs to weigh then: a new guest-facing endpoint, rate limiting, and CPU
on a prod box that is already contended during eval backfills.
