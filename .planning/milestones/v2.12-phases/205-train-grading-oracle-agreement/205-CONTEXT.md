# Phase 205: Train Grading Oracle Agreement - Context

**Gathered:** 2026-08-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Stop a Train puzzle contradicting itself on the surfaces users actually see. Two independent changes, sequenced as two waves:

- **Wave 1 (Proposal B, frontend-only)** — the root ply of free play is graded from the mount search's own rank line instead of a fresh MultiPV-2 search of the post-move position, so playing a move listed in the reveal's "Also fine" row can never be badged worse than that listing claims.
- **Wave 2 (Proposal A, backend)** — a selection-level dead band excludes drill items whose second-best drop sits in `[INACCURACY_DROP, BLUNDER_DROP)` = `[0.05, 0.15)`, enforced live at every SR selection site and never snapshotted onto `drill_items`.

Not in scope: raising `SHARP_GAP_ES` (rejected in SEED-137), a server `bu` best-move key (residual 2, an eval-pipeline change), clearing the browser Stockfish TT (SEED-130), widening the mount MultiPV (D-09), and red-herring puzzles (structurally out — see Code Insights).

</domain>

<decisions>
## Implementation Decisions

### Scope & sequencing

- **D-01:** Both proposals ship in this phase, **B first as wave 1**, A as wave 2 blocked on B landing. B is small, frontend-only, has no DB reach, and fixes the bug actually reported; A touches pool entry and session composition and costs ~12% of pool items. ROADMAP success criterion 3's conditional ("if the dead band ships") resolves to **yes**.

- **D-02:** The success-criterion-5 viability re-measurement is **measure-and-record, not a gate**. The band ships regardless of the fresh number; the measurement exists so the cost is a documented number rather than a discovery. A pre-declared stop threshold was considered and explicitly declined. Planning must still re-run the measurement against current prod (the 2026-08-04 snapshot: 12.0% of items dropped, 219→218 users able to fill a session, 89.7% of distinct games retained) and record the fresh figures in the phase artifacts. — **Reversibility:** reversible — the measurement is a one-off script run; nothing depends on its outcome.

- **D-03:** Both of `classify_puzzle_type`'s degenerate paths are **excluded** from the pool under the band:
  - `su == ""` (no legal second move, currently returned as unconditionally "sharp") — user's reasoning: *"If there's only one legal move, it's hardly a puzzle, is it?"* Reinforcing fact discovered during discussion: node 0 describes the **pre-flaw** position, so a position with exactly one legal move cannot produce a blunder at all — these rows are a data artifact. **Planning must confirm the prod count is negligible rather than assume it.**
  - Unreadable blob (non-dict node 0, or either expected score resolving to None, currently defaulting to `"soft"`) — an item we cannot adjudicate is exactly what the band exists to stop serving. This stops the non-leaking `"soft"` default from doubling as a silent admission path.

  `classify_puzzle_type` itself keeps its current return contract (it is a classifier, never an entry gate, P-04); the exclusion lives in the selection predicate, not in the classifier's defaults.

- **D-04:** Proposal B short-circuits **only on a rank match**. A first freely played move that matches one of the top-4 mount ranks is graded from that rank line (the `rankLineForMove` primitive `gradeMoveInner` already uses). A move outside the mount ranks keeps today's path — seeded `esBefore` from evaluator 2, fresh `esAfter` from the free-play engine. That residual cross-oracle seam is accepted because an unranked move is by construction never on the "Also fine" list, so it cannot produce the reported contradiction. Coupling free play to the session-scoped grading Worker (which Phase 200 deliberately kept separate) and suppressing the badge for unranked moves were both considered and rejected.

### Dead-band reach

- **D-05:** The band is enforced at **all three SR predicate sites**, expressed as a shared predicate helper living next to `answer_key_present` in `app/services/train_pool.py`:
  1. `pool_entry_stmt` (`train_pool.py:402`) — fresh material. Covers compose, the waiting count's untracked-pool arm, and `_material_flags`'s `has_pool_candidates` in one edit, so `_pool_state` follows for free.
  2. `compose_and_materialize_session`'s `due_stmt` (`train_repository.py:1478`) — already-tracked items being re-served.
  3. `get_waiting_puzzle_count`'s `due_count_stmt` (`train_repository.py:967`) — the nav badge, documented as mirroring `due_stmt` "exactly, in COUNT-only form".

  This follows the precedent the existing comment at `train_repository.py:1495` already states: *"the entry gate (`pool_entry_stmt`) and this re-serve scan must apply the same answer-key standard."* Leaving the count unbanded (defensible on its own UPPER-BOUND docstring) was rejected: it would drift the two statements the comments require to mirror, and a user whose whole due set is banded would see a badge for a session that composes empty. — **Reversibility:** reversible — a predicate added at three call sites, no schema change and no stored value.

