# Phase 199: Bot re-calibration sweep + strength curve refit - Pattern Map

**Mapped:** 2026-07-31
**Files analyzed:** 4 (this phase creates very little code — see RESEARCH.md's scope note)
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `scripts/calibration-harness.mjs` (modified: `RAW_LEDGER_COLUMNS` + `playCellAnchorGames`) | utility (game-loop instrumentation) | streaming/CRUD-append | itself — the diff is additive to existing code (see RESEARCH.md Code Examples, already exact) | exact (self-analog, no external copy needed) |
| new Python script — D-03 pooled-shift/parity verdict (`scripts/calibration_parity_check.py` suggested name) | utility (statistical transform) | batch/transform | `scripts/calibration_anchor_fit.py` (`combine_preset_g_preset`, lines 669-700) for the pooling math; `scripts/calibration_persona_fit.py` for the file/CLI/self-test skeleton | exact (math) + role-match (skeleton) |
| new run.log parser → derived timing baseline (`scripts/parse_calibration_timing_baseline.py` suggested name) | utility (file I/O, parse) | file-I/O/transform | `scripts/calibration_anchor_fit.py`'s stdlib-only + `argparse` + `Path(__file__).resolve().parent.parent` header convention; no direct log-parsing analog exists — pattern the shape, not the parsing logic | role-match (no exact parsing analog in repo) |
| new `.check.mjs` for D-08 ledger schema | test | request-response (black-box function calls) | `scripts/lib/calibration-game-loop.check.mjs` | exact |
| new report `reports/bot-parity-199/report.md` (or similar slug) | config/docs | — | `reports/grading-ladder/report.md` (Phase 195) | exact |

## Pattern Assignments

### `scripts/calibration-harness.mjs` (modify in place)

**Analog:** itself. RESEARCH.md's "Code Examples" section already contains the exact diff — do not
re-derive it. Three touch points, in this order:

1. **`RAW_LEDGER_COLUMNS`** (currently lines 1185-1205) — append `elapsed_ms`, `mean_move_ms` at the
   END of the list (never insert mid-list — `parsePriorLedgerRow`'s by-name getters and the
   `--resume` header-position check both depend on stable ordering of the untouched columns):
   ```javascript
   const RAW_LEDGER_COLUMNS = [
     /* ...unchanged 19 columns... */
     'maia_agree',
     'elapsed_ms',     // NEW (D-08): total wall-clock ms for the WHOLE game, all plies/both movers
     'mean_move_ms',   // NEW (D-08): mean wall-clock ms per BOT-ONLY move (search cost)
   ];
   ```

2. **`playCellAnchorGames`** (currently lines 1276-1320) — the `onPly` callback already fires per ply
   with `p.moveMs`/`p.mover`; today it only `console.log`s. Add accumulators and thread them into
   `ledgerWriter.writeRow`:
   ```javascript
   let elapsedMs = 0;
   let botMoveMsSum = 0;
   let botMoveCount = 0;
   const result = await playGame({
     /* ...unchanged... */
     onPly: (p) => {
       console.log(`[calibration-harness]   ply ${p.ply} (${p.mover}) ${p.uci} took ${(p.moveMs / 1000).toFixed(2)}s`);
       elapsedMs += p.moveMs;
       if (p.mover === 'bot') { botMoveMsSum += p.moveMs; botMoveCount++; }
     },
     style,
   });
   // ...
   ledgerWriter.writeRow({
     /* ...unchanged fields... */
     elapsedMs: Math.round(elapsedMs),
     meanMoveMs: botMoveCount > 0 ? botMoveMsSum / botMoveCount : null,
   });
   ```

3. **`parsePriorLedgerRow`** (lines 1409-1439) — matching getters for `--resume` reconstruction:
   `elapsedMs: int('elapsed_ms')`, `meanMoveMs: Number.parseFloat(get('mean_move_ms'))`.

**Do NOT** thread these into `foldGameIntoCellAnchor`/`buildCellAggregateRows`/`mainTsvColumns` (the
`-cells.tsv` near-free-metrics plumbing) — RESEARCH.md's explicit recommendation is ledger-only for
this phase; compute per-cell means with a standalone script reading the raw ledger directly instead
of threading a new accumulator through machinery built for ACPL/blunder/agreement.

**Error handling:** none needed — this is a pure accumulation, no new failure mode. The existing
`--resume` header-position check (unchanged code) will correctly refuse a pre-D-08 ledger; that's
by design (Pitfall 1 in RESEARCH.md), not a new bug to guard against.

---

### New: D-03 pooled-shift / parity-verdict script

**Analog for the math:** `scripts/calibration_anchor_fit.py:669-700` (`combine_preset_g_preset`).
**Analog for the file shape/CLI/self-test convention:** `scripts/calibration_persona_fit.py`.

**Module header pattern to copy** (docstring conventions — stdlib-only note, Sentry-exemption note,
usage examples up top):
```python
"""calibration_parity_check.py — Phase 199 (D-03) before/after pooled-shift parity verdict.

stdlib-only (`argparse`/`json`/`math`/`sys`) — no numpy/scipy, matching
`calibration_anchor_fit.py`'s convention. Standalone research tool (`scripts/`, not `app/`) — no
Sentry capture (CLAUDE.md Sentry rules apply to `app/services`/`app/routers` only).

Usage (fixture self-test):
    uv run python scripts/calibration_parity_check.py --self-test

Usage (real verdict):
    uv run python scripts/calibration_parity_check.py \\
        --old-json reports/data/bot-curves-internal-scale.json \\
        --new-cells-tsv reports/data/sweep-199-<cell>/...-cells.tsv \\
        --out-json reports/data/bot-parity-199-verdict.json
"""
```

**SE-from-CI-width + inverse-variance pooling (reuse verbatim, do not re-derive):**
```python
# Source: scripts/calibration_anchor_fit.py:83-85, 669-700 — mirror, do not re-derive
NORMAL_95_Z = 1.959963985

def _se_from_ci(ci_lo: float, ci_hi: float) -> float:
    return (ci_hi - ci_lo) / (2.0 * NORMAL_95_Z)

# Per-cell, per-family shift + pooled combination:
# shift = rating_new - rating_old
# se_shift = math.hypot(se_new, se_old)
# weight = 1.0 / (se_shift * se_shift)
# pooled = sum(weight * shift for ...) / sum(weight for ...)
```

**Critical constraint (D-03):** compute and report `rating_vs_maia` and `rating_vs_sf` pooled shifts
COMPLETELY SEPARATELY — never combine into one number before the threshold check, mirroring
`fit_all_bot_cells`'s "never merge" discipline already enforced elsewhere in the pipeline.

**`--self-test` convention to copy** (`calibration_persona_fit.py:349-421`): a small hardcoded
fixture (NOT real data) proving the wiring — feed synthetic old/new (rating, ci_lo, ci_hi) tuples
where the true pooled shift is known by construction, assert the computed pooled shift lands in the
expected band, assert an out-of-band single-cell input trips the "shape guard" FAILS branch, and
assert a bogus/malformed input fails loud (mirroring the `<24-persona TSV must fail loud>` pattern
at lines 398-419). Print `"OK: calibration_parity_check self-test passed."` on success.

**argparse block to copy the shape of** (`calibration_persona_fit.py:424-460`): `--self-test` as an
early-return branch before any real-file argument is required, `default=` constants for paths,
one `main(argv: list[str] | None = None) -> None` entry point, `if __name__ == "__main__": main()`.

**Validation approach:** manual fail-loud `raise ValueError(...)` checks (not Pydantic — this is
`scripts/`, not `app/`), matching `_preset_for_blend`'s pattern of raising on an unrecognized input
rather than silently defaulting.

**Pre-registration note for the plan:** the exact threshold numbers (±50 SF / refine Maia toward
±85 per RESEARCH.md Pattern 2) must be literal constants in this script, written BEFORE the sweep
runs and never edited after — encode them as named module-level constants (e.g.
`PARITY_THRESHOLD_SF_ELO = 50.0`, `PARITY_THRESHOLD_MAIA_ELO = 85.0`), not CLI flags, so there is no
accidental post-hoc edit path.

---

### New: pre-195 run.log timing-baseline parser

**Analog for conventions only (no direct parsing analog exists in the repo):**
`scripts/calibration_anchor_fit.py`'s header shape (`from __future__ import annotations`,
`_REPO_ROOT = Path(__file__).resolve().parent.parent`, stdlib-only, `argparse` with defaults).

