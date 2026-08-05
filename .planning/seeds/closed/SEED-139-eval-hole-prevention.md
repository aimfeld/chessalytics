---
id: SEED-139
status: dormant
planted: 2026-08-05
planted_during: investigation of why `scripts/resweep_holed_games.py --db prod` still finds a few holed games ("can we prevent holes / raise timeouts?")
trigger_when: the next eval/worker-fleet phase, OR the next time a resweep returns a non-trivial count, OR when a new volunteer worker joins the fleet
scope: medium (four independent changes across worker script, server decision path, and a periodic task; each small on its own)
---

# SEED-139: prevent Path-C eval holes instead of resweeping them away

## Why This Matters

`resweep_holed_games.py` is a permanent manual chore. Every run is a human noticing that
some games silently lost mid-game evals. The holes are preventable, and the measurement
below shows the production mechanism precisely — one root cause, one concentrated source,
and four cheap mitigations, three of which need no cooperation from the machines causing
the problem.

## Measurement (prod, 2026-08-05)

Current state is clean: the resweep dry-run returns **0 games**, and of the **187k engine
games stamped in the last 14 days, 0 carry a non-terminal hole**. The repair works. The
production mechanism does too:

- Path C still fires — 7 `stamping complete after MAX_EVAL_ATTEMPTS with residual holes`
  warnings in a 3h log window (hole counts 5–23); Sentry `FLAWCHESS-8B` recorded 5257
  events in 29 days before that capture was downgraded to `logger.warning` on 2026-08-03.
- Path-C-eligible population (`full_eval_attempts = 2`, stamped, engine games): 9,988 games,
  **all of them hole-free** — i.e. the third attempt currently rescues every game that
  needs it, with no fourth attempt behind it.
- Retry pressure: 45,864 games (8.8%) needed a 2nd round, 9,988 (1.9%) a 3rd.

**Holes come from two machines.** `worker_heartbeats.holes_submitted / plies_leased`
(lifetime, atomic lane only):

| worker | IP | hole rate | holes |
|---|---|---|---|
| evjatkj8 | 88.198.19.214 | **62.9%** | 863,084 |
| 1nnk6a2k | 95.217.146.94 | **38.0%** | 721,909 |
| (several) | 31.10.131.115 | 12–54% | ~38k |
| ws80 | 34.65.108.190 | 11.1% | 28,451 |
| amalie-nb / amalie-pc / ai-slim / 3ag3c2qv | — | 0.00–0.07% | ~1k combined |

~99% of every hole ever submitted came from two boxes. Healthy workers time out on roughly
1 ply in 1500. Those same worker IDs appear in today's Path-C log lines.

## Root cause

A hole has exactly one origin: `_NODES_TIMEOUT_S = 5.0` (`app/services/engine.py:101`),
the wall-clock cap on the 1M-node search. On timeout `_acquire_and_analyse` returns `None`
→ `evaluate_nodes_with_pv` returns `(None, None, None, None)` → the worker submits NULL for
that ply → `_apply_full_eval_results` counts it in `failed_ply_count` → after
`MAX_EVAL_ATTEMPTS = 3` (`app/services/eval_apply.py:93`) `apply_completion_decision` Path C
stamps the game complete with the holes still in it.

The timeout is a defensive guard, not a search budget — a 1M-node search always terminates.
It only ever punishes a slow or oversubscribed box.

## The changes

### 1. Stop advertising CPU oversubscription (docs, no code)

`REMOTE_WORKER.md:41` tells operators they can go "up to twice your number of CPU cores."
Under a node-budget search with a 5s wall clock, 2× oversubscription roughly doubles
per-position time — harmless at prod's 1.28s p90, fatal on a slow CPU. Change the guidance
to "no more than your physical core count" and say why (each worker is `Threads=1`, and a
position that overruns 5s is discarded, not merely slowed).

Also worth writing down: the two operators above should lower `--workers`. That part is
blocked on contacting them and is **not** a prerequisite for anything below.

### 2. Worker-side retry of timed-out plies before submitting

