---
id: SEED-117
status: promoted (Phase 186, v2.8 — 2026-07-24)
planted: 2026-07-24
planted_during: /gsd-explore session on import filters (2026-07-24). User proposed adding time-control and game-count filters to the Import tab to keep storage and analysis compute in check; the session resolved the three load-bearing design questions (filter mutability, cap accounting, existing-user grandfathering).
trigger_when: Next milestone planning, or sooner if storage/compute pressure from large imports becomes acute (watch db-report game/position growth and analysis backlog).
scope: phase (2-3 plans) — backend fetch changes (backward backfill path, per-platform oldest-imported boundary, TC filtering in both import directions, per-user import settings storage + migration), frontend Import tab UI (TC multiselect row, cap single-select row, at-cap state display), grandfathering backfill for existing users.
depends_on: Nothing hard. Touches app/services/import_service.py, chesscom_client.py, lichess_client.py; the lichess client already has max_games/perf_type pass-through (benchmark-only today) that this can generalize.
---

# SEED-117: Import filters — time controls + per-platform game cap

## The product goal

Let users choose on the Import tab which time controls to import and how many games, so casual users don't pull (and FlawChess doesn't store/analyze) tens of thousands of bullet games nobody will look at. Storage and Stockfish compute are the real constraints; the filter UI is the lever.

## UI (Import tab)

- **Time controls:** multiselect button row (bullet / blitz / rapid / classical), styled like the existing filter panel. Default: all enabled **except bullet**.
- **Game cap:** single-select button row: 1000 / 3000 / 5000. Default 1000.
- One shared setting per user, applied to both platforms (cap is counted per platform, so 3000 = up to 6000 total across lichess + chess.com).
- At-cap state must be legible in the UI (e.g. "1000/1000 imported" per platform), because enabling a TC while at cap imports nothing and would otherwise look broken.

## Locked design decisions (from the explore session — don't re-litigate)

1. **Cap applies to the pre-signup backlog only.** Anchor = the user's FlawChess **account creation date** (single per-user timestamp, not per-platform first-import). Games played after the anchor always import and never count toward the cap, so newly played games can always sync.
2. **The TC filter applies to BOTH backfill and incremental sync.** Only the count cap is waived for post-anchor games. (A bullet-heavy player generates thousands of bullet games/month; exempting incremental sync from the TC filter would defeat the storage/compute goal.)
3. **Cap accounting: cap = total imported backlog games per platform**, regardless of current TC toggles. Enabling a TC while at cap imports nothing until the cap is raised. Chosen over "cap per current selection" (storage drifts past nominal cap, weird re-enable semantics) and "cap per TC bucket" (multiplies storage).
4. **Full upgrade support (filters editable anytime).** Raising the cap or enabling a TC while under cap backfills older history. Deselecting a TC or lowering the cap **never deletes** — existing games and their completed analysis stay.
5. **Existing users are grandfathered to all four TCs on + the 5000 cap.** Their sync behavior is unchanged; being over cap just means no further backfill, which they don't need. No legacy-unlimited flag, no silent behavior change.

## Architecture implications

- **Backward-fetch path is the main new machinery.** Current import is forward-only from `last_synced_at`. Backfill upgrades need a per-platform **oldest-imported boundary** and a backward walk: lichess via `until` + `max` (streams newest-first natively); chess.com via newest-to-oldest monthly archive iteration.
- **chess.com caveat:** TC filtering saves storage and analysis compute but NOT fetch bandwidth — monthly archives are all-or-nothing downloads; filtering happens post-fetch. Lichess can filter server-side via `perfType`.
- The lichess client's existing `max_games` / `perf_type` parameters (currently benchmark-only, threaded through `JobState`) are the natural generalization point.
- Needs a per-user import-settings table (or columns) + Alembic migration, plus the grandfathering backfill for existing users.