**What it must do (from RESEARCH.md, A-02 amendment):**
- Parse `reports/data/sweep-{human,light,deep}/run.log` and
  `reports/data/persona-sweep-{grinder-1600,wall-1800}/run.log` ONLY (NOT the two root-level
  `calibration-fullgrid-run.log`/`calibration-blend0-run.log` — retired `maia900`/`{0,0.5,1}` anchor
  scale, Pitfall 3).
- The per-ply line format to match (verbatim from the harness's own `console.log`, so the parser's
  regex should target this exact shape):
  ```
  [calibration-harness]   ply 3 (bot) b1c3 took 3.73s
  ```
  Regex sketch: `^\[calibration-harness\]\s+ply\s+(\d+)\s+\((bot|anchor)\)\s+\S+\s+took\s+([\d.]+)s$`
- Sum/mean per target cell (the log has no `bot_elo`/`bot_blend` markers inline — cell boundaries
  must be inferred from the run's structure, e.g. cross-referencing against the committed raw ledger
  TSV in the same out-dir which DOES carry `bot_elo`/`bot_blend`/`game_index` per row, joining on
  ply-count position). Read `reports/data/sweep-human/calibration-harness-2026-07-19T21-13-45-244Z.tsv`
  (or the light/deep sibling) to establish that join.
