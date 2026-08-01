# Bot re-calibration parity check — accept rule

**Committed:** 2026-07-31, before any Phase 199 sweep game has been played. This
document discharges CONTEXT.md decisions D-01, D-03, D-04, D-05, and amendment
A-04. It is a decision contract, not a narrative: every threshold below is
fixed in advance, derived from the already-committed bootstrap CIs in
`reports/data/bot-curves-internal-scale.json`, and is not editable once the
sweep starts. Its machine-readable twin is
`scripts/calibration_parity_verdict.py`, whose five constants carry these
exact numbers.

## 1. This is a parity check, not a refit (D-01)

Phase 199 answers one question: does the shipped bot still play at roughly
the same strength after Phase 195's grading ladder? It does **not** re-run
the 15-cell curves sweep or the 24-persona sweep, and it does not refit
`bot-strength-lookup.json` or `botStrengthCurves.ts`. Of the five phases that
shipped in this milestone, only Phase 195 (the ladder) is strength-relevant
to bot play — 194 is bit-identical by requirement, 196 never touches bot
play, 197's LEAF-01 was rejected with the mechanism stripped, and 198 was
never built. So this is a single-change gate against a pinned comparison
target, not a from-scratch measurement.

## 2. The five cells and their roles (D-05)

| Cell (`bot_elo`/`bot_blend`) | Preset | Role |
|---|---|---|
| `1100 / 0.00` | Human | **Null control.** `blend <= 0` never calls `mctsSearch` (BOT-02), so the ladder cannot touch this cell at all. It distinguishes "the ladder shifted strength" from "this run is not comparable." |
| `1300 / 0.05` | Light | The real measured non-monotone dip — the most fragile point on any curve. |
| `1900 / 0.05` | Light | Light preset's top end. |
| `1500 / 0.50` | Deep | Deep preset's low end. |
| `2300 / 0.50` | Deep | The cell all four rung-1800 personas share post-retargeting. |

## 3. The three criteria, in evaluation order

Evaluated per anchor family (Maia-argmax rungs, Stockfish skill levels)
**completely separately** — the two families are never averaged or summed
into one number before a threshold check, mirroring
`fit_all_bot_cells`'s never-merge discipline.

1. **Validity gate (evaluated first).** The `1100/0.00` null control's shift
   must not exceed its own family tolerance:
   - Maia family: `|shift| <= NULL_CONTROL_MAX_SHIFT_MAIA_ELO` = **165.0**
   - SF family: `|shift| <= NULL_CONTROL_MAX_SHIFT_SF_ELO` = **149.0**

   If either tolerance is exceeded, the run is not comparable to the
   2026-07-21 committed numbers and the verdict is **VOID** — no parity
   claim is made about the exposed cells regardless of what they show.

2. **Primary — pooled shift over the 4 exposed cells.** Per family, the
   inverse-variance-weighted mean of the four exposed cells' shifts
   (`shift = rating_new - rating_old`, `se_shift = sqrt(se_new^2 + se_old^2)`)
   must fall within:
   - Maia family: `|pooled shift| <= PARITY_POOLED_THRESHOLD_MAIA_ELO` = **85.0**
   - SF family: `|pooled shift| <= PARITY_POOLED_THRESHOLD_SF_ELO` = **50.0**

3. **Shape guard.** Parity FAILS if any single exposed cell's new point
   estimate falls outside its own committed CI **in both families
   simultaneously**. Landing outside the CI in only one family is inside
   run-to-run noise and does not, on its own, fail parity.

Void wins over everything; a shape-guard trip or a pooled-threshold miss (in
either family) fails an otherwise-void-clear run; passing both is HOLDS.

## 4. Derivation (A-04)

Recomputed this session from the committed bootstrap CIs in
`reports/data/bot-curves-internal-scale.json`, not copied from RESEARCH.md.
Formula mirrors `scripts/calibration_anchor_fit.py:83-85` and `:669-700`
(`se = (ci_hi - ci_lo) / (2 * NORMAL_95_Z)`, `weight = 1/se^2`), with
`se_shift = sqrt(se_new^2 + se_old^2) ~= sqrt(2) * se_old` under the
symmetric-uncertainty assumption (the new run has not happened yet; carried
as an open assumption in 199-01-PLAN.md).