In `scripts/remote_eval_worker.py` `_eval_positions` (and the blob/second-best analogues),
run one extra pass over the positions that came back `None`, with a longer timeout. On a
healthy box this never fires. On a slow box it converts most transient timeouts into real
evals instead of holes.

Preferred over raising `_NODES_TIMEOUT_S` globally, which would also slow the prod server
pool for no benefit. If a blanket raise is chosen anyway, note two couplings:
`STALL_THRESHOLD_S = 600` derives its budget from `5s × (100 / --workers)`, and
`LEASE_TTL_SECONDS = 120` would be overrun more often (see item 3).

**Caveat: this only helps once the slow boxes pull the updated worker.** It is the one item
here gated on operator action.

### 3. Do not burn a retry on a submit that made progress (server-side)

`apply_completion_decision` (`app/services/eval_apply.py:785`) increments
`full_eval_attempts` per *submit*, not per *round*. Prod logs show the same game
Path-C-submitted by two different workers seconds apart (game 2263068, game 2268178) — a
slow worker overruns `LEASE_TTL_SECONDS = 120`, a second worker re-claims, both submit,
and two of the three attempts are gone in a single round.

Fix: increment only when the submit failed to reduce the game's hole count. The atomic lane
passes `preserve_existing_evals=True` (`app/routers/eval_remote.py:1327`), so an existing
eval is never overwritten with NULL — the hole count is monotonically non-increasing and
the retry loop still terminates (bounded by ply count + `MAX_EVAL_ATTEMPTS` no-progress
rounds). Re-read `_is_engine_hole` / `_is_lichess_best_move_hole` before implementing:
their existing-value guards are the same monotonicity argument in local form.

### 4. `MAX_EVAL_ATTEMPTS` 3 → 5

Nearly free since SEED-076 made re-leases incremental (only the still-missing plies are
re-sent, so a retry costs a handful of positions, not a whole game). Today *every* game
that reached the 3rd attempt succeeded and there is no 4th behind it — the budget is the
binding constraint, not the engine.

### 5. Automate the resweep

Run `resweep_holed_games` on a schedule (daily or weekly backend task) so the repair stops
being manual. This is a safety net, not a prevention — keep it even after 2–4 land.

Watch-out: the resweep resets `full_eval_attempts` to 0, so an unconditional periodic sweep
would re-arm a genuinely unevaluable game forever, burning 3 attempts each cycle. Current
evidence says every swept game does get fixed, so this is acceptable to start; if that
changes, add a bounded `resweep_count` column rather than dropping the automation.

## Does this help without fixing the slow workers?

Yes, for 3, 4, and 5 — all server-side, effective immediately, and aimed exactly at the
failure mode a slow worker produces (budget exhausted by duplicate/partial submits before a
healthy worker gets a turn). Item 1's doc fix is preventive for future operators. Item 2 is
the only one that needs the slow boxes to update.

## Deliberately not included

A **server-side worker quality gate** — refusing atomic leases to a worker whose recent hole
rate exceeds a threshold. That is the real structural prevention, and the telemetry for it
already exists, but `worker_heartbeats` counters are lifetime-cumulative and documented as
"passive telemetry only (D-01/D-04) — no gate". A gate needs a windowed rate (last-K or
EWMA) plus a lease-time check, which is a proper phase, not a seed item. Plant it separately
if 1–5 prove insufficient.

## Related

- `[[project_atomic_submit_staledata_and_8b]]` — 8B is this population; the 2026-07-25
  fix (a timeout no longer restarts the Stockfish worker) removed the *amplifier* that
  turned one slow position into a median of 25 holes. It did not remove the source.
- `[[project_worker_fleet_topology]]` — worker IPs live only in access logs / heartbeats;
  there is no DB registry, so the table above is the only attribution mechanism.
- `[[project_eval_nondeterminism]]` — the same wall-clock timeout is why eval_cp is not
  reproducible across machines.
- SEED-045 (bounded-retry Path A/B/C), SEED-076 (incremental re-lease), SEED-049
  (game-ending-ply hole exclusion), quick task 260725-da3 (timeout no longer restarts).