- **D-06:** **No mid-session eviction.** A banded item already materialized into an open session is served out. `load_session_puzzles` keeps its current eviction set (missing flaw row / missing game / unreconstructable FEN) and does **not** gain a band check.

  User's stated requirement: *"It's fine if these items are still in already set up train sessions for the current day. But I'd like to avoid including them in newly generated train sessions."* Verified during discussion that D-05 already delivers exactly this with no extra mechanism:
  - Composition always builds a **fresh** `DrillSession` from the two banded predicates, so a newly generated session can never contain a banded item.
  - There is **no top-up path** — `_resume_session` only hands back the session that already exists.
  - The exposure window closes on its own: `expires_on` is set by `session_window` at composition, `is_session_expired` is inclusive (`today >= expires_on`), and `expire_stale_sessions` closes the row — so an open banded session cannot outlive the user's next scheduled training day.

  Evicting at serve time was rejected because `puzzle_count` is frozen at composition and the progress UI counts down against that denominator; discard-and-recompose was rejected because it would destroy in-progress solves.

- **D-07:** A user starved by the band still sees **`"exhausted"`**. No fourth `_pool_state` value, and no new metric for the banded count. The distinction between "no blunders left" and "no adjudicable blunders left" is not actionable for the user, and the band is meant to be invisible.

### How much of evaluator 2 we trust

- **D-08:** The "Also fine" row stays at **up to 3 alternatives** (`TRAIN_SOFT_ALT_MOVE_ARROWS = 3`, unchanged). Ranks 3–4 are accepted as browser-grade. Rationale: after Proposal B those ranks at least grade *consistently* in free play (playing rank 4 gets rank 4's own eval), so the visible contradiction is gone even though the advice is not server-verified. Capping to 1 was considered and declined — it would only cap the count, not the identity (evaluator 2's rank 2 may be a different move than the server's `su`), at the cost of a less informative reveal. Sending `su` to the client was rejected: it would mix authorities in the same row, since residual 2 (no `bu` key) means "Best move" is always evaluator 2's.

- **D-09:** Residual 1 is an **explicit non-goal**. The mount search keeps `TRAIN_GRADING_MULTIPV_WIDTH = 4` at `TRAIN_GRADING_MOUNT_MOVETIME_MS = 1500`. Reasoning to carry forward: widening splits the same budget across more lines, so every line gets *shallower*, and Phase 195's own measurement found that raising the movetime to 2500ms did **not** remove the ES noise — so a wider/shallower mount plausibly makes it worse. After the band, an unranked move is ≥0.15 below best on a sharp item, and D-04 already lets unranked root moves fall through.

- **D-10 (Claude's discretion, flagged to the user, not overridden):** `trainRevealCache` serializes the whole `GradeResult` to sessionStorage behind a deliberately shallow shape check (`typeof gradeResult.bestLine === 'object'`). Adding the mount `lines` for the free-play seed means an entry written by the old bundle validates fine but carries no `lines`. **Graceful fallback**: that one restored reveal keeps today's free-play behavior. No cache-key bump and no new nested shape check — the module's docstring states the SEED-119 `move_quality` check "is not a license to deep-validate every field", and unlike that case a stale entry here renders *unfixed*, not *wrong*.

### Inherited, not re-litigated

- **D-11:** The band's shape and width are taken from SEED-137 as-is and were deliberately not reopened: **sharp** requires second-best drop ≥ `BLUNDER_DROP` (0.15), **soft** requires < `INACCURACY_DROP` (0.05), `[0.05, 0.15)` excluded, boundaries as the seed states them. The 0.05 buffer (rather than the measured `ES_STABILITY_TOLERANCE` of 0.025) stands on SEED-130's rationale: the browser never clears the Stockfish TT, so evaluator 2's reading depends on what that worker slot searched before (up to 241 cp / 0.0135 ES mean at depth 14 in this project's own grading-ladder data). `SHARP_GAP_ES = MISTAKE_DROP` stays an identity, not a knob.

### Claude's Discretion

- **The band predicate's SQL vs Python placement.** A finding, not a decision to escalate: `compose_and_materialize_session` already materializes all pool rows and filters in Python (`train_repository.py:1545-1551`), but `get_waiting_puzzle_count` uses `select(func.count()).select_from(pool_subq)` — a pure SQL count that cannot be Python-filtered without materializing the set. **SQL is effectively forced** for a consistent predicate across all three sites. `expected_score_sql` already exists and is used by `pool_entry_stmt` for exactly this kind of JSONB-derived comparison.
- **Mover color for the band comparison.** `classify_puzzle_type` needs a mover color. In the repository it is derived from ply parity (`mover_color_for_ply(solve.ply)`, `train_repository.py:1827`), **not** from `Game.user_color` — so the band predicate does not force `due_count_stmt` to re-add the `Game` join it deliberately drops. Note the CLAUDE.md rule against hand-rolling `ply % 2`: use `player_only_gate`'s convention or an equivalent named helper, never a bare parity expression.
- Requirement IDs (`ORACLE-` prefix) are minted at planning into the phase's first PLAN.md — there is no active `.planning/REQUIREMENTS.md` (v2.11's is archived), same convention as Phase 204.
- Test/mutation-test structure for the two contradiction shapes (criterion 6) is planner territory; the only constraint is the project rule that a gap fix is proven by reverting it and confirming the test goes red, never by symbol presence.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source
- `.planning/seeds/SEED-137-train-grading-oracle-disagreement.md` — the full problem statement: the three-evaluator table, both observed contradictions with their node-0 numbers, prod prevalence, Proposals A and B, the four residuals, and the rejected `SHARP_GAP_ES` raise with its reasoning. **The single most important read for this phase.**
- `.planning/ROADMAP.md` § "Phase 205: Train Grading Oracle Agreement" — goal, scope, the four plan-time decisions (all resolved above), six success criteria, non-goals.

