---
title: Stream (or promptly release) chess.com archive JSON during import
trigger_condition: If import OOM pressure recurs in prod, OR when next touching the chess.com import path / import-memory work
planted_date: 2026-07-03
source: reports/code-review-fable-2026-07-02.md (finding #7 / 2.3)
---

# SEED-078: chess.com archive streaming import

`chesscom_client.py:314-324` materializes each monthly archive twice (raw response + parsed
dict, both alive while the batch loop consumes it), up to `CHESSCOM_SEMAPHORE_LIMIT = 3`
concurrent imports. A heavy bullet month is tens of MB of JSON × Python object overhead —
the largest single allocation in the import path. Lichess correctly streams NDJSON;
chess.com doesn't.

## Why deferred (not doing it now)

The prod OOM history is real, but that cause was already traced to import memory pressure
and mitigated via prod config (see memory `project_prod_oom_cause_and_stockfish_capacity`
and `project_prod_postgres_wal_and_buffers`; CLAUDE.md prod config section). No active OOM
symptom right now. Revisit if OOM-kills recur or when doing dedicated import-memory work.

## Fix

Stream-parse (`ijson` over `aiter_bytes()`), or at minimum `del resp` after `.json()` and
consume the games list destructively so both copies aren't held across the batch loop.

Related: SEED-017 (import resilience hardening), SEED-022 (import concurrency & postgres
headroom), SEED-024 (import process pool), SEED-027 (DB memory budget), and the
2026-05-20 import-pipeline-rethink note.
