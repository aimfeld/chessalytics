---
id: SEED-146
status: active
planted: 2026-08-10
planted_during: /gsd-explore — "what happens if 100 users import simultaneously; low-hanging
  fruit before a YouTube recommendation sends a signup spike"
trigger_when: before any planned or plausible traffic event (YouTube/streamer mention, Show HN,
  press, product launch), OR when observed concurrent imports regularly exceed ~5, OR when
  concurrent active tabs exceed ~100. Items 1–3 and 5 are cheap enough to do pre-emptively.
scope: small-to-medium — four self-contained fixes (one frontend hook, one `to_thread`, one DNS
  change, one semaphore) plus one medium feature (import queue + position UI). No migration.
  Item 6 is explicitly deferred and sized here only so it is not mistaken for cheap.
promoted: Phase 209 (2026-08-10) — quick-win cut only (items 1, 2-guest, 3, 5, and a thin
  item 4 of global semaphore + bare "queued" status). Register/login hashing, queue
  position/ETA UX, and item 6 remain unimplemented by user decision; seed stays active
  until they are done or explicitly abandoned.
---

# SEED-146: Traffic-surge readiness — survive a YouTube mention without falling over

## Why This Matters

FlawChess today serves ~10–25 DAU with a peak of **3 concurrent imports**. Every capacity
question has therefore never been asked in anger. A single creator recommendation would take
the site from 20 concurrent users to several hundred inside an hour, and the failure modes are
not where you would expect: **the import pipeline is not the first thing to break.**

The pipeline is actually well defended — the eval hot lane was decoupled into the cold drain
(Phase 91 / SEED-023), sessions are per-batch (Phase 90 / SEED-018), the DB pool was bounded
after the 2026-05-21 OOM, and `max_wal_size=8GB` handles the checkpoint storms. Postgres runs
at **0.012 average busy backends**. It is the least stressed component on the box by a wide
margin.

What breaks first is a set of things that are invisible at 20 DAU because they scale with
*concurrent users* rather than with data volume:

1. an unbounded 3-second poll that never terminates,
2. a 66 ms synchronous CPU block on the single event loop, sitting directly on the "Use as
   Guest" button — i.e. on the exact funnel a video sends traffic into, and
3. 82 MB of vendored ML runtime served off the origin box.

None of these needed a load test to find; all were measured directly. **None of them require a
staging environment to fix**, which matters because there isn't one.

## Explicitly Out Of Scope

- **Analysis backpressure.** A user's archive taking days to analyze is *fine* — the ES lottery
  is designed for it, provided progress is visible. Do not let this seed grow an eval-throughput
  track. (Related: `project_tier4_blob_backfill_measurement`, `project_eval_completion_columns`.)
- **Web Push for the "analysis ready" signal.** Considered and rejected for this work: the poll
  gets fixed in place. Push stays for what Phase 201 built it for.
- **Load testing.** No staging environment exists. Every fix below is verifiable locally or by
  inspection; do not gate this seed on building a load-test rig.

## Measured Facts (verified 2026-08-10, do not re-derive)

### The blocking costs

| Fact | Value | How measured |
|---|---|---|
| **Argon2id hash** (`fastapi-users` 15.x → pwdlib) | **65.9 ms** per call | direct benchmark of `PasswordHelper().hash()` |
| **`process_game_pgn`** (parse + Zobrist + classify) | **5.80 ms/game**, 0.064 ms/ply, 172.5 games/s | 500 real games / 45,427 plies |
| **Prod core vs dev core** | **parity** — 0.733 s vs 0.772 s | identical Python busy-loop, run in the prod backend container |
| `COPY game_positions` | 71.7 ms mean, 4,905 calls | `pg_stat_statements` |
| `compute_stage_a` percentile query | **1,111.7 ms mean**, 333 calls | `pg_stat_statements` (calls ≈ 306 completed imports — it is per-import, not per-page) |

Prod cores being *as fast as* the dev box is load-bearing: it means the 5.80 ms and 65.9 ms
figures transfer directly, with no scaling fudge.

### The box and its current headroom

