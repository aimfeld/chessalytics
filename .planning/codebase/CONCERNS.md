# Codebase Concerns

**Analysis Date:** 2026-09-02

## Tech Debt

**Backend `except Exception` blocks without Sentry capture (RESOLVED 2026-09-02, quick task 260902-rmn):**
- Audit: 136 `except` clauses in `app/services/` + `app/routers/`; 69 had no capture in the block body. 62 are expected conditions under the CLAUDE.md rule (input-parse fallbacks, `CancelledError` re-raise, retry loops that capture on the last attempt, per-item loops with one aggregate post-loop capture, deliberately swallowed best-effort syscalls, optional-dependency `ImportError`, stale bearer-token decode). The raw clause/capture ratio in the original entry overstated the problem.
- Fixed (commit 7fc994cf7): 7 sites that swallowed genuine failures silently — Stockfish respawn failure and engine crash in `app/services/engine.py`; `read_game` raising on a stored PGN in `app/services/eval_apply.py` (2 sites), `app/services/eval_entry.py`, `app/routers/eval_remote.py`; `board.san` on the mainline in `eval_apply.py`. Guarded by `tests/services/test_sentry_capture_gaps.py` and `tests/services/test_engine_nodes.py`.
- Remaining: none known. Details in `.planning/quick/260902-rmn-implement-missing-sentry-captures-in-app/260902-rmn-SUMMARY.md`.

**`gen_benchmarks.py` incomplete migration to modular chapters:**
- Issue: `scripts/gen_benchmarks.py:179-190` contains an explicit "TODO stub" fallback — `return {"status": "TODO", "section": todo, "tables": [], "values": {}}` — for report sections not yet ported to the newer per-chapter compute functions.
- Files: `scripts/gen_benchmarks.py:179`, `scripts/gen_benchmarks.py:190`
- Impact: any benchmark section still routed through this fallback silently produces an empty stub result instead of failing loudly, which could mask a missing chapter in a generated report.
- Fix approach: finish porting remaining sections one at a time (as the comment itself instructs — diff each against the legacy path before moving to the next), then remove the stub branch entirely.

**Large "God files" exceeding the CLAUDE.md size/complexity guidance:**
- Issue: the next tier of frontend pages/components still exceeds the documented soft/hard limits (soft 100 / hard 200 *logic* LOC per function). These files are baselined in the Phase 215 override region of `frontend/eslint.config.js` (`complexity`/`max-depth`/`max-statements` at `error`) and shrink under CLAUDE.md's "refactor bloated code on sight" rule as each is next touched — the gate now catches any NEW breach in these or any other frontend file; it does not by itself shrink an already-baselined one.
- Files: `frontend/src/components/train/TrainReveal.tsx` (1,365 lines), `frontend/src/components/library/EvalChart.tsx` (1,311 lines), `frontend/src/components/results/LibraryGameCard.tsx` (1,299 lines), `frontend/src/components/train/TrainSolveScreen.tsx` (1,214 lines), `frontend/src/components/analysis/VariationTree.tsx` (1,121 lines), `frontend/src/App.tsx` (1,032 lines)
- Impact: high cognitive load for any change; CLAUDE.md's own rule ("refactor bloated code on sight" when editing) implies these files are known debt that keeps growing rather than shrinking, since new work is added to the same modules.
- Fix approach: per CLAUDE.md guidance — split along data-shaping-hook or desktop/mobile-renderer seams when a file is next touched, rather than an unscoped big-bang refactor. A file's entry leaves the `frontend/eslint.config.js` Phase 215 baseline override region once its complexity is fixed, the same "only ever shrinks" contract the backend's `per-file-ignores` region already follows.
- History: the six backend god files this entry previously listed were fully decomposed in Phase 214 (Backend God-File Decomposition, completed 2026-09-03) with zero behavior change. The four frontend god files this entry previously listed (`Analysis.tsx`, `useBotGame.ts`, `workerPool.ts`, `Openings.tsx`) were decomposed in Phase 215 (Frontend God-File Decomposition, completed 2026-09-04), landing the eslint `complexity`/`max-depth`/`max-statements` gate plus report-only `npm run lint:cognitive`; this entry now tracks only the next-tier frontend debt.

