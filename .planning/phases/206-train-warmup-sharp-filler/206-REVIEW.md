---
phase: 206-train-warmup-sharp-filler
status: issues_found
depth: standard
files_reviewed: 12
critical: 0
warning: 4
info: 0
reviewed: 2026-08-07
---

# Phase 206 Code Review: Train Warm-Up Sessions & Sharp Filler Pool

## Summary

Reviewed all 12 production source files changed in this phase: the Alembic migration,
`DrillSolve`/`DrillSession` models, the new `app/services/sharp_filler.py` module, the
`compose_and_materialize_session` composition pipeline and its `_select_candidates`/
`_backfill_sharp_fillers`/`_wire_source` helpers in `train_repository.py`, the widened
`train.py` schemas/router, the one-off `scripts/gen_sharp_filler_set.py` authoring tool, the
committed `sharp_filler_puzzles.csv` data file, and the frontend `types/train.ts`,
`TrainReveal.tsx`, `TrainStartScreen.tsx`.

The three-way `DrillSource` branching this phase's own review-focus flags (D-19's four
predicate-rewrite sites, `_wire_source`, `_classify_solve_puzzle_type`, `reveal_for_puzzle`,
`load_session_puzzles`, `_mark_session_complete_if_done`'s SR/herring leniency clauses) was
checked exhaustively against the two-way-assumption failure mode named in the task — no
remaining two-way `if/else`, boolean `is_herring`, or defaulting `.get()` was found; every
site is a genuine three-way branch or raises on an unrecognized member. The
`SHARP_SET_BY_ID`/`pick_sharp_fillers` monkeypatch-by-reference pitfall (`from ... import
SHARP_SET_BY_ID` binding a stale dict reference in `train_repository`'s namespace) was also
already caught and correctly handled by the test suite's `_install_sharp_fixture` helper — not
a bug. Migration upgrade/downgrade symmetry, NOT NULL/server_default ordering, and the
`is_warmup` freeze-on-resume contract are all correct. No hardcoded secrets, no answer-key
leak to `TrainPuzzle`/`SolveRequest`, no lichess `PuzzleId` served pre-attempt, no IDOR gaps in
the new sharp-filler-serving code paths.

Four WARNING-level findings remain — none of them are visible under the phase's own test
suite because each requires either a rare boundary condition (near-total exhaustion of a
208-position pool) or a future violation of a documented-but-unenforced contract
(CSV append-only). None is a BLOCKER: none produces incorrect graded output, a security gap,
or data loss under the phase's actual shipped state.

## Warnings

### WR-01: `_mark_session_complete_if_done`'s SHARP_FILLER guard checks column non-nullity, not existence in `SHARP_SET_BY_ID` — the exact bug class WR-02/SEED-123 already hit twice for herring, unguarded here

**File:** `app/repositories/train_repository.py:2282-2289` (guard clause), compare
`app/repositories/train_repository.py:1220-1227` (`load_session_puzzles`'s SHARP_FILLER skip)
and `app/services/sharp_filler.py` (no queryable table to join against).

**Issue:** For `RED_HERRING`, the completion-check query OUTER JOINs `HerringPool` and tests
`HerringPool.id.isnot(None)` — this verifies the referenced row still *resolves*, which is what
let the SEED-123 fix (a real 2026-07-28 prod incident, 14 stuck sessions) catch a
`herring_pool_id` that pointed at a since-deleted pool row. The comment directly above the
SHARP_FILLER clause calls it "SEED-123 symmetry", but the clause it actually adds is:

```python
or_(
    DrillSolve.source != DrillSource.SHARP_FILLER,
    DrillSolve.sharp_puzzle_id.isnot(None),
),
```

This only checks that a `sharp_puzzle_id` was assigned at all — never that the id still
resolves in the current `SHARP_SET_BY_ID` (there is no table to outer-join against; the
referent is an in-memory dict rebuilt from a committed file, D-10, deliberately with no FK).
`load_session_puzzles` DOES perform the real existence check
(`SHARP_SET_BY_ID.get(solve.sharp_puzzle_id)`, `continue` on `None` — "data file entry missing
(should not happen; committed file is static)"), but `_mark_session_complete_if_done` has no
matching leniency clause for that case.

**Concrete failure scenario:** `app/data/sharp_filler_puzzles.csv` is documented APPEND-ONLY
("never delete a row, since an in-flight `drill_solves` row may reference its puzzle_id" —
`scripts/gen_sharp_filler_set.py`'s `CSV_HEADER_COMMENT`), but nothing enforces that at the
code level — it is a comment, not a CHECK, not a test, not a script guard. If a future
`app/data/sharp_filler_puzzles.csv` edit (a manual fix, a re-run of the authoring script with a
different candidate pool, a rebase mistake) removes or renames a `puzzle_id` that an
in-flight, unsolved session already references: `load_session_puzzles` silently stops serving
that puzzle (correct, matches D-11), but `_mark_session_complete_if_done`'s `remaining` count
still includes it (the DB column is non-NULL), so `remaining` can never reach 0 and the session
is stuck on "resume" forever — reproducing WR-02 and SEED-123's exact stuck-session shape a
third time, this time with no test guarding against it (no test in
`tests/repositories/test_train_repository.py` monkeypatches `SHARP_SET_BY_ID` to simulate a
missing entry against a solve row that references it, unlike the herring-pool-row-deleted test
at `test_completion_ignores_herring_with_missing_pool_row`).

**Fix:** Add a matching leniency clause testing `DrillSolve.sharp_puzzle_id.in_(SHARP_SET_BY_ID)`
(or equivalent) alongside the existing non-null check, so a SHARP_FILLER row whose id no longer
resolves is excluded from `remaining` the same way an orphaned herring is:

```python
or_(
    DrillSolve.source != DrillSource.SHARP_FILLER,
    DrillSolve.sharp_puzzle_id.in_(SHARP_SET_BY_ID.keys()),
),
```

(Requires importing `SHARP_SET_BY_ID` — already imported — and evaluating the `IN` list at
query-build time, which is safe since it is a module-level constant.) Add a mirroring unit test
that monkeypatches `SHARP_SET_BY_ID` to exclude an id a seeded solve row references, and asserts
`_mark_session_complete_if_done` still reaches `remaining == 0`.

---

### WR-02: `pick_sharp_fillers` under-fills near total exhaustion, contradicting the phase's own "a session is always full" claim (F-03/D-05)

**File:** `app/services/sharp_filler.py:153-155` (`pick_sharp_fillers`), called from
`app/repositories/train_repository.py:1666` (`_backfill_sharp_fillers`).

**Issue:**

```python
unserved = [p for p in SHARP_SET if p.puzzle_id not in served_ids]
pool = unserved if unserved else SHARP_SET
return list(pool[:limit])
```

The exhaustion fallback (`unserved if unserved else SHARP_SET`) only triggers when the unserved
set is *literally empty*. When it is small-but-nonzero and smaller than `limit`, the function
returns fewer than `limit` puzzles rather than topping up with repeats from the full set — this
is deliberate (mirrors `herring_stmt`'s identical all-or-nothing exhaustion contract) and is
explicitly unit-tested as the intended behavior
(`tests/services/test_sharp_filler.py::test_excludes_already_served_ids`: 5-item fixture, 2
served, `limit=5` → returns only the 3 unserved items, not 5).

**Concrete failure scenario:** The committed set holds 208 puzzles. CONTEXT.md's own framing
(F-03) states: "with a sharp filler that repeats once exhausted, a session is still always
full" — this is the premise that justifies removing the `'short'` landing state entirely
(D-16). That premise is false at the boundary: for a single heavy warm-up user who has been
served, say, 204 distinct sharp-filler ids and needs 6 more this session, `pick_sharp_fillers`
returns only the 4 remaining unserved ids (not 6), so `_backfill_sharp_fillers` under-fills the
shortfall by 2, and `compose_and_materialize_session` persists
`puzzle_count = requested_count - 2` — the exact "always full" invariant D-16's removal of the
`'short'` state assumed can no longer happen. The impact is benign (the UI shows the true,
smaller `puzzle_count` via the surviving `'warmup'`/`'fresh'` states — no crash, no stuck
session, self-heals the next day once more repeats become servable), but it is a real, provable
gap between the documented design invariant and the shipped behavior, reachable in real usage
given the sharp set is deliberately sized "~a month" (D-12) rather than years.

**Fix:** Either (a) accept the gap and correct F-03's "always full" claim in the CONTEXT/ROADMAP
docs to "full except within the last `n-1` puzzles before a full-set repeat cycle", or (b) make
`pick_sharp_fillers` top up from the full `SHARP_SET` (allowing an intra-call repeat) whenever
`len(unserved) < limit`, not only when it is literally zero — e.g. `unserved + [p for p in
SHARP_SET if p not in unserved][: limit - len(unserved)]` when `0 < len(unserved) < limit`.

---

### WR-03: `_load_sharp_set`'s `side_to_move` parsing silently coerces any unrecognized value to `"black"` instead of validating, contradicting the loader's own documented fail-closed contract

**File:** `app/services/sharp_filler.py:90`

**Issue:**

```python
side_to_move="white" if row["side_to_move"] == "white" else "black",
```

The function's docstring states: "Fails closed (T-206-03): a missing file or a file with zero
data rows raises `RuntimeError` rather than silently yielding an empty set." That fail-closed
posture is real for the file-level cases (`path.exists()`, `if not puzzles`) and for `ply`/
`rating` (`int(...)` raises `ValueError` on a malformed value), but `side_to_move` is the one
field parsed with a silent, unvalidated ternary: any value other than the exact string
`"white"` — a capitalization typo (`"White"`), a stray whitespace, an empty field, a copy-paste
error from a future manual CSV edit — becomes `"black"` with no exception and no log line.

**Concrete failure scenario:** A future direct edit to `app/data/sharp_filler_puzzles.csv`
(bypassing `scripts/gen_sharp_filler_set.py`, which always writes the literal strings
`"white"`/`"black"` from `ply_from_fen`) introduces a row with `side_to_move` misspelled or
blank. `_load_sharp_set` loads it as `"black"` regardless of what the `fen` column actually
says. The committed file's own data-integrity test
(`TestCommittedSharpSetDataIntegrity::test_ply_parity_matches_side_to_move_and_fen`) would catch
this in CI before merge for the *currently committed file*, but the parser itself provides no
defense-in-depth for the next edit — it is the only field in this loader that trades a loud
failure for a silent wrong value, at odds with the module's stated design philosophy.

**Fix:** Validate against the `Literal["white", "black"]` type explicitly and raise
`RuntimeError` (matching the function's existing fail-closed pattern) on anything else:

```python
raw_side = row["side_to_move"]
if raw_side not in ("white", "black"):
    raise RuntimeError(f"Sharp filler row {row['puzzle_id']!r} has invalid side_to_move: {raw_side!r}")
side_to_move: Literal["white", "black"] = raw_side
```

---

### WR-04: `scripts/gen_sharp_filler_set.py` writes the output CSV *before* checking for a per-motif shortfall, so a failed run can overwrite the good committed file with an incomplete one

**File:** `scripts/gen_sharp_filler_set.py:494-532` (`main`)

**Issue:**

```python
short_motifs = _log_result_table(results, args.per_motif_cap)
all_puzzles = [p for result in results.values() for p in result.accepted]
_write_csv(all_puzzles, args.out)          # <-- writes unconditionally

if short_motifs:
    _log("")
    _log(f"FAILED: motif(s) short of --per-motif-cap ({args.per_motif_cap}): {short_motifs}")
    sys.exit(1)                             # <-- fails only after the write
```

`_write_csv` defaults `out_path` to `DEFAULT_OUT_PATH` = the real committed
`app/data/sharp_filler_puzzles.csv` (`scripts/gen_sharp_filler_set.py:98-100`). The script
correctly treats a per-motif shortfall as a hard failure (`sys.exit(1)`, per D-12's "never
silently redistribute a shortfall" requirement), but it performs the write *before* checking
that condition, so the loud failure comes one step too late: the committed file on disk has
already been overwritten with the short/incomplete set.

**Concrete failure scenario:** A future maintainer re-runs this one-off script (its own
docstring documents this as an expected future use: "safe to re-run manually in the future if
the sharp set ever needs regenerating") without `--out` pointed at a scratch path, intending to
raise `PER_MOTIF_CAP` or add a 14th motif. If any motif's raw supply is too thin for the new cap
(exactly the failure mode `_log_result_table`'s `short_motifs` exists to detect, and exactly
what this phase's own RESEARCH Pitfall 4 warns about for `backRankMate`/`sacrifice`/etc.), the
script exits 1 as designed — but by then it has already clobbered the real 208-row committed
file with a short one, and a `git diff`/`git add` step performed without reading the exit code
would stage that regression. This is a one-off authoring tool (not shipped, held to a lower
bar), but the failure mode is a genuine one-line-reorder bug, not a design tradeoff.

**Fix:** Check `short_motifs` before writing, or write to a temp path first and only replace
`args.out` on success:

```python
short_motifs = _log_result_table(results, args.per_motif_cap)
if short_motifs:
    _log("")
    _log(f"FAILED: motif(s) short of --per-motif-cap ({args.per_motif_cap}): {short_motifs}")
    _log("Not writing output file — fix the shortfall and re-run.")
    sys.exit(1)
all_puzzles = [p for result in results.values() for p in result.accepted]
_write_csv(all_puzzles, args.out)
```

---

_Reviewed: 2026-08-07_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
