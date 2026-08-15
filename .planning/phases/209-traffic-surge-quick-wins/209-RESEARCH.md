# Phase 209: Traffic-Surge Quick Wins - Research

**Researched:** 2026-08-10
**Domain:** Backend concurrency control (asyncio semaphores/to_thread), frontend poll backoff (TanStack Query), static-asset CDN caching
**Confidence:** HIGH (all claims below are file:line-verified against the current codebase this session, not derived from the seed's characterizations)

## Summary

This is a five-item hardening phase with no new dependencies, no new architecture, and (per my
recommended design below) no migration. Every target file, function, and call site was opened
and read this session; findings are cited with exact line numbers.

The two items with real design risk are **item 1** (readiness poll) and **item 4** (import
queue). For item 1, `useReadiness`'s `tier2` flag is **actively consumed by three live UI
surfaces** (`Endgames.tsx`'s whole-page blocking gate, plus two Opening-explorer card
components) that reactively unlock when `tier2` flips true — this means CONTEXT.md's
"optionally stop at tier1 entirely" discretionary option, if taken literally, would **regress**
these three surfaces (a user sitting on the Endgames page would never see it unlock without a
manual navigation away-and-back). Decay-but-never-fully-stop is the safe default; a hard stop at
tier1 needs an explicit acknowledgment that Endgames/Openings live-unlock is being traded away.

For item 4, the load-bearing subtlety is that the periodic reaper's 3-hour cutoff is **not** the
in-process `asyncio.timeout()` — it is a separate SQL predicate
(`app/repositories/import_job_repository.py:237-240`) keyed off `ImportJob.started_at`, a
column stamped at **DB-row-creation time** (i.e. at the moment the import was *requested*, before
any semaphore is even involved). A purely in-memory "queued" wire state does nothing to fix the
reaper unless `started_at` is explicitly re-stamped when the semaphore slot is actually acquired
— the two clocks are decoupled today, and CONTEXT.md's "start the timeout clock at slot
acquisition" option means bumping `started_at`, not adding an `asyncio.timeout` delay.

**Primary recommendation:** implement item 4's "queued" state entirely in the in-memory
`JobState`/`JobStatus` registry (no DB migration, no new DB status value, no partial-unique-index
change) — the DB row already stays `status='pending'` throughout today's flow until the first
batch flush, and `GET /imports/{job_id}` / `GET /imports/active` read the in-memory registry
first, so a `QUEUED` enum member is sufficient to drive the wire format. Fix the reaper by
UPDATE-ing `ImportJob.started_at` to `now()` the moment the semaphore is acquired (transition
QUEUED → IN_PROGRESS), which naturally resets the reaper's cutoff without touching
`fail_orphaned_jobs`'s SQL at all.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Readiness poll backoff | Browser / Client | API / Backend (optional cheap-endpoint tweak) | `useReadiness.ts`'s `refetchInterval` is pure client-side scheduling logic; the backend endpoint itself is already well-indexed (see Pitfall 6) |
| Guest-promotion password hashing off the loop | API / Backend | — | `asyncio.to_thread` around a synchronous CPU-bound call inside `app/services/guest_service.py` — a backend-only concern |
| CDN for `/maia/*`/`/engine/*` | CDN / Static | — | Operator DNS/Cloudflare work; Caddy already sets correct per-path cache headers, the CDN just needs to respect them |
| Import concurrency cap + queued state | API / Backend | Browser / Client (rendering the bare label) | The semaphore and reaper-exemption logic are backend; the frontend only needs a new literal value in an existing status union and a new text branch |
| Percentile-compute concurrency gate | API / Backend | — | Purely a backend `asyncio.Semaphore` around DB-heavy background tasks |

## Standard Stack

No new packages. All five items use Python/TypeScript standard library or already-vendored
tooling:

| Tool | Version (verified) | Purpose |
|------|---------------------|---------|
| `asyncio.Semaphore` | stdlib (Python 3.13) | Items 4 and 5 — mirrors `app/core/rate_limiters.py`'s existing pattern |
| `asyncio.to_thread` | stdlib (Python 3.13) | Item 2 |
| `@tanstack/react-query` | `^5.100.14` [VERIFIED: frontend/package.json:22] | Item 1 — `refetchInterval` callback already in use |
| Cloudflare (free plan) | n/a (SaaS) | Item 3 — operator-only, no code dependency |

## Package Legitimacy Audit

Not applicable — this phase installs no new packages in any ecosystem.

## Phase Requirements

| ID | Description (from ROADMAP.md Success Criteria, in order) | Research Support |
|----|-------------|------------------|
| SURGE-01 | Readiness poll's emitted interval sequence backs off while `tier1` true/`tier2` outstanding, stays 3s while `tier1` false, stops after a duration cap; test asserts the sequence itself | `useReadiness.ts` mechanics below; existing fake-timer test file `frontend/src/hooks/__tests__/useReadiness.test.tsx` gives the exact assertion pattern to extend |
| SURGE-02 | `POST /auth/guest/promote/email` hashes off the event loop; revert-sensitive test; register/login and guest/create untouched | `guest_service.py:23,94` verified; D-02 correction re-verified in code this session (see Pitfall 1) |
| SURGE-03 | `/maia/*`/`/engine/*` served from CDN cache with correct headers; `/maia/maia-worker.js` stays `no-cache` | `deploy/Caddyfile:42-59` verified verbatim |
| SURGE-04 | Import cap enforced; cap+1th job visibly "queued", starts on slot free, never reaped while alive | Full job-lifecycle trace below — this is the highest-risk item |
| SURGE-05 | Burst import completions never exceed the percentile semaphore's concurrency | `compute_stage_a`/`compute_stage_b` call-site trace below — **two** trigger sites found, not one |
| SURGE-06 | Outbound rate-limiter semaphores byte-identical to before the phase | `app/core/rate_limiters.py` read in full — recommend placing the NEW semaphore elsewhere entirely to make this trivially true |
| SURGE-07 | Every production change mutation-tested (revert → red) | Test-seam recommendations per item below, including one concrete existing pattern to copy for the reaper test |

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser (N tabs)                                                     │
│                                                                        │
│  useReadiness() ──refetchInterval──▶ GET /imports/readiness (poll)   │
│    │ tier1 gates: NavHeader, MobileMoreDrawer,                       │
│    │              ImportRequiredRoute (App.tsx:174,394,517,743)      │
│    │ tier2 gates: Endgames.tsx (whole-page block),                   │
│    │              OpeningFindingCard, OpeningStatsCard,               │
│    │              PositionResultsPanel  ◀── live-consumed, NOT dead  │
│                                                                        │
│  ImportPage → POST /imports ──▶ ImportProgressBar                    │
│    useImportPolling (2s) ──▶ GET /imports/{job_id}                   │
└───────────────────────────────┬────────────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────────────┐
│ Backend (single uvicorn process, single event loop)                  │
│                                                                        │
│ POST /imports (imports.py:52)                                        │
│   → create_import_job (DB row, status='pending') ── commit            │
│   → asyncio.create_task(run_import(job_id))         [imports.py:157] │
│        │                                                              │
│        ▼ run_import (import_service.py:752)                          │
│        job.status = IN_PROGRESS (in-memory only, today)              │
│        ─── NEW: job.status = QUEUED here instead ──────────────────  │
│        ─── NEW: async with get_import_semaphore(): ─────────────────  │
│              job.status = IN_PROGRESS + started_at=now() DB stamp    │
│              async with asyncio.timeout(IMPORT_TIMEOUT_SECONDS):     │
│                _bootstrap_import_job → forward/backward fetch        │
│                  → get_chesscom_semaphore()/get_lichess_semaphore()  │
│                    (UNTOUCHED — SC-6)                                │
│                _flush_batch_with_progress → DB status='in_progress'  │
│                _complete_import_job → DB status='completed'          │
│                  → asyncio.create_task(compute_stage_a(uid))         │
│                       [import_service.py:716]                        │
│                  → asyncio.create_task(compute_stage_b(uid))         │
│                       [import_service.py:735, ALSO eval_drain.py:384]│
│                       ── NEW: percentile semaphore must wrap BOTH    │
│                          call sites — cleanest done INSIDE            │
│                          compute_stage_a/b themselves                │
│                                                                        │
│ run_periodic_reaper() [every 5 min, import_service.py:344]           │
│   → fail_orphaned_jobs(threshold=3h) keyed off ImportJob.started_at  │
│     [import_job_repository.py:214-252] — DOES NOT know about the     │
│     in-memory semaphore-wait state at all; only sees the DB row.     │
└────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

No new files needed. Touch points:

```
app/
├── core/rate_limiters.py            # READ ONLY — mirror pattern, DO NOT EDIT (SC-6)
├── services/
│   ├── import_service.py            # JobStatus enum, run_import, new semaphore + getter here
│   ├── guest_service.py             # to_thread wrap at line 94
│   └── user_benchmark_percentiles_service.py  # semaphore wraps compute_stage_a/b bodies
├── repositories/import_job_repository.py      # (read only — verify started_at semantics)
frontend/src/
├── hooks/useReadiness.ts            # backoff + duration cap
├── hooks/useImport.ts               # no change expected (status already generic)
├── pages/Import.tsx                 # new "queued" progressText branch
├── types/api.ts                     # ImportJobStatus union += 'queued'
```

### Pattern 1: Lazy module-level Semaphore (mirror for items 4 and 5)

**What:** `app/core/rate_limiters.py` (read in full this session) is the house style for a
shared, lazily-initialized `asyncio.Semaphore`:

```python
# Source: app/core/rate_limiters.py:1-34 (verbatim, existing code — do not edit this file)
import asyncio

CHESSCOM_SEMAPHORE_LIMIT = 3
LICHESS_SEMAPHORE_LIMIT = 3

_chesscom_semaphore: asyncio.Semaphore | None = None

def get_chesscom_semaphore() -> asyncio.Semaphore:
    """Return the shared chess.com rate-limiting semaphore (lazy init)."""
    global _chesscom_semaphore
    if _chesscom_semaphore is None:
        _chesscom_semaphore = asyncio.Semaphore(CHESSCOM_SEMAPHORE_LIMIT)
    return _chesscom_semaphore
```
Used as `async with get_chesscom_semaphore():` at `app/services/chesscom_client.py:340,468` and
`app/services/lichess_client.py:160`.

**When to use:** For both new semaphores (import concurrency cap, percentile-compute gate).
Lazy init exists specifically because `asyncio.Semaphore()` must not be constructed before the
event loop starts (Python 3.10+ requirement) — the same constraint applies to any new
module-level semaphore.

**Recommendation — do NOT add the new import-cap semaphore to `rate_limiters.py`.** SC-6 requires
`CHESSCOM_SEMAPHORE_LIMIT`/`LICHESS_SEMAPHORE_LIMIT` to be **byte-identical**. Editing that file
at all (even additively) creates unnecessary diff-review risk against SC-6. Place the new
`IMPORT_CONCURRENCY_LIMIT` constant and `get_import_semaphore()` getter in
`app/services/import_service.py` instead, right beside the existing `IMPORT_TIMEOUT_SECONDS`
constant (`import_service.py:88`) — same file already owns job lifecycle state.

### Pattern 2: `asyncio.to_thread` for the one CPU-bound sync call

**What:** `app/services/guest_service.py:23` constructs `_password_helper = PasswordHelper()` at
module scope (stateless — `PasswordHelper.hash` is a pure function delegating to
`self.password_hash.hash(password)`, verified via `inspect.getsource` this session against
pwdlib `0.3.0` [VERIFIED: pwdlib 0.3.0 installed in .venv]). The call site is
`app/services/guest_service.py:94`:

```python
# Current (guest_service.py:94)
hashed_password = _password_helper.hash(password)

# Target
hashed_password = await asyncio.to_thread(_password_helper.hash, password)
```

**When to use:** Exactly this one call site. There is **no existing `asyncio.to_thread` usage
anywhere in `app/`** [VERIFIED: `grep -rn "asyncio.to_thread" app --include="*.py"` returned zero
production hits — every hit is in `tests/` driving synchronous Alembic commands]. This is a novel
pattern for the codebase; there is no in-repo precedent to imitate beyond stdlib usage.

**Confirmed by D-02's correction (re-verified this session):** `POST /auth/guest/create` →
`create_guest_user` (`app/routers/auth.py:319` → `guest_service.py:26-51`) sets
`hashed_password=""` directly on the `User(...)` constructor call and never touches
`_password_helper` — zero hashing cost, confirmed by reading the full function body. The only
hash call in `guest_service.py` is at line 94, inside `promote_guest_with_password`
(`auth.py:511` reaches it via `POST /auth/guest/promote/email`).

### Pattern 3: Item 4 — queued state, in-memory only (recommended design)

**Current state machine** (`app/services/import_service.py:153-188,752-786`):

```python
class JobStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"

# run_import (import_service.py:752)
job = _jobs.get(job_id)
job.status = JobStatus.IN_PROGRESS          # line 777 — no DB write yet
try:
    async with asyncio.timeout(IMPORT_TIMEOUT_SECONDS):   # line 780
        ...
```

The DB row is created with `status="pending"` synchronously in the router
(`app/repositories/import_job_repository.py:21-52`, called from
`app/routers/imports.py:104-111`), **before** `asyncio.create_task(run_import(job_id))` even
fires (`imports.py:157`). The DB row's `status` only transitions to `"in_progress"` at the
**first batch flush** (`import_service.py:654-661`, inside `_flush_batch_with_progress`) — so
today, for the entire fetch phase (which can be tens of seconds), the DB row still reads
`"pending"` even though the job is actively running. This is an existing quirk to be aware of,
not something this phase needs to fix.

**Recommended design (avoids any migration):**

1. Add `QUEUED = "queued"` to `JobStatus` (in-memory enum only).
2. In `run_import`, set `job.status = JobStatus.QUEUED` immediately (before any semaphore
   involvement), then wrap the existing body:
   ```python
   job.status = JobStatus.QUEUED
   async with get_import_semaphore():
       job.status = JobStatus.IN_PROGRESS
       # NEW: re-stamp started_at at the moment of actual execution start —
       # see "reaper exemption" below for why this line is load-bearing.
       async with async_session_maker() as session:
           await import_job_repository.update_import_job(
               session, job_id=job_id, started_at=datetime.now(timezone.utc)
           )
           await session.commit()
       try:
           async with asyncio.timeout(IMPORT_TIMEOUT_SECONDS):
               ...  # unchanged body
   ```
3. **DB row status is never written as `"queued"`** — it stays `"pending"` throughout the queue
   wait, exactly as it does today during the fetch phase. This means:
   - **No Alembic migration.** `ImportJob.status` is `String(20)` with **no CHECK constraint**
     anywhere in the schema [VERIFIED: `grep` across `alembic/versions/` for a CHECK on
     `import_jobs.status` returned no hits; the model at `app/models/import_job.py:36-38` has a
     bare comment, not a DB constraint].
   - **No change to the partial unique index** `uq_import_jobs_user_platform_active`
     (`app/models/import_job.py:21-27`, predicate `status IN ('pending', 'in_progress')`) —
     duplicate-import prevention at the DB layer is unaffected because the row is still
     `"pending"`.
4. `GET /imports/{job_id}` (`app/routers/imports.py:434-484`) and `GET /imports/active`
   (`imports.py:162-212`) both check the **in-memory registry first** and only fall back to the
   DB row's `status` once the job is evicted from `_jobs` — so `job.status.value == "queued"`
   flows straight to the frontend with **zero** backend-schema changes required
   [VERIFIED: `imports.py:453-466` returns `status=job.status.value` from the in-memory
   `JobState`, falling back to `db_job.status` only at `imports.py:469-482`].

**Three call sites MUST be updated to include `QUEUED`** in their active-job checks, or a queued
job silently disappears from "active" surfaces (breaking the whole point of item 4's visible
state):
- `find_active_job` (`import_service.py:279-298`) — currently checks
  `job.status in (JobStatus.PENDING, JobStatus.IN_PROGRESS)`
- `find_active_jobs_for_user` (`import_service.py:301-316`) — same tuple, feeds `GET
  /imports/active`
- `count_active_platform_jobs` (`import_service.py:319-335`) — same tuple, feeds the
  `other_importers` "X other users are importing" UI (`Import.tsx:231-235`)

### Pattern 4: Reaper exemption — the load-bearing detail

**The reaper's actual mechanism** (verified by reading both the caller and the SQL):

```python
# app/repositories/import_job_repository.py:214-252 (verbatim)
async def fail_orphaned_jobs(session, orphan_age_threshold=None):
    where_clause = ImportJob.status.in_(["pending", "in_progress"])
    if orphan_age_threshold is not None:
        cutoff = datetime.now(timezone.utc) - orphan_age_threshold
        where_clause = where_clause & (ImportJob.started_at < cutoff)
    result = await session.execute(
        update(ImportJob).where(where_clause).values(status="failed", ...)
    )
```

Called by `run_periodic_reaper` (`import_service.py:344-367`) every 5 minutes
(`_REAPER_INTERVAL_SECONDS`, `import_service.py:119`) with
`orphan_age_threshold=timedelta(seconds=IMPORT_TIMEOUT_SECONDS)` (3h).

**The cutoff is `ImportJob.started_at`, a column with `server_default=func.now()`
(`app/models/import_job.py:43-46`) that is stamped at DB-row-creation time** — i.e. at the moment
the user clicked "Sync", not at the moment execution actually began. Today, with no queue, this
is fine because execution begins essentially immediately after creation. **With a global cap, a
job can now sit queued for an arbitrary duration before its semaphore slot is acquired.** If
`started_at` is never re-stamped, a job queued for e.g. 2 hours and then actively running for
another 1.5 hours totals 3.5h of *wall time since the DB row was created* — the periodic reaper
will mark it `"failed"` in the DB at the 3-hour mark even though the in-memory task is alive and
has barely started real work. **This is a real bug the naive "just add a queued status" fix does
NOT solve on its own** — the reaper's IN-list already excludes `"queued"` by construction (good),
but the *DB row itself never becomes `"queued"`* under the recommended design (Pattern 3) — it
stays `"pending"`, which **is** in the reaper's IN-list. The re-stamp-`started_at`-at-acquisition
step in Pattern 3 above is what actually closes this gap; it is not optional set-dressing.

**Existing test pattern to copy directly** for the mutation test
(`tests/test_import_service.py:1694-1789`, class `TestFailOrphanedJobsAgeThreshold`):
```python
# Source: tests/test_import_service.py:1705-1746 (verbatim structure — reuse this helper)
async def _seed_job(self, session, user_id, job_id, status, started_at, platform="lichess"):
    job = ImportJob(id=job_id, user_id=user_id, platform=platform, username="test_user",
                     status=status, games_fetched=0, games_imported=0)
    session.add(job)
    await session.flush()
    await session.execute(
        text("UPDATE import_jobs SET started_at = :ts WHERE id = :id"),
        {"ts": started_at, "id": job_id},
    )
    await session.flush()
```
For the new test: seed a job with `started_at = now - 4h` and `status="pending"` (simulating a
job still queued long past 3h under the OLD/buggy behavior), call
`fail_orphaned_jobs(session, orphan_age_threshold=timedelta(seconds=IMPORT_TIMEOUT_SECONDS))`,
and assert the row survives — but only once the executor's fix re-stamps `started_at` at
acquisition; reverting that re-stamp must turn this test red by making the row get reaped despite
the in-memory task being "alive" (simulate aliveness via a still-registered `_jobs[job_id]` entry
with a mocked semaphore that never releases, or test the `started_at` re-stamp directly as a unit
assertion on `run_import`).

### Pattern 5: Item 5 — percentile semaphore must wrap the function, not one call site

**Two production trigger sites found for `compute_stage_b`, not one:**

| Site | Trigger condition |
|------|--------------------|
| `app/services/import_service.py:735` | Import completes AND user's pending-eval count is already zero |
| `app/services/eval_drain.py:384` | A cold-drain eval batch finishes AND a user's pending count crosses to zero |

`compute_stage_a` has exactly one trigger site: `import_service.py:716`.

CONTEXT.md D-06 names only `import_service.py:716` as the semaphore location. **If the semaphore
is applied only around that one `asyncio.create_task(...)` call, `eval_drain.py:384`'s
`compute_stage_b` fires stay ungated** — and the eval drain is exactly the kind of background
process that can burst-complete many users' pending counts at once during a surge (many imports
landing → many users crossing to zero-pending roughly together). **Recommendation: wrap the
semaphore acquisition INSIDE `compute_stage_a`/`compute_stage_b` themselves**
(`app/services/user_benchmark_percentiles_service.py:398-469` and `:471-561`), as the first line
inside each function body, before `async with maker() as session:`. This automatically covers
both call sites with one change and requires no edit to either `import_service.py:716/735` or
`eval_drain.py:384`.