### Related seeds
- `.planning/seeds/SEED-130-browser-grade-nondeterminism-uncleared-stockfish-hash.md` — the uncleared browser Stockfish TT. Same family, different surface; it is the justification for D-11's 0.05 buffer over the measured 0.025 tolerance. Out of scope here.

### Prior-phase context this phase builds on
- `.planning/milestones/v2.9-phases/189-*/` — `pool_entry_stmt`, `classify_puzzle_type`, `SHARP_GAP_ES`, and the D-01/D-02 anchoring rules. Note especially 189-06's `answer_key_present` / `answer_key_pending` split and D-GAP-01.
- `.planning/milestones/v2.9-phases/190*/` — `useTrainGradingEngine`, the MultiPV-4 mount search, the reveal contract, and the 190.1 UAT round 9 rank-match fix that Proposal B generalizes.
- `.planning/milestones/v2.11-phases/200-*/` — `useTrainFreePlay` and its `seedEval` prop; the deliberate separation of the free-play Worker from the session-scoped grading engine (relevant to D-04).

### In-repo rules that constrain this phase
- `CLAUDE.md` § "Database Design Rules", § "Coding Guidelines", § "Critical Constraints" — no magic numbers, `Literal[...]` over bare `str`, `ty` clean, never hand-roll `ply % 2`.
- `app/models/drill_item.py` module docstring — the **D-01/D-02 anchoring rules**: `drill_items` deliberately does NOT FK `game_flaws`, serve-time reads LEFT JOIN and tolerate a missing match (lazy eviction), and grading-critical fields derived from `missed_pv_lines` are **never snapshotted** onto the row. D-05 and D-06 both depend on this.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`rankLineForMove(lines, uci)`** (`frontend/src/hooks/useTrainGradingEngine.ts:300`) — the exact primitive Proposal B needs. `gradeMoveInner` already uses it at `:740` for the solve verdict and `startGameMoveSearch` at `:867` for the PLAYED-IN-GAME box, both with the same "same search as rank 1, so the eval can never invert" rationale.
- **`answer_key_present(col)`** (`app/services/train_pool.py:279`) — the shape and home for D-05's shared band predicate: a total, composable SQLAlchemy boolean applied identically at every selection site.
- **`expected_score_sql` / `expected_score_for`** (`train_pool.py`) — the paired SQL/Python sigmoid, already used by `pool_entry_stmt` and `classify_puzzle_type`. The band must reuse these, never declare a second sigmoid (the existing docstrings warn that a second one risks silent disagreement exactly at the threshold boundary).
- **`classifyLiveSeverity` / `classifyTrainMoveQuality`** — the shared cutoff functions on the frontend. Proposal B must not introduce a new cutoff.

### Established Patterns