| | |
|---|---|
| Host | Hetzner CPX42, 8 vCPU, 15.6 GB, load average **0.07** |
| backend container | 2.06 / 4 GB (`STOCKFISH_POOL_SIZE=6`, SCHED_IDLE) |
| db container | 6.43 / 12 GB |
| Disk | 39 G used / 105 G avail of 150 G |
| DB size | 24 GB — `game_positions` 14 GB, `game_flaws` 6.5 GB, `games` 3.9 GB |
| Postgres load | **0.012 avg busy backends** over a 12.75-day window (13,342 s exec / 109.3 M calls) |

### The population

| | |
|---|---|
| Users | 521 (304 guests, 217 real) |
| Games / positions | 774,422 / 53,265,490 |
| Games per user | median **1,109**, mean 2,581, p90 7,160, max 40,218 |
| Storage all-in | **32.5 KB/game** → ~36 MB median user, ~84 MB mean user |
| Import wall-clock | chess.com median 1,353 games / 59.9 s; lichess 1,038 / 73.8 s; p90 ~6,000 games / 241–337 s |
| **Peak observed concurrency** | **3 imports**; DAU peak 64 (launch spike), typical 10–25 |

Disk headroom: ~800–1,000 additional mean-sized users before it is a concern. **Storage is not
the constraint.**

### Static asset weight (origin-served)

| File | Size |
|---|---|
| `frontend/public/maia/maia3_simplified.onnx` | **45.68 MB** |
| `ort-wasm-simd-threaded.asyncify.wasm` | 24.25 MB |
| `ort-wasm-simd-threaded.wasm` | 13.48 MB |
| `frontend/public/engine/stockfish-18-lite-single.wasm` | 7.30 MB |

Correctly `lazy()`-loaded (Analysis/Bots/Train only, `App.tsx:48–54`) and cached 30 days
(`deploy/Caddyfile` `@vendored_runtime`). The problem is purely first-visit concurrency off a
single 1 Gbps NIC: ~45 MB/user ≈ **2.8 users/sec** before the link saturates — on the same box
as Postgres and the backend.

### Estimated ceilings (derived from the above; NOT load-tested)

| Load | Comfortable | Degraded | Breaks |
|---|---|---|---|
| Concurrent imports | ~10–15 | 20–40 | >40 (pool timeouts → site-wide 500s) |
| Concurrent browsing users | ~200 | 300–600 | >800 |
| API req/s (single event loop) | <50 | 50–120 | >150 |

## The Ranked Fix List

Ordered by impact-during-spike ÷ effort. **1, 2, 3, 5 are roughly a day together** and cover
every failure mode that takes down the *whole site* rather than just slowing new arrivals.
Item 4 is what delivers the agreed UX.

### 1. `useReadiness` — the unbounded poll (highest impact)

`frontend/src/hooks/useReadiness.ts:36` polls every 3 s (`READINESS_POLL_INTERVAL_MS`, `:5`) and
stops **only when `tier2` is true**. Tier 2 requires `pending_count == 0` — evals fully drained.

Since a days-long analysis window is explicitly acceptable (see Out Of Scope), **tier2 stays
false for days, so the poll never terminates.** It is mounted at four places in `App.tsx`
(`:174, :394, :517, :743`), so it runs on essentially every page. TanStack dedupes per tab, so
it is 1 request / 3 s **per open tab, indefinitely**.

Each request hits `GET /imports/readiness` (`app/routers/imports.py:216`), which runs
`count_games_for_user` + `count_pending_evals` and, on the "stuck" path, up to four more per-TC
anchor CTEs. `count_pending_evals` looks like the 135 ms / 72 ms `count(*) FROM game_flaws`
shapes near the top of `pg_stat_statements`.

At 300 concurrent tabs that is ~100 req/s of the heaviest read query on the site, on one event
loop — **at the ceiling before a single import or signup happens.** Unlike an import surge it
does not drain; it is standing load proportional to concurrent users.

Fix (locked: in place, not Web Push):
- Exponential backoff — 3 s while tier1 is false (the import phase, seconds-to-minutes), then
  decay hard once tier1 flips and only tier2 is outstanding.
- Consider stopping at tier1 entirely for the surge UI and revealing tier2 surfaces on next
  navigation rather than by polling.
- Cheapen the endpoint. `count_pending_evals` on a 7,000-game user is not a 3-second-loop query.
- Cap total poll duration. A tab open for 8 hours should not still be asking.

> **Verify the fix by reverting it**, per `feedback_mutation_test_gap_closures` — a test that
> only asserts "backoff constant exists" proves nothing. Assert the *interval sequence*.

