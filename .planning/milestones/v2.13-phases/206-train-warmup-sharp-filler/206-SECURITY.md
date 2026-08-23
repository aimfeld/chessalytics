---
phase: 206
slug: train-warmup-sharp-filler
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-07
---

# Phase 206 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

Register origin: `register_authored_at_plan_time: true` — all three PLAN files
(`206-01`, `206-02`, `206-03`) carried a `<threat_model>` block authored before execution.
This audit **verifies the mitigations exist**; it does not scan for new threats.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Browser → `POST /api/train/sessions/{id}/solve` | Authenticated user input crosses here | `position`, `guess`, `played_move`, `move_quality` |
| Browser → `GET /api/train/sessions/{id}/puzzles/{position}/reveal` | Authenticated user supplies both path params, untrusted | `session_id`, `position` |
| Browser → `POST /api/train/sessions` | Authenticated user; body carries no fields, user id from `current_active_user.id` | none |
| Server → browser (`TrainSessionResponse.puzzles`) | Pre-attempt payload — anything here is reachable before the user commits to a guess (POOL-10) | puzzle FEN, arriving move, ply |
| Server → browser (`TrainSessionResponse.is_warmup`) | One server-computed boolean; the client branches, never computes | session label |
| Server → `train_settings.pool_eligible_since` | Guarded, monotonic, idempotent write from an ordinary composition request | streak floor date |
| `app/data/sharp_filler_puzzles.csv` → app process | Build/deploy-time input, loaded at import into an immutable module constant | public CC0 puzzle rows |
| `fixtures/tagger/detector_fixture_*.csv` → authoring script | Offline developer-invoked read; never a runtime path | public CC0 fixture rows |
| Local Stockfish binary → authoring script | Developer-machine subprocess, offline only; never invoked by request-serving code | engine evaluations |
| Alembic revision → prod Postgres | Runs automatically on backend container start (`deploy/entrypoint.sh`) | schema DDL |

---

## Threat Register

14 unique threats consolidated across the three plans (`T-206-03` and `T-206-SC` appeared in
more than one plan and are recorded once).

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-206-01 | Tampering | `SolveRequest` / reveal path params | medium | mitigate | `sharp_puzzle_id` is never client-supplied — written by `compose_and_materialize_session`, read-only thereafter. **Verified:** `SolveRequest.model_fields` == `['guess', 'move_quality', 'played_move', 'position']` — no sharp field added. | closed |
| T-206-02 | Information Disclosure | `reveal_for_puzzle`, `record_solve`, `load_session_puzzles` | high | mitigate | Sharp branches sit INSIDE queries already carrying `DrillSolve.user_id == user_id` (T-189-16 IDOR guard); the FEN lookup is an in-memory dict read keyed off an already user-scoped row, adding no join and no query. **Verified:** all three functions carry `DrillSolve.user_id == user_id` in their WHERE clause (`train_repository.py:2690`, `:2410`ff, `:1196`). | closed |
| T-206-07 | Information Disclosure | `TrainPuzzle` / `TrainSessionResponse.puzzles` | high | mitigate | The lichess `PuzzleId` points directly at the published solution and must never appear pre-attempt. **Verified by executable assertion, not grep:** `TrainPuzzle.model_fields` == `['fen', 'game_id', 'last_move_uci', 'ply', 'position', 'side_to_move']` — no identity field, no `motif`. `motif` rides only `PuzzleRevealResponse`, behind the existing `solved_at IS NULL` → 409 gate. | closed |
| T-206-03 | Denial of Service (fail-open degradation) | `app/services/sharp_filler.py` loader | medium | mitigate | A missing or empty data file must not silently yield an empty `SHARP_SET` and degrade composition back to an all-herring session — the exact defect this phase removes. **Verified:** `_load_sharp_set` raises `RuntimeError` on a missing file (`sharp_filler.py:77`) and on zero data rows (`:98`); both paths unit-tested, and `len(SHARP_SET) >= 200` is pinned against the real committed file. | closed |
| T-206-05 | Tampering | Alembic revision on prod | medium | mitigate | The revision widens a CHECK on a table with live prod rows, unattended on container start. **Verified:** explicit `downgrade()` present and the exact inverse of `upgrade()`; the widen is additive (`0,1` ⊂ `0,1,2`) so no existing row can violate it; `upgrade head` → `downgrade -1` → `upgrade head` round-tripped on the dev DB before merge. See operational note OP-01 below. | closed |
| T-206-08 | Tampering | `app/data/sharp_filler_puzzles.csv` | medium | mitigate | Committed to git and reviewed like any other change; no user-writable path touches it and no runtime code writes it. **Verified:** `TestCommittedSharpSetDataIntegrity` runs against the REAL committed file (never a monkeypatched fixture) — an illegal `solution_uci`, out-of-band rating, mate theme, or duplicate id fails CI. | closed |
| T-206-11 | Tampering | `drill_sessions.is_warmup` | medium | mitigate | Never accepted from client input. **Verified:** derived server-side at `train_repository.py:1908` as `is_warmup = len(surviving_sr_keys) == 0`, written once inside the existing composition SAVEPOINT; `_resume_session` reads the stored column and never writes it, so no request path can flip an existing session's label. Mutation-checked (reverting the resume read turns two tests red). | closed |
| T-206-13 | Elevation of Privilege | widened `pool_eligible_since` stamp | medium | mitigate | Streak accrual is user-scoped progress, not an authorization boundary. **Verified:** the write is `WHERE user_id = :user_id AND pool_eligible_since IS NULL` (`train_repository.py:588`) behind an `is not None` early return (`:579`) — monotonic, so it can only move the floor from unset to today, never backwards to inflate a streak. | closed |
| T-206-06 | Repudiation | `drill_solves` | low | accept | See AR-01. | closed |
| T-206-09 | Information Disclosure | committed data file contents | low | accept | See AR-02. | closed |
| T-206-10 | Denial of Service | authoring script's engine pass | low | accept | See AR-03. | closed |
| T-206-12 | Information Disclosure | `TrainSessionResponse.is_warmup` | low | accept | See AR-04. | closed |
| T-206-14 | Denial of Service | `resolveLandingState` | low | accept | See AR-05. | closed |
| T-206-SC | Tampering | supply chain | low | accept | See AR-06. | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above `workflow.security_block_on` (high) count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-206-06 | Solve outcomes are already recorded with `solved_at` and the first-write-wins claim guard. This phase adds a third `DrillSource`, not a new recording path — no new audit requirement. | Adrian Imfeld (at planning) | 2026-08-07 |
| AR-02 | T-206-09 | The committed rows are public CC0 lichess puzzles: FEN, UCI moves, a rating, and theme labels. No user, account, or game data is copied out of the fixtures — nothing user-identifying exists in the file. | Adrian Imfeld (at planning) | 2026-08-07 |
| AR-03 | T-206-10 | The MultiPV-5 authoring pass runs offline on a developer machine. It touches no production Stockfish pool, no production database, and no request path; prod `STOCKFISH_POOL_SIZE` is unaffected. Confirmed at audit: nothing under `app/` imports `scripts/gen_sharp_filler_set.py`. | Adrian Imfeld (at planning) | 2026-08-07 |
| AR-04 | T-206-12 | The boolean reveals only that this user's own session contains no SR items — information they already have, since they are looking at their own puzzles. It carries no cross-user data and no answer-key signal (it says nothing about whether any individual puzzle is critical or several), and every session read is already scoped to `current_active_user.id`. | Adrian Imfeld (at planning) | 2026-08-07 |
| AR-05 | T-206-14 | A pure client function over an already-fetched response. The new branch adds one boolean equality check — no fetch, no loop, no arithmetic. | Adrian Imfeld (at planning) | 2026-08-07 |
| AR-06 | T-206-SC | No npm/pip/cargo install in this phase. Backend imports are stdlib, `python-chess`, SQLAlchemy, `sentry_sdk`, and in-repo `app.*`; frontend uses the already-vendored `lucide-react` (`Dumbbell`) and `date-fns` (`format`/`parseISO`), both already imported on this surface. RESEARCH.md § Package Legitimacy Audit records "N/A — no new external packages"; no `[ASSUMED]`/`[SUS]`/`[SLOP]` package exists, so no legitimacy checkpoint applies. | Adrian Imfeld (at planning) | 2026-08-07 |