**Widespread `# ty: ignore` suppressions concentrated in a few patterns:**
- Issue: ~140 `# ty: ignore[...]` suppressions exist across `app/` and `tests/`. The large majority fall into a handful of recurring, arguably-fixable shapes rather than truly unfixable SQLAlchemy/FastAPI-Users generics:
  - `result.rowcount` on DML results (`ty: ignore[unresolved-attribute]`) appears ~15+ times across `app/repositories/`, `app/services/`, `scripts/` (e.g. `app/repositories/train_repository.py:2670`, `app/repositories/push_repository.py:138`, `app/repositories/import_job_repository.py:252`, `app/services/eval_queue_service.py:222`, `app/services/eval_queue_service.py:1204`).
  - `update(games_table)` / `update(jobs_table)` typed as raw `Table` objects (`ty: ignore[invalid-argument-type]`) recurs ~15 times, notably clustered in `app/services/eval_apply.py:785,801,819,939,965,1232`, `app/services/import_service.py:1492,1511,1528,1584`, `app/services/eval_queue_service.py:214,1106,1135`.
  - `row.<attr>` access on labeled `Row`/`NamedTuple` results (`ty: ignore[unresolved-attribute]`) is heavily concentrated in `app/services/endgame_service.py` (15+ occurrences between lines 1412-3084).
- Files: see above; full list obtainable via `grep -rn "ty: ignore" app/`
- Impact: each suppression is a spot ty cannot verify — a legitimate `CLAUDE.md`-sanctioned escape hatch per the file's own comments, but the sheer count (dominated by 3 repeating idioms) suggests a typed-helper wrapper (e.g. a small `Table`-typed alias, or a `TypedDict`/dataclass row-mapper for `endgame_service.py`'s raw SQL results) could eliminate a large fraction without touching business logic.
- Fix approach: not urgent (CLAUDE.md explicitly sanctions this pattern), but if `endgame_service.py` is refactored for size (see above), replacing raw `Row` attribute access with a typed mapping struct would remove ~20 suppressions in the same pass.

**React `exhaustive-deps` lint suppressions (26 occurrences):**
- Issue: 26 `eslint-disable(-next-line) react-hooks/exhaustive-deps` comments across the frontend, concentrated in `frontend/src/pages/Analysis.tsx` (6 occurrences: lines 1057, 1072, 1083, 1124, 1154, 2849), `frontend/src/components/analysis/AnalysisTagsPanel.tsx` (7 occurrences: lines 116-252), and scattered across `Bots.tsx`, `Endgames.tsx`, `Openings.tsx`, `EvalChart.tsx`, `TrainScoreScreen.tsx`, `EndgameTimePressureSection.tsx`, `EndgameMetricsByTcSection.tsx`, `EndgameTypeBreakdownSection.tsx`.
- Files: as listed above
- Impact: each suppression is a candidate for a stale-closure bug if the omitted dependency ever changes without triggering the effect; most carry justification comments (e.g. `TrainLineStepper.tsx:169,196`), but the density inside `Analysis.tsx` and `AnalysisTagsPanel.tsx` — both already oversized files — compounds the "large file, hard to reason about effect deps" risk.
- Fix approach: when next touching these hooks, verify each suppressed dependency truly cannot change independently of the tracked deps; extract `useAnalysisLayoutMode`-style focused hooks (a pattern the file already uses at `frontend/src/pages/Analysis.tsx:292`) to shrink each effect's dependency surface.

**Documented latent stale-closure risk left un-fixed:**
- Issue: `frontend/src/hooks/useGemSweep.ts:244` contains a comment explicitly flagging "a latent stale-closure" in a dependency-array entry, with no accompanying `eslint-disable` — i.e., the lint rule doesn't even flag it, but the author has manually identified a risk and left it unaddressed.
- Files: `frontend/src/hooks/useGemSweep.ts:244`
- Impact: unclear scope without deeper investigation, but the code author's own comment indicates the closure risk is known and real; not merely a suppressed-lint edge case.
- Fix approach: read the surrounding hook logic, confirm which state the closure can go stale against, and either restructure with a ref (the pattern used at `frontend/src/App.tsx:839-842` for the same class of problem) or add an effect dependency.

