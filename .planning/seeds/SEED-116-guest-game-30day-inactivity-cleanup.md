---
id: SEED-116
status: promoted (Phase 187, v2.8 — 2026-07-24)
planted: 2026-07-23
planted_during: /gsd-explore session on 2026-07-23, triggered by a user importing ~65k games from GM Hikaru's chess.com account (~5M game_positions rows). Explored import/storage/compute resource limits; converged on guest-game retention as the proportionate lever.
trigger_when: Next maintenance/pipeline window. No external blocker — the decision is made and the mechanics exist. Prioritize if guest storage growth becomes a measured concern.
scope: small (one GSD phase: a scheduled cleanup job + activity-column verification + cursor reset). Grows slightly if last_activity turns out not to be bumped on guest browsing.
priority: medium (storage reclamation + honors already-advertised copy; no registered-user-facing behavior change)
references:
  - app/models/user.py:27                  # users.last_activity (the inactivity signal; already used by the eval lottery)
  - app/services/guest_service.py:26        # guest User creation (sentinel email guest_<uuid>@guest.local, 30-day JWT TTL)
  - app/routers/imports.py:48               # start_import — no ownership check, no per-user cap
  - app/services/import_service.py:459      # _bootstrap_import_job — last_synced_at incremental cursor
  - app/models/game_position.py:127         # game_positions composite FK (cascades from games)
  - app/services/eval_queue_service.py:55   # guests excluded from tier-3 full-analysis (guest imports are storage-only)
---

# SEED-116: 30-day-of-inactivity guest game cleanup

## Problem this addresses

Any user (registered or guest) can enter **any** chess.com/lichess username and import its
full history — there is no ownership check and no per-user game cap (`imports.py`,
`schemas/imports.py`). A 65k-game import (GM Hikaru) writes ~5M permanent `game_positions`
rows (≈80 rows/game, three 8-byte Zobrist hashes each + partial indexes). Storage is the
only genuinely **unbounded** cost — compute is already soft-rationed by the recency-weighted
tier-3 lottery, and **guests are excluded from full analysis entirely**
(`eval_queue_service.py:55`), so a guest import costs storage only.

The welcome/import page already tells guests their games are deleted after 30 days of
inactivity. That policy was never implemented — no pruning/cleanup job exists anywhere in
the code, scripts, or scheduler.

## Decision (from the explore session)

Implement a scheduled job that, for **guest** users (`users.is_guest = true`) inactive for
≥30 days, **deletes their games (+ cascading positions/flaws/bookmarks) but KEEPS the guest
User row**. Guests can still log back in later — the session lives in browser localStorage,
not the 30-day JWT — so keeping the account lets a returning guest simply re-import.

## Three implementation gotchas

1. **"Inactivity" = `users.last_activity`.** The column exists (`user.py:27`) and is already
   the eval lottery's recency signal, so it's maintained
2. **Reset the import cursor on cleanup.** Import is incremental off `last_synced_at`
   (`import_service.py:459`). If games are deleted but the `import_jobs` cursor is left in
   place, a returning guest's re-import syncs from that cursor and pulls almost nothing.
   Cleanup must clear/reset the cursor (delete the `import_jobs` row or null `last_synced_at`)
   so a full re-import is possible.
3. **Cascade scope.** Deleting a guest's games must cascade `game_positions` (existing
   composite FK, `game_position.py:127`) plus every other user/game-scoped child
   (`game_flaws`, bookmarks, eval_jobs, etc.). Confirm each child cascades or is handled so
   no orphan rows remain. Keep the User row and its auth intact.


