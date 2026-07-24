# Phase 188: Import/Eval Pipeline Cleanup — Pattern Map

**Mapped:** 2026-07-24
**Files analyzed:** 10 (2 edited docstring/logic, 7 archived, 1 new migration + 1 model edit)
**Analogs found:** 10 / 10 (this is a maintenance phase — every "file" has a direct in-repo precedent, no external pattern needed)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `alembic/versions/<new>_realign_ix_games_bestmove_backfill_pending.py` | migration | batch/DDL | `alembic/versions/20260716_171823_1eda5daba951_phase_174_07_lichess_best_move_backfill_.py` | exact (same table, same index-drop/create shape) |
| `app/models/game.py` (Index at ~97-104) | model | CRUD (index metadata only) | itself — must stay byte-identical to the new migration's `postgresql_where` text | exact |
| `app/services/eval_queue_service.py` (docstring/comment trim, no logic change) | service | request-response (scheduler) | itself — no external analog needed, this is in-place text editing | n/a (self-edit) |
| `app/services/eval_drain.py` (re-export block ~63-105; `resweep_holed_games` docstring ~1151-1289) | service | CRUD / batch | itself — no external analog needed | n/a (self-edit) |
| `app/routers/eval_remote.py` (docstrings ~428-429, ~1313-1316) | route/controller | request-response | itself — no external analog needed | n/a (self-edit) |
| `scripts/backfill_eval.py` → `scripts/archive/backfill_eval.py` | utility (one-shot CLI) | batch | `scripts/archive/backfill_user_percentiles.py` (commit `1d74a8e8` precedent) | exact |
| `scripts/backfill_full_evals.py` → `scripts/archive/...` | utility | batch | same as above | exact |
| `scripts/backfill_best_move_pv.py` → `scripts/archive/...` (+ import repoint) | utility | batch | same as above, plus needs a 1-line import fix (new territory vs. the 3-file precedent, which needed zero content changes) | exact + minor deviation |
| `scripts/backfill_multipv.py` → `scripts/archive/...` (+ import repoint) | utility | batch | same as above | exact + minor deviation |
| `scripts/backfill_opening_eval_cache.py`, `snapshot_tactic_counts.py`, `backfill_accuracy_acpl.py` → `scripts/archive/...` | utility | batch | `scripts/archive/backfill_user_percentiles.py` | exact |

## Pattern Assignments

### `alembic/versions/<new>_realign_ix_games_bestmove_backfill_pending.py` (migration)

**Analog:** `alembic/versions/20260716_171823_1eda5daba951_phase_174_07_lichess_best_move_backfill_.py`