## Known Bugs

None identified with clear reproduction steps from static analysis. No open bug-tracking comments (`FIXME`, `BUG`) were found in `app/` or `frontend/src/` — the only `TODO`/`FIXME`-adjacent hits are the `gen_benchmarks.py` stub (tech debt, above) and prose/test-string matches unrelated to actual bugs (e.g. `frontend/src/lib/flawComparisonMeta.ts:272` is a docstring describing `"p < 0.001"` formatting, not a marker).

## Security Considerations

**`.env` and secret files present but not readable (expected, noted for completeness):**
- Risk: standard secret-in-environment-variable pattern; no findings of hardcoded credentials in source during this scan.
- Files: `.env*` files exist at the project root (existence only confirmed, contents not read per policy)
- Current mitigation: secrets are environment-variable based, consistent with FastAPI/Uvicorn conventions.
- Recommendations: none beyond standard practice; out of scope for a static grep-based audit to verify secret-handling correctness further.

**Frontend production dependency vulnerability gate currently clean:**
- Risk: `frontend/audit-ci.jsonc` gates CI on `npm audit`-equivalent high/critical advisories in production dependencies, with an explicit empty `"allowlist": []`.
- Files: `frontend/audit-ci.jsonc`
- Current mitigation: the two previously allowlisted `react-router` advisories (GHSA-chx6-hx7r-mcp5 DoS, GHSA-qwww-vcr4-c8h2 RSC CSRF bypass) were resolved by migrating off `react-router-dom` to the `react-router` package at `^8.3.0` (`frontend/package.json:40`), per the file's own changelog comment.
- Recommendations: none — this is a well-maintained gate, included here for completeness since project memory (`project_frontend_audit_ci_allowlist.md`) flags it as a recurring area to check; current state is clean (empty allowlist).

## Performance Bottlenecks

No specific slow-query or hot-path bottleneck was identified from static code inspection alone (would require `EXPLAIN`/`pg_stat_statements` analysis per project memory — `project_pg_stat_statements_dead_shapes.md` warns that static analysis of "slow-looking" code is unreliable without live query cost data). Flagging structural risk only:

**Endgame service's raw-`Row` heavy compute path:**
- Problem: `app/services/endgame_service.py` builds large in-memory dict/list aggregations across many raw SQL `Row` results (`rows_by_game[row.game_id].append(row)` at line 1412, and similar patterns through line 3084) rather than ORM-mapped objects, inside functions already at or near the 200-line hard limit (`_get_endgame_performance_from_rows`, ~215 lines).
- Files: `app/services/endgame_service.py:1412-3084`
- Cause: raw-row processing avoids ORM overhead but concentrates significant single-function complexity, making it hard to spot accidental O(n²) row-matching or redundant re-iteration without careful reading.
- Improvement path: not a confirmed bottleneck — flag for profiling only if `/endgames` or benchmark generation is reported slow; the `benchmarks` skill's chapter5 fast-refresh path already exists for iterative compute changes.

## Fragile Areas

**`AsyncSession` concurrency discipline is manually enforced by convention, not the type system:**
- Files: `app/services/eval_drain.py:10-18`, `app/services/openings_service.py:167`, `app/repositories/library_repository.py:2403,2430`, `app/services/engine.py:31,404`, `app/routers/imports.py:264,376`, `app/services/eval_queue_service.py:727`, `app/services/push_send.py:259`, `app/services/train_reminder_service.py:224`, `app/repositories/endgame_repository.py:612,700`
- Why fragile: the "never `asyncio.gather` on one `AsyncSession`" constraint (CLAUDE.md) is enforced only through inline comments at ~15 call sites — there is no lint rule, type constraint, or runtime guard preventing a future contributor from introducing `asyncio.gather` inside a session-scoped function. `app/services/email_service.py:146` does use `asyncio.gather(*pending, return_exceptions=True)` — worth confirming this call site genuinely has no open `AsyncSession` in scope, since it's the one place gather actually appears (all other matches are comments/docstrings explaining its avoidance).
- Safe modification: before adding any concurrent execution in a service/router function, grep the function body for open sessions; `app/services/eval_drain.py:10-18`'s docstring is the most explicit statement of the rule and a good template for new code.
- Test coverage: not verifiable via static analysis whether tests would catch a `gather`-on-session regression; likely would only surface as an intermittent connection-pool error in CI or prod.

