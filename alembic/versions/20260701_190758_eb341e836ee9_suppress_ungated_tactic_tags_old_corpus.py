"""suppress ungated tactic tags old corpus

Part A old-corpus data migration (D-03, D-04, SEED-074): the remote-submit path
(Phase 146) writes raw, ungated tactic tags whenever the forcing-line gate's PV
blob hasn't arrived yet, and those tags previously sat uncorrected until tier-4
backfill happened to reach that game. This migration delivers the "no ungated
tags anywhere" invariant immediately for the pre-existing corpus rather than
waiting on the tier-4 ES lottery to drain it (D-03 overrides SEED-074's
go-forward-only lean).

Suppresses (sets to NULL) `<orientation>_tactic_motif`/`_piece`/`_confidence`/
`_depth` ONLY for cp-based candidate rows, gated PER ORIENTATION on its own
blob column:
  - `<orientation>_pv_lines IS NULL` (blob truly absent, not the D-06 `[]`
    sentinel — an empty JSONB array is NOT NULL and never matches this
    predicate, so D-06 rows are preserved automatically)
  - joined `game_positions.eval_cp IS NOT NULL` (the cp-based gate applies;
    mate-adjacent rows have `eval_cp IS NULL` and are preserved)
  - `<orientation>_tactic_motif IS NOT NULL` (nothing to suppress otherwise)

`pre_flaw_eval_cp` is not a `game_flaws` column — it's
`game_positions[flaw_ply - 1].eval_cp` — so the predicate joins to
`game_positions` on `(user_id, game_id, ply = gf.ply - 1)`, which hits that
table's composite PK directly (index-driven, verified via EXPLAIN in
147-RESEARCH.md; no new index needed — the existing partial index
`ix_game_flaws_blob_backfill` on `game_flaws (game_id) WHERE
allowed_pv_lines IS NULL`, built for the tier-4 lottery, already drives the
candidate scan).

Batched via the repo's established `DO $$ ... WHILE rows_updated > 0 LOOP ...`
idiom (see the pawnless-reclassify migration), batch_size 100000. `game_flaws`
has no surrogate `id` column (composite PK `(user_id, game_id, ply)`), so
batching keys on that composite tuple via a `WITH batch AS (...) UPDATE ...
FROM batch` shape, not an `id IN (...)` pattern.

Idempotent: re-running the loop after the first pass updates zero rows, since
the target columns are already NULL and no longer match the WHERE predicate
(D-04's "idempotent + self-healing" requirement).

Revision ID: eb341e836ee9
Revises: c3f5d1e8a092
Create Date: 2026-07-01 19:07:58.793553+00:00

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'eb341e836ee9'
down_revision: Union[str, Sequence[str], None] = 'c3f5d1e8a092'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Suppress ungated cp-based tactic tags on the old corpus (batched, index-driven)."""
    op.execute(
        """
        DO $$
        DECLARE
            batch_size CONSTANT int := 100000;
            rows_updated int := 1;
        BEGIN
            WHILE rows_updated > 0 LOOP
                WITH batch AS (
                    SELECT gf.user_id, gf.game_id, gf.ply,
                           (gf.allowed_pv_lines IS NULL AND gp.eval_cp IS NOT NULL
                                AND gf.allowed_tactic_motif IS NOT NULL) AS suppress_allowed,
                           (gf.missed_pv_lines  IS NULL AND gp.eval_cp IS NOT NULL
                                AND gf.missed_tactic_motif  IS NOT NULL) AS suppress_missed
                    FROM game_flaws gf
                    JOIN game_positions gp
                      ON gp.user_id = gf.user_id AND gp.game_id = gf.game_id
                         AND gp.ply = gf.ply - 1
                    WHERE (gf.allowed_pv_lines IS NULL OR gf.missed_pv_lines IS NULL)
                      AND gp.eval_cp IS NOT NULL
                      AND (gf.allowed_tactic_motif IS NOT NULL OR gf.missed_tactic_motif IS NOT NULL)
                    LIMIT batch_size
                )
                UPDATE game_flaws gf
                SET allowed_tactic_motif      = CASE WHEN b.suppress_allowed THEN NULL ELSE gf.allowed_tactic_motif END,
                    allowed_tactic_piece      = CASE WHEN b.suppress_allowed THEN NULL ELSE gf.allowed_tactic_piece END,
                    allowed_tactic_confidence = CASE WHEN b.suppress_allowed THEN NULL ELSE gf.allowed_tactic_confidence END,
                    allowed_tactic_depth      = CASE WHEN b.suppress_allowed THEN NULL ELSE gf.allowed_tactic_depth END,
                    missed_tactic_motif       = CASE WHEN b.suppress_missed  THEN NULL ELSE gf.missed_tactic_motif END,
                    missed_tactic_piece       = CASE WHEN b.suppress_missed  THEN NULL ELSE gf.missed_tactic_piece END,
                    missed_tactic_confidence  = CASE WHEN b.suppress_missed  THEN NULL ELSE gf.missed_tactic_confidence END,
                    missed_tactic_depth       = CASE WHEN b.suppress_missed  THEN NULL ELSE gf.missed_tactic_depth END
                FROM batch b
                WHERE gf.user_id = b.user_id AND gf.game_id = b.game_id AND gf.ply = b.ply
                  AND (b.suppress_allowed OR b.suppress_missed);
                GET DIAGNOSTICS rows_updated = ROW_COUNT;
            END LOOP;
        END $$;
        """
    )


def downgrade() -> None:
    """Irreversible: this migration DELETES information (raw pre-gate tactic tags).

    Matches the repo's convention that lossy bulk-correctness migrations are
    upgrade-only in practice (e.g. the eval-only-residue wipe). There is no
    approximation to reconstruct: once suppressed, the raw motif value is gone
    (it self-heals forward via tier-4's D-07 retag once a blob is written, not
    via a downgrade). This is intentionally a documented no-op.
    """
    pass