### 2. Argon2id on the event loop — 66 ms per hash

> **CORRECTION (2026-08-10, verified in code during Phase 209 scoping):** the funnel claim
> below is wrong. `POST /auth/guest/create` calls `create_guest_user`
> (`app/routers/auth.py:319` → `guest_service.py:26`), which writes `hashed_password=""` and
> **never hashes anything** — the "Use as Guest" button costs zero hashing. The call at
> `guest_service.py:94` is in `promote_guest_with_password`, reached from
> **`POST /auth/guest/promote/email`** (`auth.py:511`) — the later guest→account upgrade.
> So the "100 clicks ≈ 6.6 s frozen loop" scenario does not exist; hashing load is
> proportional to register/login/promotion volume, which is far below guest-click volume
> during a spike. This demotes item 2 from "funnel-critical" to "cheap hygiene": the XS
> `to_thread` at `:94` is still worth its one line, and the register/login (M) half is even
> more comfortably deferrable than argued below.

`app/services/guest_service.py:94` calls `_password_helper.hash(password)` synchronously
(`PasswordHelper()` at `:23`). `fastapi-users` 15.x uses pwdlib/Argon2id, measured at **65.9 ms**.
One uvicorn process, one event loop: that is 66 ms during which **nothing else is served**, for
anyone.

~~It fires on register, on login, and on **`POST /auth/guest/create`** — reached from the "Use as
Guest" button on `pages/Home.tsx:282,287` via `hooks/useAuth.ts:146`. That button is the funnel a
video points at. 100 people clicking it ≈ **6.6 s of fully frozen event loop**.~~ *(struck per
the correction above — guest creation does not hash)*

Split the fix — the two halves are not the same size:

- **Guest creation (XS, do first).** Our own code, so `await asyncio.to_thread(...)` is
  essentially a one-liner. Highest value-to-effort ratio in this seed.
- **Register / login (M).** Goes through `BaseUserManager.create()` / `authenticate()`, which
  call the hasher internally, and `PasswordHelperProtocol`'s methods are **sync — not awaitable**,
  so a custom password helper cannot fix this. The path is overriding both methods on our
  `UserManager` (`app/users.py`). Do not scope this as a one-liner.

Tuning Argon2 cost parameters downward is a *third* option and a security trade — treat it as a
fallback, not the plan.

### 3. CDN for `/maia/*` and `/engine/*` (XS — DNS, not code)

~82 MB of vendored ML runtime served from origin at ~2.8 users/sec before link saturation.

This is a **prerequisite, not a nice-to-have**, because the agreed wait-time UX is *"try a game
against one of the bots while your import runs"* — which sends a first-time visitor to download
45.68 MB at precisely the moment the box is at peak load. Good UX instinct, bad infrastructure
moment, unless the bytes come from somewhere else.

`@vendored_runtime` already carries `max-age=2592000` (`deploy/Caddyfile`), so a cache in front
needs no code change. Note `@maiaworker` (`/maia/maia-worker.js`) is deliberately `no-cache` and
must stay that way — the CDN config has to respect the existing per-path headers rather than
blanket-caching `/maia/*`.

### 4. Global import semaphore + queue position (S–M — delivers the agreed UX)

`app/routers/imports.py:157` fires `asyncio.create_task(import_service.run_import(job_id))` with
**no global cap** — only per-user-per-platform duplicate prevention.

What currently prevents catastrophe is accidental: the module-level outbound rate limiters
(`app/core/rate_limiters.py`, `CHESSCOM_SEMAPHORE_LIMIT = 3` / `LICHESS_SEMAPHORE_LIMIT = 3`)
throttle fetching, and lichess holds its slot for the entire stream. That also keeps memory off
the critical path (~6 imports actively buffering, not 100). **Do not remove these while raising
concurrency elsewhere** — they are load-bearing for the 4 GB backend limit.

But the *flush* phase is not semaphore-gated, and `_flush_batch` (`import_service.py:1326`) holds
a pooled session across the CPU-bound PGN parse. Pool is 10 + 10 = 20 (`app/core/database.py`),
`pool_timeout` is **unset** → SQLAlchemy's 30 s default, then `TimeoutError`. Past ~20 imports
simultaneously in flush, requests **from users who aren't importing** hang 30 s and then 500.

