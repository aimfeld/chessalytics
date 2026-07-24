# Phase 186: Import Filters — Time Controls + Game Cap - Context

**Gathered:** 2026-07-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Users control what gets imported via a time-control multiselect (bullet/blitz/rapid/classical, default all except bullet) and a backlog game cap (1000/3000/5000, default 1000) on the Import tab. Raising the cap or enabling a TC backfills older history via a backward-fetch path; lowering never deletes; existing users are grandfathered. One shared setting per user across both platforms.

**IMPORTANT — seed override:** This discussion CHANGED SEED-117's locked decision #3. Cap accounting is now **per (platform, TC) budgets**, not total-per-platform. Where this CONTEXT.md and SEED-117 disagree, this file wins.

</domain>

<decisions>
## Implementation Decisions

### Cap accounting model (overrides SEED-117 decision #3)
- **D-01:** Cap = per (platform, TC-bucket) backlog budget. Each *selected* TC gets its own budget of `cap` games per platform (cap 1000 + 3 TCs selected = up to 3000/platform backlog). Enabling a TC later always backfills that TC up to `cap`; the "enabled a TC at cap, nothing happens" dead state from the seed's total-per-platform model disappears. Storage worst case: 4 TCs × 5000 × 2 platforms = 40k backlog games/user — accepted. — **Reversibility:** costly — cap semantics are user-visible and baked into budget-counting queries, the settings schema, and UI copy; switching models later changes what users were promised.
- **D-02:** Unchanged from SEED-117: cap applies to pre-signup backlog only (anchor = `users.created_at`); post-anchor games always import and never count toward any budget. TC filter applies to BOTH backfill and incremental sync.

### Filter change → backfill trigger
- **D-03:** Settings changes only persist — nothing runs on save. The existing per-platform **Sync button** is the single trigger: "make my library match my settings" (forward sync of new games + backward backfill while budgets have headroom).
- **D-04:** Settings are editable anytime, including during a running import. A running job finishes with the settings it started with; the next Sync applies new values. No locking UI.
- **D-05:** One job does both directions: forward sync first, then backward backfill. One progress bar per platform; the one-active-job-per-(user, platform) partial-unique index stays as is.

### Fetch order & stop condition
- **D-06:** ALL backlog fetching is newest-first: lichess streams newest-first natively (`until` + `max`); chess.com walks monthly archives newest→oldest. The first import is just a backfill run of the same backward path (plus the trivial forward pass).
- **D-07:** The backward walk stops only when **ALL selected TC budgets are full** or history is exhausted — never after just one budget fills. A never-filling budget (user barely plays classical) means walking to the oldest archive; accepted. chess.com early stop is per-month granularity (archives are all-or-nothing downloads).

### Import tab layout & save semantics
- **D-08:** Filter controls live in one shared "Import filters" card ABOVE the two platform cards (makes the shared per-user scope obvious). TC multiselect button row + cap single-select row, styled like the existing filter panel.
- **D-09:** Auto-save on toggle (immediate PATCH to the settings endpoint), no Save button, no dirty state. Safe because nothing runs until Sync (D-03).
- **D-10:** Copy: one inline line under the controls ("Limits how much older history is imported — new games always sync") plus a HelpCircle info popover with the full rule (per-TC budgets, backlog-only anchoring, never-delete). Follows the existing MetricStatPopover pattern; popover may use text-xs per CLAUDE.md exception.

### At-cap & progress display
- **D-11:** Each platform card shows per-TC budget chips/rows for the *selected* TCs: e.g. "Blitz 1000/1000 · Rapid 640/1000 · Classical 120/1000". Full budgets read as complete, not broken.
- **D-12:** Over-budget grandfathered users see the honest count with "full" styling (e.g. "Blitz 8000/5000"); popover explains existing games are never deleted.

### Grandfathering (updated for per-TC model)
- **D-13:** Existing users are grandfathered to all four TCs enabled + the 5000 cap, which under D-01 means a 5000 budget per (platform, TC). Sync behavior unchanged; being over budget only means no further backfill. — **Reversibility:** one-way — shipped via a data migration seeding settings rows for all existing users; re-running with different values would silently change real users' import behavior.

