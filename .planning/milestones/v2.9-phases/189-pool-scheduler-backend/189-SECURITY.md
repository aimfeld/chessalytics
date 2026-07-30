---
phase: 189
slug: pool-scheduler-backend
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-25
---

# Phase 189 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

**Register origin:** authored at plan time — all six PLAN files (189-01 … 189-06) carry a
`<threat_model>` block. This audit **verifies the planned mitigations exist**; it does not
retroactively scan for new threats (ASVS L1, `security_block_on: high`).

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| client → `/api/train/*` | Authenticated but untrusted input | `session_id`, `position`, `guess`, `played_move`, `correct_move`, IANA timezone, weekday mask, session size |
| authenticated user → other users' drill rows | Every train table is user-scoped; scoping comes from the JWT principal, never the request | `drill_items`, `drill_solves`, `drill_sessions`, `train_settings` rows |
| authenticated user → `game_best_moves` rows | Position-scoped table with no `user_id`; ownership established only by the join to a user-scoped `games` row | red-herring candidate positions |
| backend → eval-pipeline tables | Train reads `games` / `game_positions` / `game_flaws` / `game_best_moves` and must never write them | flaw rows, answer-key blobs |
| eval pipeline (worker submit) → `game_flaws.missed_pv_lines` | Worker-supplied blob assembled server-side into JSONB; Train reads it in a WHERE clause | answer-key JSONB (incl. the D-06 empty-array sentinel) |
| scheduled job → guest rows | `_purge_guest` selects targets by eligibility query, not by request input | guest `games` + cascaded drill rows |
| composition write path | Two concurrent requests race for the single open-session slot | `drill_sessions` open-session row |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-189-01 | Elevation of Privilege | `train_repository` all functions | high | mitigate | Every repository function is keyword-only on `user_id` (`session: AsyncSession, *, user_id: int` at lines 118/136/168/212/241/258/358/759/805/971); all 5 routers inject `Annotated[User, Depends(current_active_user)]` — no handler accepts a user id from body or path | closed |
| T-189-02 | Information Disclosure | `POST /api/train/sessions` response | high | mitigate | `TrainPuzzle` (`app/schemas/train.py:17`) is a closed 5-field model (`position`, `game_id`, `ply`, `fen`, +1) with a LOCKED docstring; `test_pre_attempt_payload_shape` (`tests/routers/test_train.py:576`) asserts exact key equality so a future field addition fails the suite | closed |
| T-189-03 | Elevation of Privilege | every `/api/train/*` handler | medium | mitigate | `_reject_guest(user)` (`app/routers/train.py:34`) is the first statement of all 5 handlers (lines 54, 99, 143, 175, 201) — an explicit 403, not an empty-result gate | closed |
| T-189-04 | Tampering | drill progress vs `_classify_and_fill_oracle` | high | mitigate | `drill_items` FKs `games(id) ON DELETE CASCADE` only, with plain `(game_id, ply)` reference columns and no `ForeignKeyConstraint` to `game_flaws` (`app/models/drill_item.py:12`, D-02 LOCKED); serve-time reads LEFT JOIN `game_flaws` and tolerate a missing match (lazy eviction, never a DELETE) | closed |
| T-189-05 | Denial of Service | `full_fen_at_ply` PGN replay | low | accept | Bounded by `puzzles_per_session` (≤ 50 by CHECK) replays per request over already-stored PGNs; parse failures are caught and the puzzle is dropped. Below the `high` block threshold | closed |
| T-189-06 | Denial of Service | dangling drill rows after a game wipe | medium | mitigate | `ondelete="CASCADE"` on `drill_items.game_id` (`drill_item.py:81`) and `drill_solves.game_id` (`drill_solve.py:73`); pinned by cascade tests at both real call sites (`tests/test_imports_router.py:696`, `tests/test_guest_cleanup_service.py:382`) | closed |
| T-189-07 | Tampering | a future cleanup commit deleting `drill_sessions` | medium | mitigate | Explicit D-04 rationale at both call sites plus assertions that `drill_sessions` survives (`test_imports_router.py:772`, `test_guest_cleanup_service.py:441`), so removal fails CI rather than silently erasing streak history | closed |
| T-189-08 | Elevation of Privilege | wrong-target guest purge | low | accept | Pre-existing WR-01 in-transaction eligibility re-check in `_purge_guest` is unchanged by this phase. Below the `high` block threshold | closed |
| T-189-09 | Information Disclosure | `herring_stmt` | high | mitigate | `Game.user_id == user_id` correlation is mandatory and documented as the sole scoping seam (`app/services/train_pool.py:312`, since `game_best_moves` carries no user column); covered by `test_herring_excludes_other_users_games` (`tests/services/test_train_pool.py:575`) | closed |
| T-189-10 | Denial of Service | `classify_puzzle_type` on a malformed blob | medium | mitigate | Every degenerate shape returns the `"soft"` default instead of raising — `None`/empty (`if not missed_pv_lines`), non-dict node 0 (`isinstance` guard), missing cp/mate on either side (`best_es is None or second_es is None`); documented "never raises" contract with explicit tests | closed |
| T-189-11 | Information Disclosure | classifier output leaking pre-attempt | high | mitigate | `classify_puzzle_type` has exactly two production call sites, both post-attempt: the solve path (`train_repository.py:691`) and the reveal path (`train_repository.py:1050`); `TrainPuzzle` has no field able to carry it (see T-189-02) | closed |
| T-189-12 | Elevation of Privilege | `load_session_puzzles` | high | mitigate | WHERE clause filters `DrillSolve.user_id == user_id` in addition to `session_id` (`train_repository.py:289–290`); a foreign session id resolves to zero rows rather than another user's puzzles | closed |
| T-189-13 | Information Disclosure | frozen puzzle ordering | medium | mitigate | Deterministic `(user_id, session_date)`-seeded shuffle — `random.Random(f"{user_id}:{today.isoformat()}").shuffle(reconstructed)` (`train_repository.py:556`, D-09) — so a red herring's slot is not inferable from a fixed SR-then-herring layout | closed |
| T-189-14 | Tampering | concurrent composition | medium | mitigate | `uq_drill_sessions_user_open` partial unique index (`app/models/drill_session.py:50`) is the authority; the losing request catches `IntegrityError` (`train_repository.py:618`) and resumes rather than creating a second session | closed |
| T-189-15 | Denial of Service | composition cost per request | low | accept | Bounded by `puzzles_per_session` (CHECK caps at 50) index-backed candidate queries plus at most that many PGN replays. Below the `high` block threshold | closed |
| T-189-16 | Elevation of Privilege | `record_solve` / `reveal_for_puzzle` | high | mitigate | Both resolve the row with `user_id` from `current_active_user` in the WHERE clause (`train_repository.py:864/880/1000`); a foreign `session_id` returns 404, covered by `test_solve_foreign_session_404` (`tests/routers/test_train.py:947`) and `test_reveal_foreign_session_404` (line 1098) | closed |
| T-189-17 | Information Disclosure | reveal before attempt | high | mitigate | `solved_at IS NULL` short-circuits to `"not_attempted"` → 409 with no answer-key fields in the body (`train_repository.py:978`); asserted by `test_reveal_409_before_attempt` (`tests/routers/test_train.py:1025`) | closed |
| T-189-18 | Tampering | client-asserted `correct_move` | medium | accept | Client-side grading is the settled design (SEED-037); v1 has no leaderboard or competitive integrity, so a self-inflicted false verdict harms only that user's own schedule. `correct_guess` is NOT client-assertable (P-02). Below the `high` block threshold | closed |
| T-189-19 | Tampering | double-submit inflating a streak | medium | mitigate | The claiming UPDATE carries `DrillSolve.solved_at.is_(None)` (`train_repository.py:881`); a zero-rowcount claim (`claim_result.rowcount == 1`, line 891) returns the stored result without a second `apply_result`, proven by `test_concurrent_solve_advances_streak_once` (`tests/routers/test_train.py:899`) | closed |
| T-189-20 | Denial of Service | unresolvable timezone poisoning due dates | medium | mitigate | Pydantic `@field_validator("timezone")` constructs `ZoneInfo` at the boundary and raises → 422 on `ZoneInfoNotFoundError`/`ValueError` (`app/schemas/train.py:141–154`); `local_today` (`app/services/train_scheduler.py:59`) is the single conversion site and falls back to UTC rather than raising on a legacy bad value | closed |
| T-189-21 | Input Validation | malformed `position` / `session_id` / `played_move` | low | mitigate | Int-typed path params auto-422 before the handler runs; `played_move: str = Field(min_length=4, max_length=5)` (`app/schemas/train.py:75`) | closed |
| T-189-06-01 | Denial of Service | `pool_entry_stmt` / `due_stmt` predicate on `missed_pv_lines` | medium | mitigate | `answer_key_present` (`app/services/train_pool.py:190`) uses only TOTAL operators — `IS NOT NULL`, `jsonb_typeof(...) = 'array'`, `<> '[]'::jsonb` — deliberately never `jsonb_array_length`, since Postgres does not guarantee AND-clause evaluation order and a `null::jsonb` scalar would otherwise 500 session composition. Wired into both `pool_entry_stmt` and `due_stmt`; mutation-tested by the verifier | closed |
| T-189-06-02 | Information Disclosure | pre-attempt puzzle payload | low | accept | Excluding rows can only shrink the served set; `TrainPuzzle` stays the closed 5-field schema and no new column is read into any response. Below the `high` block threshold | closed |
| T-189-06-03 | Tampering / Elevation of Privilege | user scoping of the modified queries | low | accept | `GameFlaw.user_id == user_id` and `Game.user_id == user_id` are untouched; `user_id` remains keyword-only and sourced from `current_active_user`. The added clause filters a column of an already user-scoped row and can only narrow the result set. Below the `high` block threshold | closed |
| T-189-SC | Tampering | dependency supply chain (plans 01–06) | low | accept | Zero packages installed anywhere in this phase — `pyproject.toml` and `uv.lock` untouched, no `npm`/`pip`/`cargo`/`uv add`. Stdlib `zoneinfo`/`datetime` plus already-installed SQLAlchemy/Alembic/FastAPI only (189-RESEARCH.md Package Legitimacy Audit: not applicable). Below the `high` block threshold | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-189-01 | T-189-05 | PGN-replay cost per composition request is bounded by the `puzzles_per_session` CHECK (≤ 50) over already-stored PGNs; parse failures drop the puzzle rather than failing the request | Adrian Imfeld | 2026-07-25 |
| AR-189-02 | T-189-08 | Guest-purge targeting relies on the pre-existing WR-01 in-transaction eligibility re-check, which this phase does not modify | Adrian Imfeld | 2026-07-25 |
| AR-189-03 | T-189-15 | Composition cost is bounded by the same ≤ 50 CHECK over index-backed candidate queries | Adrian Imfeld | 2026-07-25 |
| AR-189-04 | T-189-18 | Client-side grading is the settled v1 design (SEED-037). No leaderboard or competitive integrity exists, so a self-asserted `correct_move` harms only that user's own drill schedule. `correct_guess` remains non-client-assertable (P-02) | Adrian Imfeld | 2026-07-25 |
| AR-189-05 | T-189-06-02 | The 189-06 predicate can only shrink the served set; the pre-attempt schema is unchanged | Adrian Imfeld | 2026-07-25 |
| AR-189-06 | T-189-06-03 | The 189-06 predicate filters within an already user-scoped row and cannot widen the result set | Adrian Imfeld | 2026-07-25 |
| AR-189-07 | T-189-SC | Phase 189 installs zero dependencies; no package-legitimacy checkpoint applies | Adrian Imfeld | 2026-07-25 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-25 | 25 | 25 | 0 | /gsd-secure-phase (L1 register-verification, orchestrator) |

**Method:** ASVS L1 grep-depth verification of a plan-time-authored register
(`register_authored_at_plan_time: true`), per the secure-phase short-circuit rule. Each
`mitigate` threat was confirmed against the implementation by direct file/line evidence
(recorded in the Mitigation column); each `accept` threat is recorded in the Accepted Risks
Log above. No new-threat scan was performed — that is out of scope for a plan-time register
at L1. Backend suite green at audit time: 3770 passed, 18 skipped.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-25
