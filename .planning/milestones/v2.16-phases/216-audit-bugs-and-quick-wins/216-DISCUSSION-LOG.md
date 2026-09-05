# Phase 216: Audit Bugs and Quick Wins - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-04
**Phase:** 216-audit-bugs-and-quick-wins
**Areas discussed:** Dependency automation, Security headers / CSP, Function-size gate

Offered but not selected: Phase scope (defaulted to all 7 seed groups, work ends at merge to `main`).

---

## Dependency automation

| Option | Description | Selected |
|--------|-------------|----------|
| Renovate app | Install the GitHub App, keep renovate.json (better uv/lockfile handling, cross-ecosystem grouping, dashboard) | ✓ |
| Dependabot | Delete renovate.json + badge, add .github/dependabot.yml with per-ecosystem weekly groups | |

**User's choice:** Renovate app, after asking for a pros/cons comparison first.
**Notes:** Comparison covered grouping (Renovate cross-ecosystem vs Dependabot per-ecosystem), lockfile maintenance (Renovate only), uv support maturity, dashboard, silent-failure mode of an uninstalled app.

| Option | Description | Selected |
|--------|-------------|----------|
| No guard | Dependency Dashboard issue is the visible signal | ✓ |
| CI staleness check | Fail CI when no renovate[bot] PR in N weeks | |
| Config validation only | renovate-config-validator in CI | |

| Option | Description | Selected |
|--------|-------------|----------|
| No automerge | Every update is a reviewed PR | ✓ |
| Automerge patch + lockfile | Merge on green CI | |

| Option | Description | Selected |
|--------|-------------|----------|
| Let Renovate batch it | Existing group PR absorbs the backlog | |
| Manual catch-up first | npm update + uv lock --upgrade in this phase | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| In-range only | Within semver ranges, no majors | ✓ (final) |
| Include majors | Also take majors | initially chosen, then reversed |
| All except TS 7 + onnxruntime-web | Take safe majors only | |

**Notes:** User first chose "Include majors"; after seeing the verified list (typescript 7, vitest 5, jsdom 30, @types/node 26, onnxruntime-web 1.29 with vendored runtime, anthropic 1.x, complexipy 8) they reverted to in-range only, leaving majors to Renovate PRs.

---

## Security headers / CSP

| Option | Description | Selected |
|--------|-------------|----------|
| Report-only to Sentry | Full candidate CSP as Report-Only with report-uri at Sentry's security endpoint | ✓ |
| Enforce frame-ancestors only | Enforcing frame-ancestors 'none' + report-only rest | |
| Skip CSP this phase | Other four headers only | |

| Option | Description | Selected |
|--------|-------------|----------|
| 1 year + includeSubDomains | No preload | ✓ |
| 1 year, no includeSubDomains | flawchess.com only | |
| Add preload too | Submit to hstspreload.org | |

| Option | Description | Selected |
|--------|-------------|----------|
| Post-deploy check + caddy validate | caddy validate in CI; deploy health step curls real headers | ✓ |
| Caddy container in CI | Run caddy in the CI job | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Static list + refresh script | CF ranges inline in Caddyfile + bin/ diff script | ✓ |
| Caddy cloudflare-ip plugin | Custom xcaddy build | |
| You decide | | |

**Notes:** Inventory shared with the user: Umami script from analytics.flawchess.com, Google Fonts, Sentry ingest on de.sentry.io, Google OAuth as a redirect (no GSI), blob/module workers with WASM, no dangerouslySetInnerHTML.

---

## Function-size gate

| Option | Description | Selected |
|--------|-------------|----------|
| Fix all 8 in-phase, then gate | Flatten each; Phase 214/215 precedent | ✓ |
| Baseline file, fix later | Add --baseline to the script | |
| Fix the two depth-7 only, baseline six | | |

| Option | Description | Selected |
|--------|-------------|----------|
| CI step + pre-merge gate list | ci.yml step and CLAUDE.md gate line | ✓ |
| CI step only | | |

| Option | Description | Selected |
|--------|-------------|----------|
| app/ only | Matches documented command | ✓ |
| app/ + scripts/ | | |

**Notes:** The seed's "baseline the 8 via pragma" was not possible: the `allow-loc` pragma exempts LOC only, never depth, and all 8 breaches are depth breaches.

---

## Claude's Discretion

- CI dependency caching details (setup-uv cache, setup-node npm cache)
- `/api/health` implementation (SELECT 1 under a named ~2 s timeout, 503 same shape, no alembic-head check)
- Housekeeping bundle details; orphan worktree removal is manual/local
- Plan grouping (one plan per seed group, groups 1-3 first)

## Deferred Ideas

- Major-version bumps via Renovate PRs (typescript 7 and onnxruntime-web re-vendoring as their own quick tasks)
- Flip CSP to enforcing after violation data
- Seed's "Not in this seed" list (F-04, F-05/F-13, F-06/F-07, F-10, F-11, F-14, F-15)
- Local `gh api` JWT 401 (GH_TOKEN) — check before the deploy
