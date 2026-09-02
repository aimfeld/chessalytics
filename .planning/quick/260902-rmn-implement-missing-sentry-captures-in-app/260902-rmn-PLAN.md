---
quick_id: 260902-rmn
description: Implement missing Sentry captures in app/services and app/routers except blocks (CONCERNS.md L7-11)
mode: quick
date: 2026-09-02
---

# Quick task 260902-rmn: missing Sentry captures

## Audit (planning-time, live grep of app/services + app/routers)

136 `except` clauses; 69 have no `capture_exception`/`capture_message` in their body.
62 of those are expected conditions and stay as-is:

- `ValueError`/`IllegalMoveError`/`ZoneInfoNotFoundError` fallbacks on user or PGN input (normalization, insights_llm, train_scheduler, tactic_detector, library_service, flaws_service, eval_apply token parsing)
- `UserAlreadyExists`, `InsightsValidationFailure`/`ProviderError` (HTTP mapping)
- `asyncio.CancelledError: raise` (lifespan contract)
- retry loops that re-raise or capture `last_exc` on the final attempt (chesscom_client, import_service)
- per-item loops that capture `last_failure` once after the loop (guest_cleanup_service, train_reminder_service)
- deliberately swallowed best-effort syscalls with rationale comments (engine.py SCHED_IDLE / PR_SET_PDEATHSIG), `ImportError` for optional onnxruntime, stale bearer-token decode in users.py

## Genuine gaps (7 sites)

| # | Site | Why it matters |
|---|------|----------------|
| 1 | `app/services/engine.py` `_restart_worker` `except Exception` | Stockfish respawn failure leaves a dead slot forever, no trace |
| 2 | `app/services/engine.py` `_acquire_and_analyse` `except (EngineError, EngineTerminatedError)` | engine crash → restart with no Sentry issue |
| 3 | `app/services/eval_apply.py` `_collect_full_ply_targets` read_game `except Exception` | stored PGN parse failure → silent eval hole |
| 4 | `app/services/eval_apply.py` `_collect_full_ply_targets` `board.san` `except Exception` | silent loss of played-move SAN (gem/great badges) |
| 5 | `app/services/eval_apply.py` `_build_flaw_blob_lease_positions` read_game `except Exception` | silent tier-4 blob skip |
| 6 | `app/services/eval_entry.py` `_snapshot_boards` read_game `except Exception` | silent endgame-entry skip |
| 7 | `app/routers/eval_remote.py` `_build_lease_positions` read_game `except Exception` | silent remote-worker lease skip |

## Tasks

### Task 1: add captures at the 7 sites
- `files`: the four files above
- `action`: `sentry_sdk.set_tag("source", ...)` + `set_context` with game_id / worker idx, then `capture_exception(exc)`; keep the existing fallback return values unchanged. Messages carry no variables (grouping rule).
- `verify`: `uv run ruff check`, `uv run ty check app/ tests/ scripts/`
- `done`: every site in the table captures before returning its fallback

### Task 2: tests proving the captures fire
- `files`: `tests/services/test_engine_nodes.py`, `tests/services/test_eval_apply.py`
- `action`: patch `sentry_sdk.capture_exception`, force the failure path, assert one call. Prove by reverting the fix: test must fail without it.
- `verify`: targeted pytest, then relevant suites
