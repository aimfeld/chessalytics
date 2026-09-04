# 212-09 classical tranche readiness

**Date:** 2026-08-23 (local). All measurements taken 2026-08-22 22:38–22:45 UTC
against the benchmark Postgres on `localhost:5433`.

Durable record written so 212-10's blocking decision checkpoint can be presented on
current, measured numbers even after a context clear. 212-06's checkpoint had to
assemble its five numbers live and could not offer `start-now` on its first pass,
because the snapshot did not exist yet; this file exists so that cannot repeat.

Every number below carries the command or query that produced it. Nothing here is
carried forward from CONTEXT.md's planning estimates.

---

## The five decision numbers

| # | Measure | Value | Produced by |
|---|---------|-------|-------------|
| 1 | `benchmark_selection` classical rows | **50,737** (27,020 lichess-arm / 23,717 never-analyzed, 745 distinct users) | `SELECT tc_tranche, lichess_arm, count(*) FROM benchmark_selection GROUP BY 1,2` |
| 2 | Distinct classical lichess-arm games covered by the snapshot | **27,020** | `SELECT count(DISTINCT s.game_id) FROM benchmark_lichess_eval_snapshot s JOIN benchmark_selection bs ON bs.game_id=s.game_id WHERE bs.tc_tranche='classical' AND bs.lichess_arm IS TRUE` |
| 3 | **Coverage gap (must be 0)** | **0** ✅ | number 1's lichess-arm count minus number 2 |
| 4 | Gate flags in any environment dotfile | **absent from both `.env` and `.env.example`** | `grep -q '^[[:space:]]*<KEY>=' <file>` for `BENCHMARK_SELECTION_GATE_ENABLED` and `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` across every `.env*` in the repo root |
| 5 | Free disk on the benchmark volume | **654.6 GiB free** of 1.8 TiB (63% used) | `df -B1 --output=avail /` → 702,851,485,696 bytes |

Number 4 means both flags remain command-line-only for the port 8001 instance, as
§3 of the runbook requires. Nothing in the repository turns them on implicitly.

---

## Disk verdict: **clears the transient budget with very wide room to spare**

Runbook §9's budget, applied to this tranche's actual game count:

| Figure | Arithmetic | Result |
|--------|-----------|--------|
| Net writes | 50,737 games × ~15 KiB | **~0.73 GiB** |
| Transient headroom during the run (UPDATE-heavy, ~2× net until vacuumed) | 50,737 × ~30 KiB | **~1.45 GiB** |
| Measured free | — | **654.6 GiB** |
| Headroom against the transient figure | 654.6 / 1.45 | **~450×** |

**Verdict in words:** free space clears the transient budget with room to spare, by
roughly two and a half orders of magnitude. Disk is not a reason to prefer a
stop-at-boundary plan at 212-10's checkpoint, and the post-run vacuum (runbook §7)
is hygiene here rather than a capacity necessity.

The snapshot pass itself has already been paid for out of that free space:
`benchmark_lichess_eval_snapshot` now occupies **178 MB** on disk (was 28 MB at the
smoke tranche), and the 654.6 GiB reading above was taken *after* it landed.

---

## Tranche-start leak baseline

Re-measured now, at the moment the tranche is ready to start — **not** carried from
the 212-08 smoke run. 212-10's post-run task compares against these.

| Measure | Value | Query |
|---------|-------|-------|
| `games` with `evals_completed_at` **NOT NULL** — **the leak baseline** | **1,846,458** | `SELECT count(*) FILTER (WHERE evals_completed_at IS NOT NULL) FROM games` |
| `games` with `evals_completed_at` NULL | 920,700 | same aggregate, `IS NULL` |
| Total games in the benchmark corpus | 2,767,158 | `SELECT count(*) FROM games` |
| `games` with `lichess_evals_at` NOT NULL | 641,855 | `SELECT count(*) FILTER (WHERE lichess_evals_at IS NOT NULL) FROM games` |

The leak baseline is **identical to 212-08's** (1,846,458 before and after that
run). Nothing leaked between the smoke record and this file, which is expected: no
backend and no worker touched the benchmark database during 212-09's work.

