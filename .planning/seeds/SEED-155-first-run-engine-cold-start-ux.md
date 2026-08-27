---
id: SEED-155
status: active
planted: 2026-08-27
planted_during: /gsd-explore, triggered by a real first-time user (a friend, guest account,
  Android phone) reporting that the bot took a very long time to play its first move and that
  the persona images loaded slowly
trigger_when: next milestone with appetite for a first-run / onboarding track. Pull forward
  immediately if the "bot clock runs during cold start" finding below is confirmed on a real
  device — that one is a correctness bug, not a UX complaint, and it is cheap to fix alone
scope: medium — one owned model loader (streaming fetch + progress), one clock gate wired to
  an existing seam, an avatar resize, and one conditional spawn. No schema change, no new
  backend surface, no calibration risk. The deliberately-deferred server-side option is
  scoped separately at the bottom
supersedes: nothing
---

# First-run engine cold start — bot play and analysis board

## The report

A first-time visitor created a **guest** account on an **Android phone** and started a bot
game. Two symptoms: the bot took a very long time to make its first move, and the persona
images loaded slowly. Both trace to one cause.

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

Sketch of the pieces, roughly in value order:

1. **Gate the fresh-game clock on engine readiness** via the existing `confirmLive()` seam
   (finding 1). Highest value, smallest diff, and it is the part that is arguably a bug.
2. **Own the model fetch** — streaming reader + byte counter, buffer into
   `InferenceSession.create()` (finding 2). Unlocks everything else.
3. **Surface progress wherever the engine cold-starts** — bot play AND the analysis board,
   which loads the same model. Worth auditing the analysis board's current loading state and
   reusing it rather than inventing a second one.
4. **Skip `pool.warm()` for blend-0 personas** (finding 3). Mechanical.
5. **Resize avatars to ~128px + `loading="lazy"`** (finding 5). Mechanical, independently
   valuable, no dependency on any of the above.
6. **Enable compression on the ONNX response** — Caddy's `encode gzip` does not match
   `application/octet-stream`; Cloudflare could compress it. Only ~8.5% (fp16), so lowest
   priority.

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