**`Analysis.tsx` (4,370 lines) as a single component/module:**
- Files: `frontend/src/pages/Analysis.tsx`
- Why fragile: houses the layout-mode hook, multiple helper functions (`fenToRootPly`, `bestSanFromPv`, `findFocusedFlaw`, `buildFocusedPvLine`, etc.), the main page component, and 6 `exhaustive-deps`-suppressed effects, all in one file. Its own test file is 2,831 lines (`frontend/src/pages/__tests__/Analysis.test.tsx`), indicating the component's surface area is already a known testing burden.
- Safe modification: favor extracting cohesive helper clusters (URL-param parsing, focused-flaw/PV-line logic) into `frontend/src/lib/` or a dedicated hook rather than adding further inline logic; CLAUDE.md's own guidance to split "past ~40 LOC of logic each" for desktop/mobile renderers applies directly here.
- Test coverage: extensive (2,831-line test file), but size itself is a fragility signal — large test files are harder to reason about when a regression surfaces.

## Scaling Limits

Not assessed — no production capacity/throughput data available from static code inspection. See project memory (`project_remote_workers_cover_pool.md`, `project_worker_fleet_topology.md`) for known infra-level scaling notes (worker fleet, RAM/DB as binding constraints); these are operational facts, not codebase concerns to re-derive here.

## Dependencies at Risk

**`react-router` migrated to a non-`-dom` package at v8 (recent, low-risk but notable):**
- Risk: `frontend/package.json:40` pins `"react-router": "^8.3.0"` — a relatively new major-version package family (the project migrated off the long-standing `react-router-dom` naming). Project memory confirms this was a deliberate, forced migration (`react-router-dom` discontinued at 7.18.2 with an unpatched CSRF advisory).
- Impact: low immediate risk since it was a security-driven, already-completed migration with a clean current audit gate, but the v8 API surface is newer and less battle-tested than the long-lived v6/v7 `-dom` package.
- Migration plan: none needed currently; monitor `frontend/audit-ci.jsonc` for new advisories on this package as usual.

## Missing Critical Features

None identified from this focused code/comment scan — feature-gap analysis is out of scope for a `concerns`-focus mapper pass (see `ROADMAP.md`/`.planning/` for planned work, not covered here per instructions to avoid mining planning prose).

## Test Coverage Gaps

**Sentry-capture gap doubles as a test-coverage gap:**
- What's not tested: whether `except Exception` blocks lacking `capture_exception` are actually exercised by any test that would surface a silent-failure regression; the mismatch between 67 broad-`except` sites and 85 total `capture_exception` calls project-wide suggests some exception paths are neither captured nor obviously covered by tests asserting Sentry is called.
- Files: `app/services/*.py`, `app/routers/*.py` (broad)
- Risk: a genuine production error in one of these paths would be invisible in Sentry and only detectable via a 500 response or user report.
- Priority: Medium — worth a follow-up grep-and-triage pass (per CLAUDE.md's own rule) rather than a blanket fix, since some `except Exception` blocks legitimately fall under the "expected/trivial" exemption.

**`gen_benchmarks.py` TODO stub path has no test asserting it is unreachable:**
- What's not tested: whether any currently-shipped benchmark report section still routes through the `{"status": "TODO", ...}` fallback at `scripts/gen_benchmarks.py:190`.
- Files: `scripts/gen_benchmarks.py:179-190`
- Risk: a report generation could silently emit an empty stub section without any test failing, since the stub is a valid return value, not an exception.
- Priority: Low — likely already tracked by the migration effort referenced in the comment itself (SEED-157 per `analysis/game_review_study/game_review_study.py:410`), but worth a guard test asserting no section currently resolves to `"status": "TODO"` in the generated output.

---

*Concerns audit: 2026-09-02*
