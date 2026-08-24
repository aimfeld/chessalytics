---
phase: 260824-qaz
plan: 01
status: complete
date: 2026-08-24
commits:
  - bfcc5cd37
  - 81dc3fd3d
  - 21a853213
---

# Quick 260824-qaz — Host the Activity Pulse dashboard at /activity

## What shipped

`https://flawchess.com/activity` (once deployed) serves the full Activity Pulse
dashboard inside the SPA, superuser-only, reached from a nav entry that only
superusers see. No SQL, chart code or stylesheet was forked — the standalone
tunnel workflow and the hosted page share one source.

| Commit | Task |
|---|---|
| `bfcc5cd37` | Tracer: `dashboard/stats.py` extraction, superuser-gated endpoint, route + nav, minimal page |
| `81dc3fd3d` | Split the render layer from the poll driver; scope the stylesheet |
| `21a853213` | Full markup port, build plumbing, README/CHANGELOG, timing |

## Decisions as built

All 11 locked decisions hold. The load-bearing one is **D-1**: auth is Bearer
JWT, so a browser navigating to `/activity` sends no `Authorization` header and
the HTML document cannot be gated server-side. The page therefore ships as an
SPA route and the hard gate lives on `GET /api/admin/activity/stats`
(`current_superuser`, which also 403s impersonation tokens). The page shell
carries no data.

**D-6 is structural, not conventional.** The standalone page's fetch/poll driver
moved to a new `dashboard/static/boot.js`, which the React page does not import.
There is no timer to accidentally re-enable.

## Five things that were not in the brief

1. **`dashboard/server.py` ran `app = create_app()` at import time**, building an
   engine against `DATABASE_URL_PROD`. `app/` could not import it at all, which
   forced the extraction into a side-effect-free `dashboard/stats.py`.
2. **`charts.js` bound `#tip` at module level.** Under Vite the module evaluates
   before React renders, so the binding was permanently null and every chart
   hover would have thrown. Fixed by resolving at call time. `app.js`'s
   `window.__fc` destructure had the identical latent trap and got the same fix.
3. **`check_layout.mjs` greps `styles.css` for four literal declaration strings.**
   Scoping the stylesheet had to prefix selectors while leaving those declaration
   bodies byte-identical.
4. **`allowJs` alone did not resolve `@activity-dash/*`** — tsc needs its own
   `paths` entry mirroring the Vite alias. The plan's `?url` fallback was not
   needed.
5. **knip reports an ambient `.d.ts` that nothing imports as dead code.** The
   `window.__fcApp` declarations moved into `ActivityPage.tsx` itself.

## Measured query cost

`build_payload()` runs ~16 sequential aggregates. Against the **dev** database
(25 users, 70 `user_activity` rows, 59 tracked days, 163,781 games), three
consecutive cold calls:

    0.40s (cold caches) / 0.03s / 0.03s

**This is a floor, not a prediction, and it is the weakest part of this change.**
The dev DB has 70 activity rows; production has orders of magnitude more, and
the dominant queries scale with users × active days rather than with games. The
endpoint has **not** been timed against production — the tunnel was down and
opening a prod connection was out of scope for this task.

Related, and worth knowing before the first prod load: `fetch_activity` returns
**one row per (user, day)** to the browser, because the cohort and retention
maths are done client-side. Payload size, not just query time, grows with the
active-user base.

Two things bound the cost: the 300s TTL (one query round per five minutes
regardless of open tabs) and the absence of any poll.

## Verification

Full pre-merge gate, green:

| Check | Result |
|---|---|
| `ruff format` / `ruff check .` | 444 files unchanged / all checks passed |
| `ty check app/ tests/ scripts/` | all checks passed |
| `pytest -n auto -x` | 4446 passed, 19 skipped |
| frontend `lint` / `knip` / `build` | clean |
| frontend `test --run` | 238 files, 3568 tests passed |
| `node dashboard/check_layout.mjs` | exits 0 at 320/360/390/414px |
| `import dashboard.server` | OK (standalone path intact) |

Also confirmed: the dashboard CSS and JS code-split into a dedicated
`ActivityPage-*` chunk, so no other route downloads them; and a DOM-shim smoke
test showed `mount()`/`destroy()` add and release listeners symmetrically
(required for React 19 StrictMode's double-mount in dev).

New backend tests (`tests/test_admin_activity_stats.py`, 6) cover the auth
ladder (401 anon / 403 non-superuser / 403 impersonation / 200 superuser), the
300s cache and `?refresh=1` bypass, and the read-only engine. Four new
`App.test.tsx` tests cover nav-entry gating on both surfaces.

## Outstanding — needs a human

The automated gate cannot cover these. From the plan's `<human-check>`:

- `/activity` renders every chart against real data, and hovering shows a
  tooltip (the lazy-`#tip` fix — the single most likely silent failure).
- The audience segmented control filters; "Refresh now" re-queries and the
  timestamp advances.
- Visiting `/openings` after `/activity` shows no CSS leak.
- 390px-wide viewport: no horizontal scrolling.
- A non-superuser is redirected off `/activity` and sees no nav entry.

**Before or soon after deploying, time the endpoint against production.** The
dev number above does not answer the question the 300s TTL was chosen to manage.
