---
quick_id: 260902-rmn
status: complete
date: 2026-09-02
commit: 7fc994cf7
---

# Summary: missing Sentry captures (CONCERNS.md L7-11)

## Audit result

136 `except` clauses in `app/services` + `app/routers`; 69 without a Sentry capture in the block body. 62 are expected conditions per the CLAUDE.md rule (input parse fallbacks, `CancelledError` re-raise, retry loops that raise/capture on the last attempt, per-item loops with one aggregate capture after the loop, deliberately swallowed best-effort syscalls with rationale comments, optional-dependency `ImportError`, stale bearer-token decode). Seven swallowed genuine unexpected failures silently.

## Fixed (commit 7fc994cf7)

| Site | Failure that was invisible |
|------|----------------------------|
| `engine.py` `_restart_worker` | Stockfish respawn failure → slot permanently dead |
| `engine.py` `_acquire_and_analyse` | engine crash that triggers the restart |
| `eval_apply.py` `_collect_full_ply_targets` (read_game) | stored PGN parse raise → permanent eval hole |
| `eval_apply.py` `_collect_full_ply_targets` (board.san) | lost played-move SAN (gem/great badge) |
| `eval_apply.py` `_build_flaw_blob_lease_positions` | stored PGN parse raise → tier-4 blob skipped |
| `eval_entry.py` `_snapshot_boards` | stored PGN parse raise → endgame entry skipped |
| `eval_remote.py` `_build_lease_positions` | stored PGN parse raise → remote lease skipped |

Fallback return values unchanged. Each site sets a `source` tag, a context with `game_id` / worker index, then `capture_exception(exc)`. No variables in messages.

## Tests

- `tests/services/test_sentry_capture_gaps.py` (new): read_game / san failure at 3 pure sites → exactly one capture, fallback unchanged; happy path → zero captures.
- `tests/services/test_engine_nodes.py`: engine-error test now asserts the capture; new respawn-failure test.
- Mutation check: with the app changes reverted, 6 of the 14 tests fail. `_build_flaw_blob_lease_positions` is DB-bound and untested (same 4-line pattern as the tested sites).
- Related suites: 470 tests green (`test_eval_apply`, `test_full_eval_drain`, `test_eval_worker_endpoints`, `test_eval_remote_schema_bounds`, `test_engine*`, eval_entry users). ruff + ty clean.

## Not changed (deliberate)

- `import_service.py` `engine.dispose()` warning during failure-record retry: best-effort, the retry's own final failure is captured.
- `chesscom_client.py` probe network errors → "unknown" status: transient by design.
- `users.py` impersonation JWT decode → None: a stale Authorization header alongside cookie auth is expected.

## Process note

Audit and edits were done inline by the orchestrator (memory: no subagent for small mechanical work); no planner/executor subagents were spawned. Worktree isolation auto-degraded to sequential (HEAD ahead of origin/HEAD).