---

## Operational Notes

Not threats, but recorded here because they surfaced during mitigation verification and bear on
safe operation.

**OP-01 — the `downgrade()` narrows a CHECK that live rows may violate.**
`downgrade()` restores `ck_drill_solves_source` to `source IN (0, 1)`. That is correct and safe
immediately after deploy, which is what the dev round-trip exercised. Once any user has been
served a sharp filler, `drill_solves` holds `source = 2` rows and the narrowing will fail. A
rollback past this revision on a live database therefore requires deleting or re-sourcing those
rows first. This does not weaken T-206-05 (whose mitigation is "an explicit, tested `downgrade()`
exists", and it does) — it is the ordinary cost of the one-way door the Task 1 checkpoint
confirmed before the migration was written.

**OP-02 — availability findings from `206-REVIEW.md` (WR-01, WR-02).**
The code review raised two robustness gaps with availability flavour, both confirmed and both
judged non-blocking by `206-VERIFICATION.md`: `_mark_session_complete_if_done`'s SHARP_FILLER
clause checks only `sharp_puzzle_id IS NOT NULL` rather than that the id still resolves in
`SHARP_SET_BY_ID` (a session could stick if the CSV's append-only contract were ever violated),
and `pick_sharp_fillers` under-fills when `0 < len(unserved) < limit`. Neither is reachable from
untrusted input — both need a developer to edit the committed data file or a user to exhaust
~206 of 208 puzzles — so neither enters the threat register. They remain open code-quality items.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-07 | 14 | 14 | 0 | Claude (orchestrator, L1 short-circuit) |

Audit method: `register_authored_at_plan_time: true` and `asvs_level: 1`, so the
`secure-phase` short-circuit rule applies — L1 grep-depth verification is sufficient and no
`gsd-security-auditor` subagent was spawned. Each of the 8 `mitigate` threats was verified
against the implementation at the file and line cited in its Mitigation cell, including two
executable assertions over Pydantic `model_fields` (T-206-01, T-206-07) rather than symbol
greps. The 6 `accept` threats were confirmed to carry documented rationale, transcribed into
the Accepted Risks Log above.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-07