Placement is safe relative to the existing `finally: percentile_compute_registry.clear(user_id)`
(`user_benchmark_percentiles_service.py:554-561`) — `mark(user_id)` is called at the trigger site
**before** `asyncio.create_task(...)`, so the Tier-2 readiness gate (`is_computing`) correctly
stays true for the full duration a user's compute is queued behind the semaphore, not just while
it's actively running. No conflict.

```python
# Recommended shape (user_benchmark_percentiles_service.py, inside each function)
async def compute_stage_a(user_id, *, session_maker=None):
    maker = session_maker if session_maker is not None else _default_session_maker
    async with get_percentile_semaphore():   # NEW — first line, wraps existing body
        try:
            async with maker() as session:
                ...  # unchanged
```

Both functions already accept an optional `session_maker` for dependency injection
[VERIFIED: `user_benchmark_percentiles_service.py:398-401,471-474`] — useful for the mutation
test: inject a fake `session_maker` that blocks on an `asyncio.Event`, launch N+1 concurrent
calls, and assert no more than `N` are unblocked simultaneously.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Bounding concurrent import execution | A custom counter + polling loop | `asyncio.Semaphore` | Already the house pattern (`rate_limiters.py`); `Semaphore.acquire()`/`release()` via `async with` is exception-safe and starvation-free (FIFO-ish waiter queue in CPython's implementation) |
| Off-loading the Argon2 hash | A thread pool you manage yourself | `asyncio.to_thread` | Stdlib wrapper over the default `ThreadPoolExecutor`; no lifecycle to manage, no risk of leaking threads on cancellation (it awaits `loop.run_in_executor` under a `CancelledError`-safe `Future`) |
| Poll backoff sequencing | A `setInterval` loop with manual clearTimeout bookkeeping | TanStack Query's `refetchInterval` callback (already in place) | The callback re-evaluates every fetch against `query.state.data`; `useEvalCoverage.ts` already demonstrates a stall-counter backoff pattern in this exact codebase (see Pitfall 5) — copy that shape, don't invent a new scheduling primitive |

**Key insight:** every mechanism this phase needs is already represented once elsewhere in this
codebase (semaphore pattern, `to_thread` in tests, backoff-with-cap in `useEvalCoverage`). The
research risk here isn't "what library to use" — it's "which of the 2-3 existing call sites for
each thing does the fix actually need to cover."

## Common Pitfalls

### Pitfall 1: Item 2's funnel claim was already wrong once — don't let the fix regress it
**What goes wrong:** Wrapping the WRONG call in `to_thread`, or wrapping `create_guest_user`
(which never hashes) under a mistaken belief it needs the fix.
**Why it happens:** The seed's original text (struck-through in SEED-146 item 2) claimed
`POST /auth/guest/create` hashes; this was corrected 2026-08-10 after reading the code.
**How to avoid:** The fix is exactly one line at `guest_service.py:94`. `create_guest_user`
(`guest_service.py:26-51`) sets `hashed_password=""` directly — verified again this session, no
`_password_helper` call anywhere in that function.
**Warning signs:** A test asserting `to_thread` was called during `POST /auth/guest/create` would
be asserting something that structurally cannot happen — a red flag that scope drifted back to
the deferred/corrected claim.

### Pitfall 2: A hard "stop polling at tier1" breaks three live tier2 consumers
**What goes wrong:** CONTEXT.md D-05 offers "optionally stop at tier1 entirely for the
surge-relevant UI and let tier2 surfaces refresh on next navigation" as acceptable-if-simpler.
Taken literally for the *whole hook* (not just the four App.tsx nav-gate mount sites), this
breaks reactive unlock on:
- `frontend/src/pages/Endgames.tsx:91,798-800` — whole-page blocking render:
  `if (!tier2) return <EndgamesProcessingState .../>`, with the comment "unlock is reactive once
  tier2=true... No forced navigation."
- `frontend/src/components/insights/OpeningFindingCard.tsx:49,205`
- `frontend/src/components/stats/OpeningStatsCard.tsx:61,231`
- `frontend/src/components/charts/PositionResultsPanel.tsx:73,199`

**Why it happens:** The four `App.tsx` mount sites (`:174,394,517,743`) only destructure
`{ tier1 }` (three of them) or `{ tier1, isLoading }` (the fourth `ImportRequiredRoute`) — none
of the four consume `tier2`. It's easy to read "the poll is mounted at four places in App.tsx"
(true, from the seed) and conclude tier2 has no live consumer, but the seven-file grep for
`useReadiness` shows three OTHER files that DO consume `tier2` reactively.
**How to avoid:** The safe reading of D-05 is: decay hard (near-zero frequency) once only tier2
is outstanding, but don't fully stop — the duration cap (a tab open 8h) is the actual "go quiet"
mechanism, not an early full-stop at tier1. If a full stop-at-tier1 is still chosen, it must be
scoped to the four App.tsx *nav-gate* consumers only (e.g. a `stopAtTier1` option param on the
hook), leaving the four `tier2`-dependent surfaces on the decay-only behavior — otherwise those
pages break their own committed tests' documented contract ("unlock is reactive... no forced
navigation").
**Warning signs:** `Endgames.readinessGate.test.tsx` mocks `useReadiness` directly, so it will
NOT catch this regression — it tests the page's *reaction* to tier2, not the poll's behavior. A
manual check (sit on `/endgames` mid-import, watch it unlock without navigating) is the only way
this regression surfaces, and it's the kind of thing that would only be noticed in a slow-import,
long-session scenario — exactly the surge scenario this phase is trying to protect.

### Pitfall 3: The reaper's clock and the in-process timeout are two independent mechanisms
**What goes wrong:** Assuming `asyncio.timeout(IMPORT_TIMEOUT_SECONDS)`
(`import_service.py:780`) is "the" 3-hour timeout, and that delaying its entry until after
semaphore acquisition is sufficient to protect a queued job from being reaped.
**Why it happens:** Both mechanisms share the same `IMPORT_TIMEOUT_SECONDS` constant and the same
"3 hours" framing, but one governs in-process cancellation of a running coroutine and the other is
an independent DB `UPDATE ... WHERE started_at < cutoff` run by a separate periodic task
(`run_periodic_reaper`) that has no visibility into the in-memory `_jobs` registry or the
semaphore's wait queue.
**How to avoid:** See Pattern 4 above — the fix must touch `ImportJob.started_at`, not just the
placement of `async with asyncio.timeout(...)`.
**Warning signs:** A test that only asserts the in-process timeout behavior (e.g. "a queued job
whose semaphore is held forever eventually raises `TimeoutError` only after N seconds of actual
execution") proves nothing about reaper survival — it needs a *separate* DB-level test using the
`TestFailOrphanedJobsAgeThreshold` pattern (Pattern 4 above).

### Pitfall 4: The percentile semaphore has two trigger sites, not one
**What goes wrong:** Wrapping only the `asyncio.create_task(compute_stage_a(...))` /
`asyncio.create_task(compute_stage_b(...))` calls at `import_service.py:716,735` with a semaphore
acquired at the call site, missing `eval_drain.py:384`'s independent `compute_stage_b` trigger.
**Why it happens:** CONTEXT.md D-06 names only `import_service.py:716`, and it's the more visible
/ obviously "per-import-completion" site; the `eval_drain.py` trigger is a less prominent, older
code path (cold-lane drain reaching zero-pending for a user).
**How to avoid:** See Pattern 5 — put the semaphore inside `compute_stage_a`/`compute_stage_b`
themselves so both call sites are covered by construction.
**Warning signs:** A test that only monkeypatches `import_service.compute_stage_a`/`b` (rather
than the shared module-level semaphore or the functions' own internals) and only exercises the
import-completion path will pass even if the eval-drain path is fully ungated.

### Pitfall 5: `useEvalCoverage.ts` is a second, similar-but-separate poll — do not conflate it with the target
**What goes wrong:** Confusing `useReadiness` (item 1's actual target, `GET /imports/readiness`,
3s cadence) with `useEvalCoverage` (`GET /imports/eval-coverage`, 1s cadence,
`frontend/src/hooks/useEvalCoverage.ts`), which is a sibling poll used by the Games/Flaws tabs'
"N of M analyzed" badges and is invalidated on the same interval by `Import.tsx`'s progress bar
effect (`Import.tsx:155-177`).
**Why it happens:** Both hooks poll import-adjacent readiness signals and share very similar
naming/purpose.
**How to avoid:** `useEvalCoverage` is **out of scope** for this phase (not named in CONTEXT.md
or ROADMAP.md) and **already implements its own stall-based backoff** — `MAX_STALL_POLLS = 30`
(`useEvalCoverage.ts:23,100-107`) stops polling after 30 consecutive fetches with no progress when
`trackFullAnalysis=true`, and stops entirely at `pct_complete === 100` for the default
(readiness-consumer) mode. It is not part of the "unbounded standing load" problem this phase
targets. **Do note it as a directly reusable reference pattern** for item 1's own duration-cap
logic (a `useRef`-based tracker of elapsed time / fetch count is the exact shape to copy).
**Warning signs:** A plan task that touches `useEvalCoverage.ts` at all is very likely scope
creep relative to CONTEXT.md's locked item-1 boundary (`useReadiness.ts` only).

### Pitfall 6: `count_pending_evals` is already indexed — "cheapen if trivial" likely has nothing trivial left to do
**What goes wrong:** Assuming the endpoint is doing an unindexed scan (per the seed's speculative
"looks like the 135ms/72ms `count(*) FROM game_flaws` shapes" characterization) and spending
effort adding an index that already exists.
**Why it happens:** The seed explicitly says this is an inference ("looks like"), not a measured
fact for this specific query.
**How to avoid:** `count_pending_evals` (`app/repositories/game_repository.py:196-203`) runs
`SELECT count(*) FROM games WHERE user_id = ? AND evals_completed_at IS NULL`, and
`ix_games_user_evals_pending` (`app/models/game.py:64-68`) is a partial index on
`(user_id) WHERE evals_completed_at IS NULL` — an exact match for this predicate. The query is
already using the intended index; a Postgres `COUNT(*)` still has to walk every matching row
(no materialized counter, no `HyperLogLog` estimate), so for a user with e.g. 7,000 freshly
imported pending-eval games, the index scan still touches ~7,000 rows every 3s under the OLD
polling behavior — that's real cost, but "cheapen the endpoint" would mean a structural change
(a materialized/cached count, or capping the scan) which is a bigger lift than "trivial." The
CONTEXT.md phrasing ("ONLY if trivial... must not depend on it") strongly suggests **the frontend
backoff alone is the fix**, and no backend endpoint change should be attempted unless the planner
finds something genuinely trivial beyond what's described here.
**Warning signs:** A plan task proposing a new index or a materialized counter for
`count_pending_evals` is scope creep beyond "trivial" and risks violating "no Postgres tuning."

### Pitfall 7: `ImportStatusResponse.status` and `ImportStartedResponse.status` are typed `str`, not `Literal`
**What goes wrong:** Adding `"queued"` as a fifth value without tightening the type, continuing
a pre-existing gap.
**Why it happens:** `app/schemas/imports.py:30,37` both declare `status: str` — bare `str` for a
fixed-value field, which CLAUDE.md's Coding Guidelines explicitly forbid for *new* code
("Never use bare `str` for fields with a fixed set of values — use `Literal[...]`"). This is
pre-existing debt, not something this phase introduced.
**How to avoid:** Since this phase is already touching these exact fields, tightening them to
`Literal["pending", "queued", "in_progress", "completed", "failed"]` is a natural, in-scope
opportunity (small, additive, and directly serves the type-safety goal of adding a new status
value correctly) — but is not itself a locked requirement. The frontend counterpart
`ImportJobStatus` (`frontend/src/types/api.ts:177`) IS already a proper literal union and simply
needs `'queued'` appended.
**Warning signs:** None load-bearing — flagging as an opportunity, not a defect that blocks the
phase.

## Code Examples

### Fake-timer test pattern already in place for `useReadiness` (extend, don't replace)

```typescript
// Source: frontend/src/hooks/__tests__/useReadiness.test.tsx:32-113 (verbatim existing tests)
describe('useReadiness', () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls at 3s interval when tier2 is false', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { tier1: true, tier2: false, pending_count: 5, total_count: 10 },
    });
    renderHook(() => useReadiness(), { wrapper: makeWrapper() });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    await act(async () => { await Promise.resolve(); });
    // ... assert call count
  });
});
```

**Recommended extension for the interval-sequence assertion (SURGE-01 / D-05):** record
`Date.now()` (mockable under `vi.useFakeTimers()`) at each `apiClient.get` invocation via a
`mockImplementation` side-effect, then assert the sequence of deltas between consecutive calls
matches the intended backoff curve (e.g. `[3000, 3000, ..., 3000(while tier1 false), then
increasing gaps once tier1=true/tier2=false, then no further calls after the duration cap]`).
This is exactly what D-05 means by "asserts the emitted interval sequence itself" — a test that
only checks `READINESS_POLL_INTERVAL_MS` exists (or that `refetchInterval` returns a number type)
would pass even if the backoff logic is dead code, per D-07/`feedback_mutation_test_gap_closures`.

### Reaper age-threshold test scaffold (copy directly for SURGE-04's reaper-exemption test)

```python
# Source: tests/test_import_service.py:1705-1789 (verbatim existing helper + test —
# copy this class's _seed_job helper for the new "queued survives the reaper" test)
class TestFailOrphanedJobsAgeThreshold:
    async def _seed_job(self, session, user_id, job_id, status, started_at, platform="lichess"):
        await ensure_test_user(session, user_id)
        job = ImportJob(id=job_id, user_id=user_id, platform=platform, username="test_user",
                         status=status, games_fetched=0, games_imported=0)
        session.add(job)
        await session.flush()
        await session.execute(
            text("UPDATE import_jobs SET started_at = :ts WHERE id = :id"),
            {"ts": started_at, "id": job_id},
        )
        await session.flush()

    async def test_no_threshold_reaps_all_in_progress(self, db_session):
        # seeds a "young" and an "old" (4h) row, asserts both reaped when threshold=None
        ...
```

### Deterministic (non-timing-based) test for the `to_thread` wrap

**Recommended over a wall-clock/timing assertion** — deterministic, no flakiness risk (the
project's own memory flags heavy-test-timeout flake as a recurring hazard):

```python
# New test, place in tests/test_guest_auth.py's existing
# `class TestPromoteGuestWithPassword` (tests/test_guest_auth.py:294-...)
import threading

async def test_promotion_hashes_off_the_main_thread(self, db_session, monkeypatch):
    """Reverting the to_thread wrap must turn this test red."""
    main_thread_id = threading.get_ident()
    observed_thread_id: list[int] = []

    def spy_hash(password: str) -> str:
        observed_thread_id.append(threading.get_ident())
        return "irrelevant-hash"

    from app.services import guest_service
    monkeypatch.setattr(guest_service._password_helper, "hash", spy_hash)

    user, _token = await guest_service.create_guest_user(db_session)
    await guest_service.promote_guest_with_password(
        db_session, user, "new@example.com", "some-password"
    )

    assert observed_thread_id, "hash was never called"
    assert observed_thread_id[0] != main_thread_id, (
        "hash ran on the event-loop thread — asyncio.to_thread wrap is missing/reverted"
    )
```
This directly falsifies the fix if reverted (a direct sync call runs `spy_hash` on
`threading.get_ident() == main_thread_id`), with zero timing dependency.

## State of the Art

Not applicable in the "library upgraded" sense — this phase touches no external library version
boundary. The one relevant "old approach → new approach" is internal:

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Poll-until-tier2-forever (`refetchInterval: tier2 ? false : 3000`) | Decay + duration cap | This phase | Bounds standing per-tab load from O(open tabs × ∞) to O(open tabs × bounded window) |
| Unbounded `asyncio.create_task(run_import(...))` fan-out | Semaphore-bounded, visible queue | This phase | Bounds worst-case concurrent DB-pool pressure from the flush phase |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | pwdlib's `PasswordHelper.hash` (backed by argon2-cffi's C extension) is safe to call from a thread-pool worker thread with no additional locking — no global mutable state is touched beyond the CPU-bound hash computation itself. | Pattern 2 | If pwdlib/argon2-cffi has hidden non-thread-safe global state, concurrent `to_thread` calls could corrupt output or crash; low likelihood (Argon2 is a pure-function KDF by design) but not exhaustively verified against pwdlib's C-extension internals in this session — only the Python-level `hash()` source was inspected. |
| A2 | The recommended in-memory-only "queued" design (Pattern 3) does not need the partial unique index touched, because the DB row stays `status="pending"` throughout the queue wait, identical to today's fetch-phase behavior. | Pattern 3 | If a future reviewer expects `import_jobs.status` to visibly show "queued" in the DB (e.g. for an ops dashboard querying the table directly), this design would not surface it — a deliberate simplicity/migration-avoidance tradeoff, not a functional gap for the phase's stated UX requirement (bare label via the API). |
| A3 | Cloudflare's free-plan Cache Rule with Edge TTL "respect origin headers" will honor Caddy's per-path `Cache-Control` exactly as CONTEXT.md D-04 describes (no separate Cloudflare-side override needed for the 30-day vendored-runtime TTL vs. the `no-cache` worker file). | Package Legitimacy Audit / out of code scope | This is operator-verified via response headers per D-07's stated exemption for item 3; no code risk, listed for completeness since it was not independently re-verified against live Cloudflare behavior in this session (out of scope — no Cloudflare account access). |

## Open Questions

1. **Exact backoff curve and duration cap values (D-05 discretion).**
   - What we know: 3s while `tier1` false; decay "hard" once only `tier2` outstanding; cap total
     duration so an 8-hour-open tab goes quiet; `useEvalCoverage.ts`'s stall-counter (30 stalled
     1s fetches ≈ 30s) is a nearby precedent but solves a different problem (stall detection, not
     time-based decay).
   - What's unclear: the specific decay factor (e.g. doubling? capped exponential? a fixed
     small set of steps like 3s→10s→30s→60s?) and the exact cap (10 minutes? 1 hour? 8 hours
     literally, matching the seed's own example?).
   - Recommendation: planner should pick concrete numbers (e.g. 3s→15s→60s→300s, cap at 30 min)
     and lock them as an explicit plan decision — CONTEXT.md defers this to "planner/executor
     discretion," so RESEARCH.md deliberately does not prescribe a value.

2. **Exact global import concurrency cap value (discretion).**
   - What we know: seed analysis suggests "low single digits given the outbound limiters already
     gate at 3 per platform" (CONTEXT.md Claude's Discretion); estimated ceilings table in the
     seed puts "comfortable" concurrent imports at ~10-15, "degraded" 20-40.
   - What's unclear: whether the cap should sit near the outbound-limiter number (≈3-6, matching
     "actively buffering" capacity) or nearer the "comfortable" ceiling (~10-15).
   - Recommendation: given the outbound limiters already cap active fetching at 3 per platform (6
     total across both), and the NEW cap governs the whole `run_import` body (fetch **and**
     flush, i.e. the CPU-bound PGN-parse-while-holding-a-session phase the seed flags as the
     actual pool-exhaustion risk), a cap in the 5-8 range is defensible — low enough to bound
     flush-phase pool pressure, high enough to rarely visibly queue at today's ~3-concurrent-peak
     usage. Final number is explicitly the planner's call per CONTEXT.md.

## Environment Availability

Not applicable — this phase adds no new external tool/service dependency beyond the already-live
Cloudflare account setup (operator-managed, D-04) and stdlib-only code changes. No probe needed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Backend framework | pytest 9.x + pytest-asyncio, run via `uv run pytest -n auto` (per-run cloned DB, see CLAUDE.md) |
| Frontend framework | Vitest `^4.1.7` [VERIFIED: frontend/package.json:73] + `@testing-library/react` |
| Backend config | `pyproject.toml` (pytest section) — no changes needed |
| Frontend config | `vitest.config.ts` (unread this session — not touched by this phase) |
| Quick run (backend, single file) | `uv run pytest tests/test_guest_auth.py -x` / `uv run pytest tests/test_import_service.py -x` |
| Full suite | `uv run pytest -n auto -x` (backend) + `npm test -- --run` (frontend) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SURGE-01 | Interval-sequence backoff + duration cap | unit (fake timers) | `npm test -- --run useReadiness` | ✅ `frontend/src/hooks/__tests__/useReadiness.test.tsx` (extend) |
| SURGE-02 | `to_thread` wrap, thread-identity assertion | unit | `uv run pytest tests/test_guest_auth.py -x` | ✅ `TestPromoteGuestWithPassword` class exists, add a test |
| SURGE-03 | CDN cache-hit headers, `no-cache` preserved | manual (operator, response headers) | n/a — exempt per D-07 | n/a |
| SURGE-04a | Global cap enforced, cap+1th job queued | unit | `uv run pytest tests/test_import_service.py -x` | ✅ file exists, add a class |
| SURGE-04b | Queued job never reaped while alive | DB-backed unit | `uv run pytest tests/test_import_service.py -x` | ✅ `TestFailOrphanedJobsAgeThreshold` class exists, add a test (Pattern 4) |
| SURGE-05 | Percentile semaphore bounds concurrent computes | unit (fake session_maker + Event) | `uv run pytest tests/services/test_import_service_stage_a.py` or a new file | ⚠️ Wave 0 — this specific concurrency-bound assertion has no existing precedent in the codebase (see Wave 0 Gaps) |
| SURGE-06 | Rate-limiter constants byte-identical | trivial | `git diff app/core/rate_limiters.py` (must be empty) | n/a — enforced by NOT touching the file |
| SURGE-07 | Mutation-tested (revert → red) | process | manual revert-and-run per item | n/a — methodology, not a single test |

### Sampling Rate
- **Per task commit:** the single relevant test file (see table above)
- **Per wave merge:** `uv run pytest -n auto -x` (backend) + `( cd frontend && npm run lint && npm test -- --run )` (frontend)
- **Phase gate:** full pre-merge gate per CLAUDE.md before squash-merge to `main`

### Wave 0 Gaps
- [ ] **Semaphore max-concurrency assertion pattern.** No existing test in the codebase asserts
  "no more than N concurrent operations" for any `asyncio.Semaphore`. Needs a small reusable
  helper (peak-concurrency counter via a shared mutable int + `asyncio.gather` of N+k blocked
  workers) — write this once, reuse for both SURGE-04a (import cap) and SURGE-05 (percentile
  gate).
- [ ] No dedicated `tests/services/test_import_service_queue.py`-style file exists yet for item 4
  — likely needs a new test module given the surface area (queue transition, reaper exemption,
  `other_importers` count inclusion of QUEUED). Placement: `tests/test_import_service.py` already
  has ~1800 lines; consider a new `tests/services/test_import_service_queue.py` to avoid further
  bloating the existing file, mirroring the `test_import_service_stage_a.py` split precedent.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | Marginal | Item 2 does not change the hashing algorithm or cost parameters (Argon2id via pwdlib unchanged) — only moves the *scheduling* of an unchanged call off the event loop. No V2 control changes. |
| V6 Cryptography | No change | Argon2 cost parameters explicitly NOT tuned (D-01/locked constraint #6) — `to_thread` wraps the call, does not alter it |
| V11 Business Logic | Yes (new) | Item 4's semaphore + queue introduces new state (`QUEUED`); ensure the queued-but-never-started path cannot be abused to hold a semaphore slot indefinitely (bounded by `IMPORT_TIMEOUT_SECONDS` once acquired, and by the DB-level unique-index duplicate-prevention while queued) |
| V1 Architecture | Marginal | The reaper-exemption fix (Pattern 4) must not silently create an unreapable job class — a bug in the `started_at` re-stamp logic (e.g. re-stamping on EVERY batch flush instead of once at acquisition) could make a genuinely-stuck job immortal. Test coverage (SURGE-04b) is the control here, not a library. |

### Known Threat Patterns for this phase's stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Semaphore-slot starvation (many low-value queued jobs blocking a legitimate user's import indefinitely) | Denial of Service | Out of scope for this phase's THIN slice (no priority/fairness logic requested) — the duplicate-prevention unique index still limits one user to one queued job per platform, bounding worst-case abuse to (num-distinct-users × 1 platform) queued jobs, not unbounded per-user spam |
| A reaper-exemption bug that makes queued-forever jobs permanently unreapable | Denial of Service (resource leak) | Mutation-tested via SURGE-04b/SURGE-07 — this is exactly the failure mode the phase's own mutation-testing discipline targets |

## Sources

### Primary (HIGH confidence — file:line read this session)
- `app/services/import_service.py` (full read, lines 1-900+) — job lifecycle, reaper, semaphore trigger sites
- `app/repositories/import_job_repository.py` (full read) — `fail_orphaned_jobs`, DB status semantics
- `app/models/import_job.py` (full read) — schema, partial unique index, no CHECK constraint confirmed
- `app/routers/imports.py` (lines 1-490) — endpoint wiring, in-memory-first read pattern for `GET /imports/{job_id}` and `/active`
- `app/core/rate_limiters.py` (full read) — semaphore pattern to mirror, locked-file confirmation
- `app/core/database.py` (full read) — pool_size=10/max_overflow=10/no pool_timeout confirmed
- `app/services/guest_service.py` (lines 1-100) — `to_thread` target call site, `create_guest_user` no-hash confirmation
- `app/services/user_benchmark_percentiles_service.py` (lines 390-561) — `compute_stage_a`/`b` bodies, `finally`-clear ordering
- `app/services/eval_drain.py` (lines 365-390) — second `compute_stage_b` trigger site
- `app/services/percentile_compute_registry.py` (full read) — mark/clear/is_computing pattern
- `frontend/src/hooks/useReadiness.ts` (full read)
- `frontend/src/hooks/useEvalCoverage.ts` (full read) — sibling poll, existing backoff precedent
- `frontend/src/hooks/useImport.ts`, `frontend/src/pages/Import.tsx` (relevant sections) — status rendering, `isActive` derivation
- `frontend/src/App.tsx` (grep + read) — all four `useReadiness` mount sites, confirming `tier1`-only consumption
- `frontend/src/pages/Endgames.tsx`, `OpeningFindingCard.tsx`, `OpeningStatsCard.tsx`, `PositionResultsPanel.tsx` (grep-verified) — `tier2` live consumers
- `frontend/src/types/api.ts` (lines 177-224) — `ImportJobStatus` union, `ReadinessResponse` shape
- `frontend/src/hooks/__tests__/useReadiness.test.tsx` (full read) — existing fake-timer test pattern
- `tests/test_import_service.py` (lines 1690-1789) — reaper age-threshold test pattern
- `tests/test_guest_auth.py` (grep) — `TestPromoteGuestWithPassword` class location
- `deploy/Caddyfile` (lines 1-75) — exact `@vendored_runtime`/`@maiaworker` matchers and headers
- `.planning/phases/209-traffic-surge-quick-wins/209-CONTEXT.md` — locked decisions D-01..D-07
- `../../seeds/closed/SEED-146-traffic-surge-readiness.md` — measured facts, correction block
- `.planning/ROADMAP.md` (Phase 209 section, lines 397-438) — Success Criteria / SURGE-01..07 mapping
- `.planning/config.json` — `nyquist_validation: true`, no `security_enforcement` key (treated as enabled)
- `frontend/package.json` — `@tanstack/react-query ^5.100.14`, `vitest ^4.1.7`
- `uv run python -c "import pwdlib; ... inspect.getsource(PasswordHelper.hash)"` — pwdlib 0.3.0 confirmed installed, `hash()` source confirmed pure-function shape

### Secondary (MEDIUM confidence)
- None used — every claim above traces to a file read or command run this session.

### Tertiary (LOW confidence)
- A1 in the Assumptions Log (pwdlib/argon2-cffi thread-safety at the C-extension level, not just the Python wrapper) is the only claim in this document not fully verified by direct inspection this session.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages, all stdlib/already-vendored
- Architecture: HIGH — every file:line cited was read this session, not inferred
- Pitfalls: HIGH — Pitfalls 2-4 are novel findings (live tier2 consumers, decoupled reaper clock,
  second compute_stage_b trigger site) not present in the seed or CONTEXT.md text, surfaced by
  reading the actual call graph rather than trusting the phase description's summary

**Research date:** 2026-08-10
**Valid until:** 30 days (internal-code-only findings; no external library version dependency to go stale, but a concurrent phase touching `import_service.py`, `useReadiness.ts`, or `guest_service.py` before this phase executes would invalidate the file:line citations — re-verify line numbers if significant time or intervening phases pass)