| Cell | Role | se maia (old) | se sf (old) | committed CI maia | committed CI sf |
|---|---|---|---|---|---|
| 1100 / 0.00 | null control | 59.7 | 53.6 | [864, 1098] | ±105.0 |
| 1300 / 0.05 | exposed | 46.7 | 42.5 | ±91.5 | ±83.4 |
| 1900 / 0.05 | exposed | 58.8 | 38.0 | ±115.2 | ±74.4 |
| 1500 / 0.50 | exposed | 84.9 | 37.9 | ±166.4 | ±74.2 |
| 2300 / 0.50 | exposed | 75.7 | 27.8 | ±148.4 | ±54.5 |

Pooled over the **4 exposed cells only** (the null control is a validity
gate, never pooled):
- Maia family: `se_pooled = 43.40` -> **95% half-width ±85.1**
- SF family: `se_pooled = 24.86` -> **95% half-width ±48.7**

Single-cell shift resolution for the null control: **±165.3 (Maia)**,
**±148.6 (SF)**.

This confirms RESEARCH.md's refinement and **rejects CONTEXT.md D-03's flat
±50 in both families**: ±50 holds for SF but is materially optimistic for
Maia, whose per-cell CIs are far wider (the 1500/0.5 cell alone is ±166).
Adopting the per-family split is exactly the "refine BEFORE the run"
invitation D-03's discretion note makes.

## 5. Adopted constants (final; not editable after the run starts, per D-03)

| Constant | Value | Meaning |
|---|---|---|
| `NORMAL_95_Z` | `1.959963985` | Mirrored from `calibration_anchor_fit.py:85` |
| `PARITY_POOLED_THRESHOLD_MAIA_ELO` | `85.0` | Parity HOLDS in the Maia family if the inverse-variance-pooled shift across the 4 exposed cells has absolute value at or below this |
| `PARITY_POOLED_THRESHOLD_SF_ELO` | `50.0` | Same, SF family |
| `NULL_CONTROL_MAX_SHIFT_MAIA_ELO` | `165.0` | Validity gate: the blend-0 null control's Maia-family shift must not exceed this |
| `NULL_CONTROL_MAX_SHIFT_SF_ELO` | `149.0` | Same, SF family |

**Correction over D-03's original proposal:** the SF threshold keeps D-03's
flat number (`50.0`); the Maia threshold is widened from D-03's flat `50.0`
to `85.0` because the committed Maia CIs are roughly twice as wide as the SF
CIs at these five cells. Leaving Maia at `50.0` would have produced a
false-fail rate the run cannot support — a threshold tighter than the
measurement's own noise floor is not a stricter standard, it is a coin
flip. A-04 supersedes D-03 on this point; D-03's evaluation order and
null-control-first structure are unchanged.

## 6. What this phase can and cannot claim

Committed per-cell CIs are wide enough (~±110 internal ELO for a single
cell before pooling) that a single cell cannot resolve a shift smaller than
its own CI half-width, and pooling four cells reaches roughly ±50–85
depending on family. **The claim this phase can support is "no systematic
shift larger than ~85 internal ELO in the Maia family and ~50 in the SF
family" — not "unchanged."** Anything finer requires the full 15-cell sweep,
which is out of scope for this phase (D-01).

## 7. On parity failure (D-04 exit branch)

If the verdict is FAILS (or VOID), this phase **stops and reports**. It
delivers the measurement plus a written recommendation. The revert-vs-refit
call is a separate operator decision made with data in hand — this phase
does not auto-revert the ladder and does not escalate into the full 15-cell
refit itself.

## 8. Immutability

The five constants in §5 are fixed as of this commit. They are not CLI
flags, environment variables, or config-file entries, and they are not
editable once the sweep starts — the only legitimate way to change them is
to revise this document (and `scripts/calibration_parity_verdict.py`'s
constants in lockstep) **before** launching a new sweep, which costs a
re-derivation and a re-commit, not a silent edit. The genuine one-way door
is at launch: once a sweep game exists, this contract is read-only for the
duration of that measurement.