- Emit a small derived artifact under `reports/data/` — **JSON or TSV, KB-scale, NOT the ~17.5 MB
  raw logs** (A-02's explicit constraint). Follow the existing derived-artifact convention: a flat
  JSON object or TSV with one row per cell, carrying `git_sha` provenance the same way ledger rows
  do (`git_sha` is read via `subprocess` elsewhere in this codebase — grep
  `scripts/calibration_persona_fit.py` for its `subprocess` import, used for exactly this).
- Suggested output path: `reports/data/bot-parity-199-timing-baseline.json` (or `.tsv` — Claude's
  discretion per CONTEXT.md's ledger-column-naming discretion note extends naturally here).

**Do NOT** `git add -f` the raw `run.log` files themselves unless the plan explicitly decides to
resolve RESEARCH.md's Open Question 2 that way — the default per A-02 is: parse locally, commit only
the derived output, and record the fidelity limit ("if local logs are lost, this cannot be
re-derived") in the D-09 report section.

---

### New: `.check.mjs` for the D-08 ledger schema change

**Analog:** `scripts/lib/calibration-game-loop.check.mjs` (full file read — 50-line header + body
pattern below is representative of the whole file).

**Header/shebang/run-instructions block to copy verbatim in shape:**
```javascript
#!/usr/bin/env node
/**
 * calibration-ledger-schema.check.mjs — structural check that D-08's ledger
 * schema change (elapsed_ms/mean_move_ms columns) round-trips through
 * writeRow -> ledgerRowLine -> parsePriorLedgerRow, and that --resume
 * correctly REFUSES a pre-D-08 (19-column) ledger header.
 *
 * Run via: node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-ledger-schema.check.mjs
 */
import assert from 'node:assert/strict';
```

**Import convention:** `resolveFrontendModule` from `./node-engine-providers.mjs` when a real
frontend module (e.g. `chess.js`) is needed; otherwise plain relative imports from the sibling
`.mjs` under test. This check needs `openLedgerWriter`/`ledgerRowLine`/`RAW_LEDGER_COLUMNS`/
`parsePriorLedgerRow`/`readPriorLedgerRows` — **none of these are currently exported**
(`grep -n "^export " scripts/calibration-harness.mjs` returns no ledger-related hits, per
RESEARCH.md). The plan must add `export` to these five names in `calibration-harness.mjs` as part
of this task, not invent a parallel copy.

**Body structure to mirror** (from `calibration-game-loop.check.mjs`'s three-scenario pattern): a
handful of small, named, synthetic scenarios each ending in `assert.ok`/`assert.equal`, no real
engines — e.g. (a) write a synthetic row with the new fields, read it back via
`parsePriorLedgerRow`, assert `elapsedMs`/`meanMoveMs` match; (b) construct a fake pre-D-08 header
(19 columns) and assert `readPriorLedgerRows` throws/refuses it; (c) round-trip a full
`--resume` cycle against a ledger the new code itself wrote and assert it succeeds.

**Invocation convention:** always through `scripts/lib/frontend-alias-hook.mjs` via `--import`, per
every existing `.check.mjs` in this directory — never invoke a `.check.mjs` bare with plain `node`.

---

### New: `reports/bot-parity-199/report.md` (report location/name is Claude's discretion)

**Analog:** `reports/grading-ladder/report.md` (Phase 195) — closest sibling in both recency and
shape (a single-change measurement + written verdict, same as this phase).

**Section structure to mirror** (verified against the actual file):
1. `# <REQ-ID> report — <short title>` + `**Phase:**`/`**Date:**`/`**Contract:**` header block
   pointing at a pre-registered accept-rule/threshold doc (this phase's analog: the D-03 threshold
   constants, committed BEFORE the run per D-03's hard constraint — consider a sibling
   `reports/bot-parity-199/accept-rule.md` mirroring `reports/grading-ladder/accept-rule.md` if the
   plan wants the pre-registration in its own committed file rather than only in code constants).
2. `## Headline` — one or two sentences with the actual verdict number, then an immediate table (not
   prose first) — e.g. this report's `| budget | positions | wall clock ... | agreement |` becomes
   this phase's `| cell | family | pooled shift | threshold | verdict |`.
3. **Explicit "this is NOT X" framing directly under headline** — Phase 195's report opens with "This
   is **not** the aggressive ladder..."; this phase's should open with "This is a **parity check**,
   not a refit" (mirrors D-01), matching CLAUDE.md's Communication Style ("Challenge ideas
   constructively") applied to methodology framing.
4. `## Provenance` — a table of every TSV/JSON that feeds the report, repository-relative paths,
   each row explaining what it is. This phase's provenance table rows: the 5 `-cells.tsv` outputs,
   `bot-curves-internal-scale.json` (comparison target), the timing-baseline derived artifact,
   `persona-calibration.json`. Include the exact CLI invocation used for each cell (RESEARCH.md
   already has all 5, verbatim-copyable).
5. Middle sections keyed by decision ID (Phase 195 used `## D-07 — the warm-hash determinism
   finding` as a section heading) — this phase's analogous sections: `## D-03 — parity verdict`,
   `## D-08 — timing measurement`, `## D-09 — attribution and fidelity record`.
6. `## Limits — what these numbers do and do not say` — closing section, bullet list, each bullet
   naming a specific stated limit rather than a vague caveat. This phase's bullets are largely
   pre-written in CONTEXT.md's D-09 block (SEED-130, the ±50/±85 resolution limit, the blend-0
   16-persona immunity) — copy those three near-verbatim rather than paraphrasing.

**Cross-reference convention:** Phase 195's report explicitly forward-references "Phase 199's
combined recalibration sweep is what measures strength" in its own Limits section — this phase's
report should close that loop by explicitly stating the verdict this forward-reference promised,
and update the stale "combined recalibration sweep" phrase's framing to match the D-01 re-scope
(parity check, not combined sweep) since a future reader may follow that cross-reference.

## Shared Patterns

### stdlib-only Python convention
**Source:** `scripts/calibration_anchor_fit.py`, `scripts/calibration_persona_fit.py` docstrings
**Apply to:** both new Python scripts (parity-verdict, timing-baseline parser)
No numpy/scipy. `argparse` + `json` + `math` + `pathlib.Path` + `dataclasses`/`TypedDict` cover
everything both existing fit scripts need; there is no reason this phase's scripts would need more.

### `--self-test` / `--bootstrap` argparse convention
**Source:** `scripts/calibration_persona_fit.py:424-460`
**Apply to:** the D-03 parity-verdict script (mandatory — it needs a fixture proof before ever being
pointed at real data, per RESEARCH.md's Wave-0 gap list)
`--self-test` is an early-return branch checked before any required real-file argument; prints
`"OK: <module> self-test passed."` on success; uses hardcoded, clearly-fake fixture data with an
inline comment stating it is NOT the real scale/schema.

### `.check.mjs` fixture-self-test convention (the `.mjs`-side analog)
**Source:** `scripts/lib/calibration-game-loop.check.mjs` and 11 siblings in `scripts/lib/`
**Apply to:** the new D-08 ledger-schema check
Always invoked via `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/<name>.check.mjs`;
synthetic/stub engines and movers, never real Stockfish/Maia sessions; `assert`/`assert.equal` from
`node:assert/strict`; module header comment states what invariant is covered and cites the phase/plan
decision ID it verifies.

### Derived-artifact provenance (`git_sha` recording)
**Source:** ledger rows already carry `git_sha` per game (`562bdd84` on the committed cells);
`calibration_persona_fit.py` reads the current sha via `subprocess`.
**Apply to:** the new timing-baseline derived artifact — record the sha the LOCAL run.log files were
captured under (not the current HEAD) plus the sha of the new engine's run, so a reader can tell
which commit each side of the before/after comparison corresponds to.

### Report document structure
**Source:** `reports/grading-ladder/report.md` (see full section breakdown above)
**Apply to:** the phase's single new report file
Header block → Headline (verdict-first, table immediately) → explicit "not X" framing →
Provenance table → per-decision-ID sections → closing Limits bullet list.

## No Analog Found

None — all four new/modified files have a strong analog (see table above). This phase's small
footprint (per the scope note) means an exhaustive "no analog" search was unnecessary; every file in
play sits squarely in an existing, well-established convention in `scripts/`, `scripts/lib/`, or
`reports/`.

## Metadata

**Analog search scope:** `scripts/`, `scripts/lib/`, `reports/` (grading-ladder, root-injection,
continuous-dispatch siblings), `bin/`
**Files scanned:** `scripts/calibration_anchor_fit.py`, `scripts/calibration_persona_fit.py`,
`scripts/calibration-harness.mjs` (via RESEARCH.md's prior full-file read), 12 files under
`scripts/lib/*.check.mjs` (one read in full), `reports/grading-ladder/report.md` (read in full),
`bin/run_bot_curves_sweep.sh`, `bin/run_persona_calibration_sweep.sh`, `bin/preset-supervisor.sh`
(already fully read per RESEARCH.md)
**Pattern extraction date:** 2026-07-31