- **Lazy eviction, never a write** (`drill_item.py` D-02): a serve-time predicate failure skips the item **for this session only** — status stays ACTIVE, `due_date` is untouched, nothing is deleted — so it resurfaces automatically if a later re-analysis makes it qualify again. The band must follow this exactly (`train_repository.py:1494-1506` is the model comment).
- **Never snapshot grading-critical fields** (`drill_item.py` D-01): the band is read live from `game_flaws` at every selection site. This is what makes success criterion 4 (a reclassification backfill moves an item into the band and it stops being served, with no backfill of its own) true by construction.
- **The count mirrors composition**: `get_waiting_puzzle_count`'s docstring commits its due arm to mirroring `due_stmt`'s eligibility "exactly, in COUNT-only form". D-05 preserves that.
- **Sharp puzzles already draw zero alternatives** (`TRAIN_SHARP_ALT_MOVE_ARROWS = 0`, `frontend/src/lib/trainArrows.ts:87`) — so the "Also fine" row appears only on soft and herring puzzles. This narrows D-08's blast radius considerably.
- **Inaccuracy collapses to good for display** (`toDisplayQuality`, `trainArrows.ts:257`) — a measured inaccuracy is already drawn dark green in the "Also fine" row. Pre-existing, unchanged by this phase, but relevant when reasoning about what that row claims.

### Integration Points

- **Proposal B threading:** `gradeMoveInner` (`useTrainGradingEngine.ts:689`) → a new field on `GradeResult` carrying the mount `lines` → `TrainSolveScreen.tsx:271-281`'s `freePlaySeedEval` (today only `{cp, mate, bestUci}` from `gradeResult.bestLine`) → `useTrainFreePlay`'s `seedEval` prop → the root-ply branch of `currentQuality` (`useTrainFreePlay.ts:256-277`). Note the seam is **`esAfter` only** — `esBefore` at the root is already seeded from evaluator 2 via `evalByFen.get(parentFen)`.
- **Proposal B compatibility:** `frontend/src/lib/trainRevealCache.ts` serializes `GradeResult` — see D-10.
- **Proposal A:** the shared band predicate in `app/services/train_pool.py`, applied at `pool_entry_stmt` (`:402`), `compose_and_materialize_session`'s `due_stmt` (`train_repository.py:1478`), and `get_waiting_puzzle_count`'s `due_count_stmt` (`:967`).

### Structurally out of scope (established during discussion, do not re-derive)

- **Red-herring puzzles carry `puzzle_type = "herring"`** — a third type, never sharp/soft (`app/schemas/train.py:149`, `train_repository.py:1795`). They are sourced from `herring_pool`'s MultiPV-5-vetted ladder with its own `INACCURACY_DROP` query-time gate (`train_pool.py:635`), and there is no second-best-gap comparison to band. The band is an **SR-side** change only.
- **`_pool_state`** (`train_repository.py:1071`) needs no edit — it derives entirely from `waiting_count` and `_material_flags`, both of which D-05 already bands.

</code_context>

<specifics>
## Specific Ideas

- On the degenerate-blob question, the user's own framing was decisive and went further than any option offered: *"If there's only one legal move, it's hardly a puzzle, is it? I think both should be excluded."* Preserve that reading — the exclusion is about **what makes a puzzle**, not only about what the band can measure.
- On mid-session behavior, the user drew the line precisely at composition rather than at serve: *"It's fine if these items are still in already set up train sessions for the current day. But I'd like to avoid including them in newly generated train sessions."* If a later change makes the open-session window outlive the current day, that is a violation of the stated intent even if the code still passes.

</specifics>

<deferred>
## Deferred Ideas

- **Residual 2 — the server cannot name its own best move.** Node 0 keys are `b/bm/s/sm/su` with no best-move UCI, so "Best move: Qc1" is always evaluator 2's rank 1, and on a sharp item the two can name different moves with nothing able to detect it. A `bu` key is an eval-pipeline change, not a Train change. Already a ROADMAP non-goal; worth a seed of its own if it is ever to be closed.
- **SEED-130 — clearing the browser Stockfish TT between positions.** Same family, different surface; it is what forces D-11's wider buffer. Remains a dormant seed.
- **Widening the mount MultiPV (residual 1).** Closed as a non-goal at D-09 with reasoning, not merely unaddressed. Reopening it would need its own measurement of width-vs-depth at a fixed budget, since Phase 195 already showed more movetime alone does not buy stability.

### Reviewed Todos (not folded)

Three pending todos matched `todo.match-phase 205` on keyword overlap only; all reviewed and left in place as false positives:

- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — an invalid Tailwind class on a chart's Score Y-axis label. Matched on "score"/"label"; unrelated to Train grading.
- `172-deferred-review-findings.md` — Phase 172 review carryover, unrelated domain.
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — a position-storage idea, unrelated domain.

</deferred>

---

*Phase: 205-train-grading-oracle-agreement*
*Context gathered: 2026-08-04*
