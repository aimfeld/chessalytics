# Phase 187: Guest Game Cleanup — 30-Day Inactivity Pruning - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-24
**Phase:** 187-guest-game-cleanup-30-day-inactivity-pruning-seed-116
**Areas discussed:** Scheduling & cadence, Deletion scope & cursor reset, Deletion safety at scale, Observability & dry-run

---

## Scheduling & Cadence

| Option | Description | Selected |
|--------|-------------|----------|
| Lifespan task, daily | asyncio.create_task periodic loop in lifespan (run_periodic_reaper pattern), ~24h ticks | ✓ |
| Lifespan task, hourly | Same task, hourly ticks | |
| Standalone script + external cron | scripts/ tool via host cron/systemd; no repo cron infra exists | |

**User's choice:** Lifespan task, daily
**Notes:** Matches the established in-process background-task pattern; no new ops surface.

---

## Deletion Scope & Cursor Reset

| Option | Description | Selected |
|--------|-------------|----------|
| Reset cursor + wipe bookmarks; keep import_settings | Delete import_jobs row + position_bookmarks; keep user_import_settings | |
| Reset cursor + wipe bookmarks + import_settings | Full clean slate incl. Phase 186 prefs | |
| Reset cursor only; keep bookmarks + settings | Delete import_jobs row only; leave bookmarks + settings | ✓ |

**User's choice:** Reset cursor only; keep bookmarks + settings
**Notes:** Cursor reset via deleting the import_jobs row is mandatory. Bookmarks dangle on empty positions until re-import repopulates them — accepted.

---

## Deletion Safety at Scale

| Option | Description | Selected |
|--------|-------------|----------|
| Batch/chunk deletes + per-run user cap | Bounded txn size + capped guests/run; safest on shared prod DB | |
| Batch deletes, no per-run cap | Chunked deletes, all eligible guests per run | |
| One transaction per guest, no batching | Simplest; rely on ON DELETE CASCADE | ✓ |

**User's choice:** One transaction per guest, no batching
**Notes:** Claude flagged the accepted risk — a single ~5M-row cascade (Hikaru case) in one txn can spike WAL/locks on the shared prod DB. Research to sanity-check against prod; batching kept as documented fallback (CONTEXT D-06).

---

## Observability & Dry-run

| Option | Description | Selected |
|--------|-------------|----------|
| Logging + Sentry + manual script trigger | Per-run summary logs, Sentry on error, scripts/ entrypoint w/ dry-run | |
| Above + always-available dry-run/report mode | Persistent count-what-would-delete mode | |
| Logging + Sentry only | Scheduled task logs its work + reports errors to Sentry | ✓ |

**User's choice:** Logging + Sentry only
**Notes:** No manual trigger, no dry-run mode.

## Claude's Discretion

- Constant names, eligibility query shape, sequential per-guest processing within a tick, log wording/level, and service-file placement.

## Deferred Ideas

- Per-user import cap / ownership check on imports (separate concern; partially covered by Phase 186).
- Chunked/batched deletion (only if a single large cascade proves heavy on prod).
- Manual trigger / dry-run script (declined; can be added later).
