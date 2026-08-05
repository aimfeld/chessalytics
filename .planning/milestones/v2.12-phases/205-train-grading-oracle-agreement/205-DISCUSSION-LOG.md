# Phase 205: Train Grading Oracle Agreement - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-04
**Phase:** 205-train-grading-oracle-agreement
**Areas discussed:** Scope & sequencing, Dead-band reach, How much of eval 2 we trust
**Areas offered but not selected:** Band shape & width (0.05/0.15 thresholds, boundary inclusivity, the 0.05-over-0.025 buffer) — recorded in CONTEXT.md D-11 as inherited from SEED-137 unchallenged.

---

## Scope & sequencing

### Q1 — Does the dead band (Proposal A) ship in this phase, and how is it sequenced against Proposal B?

| Option | Description | Selected |
|--------|-------------|----------|
| Both, B first as wave 1 | B is wave 1 (small, frontend-only, fixes the reported bug, no DB reach); A is wave 2, blocked on B. One phase, two waves, matching how Phase 204 was cut. | ✓ |
| B alone; A becomes its own phase | Ship the free-play seed only; the band's 12% cost, multi-surface enforcement and viability re-measurement become a separate phase gated on B's observed effect. | |
| Both, single wave | A and B are independent (frontend vs backend, no shared files), so plan them as parallel plans in one wave. | |

**User's choice:** Both, B first as wave 1.
**Notes:** Resolves ROADMAP success criterion 3's conditional ("if the dead band ships") to yes.

### Q2 — What does the success-criterion-5 viability re-measurement gate?

| Option | Description | Selected |
|--------|-------------|----------|
| Hard gate with a pre-declared threshold | Declare the acceptable newly-starved-user count BEFORE re-measuring; if exceeded, wave 2 does not ship as specified. Same pre-declared-gate discipline Phase 197 used for LEAF-01. | |
| Measure and record, ship regardless | The band ships either way; the measurement makes the cost a documented number rather than a discovery. | ✓ |
| Per-user fallback instead of a global gate | Ship unconditionally, but relax the band for any specific user who cannot fill a session. | |

**User's choice:** Measure and record, ship regardless.
**Notes:** The per-user fallback was noted as reintroducing exactly the kind of conditional grading surface this phase exists to remove.

### Q3 — What happens to `classify_puzzle_type`'s two degenerate paths under the band?

| Option | Description | Selected |
|--------|-------------|----------|
| Keep `su == ""` sharp, exclude unreadable | A forced move has an effectively infinite gap so it passes the sharp side by construction; an unreadable blob cannot be adjudicated and is excluded. | |
| Keep `su == ""` sharp, keep unreadable soft | Only the measurable `[0.05, 0.15)` window is excluded; both degenerate paths keep today's behavior. | |
| Exclude both | Any item whose second-best gap cannot be computed is excluded, including forced-move positions. | ✓ |

**User's choice:** Exclude both — free-text: *"If there's only one legal move, it's hardly a puzzle, is it? I think both should be excluded"*.
**Notes:** Claude added a reinforcing fact after the answer: node 0 describes the pre-flaw position, so a position with exactly one legal move cannot produce a blunder at all — those rows are a data artifact and excluding them should cost ~nothing. Planning is to confirm the prod count rather than assume it.

### Q4 — Proposal B: what happens when the first freely played move is not one of the top-4 mount ranks?

| Option | Description | Selected |
|--------|-------------|----------|
| Rank match only; unranked falls through | Mount-rank moves grade from that rank line; unranked moves keep today's seeded-`esBefore` / fresh-`esAfter` path. The seam survives only for moves that are never on the "Also fine" list. | ✓ |
| Also grade unranked moves off the grading engine | Run the width-1 after-move search on the grading engine so both sides always come from evaluator 2. Closes the root seam completely. | |
| Suppress the badge for unranked root moves | Only badge the root ply on a rank match. Never contradicts anything, but produces a visibly inconsistent surface. | |

**User's choice:** Rank match only; unranked falls through.
**Notes:** Option 2 was noted as coupling free play to the session-scoped grading Worker that Phase 200 deliberately kept separate.

---

## Dead-band reach

Claude read the code before framing this area and reported the concrete surface list: `pool_entry_stmt` (`train_pool.py:402`), compose's `due_stmt` (`train_repository.py:1478`), `get_waiting_puzzle_count`'s `due_count_stmt` (`:967`), and `load_session_puzzles` (`:1216`), noting that `_pool_state` derives from the first three and needs no edit.

### Q1 — Which of those surfaces enforce the dead band?

| Option | Description | Selected |
|--------|-------------|----------|
| All three predicate sites, shared helper | A `band_qualified(...)` predicate next to `answer_key_present`, applied at all three. Follows the precedent the `:1495` comment already sets and keeps the nav badge honest. | ✓ |
| Entry + compose only; leave the count alone | The count's own docstring calls it an UPPER BOUND that already over-counts, so drift is tolerated there. Two edits instead of three. | |
| `pool_entry_stmt` only | Band new entries only; existing rows age out naturally. Contradicts success criteria 3 and 4. | |

**User's choice:** All three predicate sites, shared helper.

### Q2 — What happens to a banded item already inside an open session?

**The user asked to clarify before answering.** Their question: *"In case we Serve it out — no mid-session eviction: will a new session still contain items we want to evict? It's fine if these items are still in already set up train sessions for the current day. But I'd like to avoid including them in newly generated train sessions."*

Claude verified against the code and answered: yes, option 1 gives exactly that with no extra mechanism — composition always builds a fresh `DrillSession` from the two banded predicates, there is no top-up path (`_resume_session` only returns the existing session), and `expires_on` + inclusive `is_session_expired` + `expire_stale_sessions` close the window at the user's next scheduled day. The question was then recorded as answered rather than re-asked.

