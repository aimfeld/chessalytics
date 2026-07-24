---
id: SEED-024
status: deferred (waiting on memory headroom)
planted: 2026-05-21
planted_during: /gsd-explore session on 2026-05-21 reviewing the Phase 91 stress-test report (reports/phase91-import-stress-test-2026-05-21.md). The report's "Next-step ideas" section flagged a `ProcessPoolExecutor` for position generation as the highest-throughput follow-up (estimated 2–3× chess.com fetch speedup). The /gsd-explore discussion concluded the CPU side is fine on a near-idle box, but the memory side is the blocker — today's run already peaked at 7.53 / 7.6 GB host memory with 2.52 GB swap, and 2–3 worker processes would add ~600 MB–1 GiB of duplicated Python + python-chess + Sentry SDK state.
trigger_when: Either (a) prod server RAM is upgraded (Hetzner step up from 7.6 GB → 15+ GB), or (b) we measure per-worker RSS on this codebase and confirm a `forkserver`-based pool can stay under ~300 MB combined.
scope: small (single GSD phase: pool sizing config + offload the python-chess parsing + Zobrist hashing for chess.com fetch + measurement + Sentry context for worker errors)
priority: medium (pure performance — Phase 91 is already well within the box's headroom; this is wall-clock optimization for large imports, not a stability fix)
references:
  - reports/phase91-import-stress-test-2026-05-21.md   # the stress test that bounded the win at ~2× chess.com fetch
  - logs/import-stress-20k-each-2026-05-21.log         # memory/CPU evidence
  - app/services/import_service.py                     # current single-threaded fetch lane
  - app/services/zobrist.py                            # `process_game_pgn` — the CPU-bound work to offload
  - SEED-023                                           # the Phase 91 two-lane refactor this builds on
---

# SEED-024: ProcessPoolExecutor for chess.com fetch-lane parsing

## Goal

Move the python-chess parsing + Zobrist hashing work in the chess.com fetch lane off the single asyncio thread and onto a small `ProcessPoolExecutor`, unlocking the 2–3 idle cores during fetch. Target: ~2× chess.com fetch throughput (~11 g/s → ~22 g/s), shortening the wall-clock fetch window in a concurrent two-platform import from ~33 min to ~17–20 min. Lichess is API-bound and gets no benefit, so the pool is chess.com-only.

## Why deferred

The 2026-05-21 stress test established that the bottleneck case is **memory, not CPU**:

| Resource | Headroom today |
|---|---|
| CPU | ample (drain tail peaks at 360% on a 400% box, fetch peaks at 200%; box is otherwise idle in production) |
| RAM | **none meaningful** — host memory at 7.53 / 7.6 GB peak, 2.52 GB swap in use |

Each Python worker process re-imports `app`, `python-chess`, SQLAlchemy, asyncpg, Sentry SDK on init. Empirical Python rule-of-thumb: ~150–300 MB RSS per worker on this codebase. 2–3 workers ≈ 600 MB–1 GiB additional RSS during fetch, which would push host memory past the swap-thrash threshold that triggered the 2026-05-16 OOM-kill (FLAWCHESS-56). Phase 91 fixed that failure mode by removing Stockfish from the batch transaction; we should not re-introduce a memory-pressure regression on the fetch lane.

The user traffic argument doesn't save us here either: even at near-zero concurrent traffic, swap-pressure-vs-Postgres is a host-level resource auction, not a per-request constraint.

## Trigger conditions (in priority order)

1. **RAM upgrade.** Hetzner CX31 (7.6 GB) → CX41 (15.6 GB) or higher. Doubling RAM gives ~7.5 GB of guaranteed worker headroom and removes the swap-pressure failure mode from the threat model. This is the cleanest unblock.
2. **Measured per-worker RSS with `forkserver`.** Before going to `spawn` (which re-imports everything) we should measure `forkserver` — workers fork from a minimal pre-fork process that hasn't imported the heavy modules, so they don't inherit the asyncio loop or open DB connections but they're cheaper than `spawn`. If `forkserver` workers stay under ~100 MB combined, the memory bill is small enough to fit today's headroom.
3. **An observed user complaint about chess.com import wall-clock time.** Pure performance work shouldn't precede observed need.

## Implementation sketch (when triggered)

- Add `STOCKFISH_POOL_SIZE`-style env var: `IMPORT_PARSE_POOL_SIZE` (default 0 = disabled).
- Use `concurrent.futures.ProcessPoolExecutor` with `mp_context=multiprocessing.get_context("forkserver")`. **Not `fork`** — forking after the asyncio loop and DB pool have been initialized causes file-descriptor and event-loop corruption.
- Offload `process_game_pgn` (the per-game mainline walk) to the pool. The function is already pure (no DB, no engine, no logging), which is why Phase 78 refactored it into a single-pass function — it's pool-ready by design.
- Keep the result-aggregation + DB insert on the asyncio thread (single session, no concurrency on `AsyncSession`).
- Worker exceptions surface as `BrokenProcessPool` or per-future exceptions. Capture with `sentry_sdk.capture_exception()` in the orchestrator, tagged `source=import_parse_pool`, and fall back to in-process parsing for that batch.
- Measure: backend RSS during fetch with pool enabled, on a 20k-game chess.com-only import, against the 2026-05-21 baseline.

## Open questions for the future phase

- Does the pool survive process restarts across multiple import jobs, or do we tear it down between jobs? (Trade-off: warm pool = no fork cost on each job; long-lived pool = workers accumulate any latent memory growth in python-chess.)
- Should the pool be shared across concurrent import jobs (one pool, N workers) or per-job (each job gets its own 2-worker pool)? Shared is more efficient; per-job is simpler and bounded.
- Interaction with the cold-drain Stockfish pool: today both run in-process under uvicorn. If both want 2 cores each, that's 4 cores total — exactly the box. Need explicit budgeting.

## Why this is a seed, not a phase

The trigger conditions above are not met. Promoting this to a phase before then would either be wasted work (RAM not upgraded) or premature optimization (no observed need).
