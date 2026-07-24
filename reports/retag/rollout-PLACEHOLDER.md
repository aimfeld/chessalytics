# FlawChess Rollout Report — PLACEHOLDER

**Status:** Awaiting prod operator actions (Tasks 2 & 3 of Phase 145 Plan 06)

**Dev-first validation gate:** PASSED (2026-06-30)

- `--dev-validate`: game_id=684399 picked by tier-4 lottery; 219 walkable positions +
  1 sentinel line; blobs written; 0 NULL-blob flaws remaining post-write. Idempotency: PASS.
- `--status` (post-validate): 10,262 games / 66,358 flaws remaining with NULL blobs on dev.
- `--phase before` (dev): 29 allowed motifs (16,558 flaws), 27 missed motifs (8,865 flaws).
  Written to `reports/retag/rollout-2026-06-30.md`.

**Pending operator steps:**

1. Start prod DB tunnel: `bin/prod_db_tunnel.sh`
2. Capture prod BEFORE snapshot: `uv run python scripts/archive/snapshot_tactic_counts.py --db prod --phase before`
3. Deploy upgraded remote-worker fleet (flaw-blob-lease + flaw-blob-submit endpoints).
4. Monitor drain: `uv run python scripts/archive/backfill_multipv.py --db prod --status` until ~0 NULL-blob flaws.
5. Once near-zero: run D-08 sweep on prod server via SSH:
   `uv run python scripts/retag_flaws.py --db prod --workers 6 --throttle-ms 50`
6. Capture prod AFTER snapshot: `uv run python scripts/archive/snapshot_tactic_counts.py --db prod --phase after`
7. Commit `reports/retag/rollout-<date>.md` with before/after per-motif counts.

This placeholder will be replaced by the committed prod before/after report once the rollout drains.