Locked UX (agreed): when an import cannot start immediately, show **queue position and an ETA**
("#37, starting in ~8 minutes") rather than failing or silently stalling, and offer a bot game as
the meanwhile — which is why item 3 gates this.

Also: 100 imports queued behind a 3-slot semaphore can exceed `IMPORT_TIMEOUT_SECONDS` (3 h,
`import_service.py`) while *waiting*, and the periodic reaper will mark them failed even though
the task is alive. An explicit queue must not be reaped as an orphan.

### 5. Gate `compute_stage_a` / `compute_stage_b` (XS)

`app/services/import_service.py:716` fires `asyncio.create_task(compute_stage_a(job.user_id))`
per completed import with **no concurrency gate**, and that is the **1,111.7 ms** query at the top
of `pg_stat_statements` (333 calls ≈ 306 completed imports — confirmed per-import, not per-page).

A burst of imports finishing together means N concurrent 1.1 s queries each holding one of 20
pooled connections. 20 simultaneous completions exhaust the pool for over a second; 100 for
several. A `Semaphore(2–3)` is the whole fix.

### 6. Deferred — throughput, not survival (L)

Sized here only so it is not mistaken for cheap:

- **`to_thread` the PGN parse.** 5.80 ms/game off the loop, ~4–6× ingest headroom on 8 idle
  cores. Needs the pooled session *released* around the parse, or it makes item 4 worse.
- **`uvicorn --workers`.** Biggest raw browsing win, but blocked by per-process module state:
  `import_service._jobs`, `last_activity._last_updated`, the `rate_limiters` semaphores,
  `percentile_compute_registry` — plus **six** lifespan background loops that would each run N×.
  `deploy/entrypoint.sh` currently passes no `--workers` by design.
- **Rate limiting.** There is none at all (no slowapi, no limiter middleware). 100 legitimate
  users are fine; one abusive client can peg the single loop.

## Traps

- **Do not remove the outbound rate-limiter semaphores while adding an import queue.** They are
  what keeps 100 concurrent imports inside the 4 GB backend limit (~6 actively buffering vs 100).
  Removing them re-opens the memory profile that caused the historical OOMs.
- **Do not raise `shared_buffers` above 2 GB** while tuning for the surge — see CLAUDE.md and
  `project_prod_postgres_wal_and_buffers`. Postgres is at 0.012 busy backends; it is *not* the
  bottleneck, and tuning it is motion without progress.
- **A `shm_size` or Postgres change needs container recreation**, not `docker compose restart db`.
- **`full_evals_completed_at IS NULL` counted 176,693 games** at exploration time, which reads as
  a large backlog and is misleading — it is the drain's pick predicate and almost certainly
  includes guest games the drain never processes. Do not cite it as a backlog figure without
  reconciling against `.planning/notes/eval-completion-columns.md`.
- **Item 1's fix is invisible to `tsc`/eslint/knip.** A backoff that silently never engages
  type-checks perfectly. Test the emitted interval sequence.
- **Measure before assuming the spike hits imports.** The whole reason this seed exists is that
  the intuitive answer (the import pipeline) was wrong; the standing poll and the guest-signup
  hash were both larger and both invisible at current scale.

## Rejected Alternatives

- **Web Push for the readiness signal — REJECTED.** Phase 201's infrastructure exists
  (VAPID, `push_subscriptions`, `push_send.py`) and a days-long analysis window is arguably the
  textbook case for it. Rejected anyway: fixing the poll in place is smaller, synchronous, and
  needs no subscription-permission funnel in the middle of a conversion spike. Revisit only if
  the poll proves unfixable within its own model.
- **Build a staging environment and load-test first — REJECTED.** None exists, building one is
  larger than every fix in this seed combined, and all four cheap fixes are verifiable locally or
  by inspection. The measurements above were obtained without one.
- **Vertical scaling (bigger Hetzner box) — REJECTED as the primary answer.** The binding
  constraint is a *single event loop*, not cores or RAM: the host runs at load 0.07 with 8 vCPUs
  and Postgres at 0.012 busy backends. More cores fix nothing until item 6's `--workers` work is
  done. Storage is likewise ~800–1,000 users away from mattering.
- **Removing the bot-game suggestion as the wait-time filler — REJECTED.** It is a good answer to
  "what do I do for the next 8 minutes" and it exercises the feature most likely to convert a
  video viewer. Fix the byte delivery (item 3) rather than the UX.