**Abort signal for 212-10, unchanged from 212-08:** if the corpus-wide count of
games with a non-NULL `evals_completed_at` climbs above 1,846,458 during the run,
fleet capacity is leaking onto unselected games — stop and investigate rather than
letting the run continue.

---

## Tranche progress at the starting line

From `benchmark_lane.py status --tranche classical --db benchmark`, 22:45 UTC.
Recorded so a later reader can separate what the tranche produced from what
already existed before it started.

| Arm | selected | full_evals_done | full_pv_done | best_moves_done | blobs_done |
|-----|---------:|----------------:|-------------:|----------------:|-----------:|
| lichess_arm | 27,020 | 20,279 | 8 | 8 | 876 |
| never_analyzed_arm | 23,717 | 10 | 10 | 10 | 8 |

`snapshot_rows` (lichess arm only): **1,924,579**. Percent complete
(`best_moves_done / selected`): **0.0%**.

Read these as the starting point, not as progress:

- The lichess arm's **20,279 `full_evals_done`** is pre-existing lichess-provided
  eval coverage, not work this program did. It is exactly the population D-03's
  homogenization will overwrite with our own engine's values, and exactly what the
  snapshot above preserves.
- The small non-zero `full_pv_done` / `best_moves_done` / `blobs_done` figures (8,
  8, 876 and 10, 10, 8) are the 20-game smoke tranche from 212-08 plus incidental
  pre-existing rows. The smoke tranche's 20 games are subsumed into this selection
  rather than duplicated.

---

## Pre-launch checklist — the three non-negotiables

Restated from runbook §3 and §4 because each fails silently if missed:

1. **The write-capable `flawchess_benchmark` role, never `flawchess_benchmark_ro`.**
   The `_ro` role is what the MCP tool uses (`GRANT SELECT` only); it fails on the
   first write with `asyncpg.InsufficientPrivilegeError`.
2. **Plain `DATABASE_URL`, never `DATABASE_URL_BENCHMARK`.** The app and Alembic
   only read `DATABASE_URL`. Setting only the benchmark-specific variable silently
   points the backend at the *dev* database.
3. **Maia confirmed loaded from the :8001 startup log before any worker is pointed
   at the instance.** A Maia-absent backend produces PV normally but never stamps
   `best_moves_completed_at`, and row counts alone cannot distinguish that
   afterward — which is why it is a startup-time check.

---

## Preconditions verified during this plan

- Nothing was listening on port 8001 at selection and snapshot time
  (`ss -ltnp | grep :8001` → empty), and no `remote_eval_worker.py` process was
  running. Widening the selection under a live drain would have silently widened
  that drain's scope.
- Only the classical tranche exists in `benchmark_selection` — zero rows for
  rapid, blitz or bullet. The locked TC ordering is intact.
- Every selected game id resolves to a real `games` row (0 orphans), every row
  carries the classical time-control bucket (0 mismatches), and every
  `lichess_arm` flag agrees with the game's `lichess_evals_at` (0 mismatches).
- All 20 of 212-01's smoke game ids are present exactly once each — the compound
  unique key held at full scale.
- Both selection and snapshot were proven idempotent at real scale: a second
  identical pass inserted **0** rows in each case (selection skipped all 50,737;
  snapshot skipped all 1,924,579).

## One deviation worth carrying into 212-10

The first full-scale snapshot pass **crashed at row 5,000** with
`asyncpg.exceptions.NoActiveSQLTransactionError: cursor cannot be created outside
of a transaction`. The batched `session.commit()` was running on the same session
that owned the server-side cursor, so the commit ended the cursor's transaction.
The 397-row smoke tranche never reached the 5,000-row batch threshold, so that path
had shipped unexercised.

Fixed in `8bdbfee04` (read and write split onto separate sessions) with a
regression test that feeds 2× the batch size through the loop; the fix was verified
by reverting it and confirming the test then fails with the same error. The 5,000
rows the crashed pass had already committed were skipped by the idempotency dedup
on the retry, so nothing was double-inserted and nothing was lost.

Relevance to 212-10: the snapshot subcommand is now proven at full scale, so the
recovery path D-05 depends on is real rather than assumed.