**Convention (verbatim from analog's module docstring):**
```
Created non-concurrently (inside transaction), following the project's other
partial-index migrations (ix_games_user_evals_pending, ix_games_full_pv_pending,
ix_games_needs_engine_full_evals, ix_games_pv_backfill_pending): migrations run
against a quiescent backend at container startup, and CONCURRENTLY cannot run
in a transaction.
```
`deploy/entrypoint.sh` runs `alembic upgrade head` before `exec uvicorn ...` — confirms no live-query contention to protect against. Do NOT introduce `postgresql_concurrently=True` for the first time here.

**Target `upgrade()`/`downgrade()` body** (drop-clause fix, current predicate → target predicate):
```python
def upgrade() -> None:
    op.drop_index(
        "ix_games_bestmove_backfill_pending",
        table_name="games",
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
            " AND lichess_evals_at IS NULL"
        ),
    )
    op.create_index(
        "ix_games_bestmove_backfill_pending",
        "games",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
        ),
    )

def downgrade() -> None:
    # restore exactly (drop new form, recreate 3-clause form) — mirror image of upgrade()
    ...
```
`down_revision` must be the current head `f09f8dee4aee` (`20260724_043548_..._add_user_import_settings.py`).

**Byte-identical-text requirement:** the model's `sa.text(...)` string in `app/models/game.py` and the migration's `op.create_index(..., postgresql_where=sa.text(...))` string must be character-for-character identical (per the drift-lesson comment already present at `game.py:95-96`, itself dating to the 174-07 migration) — otherwise a future `alembic revision --autogenerate` will detect a phantom diff.

---

### `app/models/game.py` — Index definition (model)

**Current (lines ~97-104):**
```python
Index(
    "ix_games_bestmove_backfill_pending",
    "user_id",
    postgresql_where=sa.text(
        "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
        " AND lichess_evals_at IS NULL"
    ),
),
```
**Target:**
```python
Index(
    "ix_games_bestmove_backfill_pending",
    "user_id",
    postgresql_where=sa.text(
        "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
    ),
),
```
Edit this in the **same commit** as the migration — both must agree per the file's own drift-lesson comment. Query it must match: `app/services/eval_queue_service.py`'s `_claim_tier4_bestmove` Stage-1/Stage-2 predicate, verbatim `g.full_pv_completed_at IS NOT NULL AND g.best_moves_completed_at IS NULL`.

---

### `scripts/archive/*.py` (utility, batch) — archival convention

**Analog:** commit `1d74a8e8` (`scripts/archive/backfill_user_percentiles.py`, `coverage_report_tactic_motifs.py`, `stress_test_dual_platform_import.py`)

**Pattern — plain `git mv`, zero content changes** (verified via `git show --stat 1d74a8e8`: "3 files changed, 0 insertions(+), 0 deletions(-)"):
```bash
git mv scripts/backfill_eval.py scripts/archive/backfill_eval.py
git mv scripts/backfill_full_evals.py scripts/archive/backfill_full_evals.py
git mv scripts/backfill_best_move_pv.py scripts/archive/backfill_best_move_pv.py
git mv scripts/backfill_multipv.py scripts/archive/backfill_multipv.py
git mv scripts/backfill_opening_eval_cache.py scripts/archive/backfill_opening_eval_cache.py
git mv scripts/snapshot_tactic_counts.py scripts/archive/snapshot_tactic_counts.py
git mv scripts/backfill_accuracy_acpl.py scripts/archive/backfill_accuracy_acpl.py
```
Commit message convention (from the precedent commit): `chore(scripts): archive ...` prefix, one bullet per file naming *why* it has no ongoing reuse value (phase/seed reference + what superseded it), `Co-Authored-By` / `Claude-Session` trailer per project convention.

**Deviation for 2 of the 7 files:** `backfill_best_move_pv.py` and `backfill_multipv.py` each import symbols from `eval_drain.py` that D-06 prunes (`_batch_update_best_move_rows`/`_batch_update_pv_rows` for the former; `_batch_update_flaw_pv_lines` for the latter). The precedent's 3 files needed zero content changes; these 2 need a 1-line import repoint in the SAME commit as the archival `git mv`:
```python
# Before (in the archived script, currently importing from eval_drain):
from app.services.eval_drain import _batch_update_best_move_rows, _batch_update_pv_rows

# After (repoint to the actual owning module — eval_apply.py — since the
# eval_drain re-export is being pruned):
from app.services.eval_apply import _batch_update_best_move_rows, _batch_update_pv_rows
```
Same for `backfill_multipv.py`, but only `_batch_update_flaw_pv_lines` moves — its other two imports (`_assemble_flaw_blobs_from_submit`, `_build_flaw_blob_lease_positions`) stay pointed at `eval_drain` (they are NOT pruned).

---

### `app/services/eval_drain.py` — re-export block prune (D-06)

**Current block (lines ~57-105), full excerpt (imports from `eval_apply`):**
```python
from app.services.eval_apply import (
    MAX_EVAL_ATTEMPTS,  # noqa: F401 — backward-compat re-export (tests)
    _FullPlyEvalTarget,
    _apply_full_eval_results,  # noqa: F401 — backward-compat re-export (tests/scripts)
    _assemble_flaw_blobs_from_submit,  # noqa: F401 — backward-compat re-export (tests)
    _assemble_one_line_blob,  # noqa: F401 — backward-compat re-export (tests)
    _batch_update_best_move_rows,  # noqa: F401 — backward-compat re-export (scripts)   <- PRUNE
    _batch_update_flaw_pv_lines,  # noqa: F401 — backward-compat re-export (scripts)     <- PRUNE
    _batch_update_pv_rows,  # noqa: F401 — backward-compat re-export (scripts)           <- PRUNE
    _build_best_move_candidates,
    _build_bestmove_lease_positions,
    _build_flaw_blob_lease_positions,  # noqa: F401 — backward-compat re-export (tests/scripts)
    _build_flaw_multipv2_blobs,
    _build_line_blobs,  # noqa: F401 — backward-compat re-export (tests)
    ...
    _walk_pv_boards,  # noqa: F401 — backward-compat re-export (scripts)
    apply_full_eval,
)
```
**Action:** delete exactly the 3 lines marked `<- PRUNE` (and their trailing comma placement adjustment). Leave every other `noqa: F401` line untouched — even though 10 of the 13 comments under-claim their real importer set (they say "scripts" but are test-imported too), that's stale metadata, not a reason to remove them. **Verification order (per research pitfall 2): run collection first** (`uv run pytest tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py --collect-only`) before the real run — an accidental over-prune surfaces as a hard `ImportError` at collection time, not a lint warning.

---

### `app/services/eval_drain.py` — `resweep_holed_games` docstring rewrite (D-01)

**Location:** lines 1151-1289 (function), docstring 1156-1193. **Keep unchanged:** lines 1163-1193 (hole definition, SEED-045/SEED-049 exclusions, Args/Returns/prod-usage — still correct and load-bearing).

**Rewrite target for lines 1156-1162** (the motivating "why" paragraph) — cites `app/services/eval_apply.py:714,739-743` verbatim:
```python
# Source: app/services/eval_apply.py:714,739-743 (Path C — the mechanism to cite)
async def apply_completion_decision(...) -> bool:
    """...
    C. failed_ply_count > 0 AND current_attempts + 1 >= MAX_EVAL_ATTEMPTS ->
       cap reached: stamp anyway (D-116-07 no-infinite-loop invariant),
       including best_moves_completed_at IFF maia_available, and invoke the
       caller-supplied on_path_c_capacity_reached callback exactly once. This
       is the EXPECTED terminal state of the bounded-retry drain, not an error.
    ...
    """
```
New docstring framing (drafted, verified against the current tree — see RESEARCH.md §6 for the full text): reframe from "pre-Phase-119 legacy, population gone" to "permanent manual re-arm tool for Path-C mid-game holes (weak-worker failure mode)", citing `apply_completion_decision` Path C by name, and demoting the old D-116-07 framing to a parenthetical historical note rather than the primary justification.

---

### `app/routers/eval_remote.py` — stale docstring fix (D-05)

**Location 1 (~428-429, `atomic_lease_eval_game`):**
```python
# STALE — contradicts the module docstring 20 lines above it (which already
# correctly says Gen-1 /lease + /submit was deleted in Phase 149-03):
"""NEW endpoint pair (Phase 147 SEED-074 Part B, D-02) — does NOT modify
/lease or /submit; both stay live and deprecated for a mixed-fleet deploy."""
```
**Fix:** delete the "both stay live and deprecated" sentence, or replace with historical-context framing (Gen-1 pair already removed pre-this-phase; this endpoint's "additive, non-modifying" claim is now moot).

**Location 2 (~1313-1316, `atomic_submit_eval`) — surgical, partial staleness:**
```python
"""NEW endpoint pair (paired with /atomic-lease, 147-04) — does NOT modify
/submit or /flaw-blob-submit; both stay live for a mixed-fleet deploy."""
```
`/submit` is gone (same error) but `/flaw-blob-submit` is genuinely still live (`@router.post("/flaw-blob-submit", ...)` confirmed live, D-09-fenced). **Fix must remove only the `/submit` half**, keep the `/flaw-blob-submit` claim intact. The next sentence ("Unlike the old /submit...") is already correctly past-tense — no change needed there.

---

### `app/services/eval_queue_service.py` — tier-2 docstring/comment trim (D-03)

No code deletion (the `TIER_2` constant is already gone, Phase 149-04; claim SQL is tier-agnostic `ORDER BY ej.tier ASC`). Pure text edits at 6 locations (module docstring ~1-14, `_claim_queued_job` docstring ~232, `claim_eval_job` docstring ~790, comment ~842, comment ~864 — leave as accurate, `release_job` docstring ~957). See RESEARCH.md table in "Verified Facts vs. Seed Drift §1" for exact before/after text per line. **Grep scope for "no live references" verification must be restricted to** `app/services/eval_queue_service.py`, `app/models/eval_jobs.py`, `app/services/eval_drain.py`, `app/routers/eval_remote.py`, `tests/` — a repo-wide "tier 2" grep hits 3 unrelated subsystems (import readiness, endgame combos, tactic detector).

## Shared Patterns

### Migration byte-identical predicate text
**Source:** `app/models/game.py:95-96` comment + `alembic/versions/20260716_171823_1eda5daba951_...py`
**Apply to:** the new migration + its `game.py` Index edit — the `sa.text(...)` string must be character-for-character identical between model and migration, in the same commit.

### Archival = plain `git mv`, zero content diff (except forced import repoints)
**Source:** commit `1d74a8e8`
**Apply to:** all 7 `scripts/archive/*.py` moves; only 2 need a content diff (import line repoint), and that diff must be minimal (one import statement, no other changes).

### Non-concurrent partial-index migrations only
**Source:** `deploy/entrypoint.sh` (migrate-before-serve) + 5+ prior `games`-table index migrations
**Apply to:** the new migration — never introduce `postgresql_concurrently=True`.

### Test-import safety net for re-export pruning
**Source:** `tests/services/test_eval_drain.py`, `tests/services/test_full_eval_drain.py`, `tests/test_eval_worker_endpoints.py`
**Apply to:** D-06 — run `pytest ... --collect-only` immediately after each individual symbol removal (not just once at the end); a broken import surfaces as a pytest collection `ImportError`, not a `ruff` warning.

## No Analog Found

None — every file in this phase's scope has a direct in-repo precedent (migration convention, archival convention, or is a self-contained docstring/text edit with no external pattern needed).

## Metadata

**Analog search scope:** `alembic/versions/`, `scripts/archive/`, `app/services/eval_drain.py`, `app/services/eval_apply.py`, `app/services/eval_queue_service.py`, `app/routers/eval_remote.py`, `app/models/game.py`, `tests/services/test_eval_drain.py`, `tests/services/test_full_eval_drain.py`, `tests/test_eval_worker_endpoints.py`
**Files scanned:** ~15 (all already verified directly in RESEARCH.md; this pass re-confirmed the 174-07 migration docstring, the eval_drain.py import block, and the archive commit's `git show --stat`)
**Pattern extraction date:** 2026-07-24
</content>