### TC bucket edge cases
- **D-14:** Correspondence/daily games stay under the **classical** toggle (status quo: they normalize to the classical bucket, `normalization.py:66`). No 5th toggle. Implementation caveat: lichess `perfType=classical` excludes correspondence server-side, so the lichess request must include correspondence (or filter client-side) whenever classical is selected.
- **D-15:** Games with no derivable TC bucket (`time_control_bucket` NULL) always import, bypass the TC filter, and count against no budget. Tiny population; no UI.
- **D-16:** Guests get the same filter UI and defaults as registered users (no bullet, cap 1000). One code path; guest storage is already bounded by the 30-day cleanup.

### Claude's Discretion
- Settings storage shape (new table vs columns on `users`), API endpoint shape, and Alembic migration details.
- Exact chip styling/copy, mobile layout of the filter card (must work in both desktop and mobile layouts per CLAUDE.md), and progress-bar copy during the backfill portion.
- How the per-platform oldest-imported boundary is persisted and how interrupted backfills resume.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Design decisions
- `.planning/seeds/SEED-117-import-filters-tc-and-game-cap.md` — original locked design decisions and architecture implications. **Decision #3 (cap accounting) is superseded by D-01 above (per-TC budgets); everything else stands.**

### Import pipeline (code)
- `app/services/import_service.py` — JobState (already carries benchmark-only `max_games`/`perf_type` pass-through — the generalization point), one-active-job constraint, `last_synced_at` bootstrap/advance semantics.
- `app/services/lichess_client.py` — `since`/`max`/`perfType` params; perfType silently excludes correspondence (relevant to D-14); mandatory User-Agent note.
- `app/services/chesscom_client.py` — monthly archive enumeration, `_archive_before_timestamp`, joined-date fallback; reusable for the newest→oldest backward walk.
- `app/services/normalization.py` — `is_correspondence_time_control`, TC bucketing (correspondence → classical).
- `app/models/import_job.py` — partial unique index `uq_import_jobs_user_platform_active` (predicate must stay textually identical to the repository WHERE clause).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `JobState.max_games` / `perf_type` (benchmark-only today) — natural pass-through to generalize for user-facing TC filtering and budget-limited fetches.
- chess.com `_enumerate_archive_urls` + `_archive_before_timestamp` — archive-month math reusable for the backward walk.
- `User.created_at` — the backlog anchor already exists (`app/models/user.py:23`).
- `Import.tsx` (545 lines) — platform cards, `ImportProgressBar`, `useImportPolling`, per-platform Sync via `useImportTrigger`; filter card slots above the platform cards in the existing `space-y-8` main column.
- MetricStatPopover / HelpCircle pattern — for the D-10 info popover.

### Established Patterns
- Routers thin, business logic in services, DB access in repositories; settings endpoint should follow `APIRouter(prefix=...)` convention.
- DB rules: FK with explicit ondelete, CHECK-backed TEXT or SMALLINT enums (no native ENUM), UniqueConstraint for natural keys (one settings row per user).
- Import pipeline is background-async with rate-limit delays; lichess NDJSON streaming, chess.com sequential monthly archives.

### Integration Points
- `create_job` / `run_import` / `_make_game_iterator` — where TC filter + budget counting + backward walk hook in.
- `_complete_import_job` advances `last_synced_at` — forward-pass semantics must be preserved when the backward pass is appended (D-05).
- User profile / settings API for the auto-save PATCH (D-09).

</code_context>

<specifics>
## Specific Ideas

- Sync button mental model: "make my library match my settings" — one button, no separate backfill concept.
- Budget chips inside platform cards, e.g. "Blitz 1000/1000 · Rapid 640/1000 · Classical 120/1000"; over-cap shown honestly ("Blitz 8000/5000") with full styling.
- Inline copy: "Limits how much older history is imported — new games always sync."

</specifics>

<deferred>
## Deferred Ideas

### Reviewed Todos (not folded)
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — database/storage idea, orthogonal to import filters; stays pending.
- `172-deferred-review-findings.md` — analysis-board gem-sweep leftovers, unrelated to imports; stays pending.

None otherwise — discussion stayed within phase scope.

</deferred>

---

*Phase: 186-import-filters-tc-and-game-cap*
*Context gathered: 2026-07-24*