| Option | Description | Selected |
|--------|-------------|----------|
| Serve it out — no mid-session eviction | Match today's precedent; the band takes effect from the next composition. | ✓ |
| Evict at serve time too | Add the band check to `load_session_puzzles`. Strictly satisfies criterion 3 with no carve-out, but serves fewer puzzles than the frozen `puzzle_count` promises. | |
| Discard and recompose the open session | Clean state, but destroys in-progress solves and needs a new one-shot discard trigger. | |

**User's choice:** Serve it out — no mid-session eviction (via the clarification above).
**Notes:** The user's line is drawn at **composition**, not at serve. If a later change lets an open-session window outlive the current day, that violates the stated intent even if the code still passes.

### Q3 — What should a user starved by the band see?

| Option | Description | Selected |
|--------|-------------|----------|
| `"exhausted"` — accept it as-is | No new state. The distinction between "no blunders left" and "no adjudicable blunders left" isn't actionable, and the band is meant to be invisible. | ✓ |
| Add a distinct banded/withheld state | A fourth `_pool_state` value plus a frontend branch and copy explaining search noise. | |
| Keep `"exhausted"` but log the banded count | No UI change; add a metric so the cost is observable in prod. | |

**User's choice:** `"exhausted"` — accept it as-is.

---

## How much of eval 2 we trust

Claude reported two grounding facts before framing this area: sharp puzzles already draw zero alternatives (`TRAIN_SHARP_ALT_MOVE_ARROWS = 0`), so the "Also fine" row appears only on soft/herring puzzles; and `deriveFineMoves` admits inaccuracy-quality ranks which `toDisplayQuality` collapses to green.

### Q1 — Residual 3: the "Also fine" row's unverified ranks 3–4

| Option | Description | Selected |
|--------|-------------|----------|
| Cap soft alternatives to 1 | `TRAIN_SOFT_ALT_MOVE_ARROWS` 3 → 1: show as many alternatives as the server verified. One constant, no API change — but it caps the count, not the identity. | |
| Leave at 3 — accept as browser-grade | After Proposal B those ranks grade consistently in free play, so the visible contradiction is gone even if the advice is browser-grade. Keeps the reveal informative. | ✓ |
| Send the server's `su` and show that | Truly server-authoritative, but a new API field, and residual 2 means "Best move" is still evaluator 2's — the row would mix authorities. | |

**User's choice:** Leave at 3 — accept as browser-grade.

### Q2 — Residual 1: widen the mount MultiPV?

Claude surfaced a measured fact first: the mount splits 1500ms across all lines, and Phase 195's measurement found raising the movetime to 2500ms did **not** remove the ES noise.

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit non-goal | Record it as deliberately out of scope with the reasoning attached: widening makes each line shallower, and more time doesn't buy stability. | ✓ |
| Widen to 6 at the same budget | Narrows the seam; unmeasured, and plausibly adds more noise than coverage. | |
| Widen AND raise the mount budget | Closes the seam without trading depth, but lengthens the "Checking your move…" wait on every puzzle. | |

**User's choice:** Explicit non-goal.

---

## Claude's Discretion

Items Claude resolved and stated rather than spending a turn on. All were surfaced to the user before the context was written; none were overridden.

- **`trainRevealCache` compatibility with Proposal B** (CONTEXT.md D-10) — graceful fallback: an entry written by the old bundle validates fine but carries no `lines`, and that restored reveal keeps today's free-play behavior. No cache-key bump, no new nested shape check. Justified against the module's own docstring ("not a license to deep-validate every field") and the fact that a stale entry renders *unfixed*, not *wrong* — unlike the SEED-119 case that motivated the one existing nested check.
- **SQL vs Python placement of the band predicate** — reported as a finding, not escalated: `get_waiting_puzzle_count`'s pure-SQL count cannot be Python-filtered without materializing the set, so SQL is effectively forced for a consistent predicate across all three sites.
- **Mover color for the band comparison** — derived from ply parity (as `_classify_solve_puzzle_type` already does), not from `Game.user_color`, so `due_count_stmt` need not re-add the `Game` join it deliberately drops.
- **Requirement ID minting** (`ORACLE-` prefix, defined in the phase's first PLAN.md) and the test/mutation-test structure for criterion 6 — left to planning.

Claude also established two facts during the discussion that removed questions rather than answering them:

- **Red herrings are structurally out of scope** — they carry `puzzle_type = "herring"`, never sharp/soft, and are sourced from `herring_pool`'s own MultiPV-5 ladder with an `INACCURACY_DROP` gate. There is no second-best gap to band.
- **`_pool_state` needs no edit** — it derives entirely from `waiting_count` and `_material_flags`, both already banded by the `pool_entry_stmt` change.

## Deferred Ideas

- **Residual 2 — the server cannot name its own best move.** No `bu` key in node 0, so "Best move" is always evaluator 2's rank 1. An eval-pipeline change; already a ROADMAP non-goal. Worth its own seed if it is ever to be closed.
- **SEED-130 — clearing the browser Stockfish TT between positions.** Same family, different surface; it is what forces the wider 0.05 buffer. Remains dormant.
- **Widening the mount MultiPV.** Closed as a non-goal with reasoning (Q2 above), not merely unaddressed. Reopening needs its own width-vs-depth measurement at a fixed budget.

### Reviewed Todos (not folded)

Three todos matched `todo.match-phase 205` on keyword overlap only. All reviewed, none folded, none presented to the user as a question:

- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` (score 0.9) — invalid Tailwind class on a chart Y-axis label; matched on "score"/"label".
- `172-deferred-review-findings.md` (score 0.6) — Phase 172 review carryover, unrelated domain.
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` (score 0.6) — position-storage idea, unrelated domain.
