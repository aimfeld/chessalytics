# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

> Note: v1.18, v1.19, v1.20, v1.23, v1.25, v1.27, and v2.1–v2.5 closes did not add retrospective sections (only the ROADMAP archives + MILESTONES entries were written). Not backfilled here to avoid reconstructing reflections after the fact; their facts live in the corresponding `milestones/vX.Y-ROADMAP.md` and `MILESTONES.md`.

## Milestone: v2.11 — Train Solve Surface & Push Reminders

**Shipped:** 2026-08-03 (tagged v2.11; **not deployed at close** — `production` remains at v2.10)
**Phases:** 4 (200, 201, 202, 203) | **Plans:** 14 | **Tasks:** 38
**Timeline:** 2026-08-01 → 2026-08-03 (11 squash-merged commits on `main`, 102 non-planning files, +14,039 / −467 since `v2.10`)

### What Was Built

The Train solve screen learned to explain itself, and Train grew a habit loop that reaches the user off-site.

Phase 200 (SEED-131) made the reveal sidebar the board's own legend — per-move arrow glyphs in exact board colors, a hover/tap spotlight that strips the board down to one move, `inaccuracy` recolored to green so yellow left the reveal board, and an "Also fine" row — then made the shared board branchable after the verdict with a free-play sideline on its own Stockfish instance. Phase 201 (SEED-132 A) built VAPID-signed `aes128gcm` Web Push over `httpx.AsyncClient` plus a 15-minute lifespan tick that reminds only on scheduled, not-yet-trained days. Phase 202 (SEED-132 A) spent the one-shot browser permission behind a deliberate score-screen press, with Settings as the permanent recovery surface. Phase 203 (SEED-134) reversed the milestone's own opening decision and shipped the install layer: a 14-day / 3-attempt cooldown replacing a permanent dismissal veto, a five-state device-aware reminder slot, and the desktop→phone QR handoff.

### What Worked

- **Seed-driven planning with zero project-level research.** All four phases came from `/gsd-explore` seeds carrying locked decisions, named rejected alternatives, and per-file anchors. Three days from milestone start to close, and no phase needed a research pass to re-derive what the seed already settled.
- **Writing the "do not re-derive" premises into REQUIREMENTS.md up front.** Web Push has no vendor and no per-message cost; iOS is the only platform where install gates push; `injectManifest` must never replace the hand-tuned `generateSW` block. These were the exact claims most likely to get relitigated mid-phase, and pinning them cost a paragraph.
- **Reversing a milestone-start decision when the evidence changed.** v2.11 opened by deferring SEED-132 Phase B on a BrowserStack dependency. Two phases in it was obvious that a reminder landing on a desktop at 18:00 is queued past the moment it existed to create, so Phase 203 was added mid-milestone rather than shipping a loop that structurally could not close.
- **Executing the real service worker in tests.** `push-sw.js` cannot be imported normally, so its focus-or-open and collapse-without-renotify contracts are pinned by running the actual file through `node:vm`. That is the only reason those handlers are covered at all.

### What Was Inefficient

- **Two load-bearing defects survived a fully green test suite and were caught only by code review.** The Android install offer was dead code: `beforeinstallprompt` is one-shot, each hook instance captured it privately, so any late-mounting consumer never saw it. And `useTrainSettings` mounted app-wide with no `enabled` gate, 403ing for every guest on every route.
- **Three UAT rounds on Phase 203 to converge on one placement rule.** Three separate locked UI decisions (203 D-13, D-15, 202 D-03) were each deviated from in live UAT before the actual invariant surfaced: the score-screen row only ever holds a pressable control, everything else renders below it. That invariant was discoverable on a real screen and not from the spec.
- **Phase 200 needed 10 UAT fix rounds.** The legend and exploration work is dense visual behavior on a shared board, and jsdom cannot observe any of it — no layout engine, no real tap targets, no composited color.
- **Stale requirement checkboxes reached milestone close.** LEGEND-06 and EXPLORE-07 still read unchecked despite Phase 200's 375px browser UAT passing 3/3 the day before. Closing the UAT did not write back to REQUIREMENTS.md.

### Patterns Established

- **A one-shot browser event belongs in a module-level singleton, never in hook state.** If the event can fire before any consumer mounts, per-instance capture is a race the tests will not see. The regression test must fire the event *before* mounting.
- **Every app-wide `useQuery` needs an `enabled` gate keyed to auth state.** This is the second occurrence of the same Sentry-noise pattern (T-191-21). Mounting a query globally means it runs on every route for every visitor class, including the ones that will always 403.
- **Prove a gap fix by reverting it.** Both Phase 203 defects were confirmed fixed by removing the fix and watching the new test fail. Symbol presence is not evidence.
- **Ship an unverifiable branch fail-safe rather than deferring it.** The iOS path had no test device, so it is written to degrade to nothing on any unrecognized state, with `push_subscriptions` rows serving as the passive signal after deploy.

### Key Lessons

- **A green suite is evidence about the code you wrote, not about the code paths that exist.** Both Phase 203 defects were invisible to tests, types, lint, and knip, because each was a missing invariant rather than a wrong statement. Code review is the only gate that caught either.
- **UI placement decisions locked in planning are guesses until a real screen contradicts them.** Three were deviated from in one phase. The cheaper posture is to plan the constraint (what the row is *for*) rather than the layout.
- **Closing a human UAT is not the same as closing the requirement.** The write-back step has no automation behind it, so a passing UAT can leave its requirement reading unfinished for days.

### Cost Observations

- Four phases, 14 plans, 11 commits over 3 days — the leanest full-product milestone since v2.5, and the first to add an off-site surface (push) to the product.
- Phase 203 alone carried 5 code-review findings and 3 UAT rounds for 4 plans: the install layer's cost was concentrated almost entirely in verification, not implementation.
- One new backend dependency (`webpush`) and one new table (`push_subscriptions`); the rest of the reminder path reuses `train_scheduler`'s existing predicates and the existing settings round-trip.
- Closed `override_closeout` on artifacts only: all four phases verified `passed`, all 46 requirements Complete, all three source seeds closed, with 31 cross-milestone carryover items acknowledged as deferred.
- Closed **without deploying** at the operator's call, so v2.11's user-facing value is tagged but not yet live.

---

## Milestone: v2.9 — Train — Spaced-Repetition Blunder Drills

**Shipped:** 2026-07-30 (deployed to production incrementally through releases #286–#290)
**Phases:** 6 (189, 190, 190.1, 191, 192, 193) | **Plans:** 31
**Timeline:** 2026-07-24 → 2026-07-30 (107 commits, 309 files, +68,178 / −2,386 since `v2.8`)

### What Was Built

The first milestone that changes what FlawChess *is*: an import-gated `/train` page re-presents the user's own blunders as spaced-repetition puzzles until the patterns stick.

- **Pool + scheduler backend (189, SEED-037)** — four CASCADE-FK tables, a pure streak-keyed interval ladder (0 → next session / 1 → ~3d / 2 → ~10d; FSRS rejected as unjustifiable for this corpus), pool entry gated on the user's own out-of-book blunders with a complete stored answer key, a sharp-vs-avoid-the-blunder blob classifier, exactly-N session composition, and solve/reveal/settings endpoints — with **zero server-side grading** by design.
- **Train page + solve loop (190)** — the full session end to end: nav on all three surfaces, six landing states, binary position read → single-move attempt graded entirely in-browser on the already-vendored Stockfish WASM at a *measured* movetime budget, auto-opening reveal, opt-in tactic stepper, resume, score screen.
- **Reveal redesign (190.1)** — every arrow, line, and eval on the reveal sourced from one MultiPV-4 client search, so no two displayed numbers can contradict the verdict.
- **Schedule + progress surface (191)** — auto-saving weekday/session-size pickers, numeric waiting-count nav badge, honest mastered/parked counts, reduced-motion-safe celebrations, tailored cold/exhausted states.
- **Red-herring position pool (192, SEED-120)** — a globally shared, phase-balanced, MultiPV-5-confirmed `herring_pool` whose raw ladder is stored so qualifiers apply at query time, plus the `drill_solves.game_id` `SET NULL` one-way door letting a herring outlive its source game.
- **Session-tick streak with a depletable shield (193, SEED-121)** — one day-judging state machine replacing the weekly-fulfillment check, `required_sessions_per_week`, and the 3-rung flame ladder.

### What Worked

- **Building the backend first, against nothing.** Phase 189 shipped a complete, tested API surface with no frontend at all, so Phase 190 spent its budget on the solve-loop UX rather than on discovering endpoint shape.
- **Blocking human UAT gates as the last plan of a phase.** Both Phases 190 and 191 ended on an explicit human checkpoint, and both earned it: 190's found three real defects (a 21–27s pool-query planner pathology fixed by a LATERAL rewrite, 22s → 40ms; a React-StrictMode-triggered indefinite grading hang; a resume dead-click), 191's found five. None were reachable from jsdom or pytest.
- **One-search-per-surface as a reusable correctness principle.** v2.0 Phase 158 established it for `/analysis` (one UCI-keyed eval lookup); 190.1 applied the same move to Train's reveal. Both times it converted "keep the numbers consistent" from a discipline into a structural property.
- **The verifier independently mutation-testing the highest-risk claim.** Phase 193's verifier didn't take the SUMMARY's word that the settle-before-layer guard was load-bearing: it removed the call, watched the test genuinely fail, and restored it. That is the standard the project already learned to demand, actually met.
- **Building the dev clock instead of waiting.** Train's behavior is calendar-shaped, so Phase 191's gate produced `dev_clock.py` + `TrainDevClock` + `reset_train_state.py` as a side effect — turning a multi-day verification problem into a one-sitting one, inert outside development.

### What Was Inefficient

- **A design defect shipped, then needed a whole phase to undo.** Phase 189's red herrings came from non-gem `game_best_moves` rows on the assumption that "not a gem" implies "several fine moves". It does not. Catching this required Phase 192 — a new table, a MultiPV-5 generator, a nullability migration on a table holding live user results, and five plans. The assumption was stated plainly in the seed and never tested against a real position before being built on.
- **A just-shipped mechanism was replaced two days later.** Phase 191 delivered the weekly streak (including a D-18 settlement snapshot and a 3-rung flame ladder); Phase 193 deleted all of it. This was cheap *only* because streaks had never reached production — verified against `origin/production` before planning. Had v2.9 shipped weekly, the same realization would have cost a data migration.
- **The empty-array sentinel bypass needed a gap-closure plan.** Phase 189's answer-key gate used `IS NOT NULL`, which admits the eval pipeline's `[]` "no lines" sentinel. Verification caught it; plan 189-06 fixed it with named total-operator predicates. The pipeline's sentinel convention was already known (`project_asyncpg_jsonb_null_vs_sql_null` records a close cousin) and should have been front-of-mind at plan time.
- **Phase 193's UAT sat unresolved for two days.** Its verification landed `human_needed` on 2026-07-28 with three genuinely browser-only checks, and nothing consumed them until the milestone close asked. Verification that ends in a queue nobody drains is a gate in name only.

### Patterns Established

- **Grade on the client when the engine is already there.** The vendored Stockfish WASM made server-side grading unnecessary, which in turn let the pre-attempt payload be built to contain neither the answer key nor the puzzle-type ground truth — a security property that fell out of a performance decision.
- **Store the raw measurement, gate at query time.** `herring_pool` keeps the full MultiPV-5 ladder on the row so both qualifier constants and the degenerate-position rule are retunable without re-analysis. The same shape as v2.4's `maia_prob` float (never a boolean) and v1.30's stored blobs driving `retag_flaws.py`.
- **Pin deferred constants from a measurement, not a guess.** 192-01 shipped `HERRING_LOOSE_BAND_ES` marked `PROVISIONAL`; 192-03 measured ~900 real candidates, set both constants from the histogram, then grep-asserted `PROVISIONAL` was gone.
- **Time-dependent endpoints take `now_utc` from a dependency**, never `datetime.now()` inline — the precondition that makes the dev clock work at all.
- **Opposite treatment for structurally-different orphans.** After `SET NULL`, an orphaned SR item must not pin a session open (the v2.9 stuck-session bug) while an orphaned herring must be skippable; the planner deliberately contradicted RESEARCH.md's assumption here and specified both together.

### Key Lessons

1. **Test the load-bearing assumption against one real row before building on it.** "Non-gem means several fine moves" was checkable in minutes and cost a five-plan phase instead.
2. **A phase that replaces a just-shipped mechanism is cheap only while the mechanism is unshipped** — check `origin/production` first, as Phase 193 did, and treat the answer as the deciding input rather than a footnote.
3. **Human-verification items need an owner and a due point**, not just an honest flag. Three UAT checks sat in `human_needed` until a milestone close happened to ask about them.
4. **When one search can source every displayed number, make it.** Twice now (v2.0 Phase 158, v2.9 Phase 190.1) the fix for "these numbers disagree" was structural, not a reconciliation pass.
5. **Known pipeline sentinels belong in the plan's pitfalls section.** The `[]` `missed_pv_lines` convention was already documented in project memory and still shipped a bypass.
6. **Insert the UAT-driven phase rather than patching in place.** 190.1 as its own numbered phase kept the redesign planned, reviewed, and archived; folding it into 190 as fixes would have hidden a real scope change.

### Cost Observations

- Six phases, 31 plans, 107 commits over 6 days — the densest milestone since v1.17, and the first since v2.0 to add a top-level product surface.
- Two of the six phases (190.1, 192) were corrections rather than planned scope, and a third (193) replaced a phase from the same milestone. Roughly a third of the plan budget went to fixing decisions made inside this milestone.
- Zero new runtime dependencies on either stack — Train runs on the already-vendored Stockfish WASM, the existing `game_flaws` archive, and one new table.
- Closed `override_closeout` on artifacts only: all six phases verified `passed`, with 31 cross-milestone carryover items (19 of them the long-known stale quick-task audit miscount) acknowledged as deferred.

---

## Milestone: v2.6 — Bot Strength Calibration

**Shipped:** 2026-07-21 (dev-only; no production deploy — nothing reads the artifact yet)
**Phases:** 3 (173, 180, 181) | **Plans:** 10
**Timeline:** 2026-07-15 → 2026-07-21, spanning v2.4 and v2.5 (173 and 180 ran as standalone post-v2.3 addendum phases and were regrouped under this milestone on 2026-07-19; 181 was added 2026-07-21 once the sweep landed)

### What Was Built

A measurement milestone, not a feature milestone: the bot's three play-style presets were placed on a strength scale derived end to end without a single human game.

- **Internal anchor scale (173, SEED-101)** — `scripts/calibration-anchor-ladder.mjs` round-robins all 10 anchors (Maia-argmax rungs 700–2300 + Stockfish skills 0/3/5/8/10, cross-family games included) under a probe→measure schedule with a connectivity guard and a resumable ledger; a stdlib Bradley-Terry fit (`scripts/calibration_anchor_fit.py`) places them on one common scale published as `INTERNAL_RATING`. Headline: the Maia-3 argmax ladder is **~2.8x compressed** relative to its nominal ELO labels, worst at the top.
- **Three-preset strength curves (180, SEED-102)** — an engine-free two-pass bot-cell scheduler windows anchors by *measured* internal rating rather than nominal `bot_elo`; a single-parameter pinned-anchor MLE (`fit_bot_cell_rating`) yields per-cell `rating_vs_maia`/`rating_vs_sf` with CIs plus the cross-family style-inflation gap `G_preset`. 15 measured cells over a 5×3 grid, with near-free per-game quality metrics and a byte-identical `--resume`.
- **Shipping lookup (181, SEED-104)** — hand-rolled PAVA isotonic regression per preset, pooled-`G` + `BLITZ_OFFSET_C = 40` conversion to approximate blitz ELO, lowest-`bot_elo`-wins inversion into 100-step lookups. Emits `reports/data/bot-strength-lookup.json` + generated `frontend/src/generated/botStrengthCurves.ts`, both CI drift-checked, plus 7 off-grid confirmation-cell predictions with inverse-variance-pooled 95% CI bands.

### What Worked

- **Building the measuring stick before measuring.** Phase 173 existed purely to answer "is the anchor ladder's own scale trustworthy?" — and the answer (no, ~2.8x compressed) invalidated the premise every earlier calibration attempt had run on. Ordering the scale phase ahead of the sweep phase is why 180's numbers mean anything.
- **The measured scale caught a real bug the nominal scale hid.** 180's scheduler windows anchors by `INTERNAL_RATING`; doing so exposed that the 2026-07-12 run had been clamped by nominal-scale anchor selection. A correctness bug surfaced by changing the unit, not by reading the code.
- **Refusing to smooth away inconvenient data.** Light's raw curve is non-monotone (a real dip at bot_elo 1300). PAVA pools it into a plateau; a spline would have interpolated it into a clean line that claims strength the measurements don't support. The lowest-`bot_elo`-wins inversion rule follows the same instinct: never claim a higher setting buys strength it doesn't.
- **Engine-free logic gates before engine-hours.** Both 180 and 181 put the expensive machinery behind pure-logic modules with `node --test` / pytest coverage, so an ~18–22h sweep was never the thing that discovered a scheduler bug.
- **Sibling generators importing, never re-implementing.** 181's confirmation-cell script imports Plan 01's PAVA fit rather than duplicating it, with an acceptance check that greps for the *absence* of a re-implemented `def isotonic_fit(`.

### What Was Inefficient

- **A multi-hour sweep was crashed repeatedly by a five-line bug.** Both blend>0 presets died every ~8.5–9h with an onnxruntime-web "memory access out of bounds" — undisposed ORT tensors leaking the wasm linear heap. The workaround (`bin/preset-supervisor.sh`, a resume-on-crash supervisor) was built and run before the root cause was found. The actual fix, applied at this milestone's close as quick 260721-sgb, is a `try`/`finally` with `dispose?.()`.
- **Milestone boundaries were assigned retroactively.** 173 and 180 ran as standalone addendum phases attached to v2.3/v2.4, then were regrouped into v2.6 on 2026-07-19, and 181 was added two days later. The work was coherent; the planning record only caught up afterward, and the archival CLI still could not see Phase 173 (its directory had already been archived under `v2.3-phases/`), forcing a `--force` close.
- **The measured outcome was well below the seed's expectation, and only the sweep could reveal it.** SEED-102 anticipated a ~2600 ceiling; Deep actually plateaus at ~1950–1970 internal (~1800 approx-blitz). Nothing was wasted, but a full milestone was spent to learn that the current ladder cannot reach the strength the product wants — now captured as SEED-114.
- **The validating run is still outstanding.** The inversion's 7 off-grid confirmation cells are committed with runbook commands and a pass criterion, but the overnight run is deferred operator HUMAN-UAT. The artifact ships unconfirmed off-grid.

### Patterns Established

- **Calibrate the scale before measuring on it** — when the anchors are themselves models, treat their nominal labels as an unverified hypothesis and fit a scale first.
- **Pure-logic scheduler modules with engine-free check suites** in front of any multi-hour engine run, so the expensive step never discovers a logic bug.
- **Monotone fits over smooth fits for measured strength** — PAVA plateaus plus lowest-setting-wins inversion, so a flat region is reported as flat instead of interpolated into a promise.
- **Sibling `gen_*.py` scripts import each other's public functions**, acceptance-gated by grepping for the absence of a duplicated definition.
- **Ship measured ranges with the disclaimer attached to the artifact**, not to the reader's memory: the generated TS carries the approximate-ELO caveat and CI bands.

### Key Lessons

1. When your measuring instrument is a model, calibrate it first — the ~2.8x compression finding retroactively explains every earlier calibration that "looked wrong".
2. Chase the crash to root cause before building a supervisor around it. A resume-on-crash wrapper for a 9-hour leak cost more than the five-line `dispose?.()` that fixed it.
3. A monotone fit is an honesty mechanism, not just a smoothing choice — it is how "we measured a plateau" survives contact with a chart.
4. Regrouping standalone phases into a milestone after the fact works for the narrative but not for the tooling: the archival CLI counts phases by directory, so already-archived phases read as unstarted.
5. A milestone whose deliverable is a number can legitimately conclude "the number is worse than we hoped" — the value is that the ceiling is now measured rather than assumed.

### Cost Observations

- Three phases, 10 plans, 35 files (+4,248 / −126) across the 180+181 span. Zero new runtime dependencies, no schema, no migration, no API surface, no deploy.
- The dominant cost was wall-clock engine time, not tokens: a ~18–22h three-preset sweep plus the Phase 173 anchor round-robin, run by the operator outside the planning loop, with resume-from-ledger doing the heavy lifting after each crash.
- Closed as `override_closeout`: no milestone audit (seed-driven, no mapped requirements) and 35 deferred artifact items — mostly stale quick-task summaries from the May/June era rather than unfinished work.

---

## Milestone: v2.0 — FlawChess Engine

**Shipped:** 2026-07-09 (deployed to production incrementally during the milestone across releases #247, #248, #249)
**Phases:** 9 (153–161) | **Plans:** 24 | **Tasks:** ~51
**Timeline:** 5 days (2026-07-05 → 2026-07-09) | ~69 commits since v1.32, 215 files (+35,171 / −2,068)

### What Was Built

A client-side practical-play analysis engine on `/analysis` (SEED-082, + SEED-085/087/088): a Maia-prior-weighted expectimax-in-MCTS search over a device-adaptive 2–4-instance Stockfish.wasm worker pool plus a dedicated Maia policy worker, ranking the strongest *human-playable* line for a player at their rating with an objective/practical score pair per line. It runs entirely in the browser — zero server load, no persistence, no new dependencies.

- **Pure search core (153)** — a frozen `SearchRunner`/`EngineProviders` contract, a root-relative leaf-sigmoid wrapper over the app's own `evalToExpectedScore`, and the one genuinely novel file of the milestone (`backup.ts`: Maia-prior-weighted expectation at inner nodes, root-max at the root), plus a depth-limited expectimax fallback implementing the same interface. All proven against fabricated providers before any WASM/ONNX existed.
- **Real providers (154)** — a lazily-spawned, priority-queued, pv[0]-keyed, abortable Stockfish worker pool (`workerPool.ts`) and a deduped narrow-ELO-batched Maia policy queue (`maiaQueue.ts`), including two rounds of promise-hang/deadlock lifecycle gap closure (CR-01…CR-03, WR-03).
- **Live UI (155–156)** — the `useFlawChessEngine` anytime hook (immediate first paint, 150ms throttled refinement, abort+stopAll on every FEN navigation), the `FlawChessEngineLines` score-pair card, three independent accent-tinted engine toggles, eval-bar precedence, and concentric board arrows (amber practical move vs blue objective move).
- **Agreement verdict (157)** — a pure aligned/safe/sharp classifier and plain-language prose verdict comparing FlawChess's practical #1 against Stockfish's objective #1, with hoverable click-to-play move spans, wired once into the shared card for automatic game-review parity.
- **Eval reconciliation (158)** — a single UCI-keyed eval lookup (authoritative free MultiPV run first, one shared `searchmoves` grading run second) so every number shown on two+ surfaces (SF card, FC card, Maia chart/quality bar, verdict) renders identically by construction; also fixed a real UCI bug (`searchmoves` must be the last clause or trailing `movetime` is silently dropped).
- **Findability + play style (159)** — a root-move findability factor (`min(1, P_you/P_ref)·V(X)`) so a ~5%-findable tail move can no longer top the list, a Maia-probability gate on the "far easier to find" verdict copy, and a log-symmetric "Play style" policy-temperature slider (Sharper ↔ More human).
- **Layout polish (160–161)** — an artifact-free ad-hoc `/gsd-quick`+`/gsd-fast` UI-polish bucket (160), then a viewport-locked `100dvh` `grid-cols-[360px_1fr_360px]` responsive `/analysis` layout with a height-aware board (SEED-088, 161).

### What Worked

- **Pure core first, real providers second.** The one novel algorithm (the Maia-prior-weighted expectimax backup rule + asymmetric self+opponent ELO routing) was proven correct in Phase 153 against *fabricated* providers — a hand-computed 0.637 fixture plus two negative-assertion baselines that make the "silently degenerates into textbook MCTS" failure mode structurally testable — before a single WASM or ONNX byte was integrated. By the time real workers arrived (154), the hard math was settled; integration was routine.
- **One frozen interface, two search implementations.** `mctsSearch` and the depth-limited `fallbackExpectimax` implement an identical `SearchRunner` contract and reuse `backup.ts`/`leafScore.ts`/`select.ts` verbatim; the fallback was proven by a same-variable swap-in test (SC5), so the escape hatch is real and exercised, not aspirational.
- **Reconcile-by-construction over reconcile-by-discipline.** Routing every displayed eval through one UCI-keyed lookup (158) made the "FC pick grades higher than the objective best" misread *impossible to render*, rather than something reviewers must keep noticing — the same by-construction instinct that paid off in v1.31's golden-snapshot refactor.
- **Reusing the app's own primitives.** Leaf scoring wraps `evalToExpectedScore`, move grading reuses `liveFlaw.ts`/`flawThresholds.ts`, the verdict scores on the app-wide win%-drop scale — no new sigmoids or thresholds to calibrate, and the engine's coloring stays consistent with game analysis elsewhere.
- **Structural gap-closure discipline.** Every worker lifecycle defect (CR-01/02/03, WR-03) was *reproduced* before being fixed, so "no `grade()`/`policy()` promise can hang forever" is a tested invariant rather than a hope.

### What Was Inefficient

- **Scope drifted past the plan and the ROADMAP header lagged.** The milestone was planned as 153–159 but grew to include an ad-hoc UI-polish bucket (160, artifact-free) and a SEED-088 responsive-layout phase (161); the ROADMAP header still read "153–159" until milestone close. The 160 bucket left no SUMMARY/VERIFICATION trail — its work is only recoverable from git, not the planning record.
- **Live-browser UAT deferred in bulk to close.** The irreducibly-visual/latency gates for 155/156/157/158/159/161 (perceptual smoothness, arrow rendering, hover-arrow isolation, streaming eval reconciliation, real-device memory ceiling, `100dvh` layout) were all routed to human review and only signed off at milestone close — 155's real-device check was itself carried forward from 154. jsdom proved every *mechanism*, but the *experience* rode on one batched manual pass. Phase 161 landed at 3/7 truths verifiable structurally, the rest browser-only.
- **A known transient reconciliation artifact shipped.** 158's `qualityBySan` fallback for an unresolvable SAN (`{evalCp: null}`) resolves to 0.5 via the sigmoid, which can briefly paint a real severity color off a fabricated even-position score in the stale-map window right after navigation (158-REVIEW WR-04) — narrow, does not affect steady state, but a real edge left in.

### Patterns Established

- **Prove the novel core against fabricated providers before real integration** — settle the algorithm with hand-computed fixtures and negative-assertion baselines while the expensive/uncertain infrastructure (WASM pool, ONNX worker) is still stubbed. Turns a scary integration into execution.
- **A frozen `SearchRunner`-style interface with a real fallback behind it** — a primary and a degraded implementation of the same contract, the fallback kept exercised by a same-variable swap-in test, not left to rot.
- **Reconcile-by-construction via a single keyed lookup** — when the same quantity surfaces on N cards, route them all through one lookup with explicit source precedence so divergence is unrenderable, rather than asserting equality after the fact.
- **Reproduce-then-fix for async lifecycle defects** — every worker promise-hang was reproduced before the fix, making non-hang a tested invariant.

### Key Lessons

1. De-risk the genuinely novel algorithm first, in isolation, against fake providers with negative-assertion tests — the WASM/ONNX plumbing is the easy part once the math is pinned.
2. Reconcile shared numbers by construction (one keyed lookup with precedence), not by reviewer vigilance — the same move on two cards should be *incapable* of showing two evals.
3. Batch-deferring every visual/latency gate to milestone close is a real risk concentration: a UI-heavy milestone should schedule at least one mid-flight live-browser pass, not carry six phases of perceptual sign-off to the end.
4. When a milestone grows past its planned phase range, update the ROADMAP header as the phases land — and give ad-hoc `/gsd-quick` polish buckets at least a thin artifact, or the work vanishes from the planning record.

### Cost Observations

- Five days, 9 phases, 24 plans; the largest single-milestone diff to date (+35,171 / −2,068 across 215 files) — but the bulk is vendored WASM/ONNX assets, generated types, and planning docs, not hand-written logic. Zero new runtime dependencies, no schema, no migration, no server load.
- Heavy, unavoidable reliance on human live-UAT for the irreducibly-visual and real-device-timing gates — jsdom + fake timers proved every mechanism but none of the experience.
- Shipped to production incrementally during the milestone (releases #247–#249) rather than in a single deploy at close — the milestone-close bookkeeping (archive, tag, GitHub release) trailed the actual production ship.

---

## Milestone: v1.32 — Maia-3 Human-Move Enrichment

**Shipped:** 2026-07-05 (merged to `main`; prod deploy pending)
**Phases:** 2 (151, 151.1) | **Plans:** 10

### What Was Built

Maia-3, a human move-prediction engine, added as a second in-browser engine on `/analysis`: onnxruntime-web inference of the unmodified, version-pinned `maia3_simplified.onnx` in a lazy Web Worker with our own MIT board→tensor/ELO/softmax glue, rendering a per-ELO "Moves by Rating" chart + a Maia WDL eval bar on the LEFT of the board (Stockfish on the RIGHT), both live per navigation with zero server round-trip and nothing persisted. Phase 151.1 (SEED-083) recolored the chart lines by Stockfish move quality on FlawChess's own expected-score-drop thresholds and replaced the fixed top-6 cap with the Maia cumulative-probability ≥ 0.95 ∪ {SF-best} set, graded by a *second, fully isolated* Stockfish WASM worker doing one `searchmoves`+MultiPV root search. The repo relicensed MIT → AGPL-3.0 with a visible attribution notice. One read-only backend field (`current_rating`); no schema, no migration.

### What Worked

- **Spike-first de-risking.** Feasibility (client-side AGPL bundling, tensor I/O contract, `searchmoves`+MultiPV on the vendored WASM) was settled by spikes 004–006 and a throwaway Plan-01 real-binary probe *before* any production code — so the two phases were mostly execution, not discovery. The multipv-reordering "landmine" (grade cache must key on pv[0]'s SAN, never the multipv index) was caught in the probe and encoded in a MockWorker test harness.
- **Reusing FlawChess's own primitives.** 151.1 graded moves through the existing `liveFlaw.ts`/`flawThresholds.ts` expected-score bands rather than importing maiachess's 3-class scheme — the chart's coloring is consistent with game analysis / live-flaw coloring elsewhere in the app, with no new thresholds to calibrate.
- **Structural isolation over shared state.** The grading engine is a wholly separate Web Worker instance that never reads the primary eval-bar engine; git history confirms it never touched `useStockfishEngine.ts`. That made "does it disturb the eval bar / engine card?" answerable by inspection.

### What Was Inefficient

- **MAIA-06 latency never measured.** The requirement called for a per-device board-response budget, but no numeric target was ever defined and no cold-load/per-position timings were recorded — the model-size decision (D-10) rests on a qualitative "felt responsive" sign-off. REQUIREMENTS.md initially marked MAIA-06 an unconditional "Complete," which the verifier flagged as overstating delivery; it closed `passed_with_override`. Lesson: if a requirement names a measurable target, define the number at plan time or explicitly downgrade the clause — don't let "felt fine" silently satisfy a metric.
- **Policy-vocab reconstruction was best-effort.** The 4352-entry Maia policy vocabulary was reconstructed (base + underpromotion lanes) rather than verified against CSSLab's literal index order until the VALID-01 live move-label check — a late, manual gate for something that could have been cross-checked mechanically against the reference client earlier.

### Patterns Established

- **Client-side ML engine in a lazy Web Worker** (onnxruntime-web + MIT glue, route-level `React.lazy` so it never enters the initial bundle) — a reusable shape for future in-browser models (SEED-082).
- **Second isolated grading worker** alongside the primary engine, with a pv[0]-keyed per-FEN cache — reusable whenever a surface needs engine evals without perturbing the main analysis engine.
- **Demote-to-seed at close** — a not-started phase (152) with its requirements captured verbatim into a seed (SEED-084), keeping the shipped milestone honest rather than carrying dead scope.

### Key Lessons

- De-risk the genuinely uncertain thing with a throwaway spike/probe and bake its findings into a test — it turns a scary integration into routine execution.
- A "measured and acceptable" acceptance clause needs a number defined up front, or it degrades into an unfalsifiable vibe check.
- Reuse the product's own thresholds/tokens for anything user-facing before importing an external reference's scheme.

### Cost Observations

- Two tightly-scoped browser-only phases over ~2 days; the bulk of the diff is the vendored model + WASM assets + planning docs (real code ~7.4k lines across 56 files).
- Heavy reliance on human live-UAT for the two irreducibly-visual/latency gates (calibration eyeball, per-device latency) — jsdom can't cover them.

---

## Milestone: v1.31 — Pipeline Consolidation

**Completed:** 2026-07-04 (merged to `main`; prod deploy pending)
**Phases:** 3 (148, 149, 150) | **Plans:** 14

### What Was Built

A server-side-only consolidation of the eval pipeline (SEED-080, from `reports/pipeline-review-2026-07-04.md`). Phase 148 fixed five 2026-07-02 code-review correctness defects (SEED-080's hard prerequisite: deep-mate tag no-op, `fen_map` ep/castling corruption, entry-drain all-fail circuit breaker, quintile overlapping-cohort sig-test, per-game import guard, entry-submit batch-scoping guard). Phase 149 retired the dead Gen-1 `/lease`+`/submit` protocol + dead weight, replaced the silent-draw chess.com fallback with an explicit unknown+Sentry, and added `worker_heartbeats`/`worker_schema_version` telemetry + a durable `import_jobs` concurrent-import guard. Phase 150 consolidated the copy-pasted write path: `apply_completion_decision()` (3→1), `_classify_with_overlay` (4→1), a per-ply diff/upsert replacing delete-then-insert (deleting the snapshot/restore compensation layer that generated FLAWCHESS-8D), extracted into `eval_apply.py` + `eval_entry.py` (`eval_drain.py` 3188 → 1074 lines). User-visible contract: no behavior change.

### What Worked

- **Retire-before-consolidate ordering** (149 → 150) paid off directly: deleting the Gen-1 protocol and dead weight first meant Phase 150 collapsed 2 copies of the write path, not 3 — the risky R3 authoritative-write rewrite got smaller before it was touched.
- **A golden-snapshot equivalence harness** (150-01: 8 fixtures captured from pristine pre-refactor HEAD + a regenerate-and-diff test) was the right gate for a load-bearing authoritative-write rewrite — it proved byte-identical output across every incremental-retry scenario and caught a real preservation bug (scenario 5, `already_blobbed_plies`) before it shipped.
- **Prod-traffic-zero evidence before deletion** — the 11.3h `/lease`+`/submit` grep + porting the only end-to-end job_id/lichess coverage to the atomic lane made the Gen-1 removal safe rather than hopeful.
- **Fixing the delete-then-insert seam at the source** (per-ply diff/upsert) retired the whole `_snapshot`/`_restore` compensation layer that had generated FLAWCHESS-8D and the Phase 146/147 ungated-tag bugs — the consolidation was also a correctness win, not just tidiness.

### What Was Inefficient

- **Plan-vs-artifact drift on fixture counts** (150-01 documented "8 goldens" but produced 7; the plan's own artifact list said 7) required a reconciliation mid-execution — a reminder that a plan's prose and its concrete-artifacts list must agree.
- **The R7 module split left one deliberate residual** (`_load_pgns_for_games` still imported by the router) — a clean "router imports zero private drain helpers" target ended at "one narrow, flagged exception," because that symbol opens its own session unlike the other 14.

### Patterns Established

- **Golden-snapshot equivalence harness for a zero-behavior-change refactor**: capture outputs from pristine HEAD as committed fixtures, then a regenerate-and-diff drift test drives the real production entry point — the safe way to rewrite a load-bearing write path.
- **One constant drives the diff** (`FLAW_BLOB_COLUMNS`): a per-ply 4-way diff/upsert keyed off a single column list makes blob/tag preservation native to the write instead of a caller-side compensation step.
- **Durable guard row + partial unique index over an in-memory check** to close a TOCTOU race at the DB level, with `IntegrityError` idempotency returning the existing job (import concurrency).

### Key Lessons

- A "consolidate the copy-paste" milestone is really a **correctness milestone** — the verbatim copies were where FLAWCHESS-8D and the ungated-tag bugs lived; unifying them removes the class of bug, not just the duplication.
- **Shrink the surface before refactoring it**: deleting dead code first (Phase 149) is the cheapest way to de-risk the hard refactor (Phase 150) — fewer copies to keep in sync, smaller blast radius.
- For a load-bearing authoritative write, **gate the rewrite on an equivalence proof, not just a green suite** — the golden harness caught a preservation bug the existing tests missed.

### Cost Observations

- Net-neutral diff (+6,579 / −6,156) is the signature of a healthy consolidation: `eval_drain.py` alone shrank 3188 → 1074 lines while behavior stayed identical.
- Clean 3-phase execution with no inserted decimal phases and no post-ship hardening quick-tasks (contrast v1.30) — the internal-refactor scope with concrete review-supplied file/line targets planned and executed predictably.

---

## Milestone: v1.30 — Forcing-Line Tactic Gate

**Shipped:** 2026-06-30
**Phases:** 7 (141–147) | **Plans:** 25

### What Was Built

An "only-move" forcing-line gate (lichess-puzzler-modeled) that pre-filters the v1.28 tactic
tagger so it credits a motif only on genuinely forced refutation lines, plus persisted
MultiPV=2 evals (`allowed_pv_lines`/`missed_pv_lines` JSONB on `game_flaws`) that make every
threshold change a seconds-fast offline re-tag. Phases 141–145 shipped the gate and rolled it
live (#229); Phase 146 offloaded the live-submit continuation eval to the remote fleet (#230);
Phase 147 hardened the invariant so only gated tags are ever persisted — go-forward
suppression + a corpus data migration + a server-authoritative atomic eval+blob worker
pipeline (#234).

### What Worked

- **Persist-then-re-derive** was the right architecture: storing MultiPV=2 blobs once turned
  every subsequent margin/threshold decision into an engine-free `retag_flaws.py --margin X`
  run (seconds), which made the Phase 144 A/B and the Bug-B depth-aware fix cheap to iterate.
- **Engine-free A/B over identical stored blobs** cleanly isolated the gate's effect from
  `eval_cp` cross-machine non-determinism — the ungated arm wired the raw detector directly
  (not `margin=0`) for a true pre-gate baseline.
- **Additive, versioned worker contracts** (Phase 142 additive `SubmitEval`; Phase 147
  parallel `/atomic-lease`/`/atomic-submit`) let a mixed old+upgraded fleet run simultaneously
  with instant rollback — no lockstep worker/server deploy.
- **The standalone-then-regroup pattern** absorbed Phases 146/147 (SEED-071/074) into the
  milestone naturally, since the real prod rollout genuinely completed through them.

### What Was Inefficient

- The **live-submit path shipped a blocking server-side continuation eval first** (Phase 145)
  and had to be offloaded to the fleet immediately after (Phase 146, SEED-071) — the bottleneck
  was foreseeable; a fleet-first design would have avoided the 120s `HTTP_TIMEOUT_S` stopgap.
- **Tier-4 blob routing shipped with two latent bugs** discovered only in prod soak: idle-scope
  fallthrough starvation (SEED-072) and a top-50 recency window that dead-lined the old
  analyzed backlog (fixed by the ES lottery). Both were queue-fairness issues that a drain
  simulation could have surfaced pre-ship.
- **The Phase 147 strict-zero invariant leaked** through the one classify caller (the in-process
  drain) that wasn't threaded with `blobs_pending` — a "suppress at every write site" invariant
  is only as strong as its least-audited caller.

### Patterns Established

- **Independent boolean signal threaded through a pure pipeline** (`blobs_pending`, never
  derived from a sibling parameter) to change behavior at exactly one call site.
- **Over-cap DoS sentinel**: when a would-be response exceeds a shared `max_length` cap,
  sentinel the underlying data (clear the re-selecting predicate) and return 204 — never
  construct the oversized payload (established in 147-03, reused by the atomic lease).
- **Two-stage Efraimidis-Spirakis weighted lottery** with floor terms for anti-starvation +
  recency preference (tier-4 blob draw, mirroring the tier-3 derived lottery).
- **Batched composite-PK Alembic DATA migration** (`DO $$ ... WHILE rows_updated > 0 LOOP`).

### Key Lessons

- When a gate has a "never do X" invariant, enumerate **every** write/classify caller and
  thread the guard through all of them at plan time — a leaked in-process caller is exactly how
  the strict-zero invariant broke.
- For any new queue rung, **simulate the drain against the real corpus shape** before ship;
  fairness bugs (starvation, dead-lined backlog) don't show up in unit tests, only in soak.
- Design compute-heavy live-request work as **fleet-offloaded from the start** when a remote
  worker contract already exists — don't ship the blocking server version as a stopgap.

### Cost Observations

- Heavy use of `/gsd-quick` for post-ship hardening (Bug-B gate fix, tier-4 routing/lottery,
  idle-scope) — the forcing-line gate's correctness surfaced through prod soak, not planning.
- The persist-then-re-derive design front-loaded the engine cost (one MultiPV=2 pass) and made
  the tuning loop nearly free, which is the intended economics of the milestone.

---

## Milestone: v1.29 — Live-Engine Analysis Page

**Shipped:** 2026-06-29
**Phases:** 5 (136–140) | **Plans:** 14

### What Was Built
A standalone `/analysis` board running single-thread lite-single WASM Stockfish (~7 MB NNUE) in-browser: `useStockfishEngine` (a UCI state machine in a Web Worker with debounced auto re-analysis and a two-layer stale-eval guard), `useAnalysisBoard` (a new branching move tree that forks a variation on a mid-line move, URL-encoded, no DB persistence), EvalBar/EngineLines/VariationTree, a lazy-loaded route (the app's first `React.lazy` + Suspense boundary), a tactic mode that subsumed and then deleted the Phase 135 TacticLineExplorer at parity, and a full-game board behind a single unified `Analyze` entry with the eval chart below the board and inline missed/allowed tactic chips that unfold stored PVs as two-level navigable sidelines. No backend schema or new endpoints (D-4).

### What Worked
- **Hook-first, test-in-isolation sequencing.** Phases 136/137 built and unit-tested the engine hook and the move-tree hook with mock Workers before any page existed, so the route (138) was thin assembly. The mock-Worker + real-WASM integration test gave a fast inner loop without a browser.
- **Regression-gated deletion.** Tactic mode had to pass 4 explicit Phase 135 parity behaviors (depth-0 highlight, missed/allowed +1 offset, real-game-ply numbering, tactic-rail state) plus knip/tsc/lint before `TacticLineExplorer.tsx` + `useTacticLine.ts` + their 26 tests were removed — a true refactor, not a rewrite.
- **Locked decisions held.** D-3 (single-thread, no site-wide COOP/COEP) kept Google OAuth + iOS Safari untouched with a CI `curl -I` guard; D-4 (ephemeral URL state) meant zero backend work.
- **Lazy route boundary** kept the ~7 MB engine bundle off every other page.

### What Was Inefficient
- **Heavy post-ship UAT tail.** Phase 140 generated ~15 quick-task rounds (260627–260629) of layout/interaction polish (move-list height, arrow colors, sideline icon persistence, mobile takeover). Much of this was visual judgment that's hard to specify up front, but the sheer count suggests the full-game board could have used a tighter design contract before execution.
- **Tactic-color churn.** Missed/allowed arrow hues were re-picked several times (violet → wine → burgundy → magenta/teal) across rounds before settling — a sketch/UI-spec pass would have front-loaded that.
- **Two production Sentry crashes after the "snappier engine" change** (FLAWCHESS-7V WASM `unreachable` from a `position`+`go` during the `stopping` state; duplicate-React-key board arrows). Both were latent races the relaxed-debounce change exposed — the state machine had an unguarded `stopping` branch, and the arrow key contract had no dedupe. Caught only in prod, not by tests.

### Patterns Established
- **WASM engine in a Web Worker as a pure-data hook** — UCI state machine exposed as plain React state, normalized to white-POV, with a debounce + stop-pending stale-eval guard. Reusable for any future engine surface.
- **`React.lazy` + Suspense route boundary** for heavy, single-route bundles.
- **Renderer owns its key-uniqueness invariant** — dedupe board arrows by move-identity at the renderer (`dedupeArrowsByMove`) rather than chasing every caller.

### Key Lessons
- A UCI/engine state machine needs every state guarded, not just the common one: the `stopping` (stop-in-flight) state must refuse a new `go`, or the WASM traps. Cheap to add up front, a prod crash to find late.
- When a feature is mostly visual full-game layout, invest in a UI spec/sketch before execution — the polish tail is where the time actually goes.
- Subsuming an existing feature is lower-risk than rebuilding it when the old behavior is pinned as a regression gate before any deletion.

### Cost Observations
- Core phases 136–140 landed fast (2026-06-26 → 06-27); the long pole was the post-ship UAT/hardening tail through 06-29.
- Released to production mid-tail via PR #227, then soaked and hardened (two Sentry fixes) before the formal close — the deploy-then-harden-then-close shape again.

## Milestone: v1.28 — Tactic Tagging

**Shipped:** 2026-06-25
**Phases:** 14 (123.1, 124–135 incl. 128.1; 130 superseded by 131–134) | **Plans:** 45

### What Was Built
A "cause of error" tactic axis on the flaw taxonomy: a cook.py-faithful, pure-CPU motif detector (original code, no AGPL) reading the already-stored refutation PV for both colors; `tactic_motif`/`tactic_piece` + `allowed_*`/`missed_*` + `*_tactic_depth` columns; a Wilson-gated you-vs-opponent comparison endpoint; a full Library tactic UI (chips, 10-family taxonomy, depth-range + Either/Missed/Allowed filters, two-bullet grid); and the Tactic Line Explorer walkable PV stepper. Plus the standalone `opening_position_eval` dedup cache (123.1) that enabled the Phase 125 backfill.

### What Worked
- **Reusing v1.27 substrate.** The refutation PV was already stored for both colors and `game_flaws` already materialized both sides' flaws, so the whole detector was pure-CPU — no new engine pass, no OOM exposure. The milestone was much smaller in risk than SEED-039 first implied.
- **Independent CC0 ground truth as the ship gate.** Scoring against an external lichess-puzzle TEST split (not detector-bucketed self-labels) made precision honest and non-gameable, and turned "is this motif good enough?" into a mechanical per-motif floor check.
- **cook.py predicate alignment as a repeatable recipe.** Once the first few detectors were ported faithfully (AND-chains, shallowest-tactic-wins dispatch, missed-vs-played dest-square gate), the same pattern lifted motif after motif from ~0.2–0.5 to ~1.000 precision.
- **Ship-or-suppress discipline.** Sub-floor motifs were suppressed via `tactic_confidence` rather than shipped, so the visible chips stayed trustworthy throughout.

### What Was Inefficient
- **Phase 130 churn.** A placeholder phase added after 129, never executed as its own unit; the real precision work landed as 131–134. The number now reads as superseded noise in the roadmap.
- **Fixture regeneration coupling.** Discovering that a fresh lichess dump shares zero row-identity with the older committed fixtures (so byte-identity gates were unattainable) cost a detour; the per-motif oversample cap + deterministic SHA-1 re-seed was the eventual fix (Phase 134).
- **Detector context faithfulness took several passes.** Getting the offline harness to build the board exactly as production does (flaw move pushed onto the stack) was the unlock that pushed pin/capturing-defender/hanging-piece to ~1.000 — found late rather than designed in.

### Patterns Established
- **External-ground-truth precision gates** for any heuristic classifier (`fixtures/tagger/*.csv` + per-motif floors in `precision_floors.py`, `--check-goals` loop mode).
- **Orientation-by-column-source** (`allowed_*` / `missed_*`) with user-perspective derived via `is_opponent_expr` — no perspective column, mirroring the v1.25 `is_opponent` voiding.
- **Standalone-then-regroup** applied again (123.1 folded into v1.28 at close, cf. v1.20/v1.27).

### Key Lessons
- When a feature can ride existing stored data, the real cost is *validation*, not compute — budget the milestone around the precision harness, not the detector code.
- A clean-room reimplementation of an AGPL algorithm + using only its CC0 *output* as reference labels is a safe, effective pattern for a hosted service.
- The offline validation harness must exercise the detector exactly as production calls it, or measured precision lies.

### Cost Observations
- Long milestone (9 days, 154 commits inflated by squash + forward-port + committed fixtures); the bulk of effort was the 131–134 precision sweep, not the initial detector or the UI.
- Phases 124–134 deployed mid-milestone (release #214) and soaked before the formal close; Phase 135 + close + deploy ran as one wrap-up session.

## Milestone: v1.26 — Full-Game Eval Pipeline

**Shipped:** 2026-06-14
**Phases:** 7 (116, 117, 117.1, 117.2, 118, 119, 120) | **Plans:** 18

### What Was Built

Eval coverage went from "endgame-entry plies only" to a full-game background analysis pipeline: an all-ply Stockfish drain at the 1M-node / NNUE / multiPV=1 Lichess-parity budget (ply≤20 `full_hash` dedup transplant, distinct `full_evals_completed_at` marker, 4g-bounded pool); a PostgreSQL SKIP-LOCKED tiered priority queue (explicit > recent windows > idle backlog) with round-robin per-user fairness, a lease/report contract, and tier-1 ~10s fan-out; `best_move` for every position + full PV adjacent to flaws; automatic `classify_game_flaws` flow-through; guest exclusion; explicit on-demand "Analyze" UX with honest coverage badges; hole-aware coverage with a recency-weighted tier-3 lottery; and an off-box headless trusted-operator eval worker.

### What Worked

- **Locking SEED-012's queue decisions (D-1..D-8) and the spike throughput numbers before planning** meant Phase 116/117 planning argued over implementation, not feasibility. The "measured, not estimated" discipline (5.83 pos/s, 8.4k games/day, 0.98s/position) paid off.
- **The lease/report contract was the right abstraction.** Designed in Phase 117 to keep a future browser worker additive, it let Phase 120's off-box headless worker land as a pure add — no queue redesign — proving the shape early.
- **Inserting correctness phases (117.1, 117.2) immediately when the off-by-one surfaced** rather than patching around it. Standardizing on one post-move convention everywhere removed a whole class of per-source branching from the classifier.
- **Clean-slate re-eval gated on `lichess_evals_at IS NULL`** made the data migrations safe to reason about: lichess data was provably never touched across 117.1/117.2.

### What Was Inefficient

- **Phase 118's tier-2 auto-enqueue was built and then dropped in Phase 119** in favour of an explicit on-demand model — the in-flight count turned out to be a structurally dishonest progress signal once tier-3 became a derived pick. The auto-enqueue design could have been pressure-tested for "is this an honest UX signal?" before implementation.
- **The pre/post-move eval off-by-one (SEED-044) shipped to prod in Phase 117 before being caught**, forcing a clean-slate re-eval. A convention-level regression fixture comparing engine vs lichess flaw detection on the same game would have caught it at the unit level.
- **Coverage-honesty bugs came in a trickle** (SEED-045 holes, SEED-046 lichess leak, SEED-049 game-ending ply) — each a separate fix. They share a root theme ("what counts as a real, fillable eval hole?") that a single up-front spec of the hole definition might have consolidated.

### Patterns Established

- **Tiered SKIP-LOCKED queue with lease/report** as the canonical background-work pattern (pluggable workers, round-robin fairness, derived idle tier).
- **One storage convention across sources, no per-source classifier branch** — the eval-storage lesson generalizes: normalize at the write path, not the read path.
- **`EVAL_AUTO_DRAIN_ENABLED`-style env gating** for background compute so dev/CI never pins cores on a backlog while prod opts in.
- **Efraimidis–Spirakis weighted-random sampling** for fair-but-recency-biased work selection (tunable τ/floor kept as constants for prod tuning).

### Key Lessons

- A background pipeline's **progress signal must be honest for the dominant path**, not the convenient-to-measure one. The in-flight count measured tier-1 (rare) and was blind to tier-3 (common) — remove a signal that lies rather than ship it.
- **Eval-convention bugs are silent and dataset-wide.** An off-by-one in storage mis-scored every chess.com game with no error — cross-source equivalence fixtures are cheap insurance.
- **Define "done/complete" precisely before stamping it.** The hole-filling saga was really three refinements of "when is a game fully analyzed?"; pin that predicate first.

### Cost Observations

- 18 plans across 7 phases in 3 days; +12,555/−494 lines, 20 `feat` commits.
- Two phases (117.1, 117.2) and one quick task (SEED-049) were unplanned correctness work — ~30% of the phase count was reactive, all tracing to the single SEED-044 convention bug and its coverage follow-ons.

## Milestone: v1.24 — Library Page

**Shipped:** 2026-06-09
**Phases:** 9 (104–112) | **Plans:** 37

### What Was Built

The **Library** — SEED-036's analysis half. Started as a pure-frontend shell folding Import + Overview into deep-linkable subtabs (104), then grew into a full-stack eval-driven mistake/flaw archive: an on-the-fly mistake-detection kernel (105), Games-surface backend (106), Games subtab (107), Flaws subtab backed by a materialized `game_flaws` table + cross-tab Flaw filter (108), per-card expected-score eval charts (109), a finalized flaw-tag taxonomy (110), an Apply-only filter-UX polish (111), and a Flaws-card rework with a single-game modal (112).

### What Worked

- **On-the-fly first, materialize later.** Phases 105/106 shipped the classifier with zero schema change behind a typed `FlawRecord` contract (LIBG-07 designed for exactly this); the `game_flaws` materialization in 108 was a clean drop-in once pagination demanded it. Decoupling the algorithm from its storage let the UI phases (107) land before the table existed.
- **Inline payload over new endpoints** (109) — the per-ply eval series rode the existing games payload, avoiding an N+1 and a migration for a chart feature.
- **Single classify path** (108 D-10) — one `classify_game_flaws` invoked from import hook / reclassify / backfill kept the three write paths from drifting.
- **Codegen + CI drift gate** for the flaw thresholds (110) mirrored the established `endgameZones.ts` pattern, keeping Python and TS in lock-step through a behavioral taxonomy change.

### What Was Inefficient

- **Roadmap bookkeeping drifted badly from reality.** The milestone header listed Phases 104–110 while 111 and 112 lived stranded in the Backlog section; the REQUIREMENTS traceability still marked three shipped requirements "Planned"; STATE.md frontmatter said `total_phases: 13, completed: 7` for a 9-phase, fully-shipped milestone. The close had to reconcile all of this before archiving. Lesson: when a milestone grows past its original scope, update the roadmap milestone grouping + the progress table at each phase add, not just at close.
- **Phase 111 shipped with no GSD plan/summary artifacts** (direct commits into an empty phase dir). Its record had to be reconstructed from git for the archive. Either run the standard plan→execute chain or write a one-line SUMMARY at ship even for polish passes.
- **Scope crept ~3× silently.** Requirements were defined for a single-phase shell (LIB-01..09); the milestone delivered nine phases. The growth was the right call (SEED-036/SEED-038 + explore decisions), but four phases carry no requirement IDs, so traceability lives only in the archive prose.

### Patterns Established

- `game_flaws` materialization (composite PK `(user_id, game_id, ply)`, typed tag-family columns + display payload, M+B-only) as the canonical derived-flaw store.
- Outcome-independent impact tagging (`reversed`/`squandered` ES ladder) — swing magnitude, not game result, as the impact signal.
- Apply-only filter panels (Reset + Apply footer; close-any-other-way discards) unifying the prior desktop-live / mobile-on-close split across every panel.

### Key Lessons

- Update the ROADMAP milestone grouping + progress table at each phase add when a milestone is actively growing — don't let phases pile up in Backlog.
- Write at least a stub SUMMARY for any phase that ships, including direct-commit polish passes, so the close doesn't reconstruct from git.
- A typed service contract (LIBG-07) is what makes "ship on-the-fly, materialize later" cheap — design the contract up front even when not materializing yet.

### Cost Observations

- Model mix: predominantly opus (Opus 4.8 1M) across discuss/plan/execute. Sessions: many over 6 days.
- Notable: the late phases (108–112) carried the bulk of the backend + DB work; the early shell phases were cheap. Per-phase human UAT at ship time (108, 109, 112) substituted for a formal milestone audit at close.

## Milestone: v1.22 — Maintenance — Test Isolation & Frontend Major Upgrades

**Shipped:** 2026-05-31
**Phases:** 2 (100, 101) | **Plans:** 3

### What Was Built

Two accrued maintenance debts cleared back-to-back in a single day. Phase 100 gave each `pytest` run (and each xdist worker) its own template-cloned database, retiring the hostile session-start `TRUNCATE … CASCADE` whole-schema lock and unblocking concurrent agent runs + `pytest -n auto` (green at 18.56s vs 40.29s serial, 2.2x). Phase 101 brought 11 majors-behind frontend deps to latest across six bisectable atomic clusters (lucide → Vite 8 → jsdom 29 → eslint 10 → TypeScript 6 → recharts 3), recharts earning a visual UAT. Alongside, small direct-to-`main` backend dep refresh + Gemini 3 thinking-level support.

### What Worked

- **Low→high risk clustering with a per-cluster gate.** Ordering the dependency bumps so the gate signal sharpened as risk rose, and committing each cluster atomically, meant any gate failure bisected to exactly one cluster. The single genuine regression (recharts 3 zone bands) was isolated immediately and locked with a regression test.
- **Up-front peer-compat research paid off.** Resolving the typescript-eslint ↔ TS6/eslint-10 question before planning the lint/TS clusters meant those landed clean — the documented escape hatch was never needed.
- **Template-clone isolation is the right primitive.** `CREATE DATABASE … TEMPLATE` per run + advisory-lock auto-refresh on Alembic drift removed a class of cross-run contention without any per-test bookkeeping, and self-heals on killed runs.
- **Per-close doc hygiene applied this time.** Unlike the v1.18–v1.20 gap, MILESTONES + RETROSPECTIVE + PROJECT were reconciled at close (the v1.21 lesson held).

### What Was Inefficient

- **The open-artifact audit still surfaces 13 dormant carry-forward items** (seeds + long-range todos) that aren't milestone-scoped and get re-acknowledged every close. Tolerable, but it's noise on every gate.
- **xdist non-determinism cost an extra fix pass.** `set`-iteration order in a parametrize and per-worker openings seeding both had to be made deterministic after the fact (`sorted()`, conftest-level seed fixture) once `-n auto` actually ran across 16 workers.

### Patterns Established

- **Per-run template-cloned test DB** (`CREATE DATABASE … TEMPLATE` + `pg_advisory_lock` auto-refresh on head drift + drop-if-exists self-heal) as the project's isolation primitive — documented in conftest.py + CLAUDE.md.
- **Clustered dependency-major upgrades**: low→high risk, one atomic commit per coupled cluster, full local gate per cluster, blocking visual UAT for anything that renders. Reusable recipe for the next dep-debt sweep.

### Key Lessons

- When adopting parallel test execution, audit for hidden order-dependence (set iteration, shared seed data) — `-n auto` exposes what serial runs hide.
- Gate-per-cluster beats gate-per-milestone for dependency work: the bisection guarantee is worth the extra commits.

### Cost Observations

- Single-session, single-day close. Phase 101 was ~75 min including the UAT loop; Phase 100 plan 02 was ~14 min. The milestone close itself (doc reconciliation) was the lighter half.

## Milestone: v1.21 — Time-Control-Aware Endgame Metrics

**Shipped:** 2026-05-31
**Phases:** 4 (97, 98, 99, 99.1) | **Plans:** 15

### What Was Built

Made the Endgames page time-control-honest end to end: per-TC Endgame Metrics cards (TC-specific Conv/Recov bands, shared Parity/Score Gap band; Phase 97), collapsible per-TC Endgame Type Breakdown accordion cards with a 2×2 type-tile grid and Mixed dropped (Phase 98), peer-relative percentile chips on the per-TC Conversion/Parity/Recovery rates via 12 new per-(metric, TC) cohort metrics (Phase 99), and the 3.1 MB generated cohort-CDF lookup demoted from Python source into a `benchmark_cohort_cdf` DB table (Phase 99.1).

### What Worked

- **Benchmark-driven band decisions.** Each "per-TC vs shared band" call was settled by the benchmark report's Cohen's d on the TC axis (Conv/Recov d≈0.9 → per-TC; Parity/Score Gap d<0.15 → shared), not by taste. The source-of-truth discipline kept the gauge calibration defensible.
- **Reusing the v1.19 per-TC chip pattern.** Phase 99 mirrored Phase 94.3's pooled-per-user methodology and chip primitive, so the 12 new metrics dropped in with the drift-impossible CDF-vs-lookup guarantee intact.
- **Quick tasks as the iteration vehicle.** Most of the visual refinement (collapsible rows, header bands, primary-TC default-expand, declutter) happened as dated quick tasks rather than reopening phases.

### What Was Inefficient

- **Milestone-doc drift accumulated silently.** MILESTONES.md was missing v1.19/v1.20, RETROSPECTIVE.md was missing v1.18–v1.20, and PROJECT.md's "Current Milestone" header lagged a full version (flagged in its own footer but not fixed until this close). The per-close hygiene step was being skipped.
- **A stale global `gsd-sdk` binary inflated the open-artifact audit to 186 items** (really 28), masking the genuine backlog behind 172 false-positive "missing" quick tasks for multiple closes. Cost real investigation time at this close to disprove.
- **Newer quick-task SUMMARY template dropped `status: complete`**, so every recent done quick task read as open to the auditor.

### Patterns Established

- **Per-(class × TC) banding with no TC-mix blend** — single-TC cards judged against that TC's own reference; the chosen-redundancy of per-TC Score Gap bands for one consistent card grammar.
- **Demote generated data from source to a seeded DB table** (Phase 99.1) — generator emits a compact `app/data/` artifact, idempotent `ON CONFLICT DO UPDATE` seed script, `run_local.sh` wiring; the SEED-030 Track B recipe, reusable for other oversized generated modules.

### Key Lessons

- Run the per-close doc hygiene (MILESTONES + RETROSPECTIVE + PROJECT footer) every time — three closes of skipping it compounded into a confusing log.
- Trust the in-package `gsd-tools.cjs` scanner over the global `gsd-sdk` bin for the audit gate, or update `gsd-sdk`; the filename-match fix isn't in the global build.

### Cost Observations

- Single-session close; the bulk of the spend was the pre-close artifact investigation (disproving the 172-count) and the multi-file doc reconciliation, not the phase work itself.

## Milestone: v1.17 — Endgame Stats Card Redesign

**Shipped:** 2026-05-19
**Phases:** 13 (84, 85, 85.1, 86, 87, 87.1, 87.2, 87.4, 87.5, 87.6, 88, 88.3, 88.4) | **Plans:** ~54 | **Delivered via:** PRs #89–#117
**Stats:** 603 files changed, +82,473 / -9,393 lines, 203 commits over 8 days (2026-05-11 → 2026-05-19) since v1.16 (commit 4075431d → 114211c2)
**Source:** `.planning/notes/endgame-stats-card-redesign.md` — a frontend table→card refactor that became a statistical-rigor milestone.

### What Was Built

Three table-driven Endgames-page sections replaced with the WDL + ScoreBullet card pattern. Eval-based per-span ΔES Score Gap bullets anchored to the Stockfish baseline replaced the mathematically degenerate rate-based mirror-bucket peer-diff. Hypothesis tests (two-sample z, paired one-sample z) + 95% CI whiskers on Endgame Score Differences. Endgame Skill concept dropped end-to-end; timeline rebuilt as Endgame ELO via a logistic stretch around Actual ELO. Time Pressure reworked with benchmark-calibrated zones and a zone-banded line chart. Inactivity-gap break annotations on all 6 ordinal-axis timeline charts.

### What Worked

- **Replan-in-place + inserted decimal phases** absorbed a large scope expansion (5 planned → 13 shipped) without a milestone reset. Each redesign exposing the next measurement flaw became its own tight phase rather than ballooning one.
- **Math-first scrutiny before UI commit** killed two dead ends cheaply: the degenerate rate-based peer-diff (Phase 87.2) and the percentile-composite Endgame Skill (Phase 87.3, retracted at UAT before shipping).
- **Benchmarks as the source of truth** for zone calibration kept the Time Pressure rework grounded rather than eyeballed.

### What Was Inefficient

- The Endgame ELO formula churned through four designs (Phase 57 multiplicative → 87.4 Conv ΔES affine → 87.5 additive-K → 87.6 logistic stretch) before landing on an invariant-preserving mapping. Earlier insistence on the "Actual ELO between the lines" invariant as a hard constraint would have shortened the path.
- Phases 85/85.1/86 shipped via direct push to main (no PR), diverging from the PR-per-phase norm and leaving the top-level ROADMAP `<details>` block badly stale by milestone close (every shipped phase still marked "planned").

### Patterns Established

- **Single-bullet doctrine** — one self-calibrating peer bullet per Conv/Parity/Recov + per-type card; cohort/p50 bullets dropped as rating-tier confounds.
- **Eval-anchored ΔES Score Gap** as the canonical per-span performance signal, replacing rate-based peer differencing.
- **Invariant-as-construction** for derived ELO lines (`eg_elo + non_eg_elo == 2·actual_elo` by the logistic stretch, not by post-hoc clamping).

### Key Lessons

- When a peer/diff metric can be derived algebraically from another, check for degeneracy *before* building the UI — Conv-Gap ≡ Recov-Gap was provable on paper.
- A composite "skill" number is a trap unless it survives cohort-deconfound, individual interpretation, temporal stability, and the median-coincide invariant simultaneously. Dropping it was the right call.
- Keep the ROADMAP `<details>` block updated as phases ship even when pushing direct-to-main; reconciling 13 stale entries at close is error-prone.

### Cost Observations

- Model mix: predominantly opus (statistical-rigor + design-judgment heavy milestone).
- Sessions: many short inserted-phase cycles rather than a few long ones.
- Notable: the inserted-phase cadence kept individual context windows small and focused; the cost was reconciliation overhead at close.

---

## Milestone: v1.16 — Stockfish Eval Analyses

**Shipped:** 2026-05-11
**Phases:** 5 (80, 80.1, 81, 82, 83) | **Plans:** 24 | **Delivered via:** PRs #80, #82, #85, #86, #88
**Stats:** 267 files changed, +47,752 / -4,427 lines, 118 commits over 7 days (2026-05-05 → 2026-05-11) since v1.15 (commit 64441744 → 46f78231)
**Source:** v1.15 substrate (per-position `phase` SmallInteger + Stockfish eval at endgame span-entry + middlegame-entry rows) unlocked five downstream consumer phases.

### What Was Built

- **Phase 80** — Opening Stats subtab: avg eval at middlegame entry ± std (user POV) with one-sample t-test confidence pill via `compute_eval_confidence_bucket` and CI-whisker MiniBulletChart on bookmarked + most-played tables. Later restructured into a two-column card grid via quick task `260506-rtk` that replaced `MostPlayedOpeningsTable`.
- **Phase 80.1** (mid-milestone insert) — Move Explorer + Opening Insights WDL/score/confidence/p_value now reflect resulting-position (transposition-inclusive) instead of move-played. `query_transposition_wdl` + `query_resulting_position_wdl` repo helpers; `game_count` and the n≥10 surfacing gate stay move-played for honest disclosure. Closes the loud 57%→61% mismatch surfaced during Phase 80 UAT.
- **Phase 81** — Endgame Start vs End twin-tile section above the Endgame Overall Performance WDL table: entry-eval (cp, Wald-z sig-tested vs 0) + endgame score (Wilson score test vs 50%), three-state color, n≥10 reliability gate, "we can't tell" framing for non-significant verdicts. `EndgamePerformanceResponse` gains 6 fields. Aggregation runs against `query_endgame_bucket_rows` (D-22 amendment), locking `n + mate + null == total` by construction.
- **Phase 82** — LLM endgame-insights prompt awareness of Start vs End metrics: `MetricId` + `SubsectionId` Literal extensions, `ZONE_REGISTRY` entries for `entry_eval_pawns` (band ±0.5 after D-08 tightening) + `endgame_score` (band [0.45, 0.55]); prompt `endgame_v23` → `endgame_v24`. Mid-phase UAT surfaced two bugs (`_SECTION_LAYOUT` missing the subsection; `_format_zone_bounds` filtering renamed timeline metrics), fixed inline before close.
- **Phase 83** — Stockfish-baseline predicted endgame score: `eval_cp_to_expected_score` (Lichess sigmoid k=0.00368208) + `eval_mate_to_expected_score`; 5 new `EndgamePerformanceResponse` fields (`entry_expected_score` + `_n` / `_p_value` / `_ci_low` / `_ci_high`); 2×2 grid restructure of Start vs End so achievable + achieved share the same units (W+0.5D ∈ [0,1]); LLM prompt `endgame_v25` → `endgame_v26` narrates achievable-vs-achieved gap as headline diagnostic. Closes SEED-014.

### What Worked

- **Wave-based plan execution stayed tight across all five phases.** Each phase locked plans into 2-4 waves with clear dependencies. No mid-execution wave reshuffling across 24 plans suggests the wave-graph shape is right.
- **Mid-milestone phase insert (80.1) over carrying tech debt.** The 57%→61% transposition mismatch surfaced during Phase 80 UAT; inserting Phase 80.1 immediately kept the fix close to the data-shape understanding that produced it. Same pattern as v1.13 Phase 71.1.
- **Live LLM UAT caught two regressions before deploy (Phase 82).** Plan 82-04 ran a live `/endgames` call against dev DB before merging. Initial run showed `endgame_score` missing from the prompt; triaged to `_SECTION_LAYOUT` + `_format_zone_bounds` issues from the metric rename in Plan 82-01. Both fixed inline; regression test `test_endgame_start_vs_end_findings_render_in_prompt` added. Pre-merge live UAT is cheap insurance for LLM-pipeline changes.
- **Tighten cohort bands over adding a `verdict` field (Phase 82 D-06, Phase 83 D-19).** Original SEED proposal exposed significance independent of cohort. Rejected because it would license LLM over-narration. Instead, `entry_eval_pawns` cohort band tightened IQR ±0.75 → ±0.5 (D-08) so borderline-but-significant cases land in `zone="typical"` and stay silent. Codified in `feedback_llm_significance_signal.md`.
- **2×2 grid restructure (Phase 83) over inserting a third tile.** Stockfish baseline + user achieved share the same units and visual idiom; the achievable-vs-achieved gap is visually readable; the LLM no longer needs to translate centipawns → score in prose. Reusing `MiniBulletChart` across both columns kept the implementation small.
- **D-22 amendment switched entry-eval source to `query_endgame_bucket_rows` (Phase 81).** UAT against user 28 surfaced a ~5-game under-count when aggregating per-class entry rows. Bucket-rows gives one row per game at chronologically first endgame position, locking `n + mate + null == total` by construction. Always prefer structural invariants over asserted-by-tests.
- **Forbidden-word regression test on prompt asset (Phase 83).** Single source of truth: narration-guidance lines using forbidden terms ("expected", "underperformance") fail CI before the prompt ships. Cheaper than per-PR LLM evals.
- **Stat methodology choices stayed consistent.** Wald-z for one-sample mean tests, Wilson for binomial-style proportion tests. Reused project-wide `compute_confidence_bucket` / Wilson half-width utils — no per-feature reinvention.

### What Was Inefficient

- **Phase 80 column structure didn't survive a week.** Quick task `260506-rtk` replaced the wide-column table with a two-column card grid ~1 day after Phase 80 shipped. The replacement wasn't anticipated during Phase 80 design — UAT scenarios on the original layout (8 deferred items in the audit) became moot. Lesson: when the existing UI is itself under reconsideration, ship the data plumbing first, prototype the visual treatment as a quick task, then commit to the layout.
- **VALIDATION.md draft flags accumulating (Phases 80.1, 82).** Both phases shipped with `status: draft` / `nyquist_compliant: false` despite verification passing. Frontmatter flag never got flipped to `approved` after verification. Process step missing — either VERIFICATION auto-flips VALIDATION on pass, or VALIDATION gets folded into VERIFICATION (one source of truth on phase status).
- **`_SECTION_LAYOUT` + `_format_zone_bounds` regressions caught at UAT, not CI.** Plan 82-01's MetricId rename should have failed CI: no test asserted "every emitted subsection appears in `_SECTION_LAYOUT`" or "every active MetricId has a non-skipped zone-bounds path". Both invariants are structural; worth a test to lock down so the next rename doesn't repeat the cycle.
- **Phase 80 +47k LOC headline dominated by generated artifacts.** `endgameZones.ts` regen + package-lock churn + LLM prompt-version chronological snapshots are not actual code volume. Future milestone-close should exclude generated files from the stats query.

### Patterns Established

- **Mid-milestone phase insert is the standard response to UX bugs surfaced during UAT.** Name the insert `<parent>.1`, lock plans during discuss-phase, run normal waves.
- **Tighten cohort bands over adding payload fields when the LLM narrates from significance** (`feedback_llm_significance_signal.md`).
- **Forbidden-word regression tests on prompt assets.** Cheap CI guard against narration drift.
- **2×2 grid as canonical layout for baseline-vs-achieved comparison** when there are natural columns (Stockfish baseline + your value) × rows (input + output).
- **Live LLM UAT before merge** is required for any phase touching the LLM prompt or insights service.

### Key Lessons

- **Add invariant tests when renaming Literal types or registry keys.** "Every emitted SubsectionId is in `_SECTION_LAYOUT`" and "every MetricId has a zone-bounds path" are both invariants either could have caught the Phase 82 regressions at CI time.
- **Process debt accumulates quietly.** VALIDATION.md draft flag is the canonical example — caught only by audit, never blocked the milestone, but is now noise that future readers have to triage.
- **Headline LOC misleads when codegen dominates.** Future milestone-close should exclude generated files from the stats query.
- **Seed → phase → close-on-merge.** Phase 83 closed SEED-014 cleanly. Worth keeping seed-status updates in the milestone close workflow so dormant seeds don't accumulate stale references to shipped features.

### Cost Observations

- Sessions: ~5 (one per phase) plus mid-milestone quick tasks.
- Notable: phases 80, 81, 83 all hit verification on first try; phases 80.1, 82 required mid-execution amendments (transposition test churn + LLM UAT regressions). Both within normal wave-execution variance.

---

## Milestone: v1.15 — Eval-Based Endgame Classification

**Shipped:** 2026-05-03
**Phases:** 2 (78, 79) | **Plans:** 10 | **Delivered via:** PR #78 (combined Phase 78 + Phase 79 cutover) plus follow-on PR #79 (`EnginePool` parallelisation)
**Stats:** 214 files changed, +21,125 / -4,336 lines, 68 commits over 5 days (2026-04-29 → 2026-05-03) since v1.14 (commit 50c16e5 → 42cddf5)
**Source:** Validation report `reports/conv-recov-validation-2026-05-02.md` flagged the material-imbalance + 4-ply persistence proxy at ~81.5% agreement vs Stockfish on the populated subset (22% lichess-only eval coverage), missing ~24% of substantive material-edge sequences. Queen and pawnless classes underperformed structurally.

### What Was Built
- Endgame Conversion / Parity / Recovery classification migrated from material-imbalance + 4-ply persistence proxy to direct Stockfish-eval thresholding (±100 cp on `eval_cp`, color-flipped to user perspective; `eval_mate` short-circuits to ±1,000,000 cp). Hard cutover, proxy code path removed entirely (`_MATERIAL_ADVANTAGE_THRESHOLD`, `PERSISTENCE_PLIES`, and the `array_agg(... ORDER BY ply)[PERSISTENCE_PLIES + 1]` contiguity case-expression deleted from the codebase). `material_imbalance` column retained for other consumers (Phase 78 REFAC-01..03, REFAC-05).
- Pinned Stockfish sf_17 AVX2 binary in the backend Docker image with SHA-256 supply-chain verification (later bumped to sf_18); CI installs `stockfish` via apt; `STOCKFISH_PATH` env var threaded end-to-end (Phase 78 ENG-01).
- `app/services/engine.py` — async-friendly Stockfish wrapper with FastAPI lifespan integration (`start_engine` / `stop_engine`, idempotent, depth-15 `evaluate()` API). Shared by import path and backfill script (Phase 78 ENG-02, ENG-03).
- `scripts/backfill_eval.py` — idempotent + resumable CLI driver (skip-where-NULL, COMMIT-every-100, `--db dev/benchmark/prod`, `--user-id`, `--limit`, `--dry-run`, `--workers N` for parallel evaluation). FILL-02 relaxed mid-plan to drop `full_hash` dedup — added complexity for marginal CPU savings on a one-shot backfill (Phase 78 FILL-01..04).
- Import-time eval pass: per-class span-entry rows + middlegame entry row populated on every new import in `_flush_batch` between `bulk_insert_positions` and the `move_count` UPDATE, in the same transaction. Adds well under 1s to the typical-game import path (Phase 78 IMP-01..02).
- Alembic `c92af8282d1a` reshapes `ix_gp_user_endgame_game INCLUDE` from `material_imbalance` to `eval_cp` / `eval_mate` so rewritten endgame queries stay index-only. `_classify_endgame_bucket(eval_cp, eval_mate, user_color)` is the single classification helper; SQL projects raw white-perspective eval, service applies the user-color sign flip (Phase 78 REFAC-04, REFAC-02).
- Phase 79: `game_positions.phase` SmallInteger column (0=opening, 1=middlegame, 2=endgame) computed via Python port of [lichess `Divider.scala`](https://github.com/lichess-org/scalachess/blob/master/core/src/main/scala/Divider.scala) using existing `piece_count`, `backrank_sparse`, `mixedness` inputs — no second board scan. 11 Divider-sourced parity assertions in `tests/test_position_classifier.py` lock output to the lichess reference (Phase 79 CLASS-01..02, SCHEMA-01..02; Alembic `1efcc66a7695`).
- Phase 79: Middlegame entry position (`MIN(ply)` of `phase = 1` per game) Stockfish-evaluated at depth 15 alongside endgame span-entry positions, populated into the same `eval_cp` / `eval_mate` columns. Substrate for v1.16 opening-stats analyses.
- Combined Phase 78 + Phase 79 operator cutover (D-79-10): single benchmark + prod backfill pass, single PR #78, single deploy. Saved an operational round-trip and consolidated the deployment risk window.
- Follow-on PR #79 (quick task 260503-pool): import-time eval pass parallelised via module-level `EnginePool` of `STOCKFISH_POOL_SIZE` workers (default 1, prod ships 2 via `docker-compose.yml`). Sequential callers see no change; parallel callers gain ~POOL_SIZE× throughput.
- Inline quick tasks during the milestone window: 260501-s0u (endgame UI rebuild from benchmark report — clock-pressure neutral band ±10pp → ±5pp, recovery typical band [25%, 35%] → [25%, 40%], grouped WDL chart replaced with six per-class Conversion/Recovery mini-gauges, LLM endgame insights prompt v18 reframes Conv/Recov as delta-from-class-baseline); 260503 (gauge typical bands recalibrated from the 2026-05-03 benchmark report); 260503-fef (`/benchmarks` skill applies equal-footing opponent filter `abs(opp_rating - user_rating) ≤ 100`); 260503-0t8 (`backfill_eval.py` parallelised via `EnginePool`).
- VAL-01 / PHASE-VAL-01 rescinded as moot 2026-05-03: once REFAC-03 deleted the proxy code path, the agreement metric became undefined. The `/conv-recov-validation` skill was deleted.

### What Worked
- **Combined sibling-phase cutover (D-79-10).** Phase 78 left FILL-03 / FILL-04 / VAL-01 / VAL-02 deferred to a combined run with Phase 79 rather than running two backfill cutovers sequentially. Single benchmark backfill, single prod backfill, single PR, single deploy. Saved an operational round-trip and consolidated the deployment risk window. Good pattern when sibling phases share an ops surface.
- **Hard cutover, no fallback.** REFAC-03 deleted the proxy code path entirely rather than running both classifiers side-by-side with a flag. The validation report had already established the proxy's structural ceiling on queen + pawnless classes; a fallback would have re-introduced the failure mode for any game without lichess `%eval` annotation. Hard cutovers are the right default when the new path strictly dominates the old and you control all consumers.
- **Treating VAL-01 / PHASE-VAL-01 as moot rather than failed.** The post-cutover agreement metric became undefined once the proxy code path was deleted (only one classifier left to compare against). Marking the requirement *rescinded* (not deferred, not failed) and deleting the `/conv-recov-validation` skill prevented future-readers from re-running a now-meaningless audit. Cleanup is part of close.
- **Per-position fields reused for the phase classifier.** Phase 79's Divider port consumed existing `piece_count`, `backrank_sparse`, `mixedness` per-position fields computed during the main import board walk — no second python-chess pass. The 11 Divider-sourced parity tests anchor the port to the lichess reference. Reusing per-position computed fields rather than recomputing from FEN is the right default in the import pipeline.
- **Separate `EnginePool` parallelisation as a follow-on quick task (PR #79).** Initial Phase 78 implementation was sequential (one engine, one game at a time); production import latency p99 regressed slightly post-cutover. Quick task 260503-pool added an `EnginePool` with `STOCKFISH_POOL_SIZE` workers and `asyncio.gather` fan-out. Sequential callers are unchanged; parallel callers gain ~POOL_SIZE× throughput. Right pattern: ship the v1 sequentially, observe production, harden via a focused follow-on rather than over-engineering ahead of evidence.
- **Inline quick tasks for UI calibration during the milestone window.** v1.15 milestone scope was strictly backend; UI gauge recalibration ran inline as quick tasks (260501-s0u, 260503) against the new benchmark report rather than blocking the cutover. Same pattern as v1.14's hotfix PRs — small UI follow-ons don't need to gate the milestone PR.
- **CI Stockfish via apt.** CI runner installs `stockfish` via apt before pytest so engine wrapper tests run in CI without bundling the binary in the test image. Cheap, works against any Ubuntu runner version.

### What Was Inefficient
- **Plan 78-06 deferred operationally to 79-04 — but the deferral wasn't planned upfront.** Phase 78 ROADMAP entries originally listed FILL-03, FILL-04, VAL-01, VAL-02 as Phase 78 deliverables. Mid-Phase-78 it became obvious that doing the cutover twice (once for Phase 78 endgame eval, again for Phase 79 middlegame eval) was wasteful, so the operational steps were folded into 79-04. The planner could have set up the combined cutover from the start, since the Phase 78 spec already mentioned "after Phase 79 ships, run combined backfill". A clear "operational steps deferred to combined cutover" annotation in the Phase 78 ROADMAP would have saved a planner round-trip.
- **`full_hash` dedup on FILL-02 was specced before evidence, then dropped mid-plan.** Original FILL-02 specified hash-dedup so identical positions weren't re-evaluated. Mid-Plan-78-03 it was dropped: the additional logic added complexity for marginal CPU savings on a one-shot backfill. Lesson: don't pre-spec optimisations that depend on data shape until you've measured the data shape. Backfill ran in expected wall-clock without dedup.
- **Engine-pool sizing has no autotune.** `STOCKFISH_POOL_SIZE` defaults to 1 outside prod and is hardcoded to 2 in prod via `docker-compose.yml`. No autotune based on CPU count, no warning if the pool is starved. Parameter is fine for v1 but worth a follow-on if import latency p99 regresses or if dev environments hit eval throughput ceilings during local benchmarking.
- **`STOCKFISH_PATH` setup is ad-hoc for standalone runs.** Documented in CLAUDE.md as a manual env-var export. A `bin/` wrapper that auto-detects the binary location would harden the local-dev experience. Filed as deferred tech debt at close.

### Patterns Established
- **Combined sibling-phase operator cutover.** When sibling phases share an ops surface (here: backfill + deploy), defer the operational steps from the earlier phase to a combined run with the later phase. One backfill walltime, one PR, one deploy, one risk window. Document the deferral in the earlier phase's ROADMAP entry so the operator knows what's coming.
- **Hard cutover with proxy code-path deletion (REFAC-03).** When a new classifier strictly dominates the old one and you control all consumers, delete the old code path entirely rather than feature-flagging both. Reduces conditional complexity, makes the next reader's life easier, and turns the validation requirement into a permanent invariant rather than a regression-test concern.
- **Mark moot validation requirements as rescinded, not deferred.** When an audit becomes undefined post-cutover (the thing being audited no longer exists), don't carry it as deferred tech debt. Mark it rescinded in the archive, delete the audit tooling (here: `/conv-recov-validation` skill), and document why in a memory or ADR. This keeps deferred-items lists honest.
- **Single classification helper with raw-eval SQL projection.** `_classify_endgame_bucket(eval_cp, eval_mate, user_color)` keeps SQL queries projecting raw white-perspective values; the service layer applies the user-color sign flip. One canonical place to test the threshold rule. Prior pattern (color-flip in SQL) made the classification semantically harder to reason about and test in isolation.
- **Reuse per-position computed fields for the phase classifier.** Divider port reads existing `piece_count`, `backrank_sparse`, `mixedness` columns rather than recomputing from FEN. Reusable pattern for any per-position classification that can be derived from already-computed fields.
- **Pinned binary with SHA-256 verification in Docker image.** Stockfish ships as a pinned binary download with SHA-256 verification in the Dockerfile rather than apt-installed. Reproducible builds + supply-chain check. CI separately installs via apt for test execution. Keeps prod binary deterministic without bloating the test image.
- **Module-level `EnginePool` over per-call engine spawn.** Long-lived UCI processes wrapped in a pool, fanned out via `asyncio.gather`. Sequential callers see no change; parallel callers gain throughput. Pattern reusable for any expensive long-lived subprocess (LLM agents, browser automation).

### Key Lessons
1. **Plan combined-cutover deferrals upfront.** When you already know that sibling phases will share an ops surface, mark the deferred operational steps in the earlier phase's ROADMAP from the start rather than discovering it mid-execution.
2. **Don't pre-spec optimisations that depend on unmeasured data shape.** FILL-02's `full_hash` dedup was dropped mid-plan once the data confirmed it wasn't worth the complexity. Wait for the measurement.
3. **Hard cutovers are the right default when the new classifier strictly dominates.** Feature flags double the conditional surface and trap deletions in a slow ratchet. When dominance is established by independent validation, delete the old path in the same PR that ships the new one.
4. **Validation requirements that become moot post-cutover should be rescinded, not deferred.** Be honest about when an audit no longer applies. Update the requirements traceability table, delete the audit tooling, document the why.
5. **Ship v1 sequentially, harden via follow-on quick tasks.** PR #79's `EnginePool` parallelisation post-dated the v1.15 cutover by hours, not weeks. Right ordering: prove the new classifier works end-to-end first, then optimise where production tells you to.
6. **CI dependencies via apt are fine for non-bundled binaries.** Stockfish in CI installs via apt before pytest. Keeps the test runner light without forcing the binary into the test image. Pattern reusable for any test that needs a system tool that's not part of the prod image.

### Cost Observations
- Sessions: ~10 conversations across the milestone window (spec × 1 + discuss × 1 + plan × 2 + execute waves × 4 + cutover × 1 + close × 1, plus inline quick tasks)
- Notable: Phase 78 ran 6 plans across 3 waves with worktree-based parallel executors (`worktree-agent-*` commits visible in git log). Phase 79 ran 4 plans, mostly sequential because the cutover plan (79-04) depends on all three preceding plans landing on benchmark + prod first.
- Sentry: zero new prod errors attributable to v1.15 changes through 2026-05-03 close. Hard cutover was clean; eval-based classification matches the validation prediction.
- Inline quick tasks (260501-s0u, 260503, 260503-fef, 260503-0t8, 260503-pool) accounted for ~30% of the LOC delta — UI recalibration and parallelisation work that was deliberately scoped *outside* the milestone PR but landed within the milestone window.

---

## Milestone: v1.14 — Score-Based Opening Insights

**Shipped:** 2026-04-29
**Phases:** 3 (75, 76, 77) | **Plans:** 16 | **Delivered via:** PRs #69, #70, #71 (inline confidence-mute hotfix), #72, #73 (quick task)
**Stats:** 123 files changed, +18,701 / -787 lines over 2 days (2026-04-28 → 2026-04-29)
**Source:** SEED-007 (Option A only — Wilson on score, 0.50 pivot, no user-baseline) + SEED-008 (label reframe). Both seeds folded into v1.14 and closed.

### What Was Built
- Score `(W + 0.5·D)/N` is the canonical metric across `opening_insights_service.py`, `openings_repository.py`, `arrowColor.ts`, and the `NextMoveEntry` / `OpeningInsightFinding` API payloads. `loss_rate` / `win_rate` removed cleanly. Effect-size gate against a 0.50 pivot with strict `≤`/`≥` boundaries — minor at 0.45/0.55, major at 0.40/0.60. Pivot stays at 0.50 (no user-baseline shrinkage; matchmaking + opponent-strength filter already center the baseline) (Phase 75)
- Trinomial Wald 95% confidence interval per finding using the actual variance of the chess result distribution `X ∈ {0, 0.5, 1}` — variance `(W + 0.25·D)/N − score²` rather than the binomial-Wilson approximation that over-states uncertainty when draws are common (standard formula in BayesElo / Ordo). Pure-Python `math` only, no scipy. Half-width buckets `≤ 0.10 → high`, `≤ 0.20 → medium`, else `low`. Pivoted from Wilson per Phase 75 D-05. `MIN_GAMES_PER_CANDIDATE` dropped 20 → 10 — confidence badge replaces hard-floor gate (Phase 75)
- `OpeningInsightFinding` payload extended with `confidence: "low" | "medium" | "high"` (the half-width bucket, user-facing badge) and `p_value: float` (two-sided Z-test of observed score vs 0.50, tooltip-grade). `severity` retained so the frontend renders effect size + precision + significance per finding. `NextMoveEntry` extended with the same three fields for moves-list parity (Phase 75 + 76-02)
- `arrowColor.ts` migrated to score (effect-size only — no confidence cue on arrows). Move Explorer moves-list row tint by score with extended mute rule `(game_count < 10 OR confidence === 'low')`. New Conf column with sort key `(confidence DESC, |score - 0.50| DESC)`. Single shared `compute_confidence_bucket` module with CI structural assertion that there's only one implementation (Phase 76)
- `OpeningFindingCard` renders score-based prose with level-specific confidence indicator and directional p-value tooltip; `UNRELIABLE_OPACITY` mute when `n_games < 10` OR `confidence === 'low'`. Four `InfoPopover` triggers added to `OpeningInsightsBlock` section headers. Mobile parity at 375px (Phase 76)
- INSIGHT-UI-04 (soften titles per SEED-008) descoped 2026-04-28 per Phase 76 D-04 — severity word never appeared as user-facing text; confidence badge + sort calibration deliver SEED-008's intent without rewriting "Weakness/Strength" titles
- Inline hotfix between Phase 76 and 77 (PR #71): force grey arrow + skip row tint when `confidence === 'low'`. Strengthens the at-a-glance board read; low-confidence findings still surface in the table with the badge but don't visually claim authority on the board
- Phase 77 troll-opening watermark — frontend-only matching via a side-only FEN piece-placement key (no backend schema, no Zobrist hash, no API contract change). `troll-face.svg` renders as 30%-opacity bottom-right watermark on `OpeningFindingCard` (mobile + desktop) and a small inline icon next to qualifying SAN rows in `MoveExplorer` (desktop only via `hidden sm:inline-block`). Curation is offline via a Node/TS script that emits per-ply candidates (both colors) for human pruning. Decorative `<img>` idiom keeps the asset cacheable and out of the accessibility tree (Phase 77)
- CI consistency test `test_opening_insights_arrow_consistency` rewritten to enforce score-based threshold lock-step between backend classification and `arrowColor.ts`
- Inline quick tasks during the milestone window: 260428-doc-framing-refresh, 260428-oxr (replaced Wald half-width buckets with p-value thresholds), 260428-tgg (sort by Wald CI bound), 260428-v9i (switched ranking from Wald to Wilson score interval bound), 260429-gmj (after-move arrow on insight finding mini board, PR #73)

### What Worked
- **Tightly-scoped milestone with one conceptual move.** v1.14 had a clear single thesis ("effect size decides what shows up, confidence annotates how sure we are") and shipped it in 2 days across 3 phases / 16 plans. The conceptual pivot was articulated in the design note before any code was written; every phase plan referenced it. Compact milestones with a clear thesis ship faster than ambitious milestones with mixed themes.
- **Decision IDs (D-XX) carried through context → plan → SUMMARY.** Phase 75 D-05 (trinomial Wald over Wilson) and D-09 (`p_value` alongside `confidence`) were debated at discuss-phase, recorded in `75-CONTEXT.md`, cited as the rationale for REQUIREMENTS amendments in Plan 75-04, and referenced in the Phase 75 SUMMARY. The chain from "why" to "what shipped" is unbroken and grep-able. Phase 76 D-03/D-04/D-17 followed the same chain.
- **Pivot during the milestone (Wilson → Wald, ranking iterations).** Originally specified Wilson half-width buckets per SEED-007 Option A; mid-Phase-75 discussion revealed Wilson over-states uncertainty when draws are common. Pivoted to trinomial Wald in `75-CONTEXT.md` D-05, with REQUIREMENTS amendment in Plan 75-04. The four post-Phase-76 quick tasks (260428-oxr/tgg/v9i + 260429-gmj) iterated on confidence buckets, sort key, and visual polish based on first-look-at-real-data feedback. Treating the metric as soft and iterable through the milestone window produced a calibrated end state that pre-locked metric specs would have over-constrained.
- **Frontend-only Phase 77 matching as a deliberate scope reduction.** Original troll-watermark design note specified backend Zobrist + TSV + frozenset — same shape as `seed_openings.py`. Switched to frontend-only matching via side-only FEN piece-placement keys at `77-CONTEXT.md` time after recognizing the small read-only nature of the curated set. Eliminated a migration, a backend service touch, an API contract change, and a CI parity test. Pure savings; no ergonomic loss.
- **CI structural assertions on shared helpers.** Both v1.14 phases shipped CI tests that catch *structural* violations beyond functional ones — `test_opening_insights_arrow_consistency` enforces backend/frontend threshold lock-step; the structural assertion on `compute_confidence_bucket` ensures only one implementation exists. Cheap to write; prevents the most common refactoring-induced drift class.
- **Inline mid-milestone hotfix (PR #71) was the right reach.** After Phase 76 shipped, the live UI showed low-confidence colored arrows still claiming visual authority on the board. Fixed inline via PR #71 (force grey + skip row tint) before opening Phase 77. Don't open a new phase for a polish-grade fix that's clearly load-bearing; don't queue for next milestone either; ship inline.
- **Phase 77 added off-roadmap-scope under v1.14, not as a hyphenated milestone.** Frontend-only follow-on with no v1.15 dependency; cheaper to ship under v1.14 than open v1.14.1.

### What Was Inefficient
- **Discuss-phase confidence-bucket math went through three pivots before settling.** Wilson (SEED-007) → Wald with half-width buckets (Phase 75 D-05) → p-value thresholds (post-Phase-76 quick task 260428-oxr) → Wilson score-interval bound for ranking only (260428-v9i). Each pivot required follow-on REQUIREMENTS/code adjustments. A 30-minute first-pass smoke against real user data during discuss-phase — sample 100 user-color pairs, compute candidate Wald/Wilson/p-value buckets, eyeball the rank order — would have surfaced the right calibration earlier. Lesson: when the milestone hinges on one statistical decision, smoke real data before locking the spec.
- **Phase 75 → 76 → 77 ran sequential when 75 + 76 had natural overlap.** Phase 75 (4 plans) and Phase 76 (8 plans) had natural overlap potential — frontend types, arrowColor.ts, helper module are pure additions atop the new constants module. Phase 76's first 3 plans are pure frontend type-shape catch-up that could have started in parallel with Phase 75. A two-track lane would have shaved a half day off the critical path.
- **No discuss-phase for Phase 77; design notes were rewritten mid-context.** Phase 77 jumped straight from "design notes in `notes/troll-openings-design.md`" to plans, then revised in `77-CONTEXT.md` ("backend Zobrist/TSV/frozenset approach is OUTDATED"). The original design note remains in tree as a misleading sibling. Future readers will hit the stale design note first.
- **133 quick-task entries without status frontmatter still showing as "open" in audits.** Carried forward from v1.10/v1.11/v1.12/v1.13 closes with the same disclaimer. Growing roughly +10/milestone. At some point this needs a one-shot script to backfill status frontmatter on the historical archive, or the audit's heuristic needs a bypass for entries with merged commits.

### Patterns Established
- **Effect size + confidence as separate UI cues.** Pioneered in v1.14: severity (effect size, color intensity) and confidence (precision, badge text + opacity mute) surfaced as orthogonal dimensions on the same finding. The user reads both at once. Reusable framing for any future ranked-discovery surface (LLM-narrated openings, endgame anomalies, rating-anomaly signals).
- **Trinomial Wald variance on chess scores, not binomial Wilson.** Future statistical work on FlawChess should default to trinomial Wald — chess is a 3-outcome game; the binomial approximation distorts the math when draws are non-trivial. `compute_confidence_bucket` is the canonical implementation.
- **Frontend-only matching for small read-only curated sets.** Phase 77 troll-opening matching established the pattern: side-only FEN piece-placement key, static data module, lookup once per render. Skips backend schema / API contract / migration / CI parity test. Use when the curated set is small (≤ 1000 entries), read-only, and doesn't need user-specific gating.
- **Decorative `<img>` watermark idiom.** Decorative `<img>` over CSS background — keeps the asset cacheable and lets browser handle scaling; `alt=""` + `aria-hidden="true"` + `pointer-events-none` keeps it out of the accessibility tree and doesn't block underlying interactivity.
- **CI structural assertion on shared helpers.** Beyond functional tests, assert *that there's only one implementation* of a cross-cutting helper. Cheap to write; prevents drift across refactors.
- **Mid-milestone hotfix PR.** When live-UI feedback reveals a polish-grade fix that's clearly load-bearing and not worth a new phase, ship inline. Pattern matches v1.13's quick-task hotfix loop.

### Key Lessons
1. **Smoke real data before locking statistical specs.** v1.14's three confidence-bucket pivots cost real REQUIREMENTS/code rewrites. A 30-min smoke on production-shape data during discuss-phase would have surfaced the right calibration first try.
2. **Compact milestones with one thesis ship faster than ambitious mixed-theme ones.** v1.14 (3 phases / 16 plans / 2 days, one conceptual move) compares favorably to v1.13's mixed scope.
3. **CI structural assertions complement functional tests.** Both Phase 75 and Phase 76 shipped CI tests that catch refactoring-induced *shape* violations, not just behavior bugs.
4. **Iteration via inline hotfixes / quick tasks is a feature.** PR #71 + four post-Phase-76 quick tasks iterated on the metric/sort/visual until the milestone felt right. Don't fight the iterative loop; structure for it.
5. **Off-roadmap-scope additions belong under the current milestone, not a hyphenated one.** Phase 77 folded into v1.14 directly rather than spawning v1.14.1.
6. **Stale design notes in tree are a future-reader trap.** Phase 77's pivot from backend to frontend matching left an outdated `notes/troll-openings-design.md` as a sibling. Either delete superseded design notes at decision time or annotate them with `> SUPERSEDED by <link>`.

### Cost Observations
- Sessions: ~7 conversations across the milestone window (discuss × 3 + plan × 3 + execute × 3 + verify × 3 + close × 1, with overlaps)
- Notable: Phase 76 ran an 8-plan parallel execute waveplan; Phase 77 ran a 4-plan / 2-wave execute. Parallel execution cut wall-clock by ~50% vs sequential.
- Sentry: zero new prod errors attributable to v1.14 changes through 2026-04-29 close. Score migration was clean.

---

## Milestone: v1.13 — Opening Insights

**Shipped:** 2026-04-27
**Phases:** 3 executed (70, 71, 71.1); Phases 72-74 descoped | **Plans:** 14 | **Delivered via:** PRs #66, #67, #68 (squash merges)
**Stats:** 106 files changed, +19,246 / -561 lines over 2 days (2026-04-26 → 2026-04-27)

### What Was Built
- Backend `opening_insights_service` with `POST /api/insights/openings` — single SQL transition aggregation per (user, color) over `game_positions` for entry plies in [3, 16]. LAG-window CTE on the new `ix_gp_user_game_ply (user_id, game_id, ply) INCLUDE (full_hash, move_san) WHERE ply BETWEEN 1 AND 17` partial composite covering index streams transitions as Index Only Scan with Heap Fetches: 0. `array_agg` window over rows BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING passes `entry_san_sequence` straight to the service — no extra roundtrip for FEN replay (Phase 70)
- Two-pass attribution: direct `query_openings_by_hashes` lookup on entry hashes; pass 2 batched query for parent-prefix hashes computed via `_compute_prefix_hashes()` with `ctypes.c_int64` signed-int64 conversion to match python-chess polyglot hashes (BLOCKER-2). Findings without direct or parent-lineage match are dropped, never surfaced as `<unnamed line>` placeholders. Sentry tag `openings.attribution.unmatched_dropped` captures drops for diagnosis (Phase 70)
- Strict `>` 0.55 win/loss boundary mirroring `frontend/src/lib/arrowColor.ts`; severity tier major (≥ 0.60) / minor in `(0.55, 0.60)`; CI test `test_opening_insights_arrow_consistency` enforces backend/frontend lock-step. `MIN_GAMES_PER_CANDIDATE = 20` evidence floor enforced at SQL HAVING level (Phase 70)
- Frontend `OpeningInsightsBlock` on Openings → Stats subtab with severity-accented `OpeningFindingCard` (DARK_RED / LIGHT_RED / DARK_GREEN / LIGHT_GREEN border, mirroring arrow colors), four-state rendering (loading skeleton, error, empty, populated), shared `LazyMiniBoard` thumbnail extracted from `GameCard` into `frontend/src/components/board/LazyMiniBoard.tsx` (Phase 71)
- Deep-link wiring — clicking a finding's Moves link replays `entry_san_sequence` through `chess.loadMoves()`, flips the board if `finding.color === 'black'`, applies the matching color filter with `matchSide: 'both'`, navigates to Move Explorer with the candidate row carrying a sticky severity tint + one-shot pulse from quick-task 260427-j41 (Phase 71)
- Openings page subnav layout refactor mid-milestone — desktop subnav lifted above `SidebarLayout` (mirrors Endgames pattern, `<Tabs>` wraps `<SidebarLayout>` so `TabsContent` context survives); mobile gains a sticky 4-tab subnav with filter button, board becomes non-sticky on Moves+Games and hidden on Stats+Insights, chevron-fold collapsible removed entirely; subtab switching resets scroll on both viewports (Phase 71.1)
- Pre-v1.13 quick task PRE-01 — dropped the parity filter from `query_top_openings_sql_wdl`, surfacing 1599 of 3301 white-defined ECO openings in the black top-10. Off-color rows now prefixed with `vs.` for clarity. Without this fix, the Phase 70 scan input would have been wrong from the start

### What Worked
- **Reuse-first phase planning.** Phase 70 plan structure was anchored on existing primitives (`apply_game_filters`, `query_top_openings_sql_wdl`, `game_positions` Zobrist hashes) and the v1.11 in-tab insights placement idiom. No new schema migrations on the analytics tables (only the new partial covering index). Made Phase 70 compact (5 plans) with low integration risk.
- **TDD with Wave 0 stubbed test scaffolding.** Phase 70 Plan 01 wrote failing tests against not-yet-existing services/routers using `pytest.importorskip` so the suite stayed collectable through Wave 1. Plans 02-05 each turned a wave green. The arrow-consistency CI test caught a frontend/backend threshold drift before merge.
- **Single SQL aggregation per (user, color), HAVING-side filtering.** Originally specified per-position recursion (D-15 redesign); collapsed to one transition CTE per color with HAVING enforcing both evidence floor and threshold at SQL level. No Python-side post-filter, no separate scan input. Latency stays under budget for typical users without precompute.
- **Mid-milestone Phase 71.1 insertion.** Frontend layout debt surfaced during Phase 71 UAT (Openings subnav diverged from Endgames subnav shape). Inserted Phase 71.1 to fix it in-milestone rather than carry the divergence into v1.14. Three plans, ~10 minutes wall-clock per plan, delivered in a half day. Cheaper than living with the inconsistency.
- **Mid-milestone scope-down on Phases 72/73/74.** After Phases 70+71+71.1 shipped (2026-04-27), spent time looking at the live UI: Move Explorer row tint already conveys the signal at the displayed position; per-finding cards already deliver per-opening actionable signal at finer granularity than an aggregate; bookmark-badge density risked alert fatigue. Descoping three planned phases on the day they would have started was the right call — a hypothetical "next milestone" planner who couldn't see the live UI couldn't have made it.
- **Quick-task hotfix loop kept v1.13 polished.** Six quick tasks landed during the milestone (PRE-01 + 260427-g4a..j41) — IllegalMoveError fix, whole-card-link → explicit-link split, candidate-move highlight, mobile link-placement adjustment, etc. Each was a sharp, atomic commit; the milestone shipped with no rough edges that real users would have hit immediately.

### What Was Inefficient
- **The v1.11 LLM stack went unused.** v1.13 deliberately kept LLM out of scope (templated/rule-based v1) but the `llm_logs` table, pydantic-ai Agent, and prompt-versioning machinery from v1.11 sat idle. Deferred is the right call (we don't yet know which findings are worth narrating), but the v1.11 retrospective's lesson — that LLM stack is a force multiplier — could have been weighed harder. Revisit in v1.13.x or v1.14 once real-user feedback identifies which findings are worth narrating.
- **`MIN_GAMES_PER_CANDIDATE` raised from n=10 (spec) to n=20 (D-15 redesign).** The original SEED-005 spec said n=10; live scanning at n=10 produced too many noisy "weakness" classifications on small samples (one bad week of blitz tilts a 0.55 loss-rate). The redesign to n=20 happened at Plan 70-04 / 70-05 time, requiring REQUIREMENTS / ROADMAP / CHANGELOG amendments (D-15/D-16/D-17). A small smoke at n=10 during discuss-phase would have surfaced the noise floor and saved the late amendments.
- **Whole-card touch target on `OpeningFindingCard` reverted twice.** Plan 71-04 specified the whole card as a single `<a href>` (D-22). Quick-task 260427-h3u then split this into explicit "Moves" + "Games" links because the whole-card target obscured which subtab opened. Live UX testing surfaced what the plan didn't anticipate. Pattern to watch: card-shaped UI with multiple potential destinations should default to explicit links from the start.
- **129 quick-task entries surfaced as "open" in pre-close audit.** Same as v1.12 — most are historical archive without status frontmatter. Audit tooling consistently misclassifies these. Should fix the audit query rather than re-acknowledge the same noise every milestone.

### Patterns Established
- **LAG-window transition CTE for chess-position scans.** When walking ply-ordered position sequences for a per-game property, use `func.lag(...).over(partition_by=game_id, order_by=ply)` plus a partial composite covering index aligned with the partition+order keys. Yields Index Only Scan with Heap Fetches: 0 at modest index size (~9% of table size with the right partial predicate).
- **`array_agg` window for trailing context.** When the consumer needs the prefix sequence (e.g., `entry_san_sequence` to replay the line), use `array_agg(...).over(partition_by=game_id, order_by=ply, rows=BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)` so the prefix lives on the same row as the entry. Eliminates a second roundtrip and a service-layer assembly.
- **Two-pass attribution with drop-on-miss.** When mapping computed structural keys (Zobrist hashes here) to a canonical reference, do (a) direct lookup and (b) batched parent-prefix lookup; drop entries that match neither. Don't surface `<unnamed line>` placeholders — they pollute the UX and grow over time.
- **Strict `>` boundary lock-step with frontend, enforced by CI.** When backend classification thresholds need to match a frontend visual (arrow color, badge color), pin the constants and add a CI test asserting they're equal. Prevents the most common drift class.
- **First migration in the project to use `postgresql_concurrently=True` + `autocommit_block`.** Required for index creation on a write-heavy table (`game_positions`) without locking out import. Captured rationale inline so future autogenerate doesn't reorder the partition columns "for symmetry" with sibling indexes. Reuse for any future write-table indexes.
- **Severity tier as a visual axis.** Two-level tier (major / minor) maps cleanly to dark / light variants of the same hue family. Composes with semantic colors (red weakness / green strength) into a 4-cell color palette. Reuse for any classification UI with severity gradients.

### Key Lessons
- **Verify n-floor with a smoke before locking it in spec.** SEED-005 said n=10; live data said n=20. A 5-minute `psql` query against dev DB during discuss-phase would have surfaced the noise floor and avoided the late spec amendments. Pattern: any classification threshold that hinges on noise floor needs at least one sample-driven sanity check before the spec is final.
- **Look at the live UI before locking the rest of the milestone scope.** v1.13 originally had Phases 72-74 planned. After Phases 70+71+71.1 shipped, the live UI made it obvious that 72 (inline bullets) was redundant with the existing row tint; 73 (aggregate) was duplicative of per-finding cards at finer granularity; 74 (bookmark badge) risked alert fatigue. None of these were visible from the spec — they only became visible after Phase 71 was on screen. Pattern: **after a frontend phase ships, audit the rest of the milestone against the live UI before starting the next phase.**
- **Quick-task loop is part of the milestone, not separate.** Six quick tasks shipped during v1.13. Treating quick tasks as first-class milestone work (with proper commit messages, CHANGELOG entries, and STATE.md tracking) kept the milestone polished. Don't relegate quick tasks to a separate "polish phase" — fold them in continuously.
- **Whole-card link defaults are wrong when the card has multiple destinations.** Future card components with deep-linking should default to explicit child links unless there's exactly one navigation target.

### Cost Observations
- v1.13 spanned 2 days of focused work (2026-04-26 → 2026-04-27) — same wall-clock as v1.12.
- Sessions: ~6 main sessions (3 plan-execute, 1 discuss-phase, 1 quick-task batch, 1 milestone close).
- Notable: 14 plans across 3 phases delivered in 2 days — the most plans-per-day of any milestone since v1.0. Driven by reuse-heavy phase shape (Phase 70 stands almost entirely on existing primitives) and TDD-with-Wave-0-scaffolding compressing the integration cycle.
- Notable: mid-milestone scope-down on Phases 72/73/74 saved an estimated 1-2 days of follow-up work that would have been thrown away once the live UI was inspected.

---

## Milestone: v1.12 — Benchmark DB Infrastructure & Ingestion Pipeline

**Shipped:** 2026-04-26
**Phases:** 1 executed (69) | **Plans:** 6 (5 fully executed + 1 with descoped sub-tasks) | **Delivered via:** PR #65 (squash merge)
**Stats:** 98 files changed, +13,440 / -1,740 lines, 51 commits over 2 days

### What Was Built
- Isolated `flawchess-benchmark` PostgreSQL 18 instance on port 5433, deployed via `docker-compose.benchmark.yml` with read-only MCP role and `bin/benchmark_db.sh` lifecycle script. Same canonical Alembic chain as dev/prod/test (no schema fork) — Lichess `[%eval` annotations populate the existing `game_positions.eval_cp` / `eval_mate` columns (Phase 69-01)
- Third read-only MCP server `flawchess-benchmark-db` registered and documented in `CLAUDE.md` Database Access section (Phase 69-03)
- Eval-presence pre-filter via streaming `zgrep` over the Lichess monthly PGN dump — the ~85% of dump games without `[%eval` headers never reach python-chess; selection scan walltime drops by an order of magnitude (Phase 69-04)
- Stratified subsampling at the player-opportunity level on (rating_bucket × time_control). 5 rating buckets × 4 TCs, separate `WhiteElo` / `BlackElo` per side; 90M games scanned, 491k qualifying (K=10 eval-bearing-game floor), 8,628 distinct players persisted across 20 cells (17/20 cells hit the 500-user cap) (Phase 69-04)
- Resumable per-user checkpoint orchestrator with idempotent inserts via the existing `(platform, platform_game_id)` unique constraint, SIGINT + SIGKILL safety, in-flight users picked up first on resume (Phase 69-05)
- Smoke-test ingest at `--per-cell 3` ran end-to-end against the live Lichess API. 60 terminal rows: 56 completed, 3 over_20k_games skips, 1 unexplained failure (deferred to SEED-006); 274,143 games and 19.4M positions imported in 3h 6min (Phase 69-06)
- Verification report at `reports/benchmark-db-phase69-verification-2026-04-26.md` covering all four Dimension-8 evidence sections plus storage budget projection (~205 GB at full `--per-cell 100` ingest, flagged for SEED-006 disk sizing) (Phase 69-06)

### What Worked
- **Mid-milestone scope-down was the right call.** Originally Phases 69-73; the realization (2026-04-26, 2 days before close) that the full benchmark ingest is days of wall-clock ops work, not a milestone gate, freed up v1.13 work and let v1.12 ship on a clean pipeline-correctness criterion. Treating ops work as a milestone gate was actively blocking unrelated planning.
- **Smoke-vs-spec catches design slips that discuss-phase can't.** The `eval_depth` + `eval_source_version` columns looked correct in plan 69-02 + decision context (D-12 etc.) — both assumed the Lichess API surfaces depth metadata. The smoke output proved otherwise immediately. Hot-patching the columns out (one Alembic migration, 5 source files) was lighter than running a corrective phase.
- **Player-opportunity bucketing on separate `WhiteElo`/`BlackElo`.** Each side independently classified into its own rating cell, never aggregated by a game-level rating field. Caught early in `/gsd-discuss-phase` (D-10/D-11), saved a structural rework downstream.
- **Per-user checkpoint table over byte-offset checkpoint.** Idempotent inserts on `(platform, platform_game_id)` made resumability trivial; SIGKILL during a batch leaves the user as `pending` and the resume logic picks it up first. Zero application-layer dedup needed.
- **`zgrep` eval pre-filter as the first stage.** Most of the Lichess dump (~85% of games) lacks `[%eval` headers entirely; pre-filtering at the text layer before python-chess sees the game cut selection-scan time from "overnight" to "morning coffee."
- **Phase 69 not split into 69 + 69.1.** Infrastructure (INFRA-01..03) and ingestion pipeline (INGEST-01..06) are tightly coupled (eval pre-filter presupposes schema decision; resumability checkpoint lives in the benchmark DB itself). Splitting would have forced a fake handoff.

### What Was Inefficient
- **Two add-then-drop columns inside the same milestone.** `games.eval_depth` and `games.eval_source_version` were added in plan 69-02 (migration `b11018499e4f`) and dropped in `6809b7c79eb3` after the smoke. The discuss-phase context (D-12) assumed Lichess API PGN includes depth like the dump exports do — it doesn't. A 5-minute `curl` against the API during discuss-phase would have prevented both the migration and the hot-patch. Lesson: **verify external API output with a sample before specifying schema**, especially when the source has multiple export channels (dump vs API).
- **Original v1.12 scope was overpacked.** 5 phases bundling infrastructure (1 phase) with applied analytics (4 phases) on a milestone whose hard dependency between halves is "the DB is fully populated" — a multi-day operational step. Should have split into v1.12 (infra + smoke) and a future milestone (analytics) at planning time, not 2 days before close.
- **Storage projection blew past INGEST-05's 50-100 GB target by 2x at modest `--per-cell 100`.** The original storage target was based on a per-endgame-type sample-unit before the 2026-04-25 pivot to per-cell distinct users (D-12). Should have re-derived storage at pivot time.

### Patterns Established
- **Verification-from-smoke.** Pipeline-correctness evidence comes from a small smoke run (e.g., `--per-cell 3`) rather than blocking on a full operational run. Document evidence in a per-phase verification report under `reports/`. Use this whenever the "real" run is operationally heavy and the smoke captures the same correctness invariants.
- **Hot-patch-mid-plan over corrective phase.** When a smoke run reveals a small surgical schema issue, hot-patch via Alembic + small source-file edits rather than spawning a corrective phase. Threshold: if the patch fits in <10 files and one migration, hot-patch; otherwise, plan a phase.
- **Streaming text pre-filter before structural parsing.** When ingesting from large external dumps with mixed-quality content, layer a streaming text filter (`zgrep`, ripgrep, etc.) before the heavy parser to drop unqualified rows early.
- **Ops tables via `create_all()` against the secondary engine.** When a benchmark/ops DB needs auxiliary tables that have no place in the canonical analytical schema (here: `benchmark_selected_users`, `benchmark_ingest_checkpoints`), create them via `Base.metadata.create_all()` against the secondary engine on first invocation. Don't pollute the canonical Alembic chain.
- **Same Alembic chain across dev/prod/test/benchmark.** Resist the temptation to fork the schema for the benchmark DB — keep one canonical chain and let the analytical columns serve both prod analysis and benchmark analysis.

### Key Lessons
- **Verify external API output with a sample before specifying schema.** Documentation about "depth available in PGN" was true for Lichess **dump** exports and false for **API** exports. A 5-minute sampling during discuss-phase would have saved one migration round-trip.
- **Operational steps don't belong in milestone gates.** Multi-day wall-clock work that doesn't change source code (population ingest, large data backfills) should live as ops scripts with their own SOPs, not as a phase a downstream milestone is gated on.
- **Plan smoke + ops as separate artifacts.** A smoke test proves correctness; the full-scale run is a separate operational task. Don't bundle them.

### Cost Observations
- Phase 69 spanned 2 days of focused work (2026-04-24 → 2026-04-26) plus the 3h 6min smoke wall-clock and ~3h discuss-phase context-gathering on 2026-04-25.
- Sessions: ~5 main sessions (4 plan-execute, 1 discuss + 1 close).
- Notable: the scope-down on 2026-04-26 happened mid-milestone via `/gsd-remove-phase` and a roadmap update. Keeping the deferred work in SEED-006 (rather than backlog or out-of-scope) preserved the design rationale for whenever the full ingest does run.

---

## Milestone: v1.11 — LLM-first Endgame Insights

**Shipped:** 2026-04-24
**Phases:** 5 executed (63, 64, 65, 66, 68); Phase 67 descoped | **Plans:** 23 | **Delivered via:** PR #61 (squash merge)

### What Was Built
- First LLM-backed feature in the codebase: `POST /api/insights/endgame` returning a structured `EndgameInsightsReport` (overview + up to 4 Section insights) via a pydantic-ai Agent, cached on findings_hash, rate-limited 3 misses/hr/user, soft-failing to last cached report (Phase 65)
- Deterministic findings pipeline: `compute_findings` transforms `/api/endgames/overview` into per-subsection-per-window `EndgameTabFindings` with zone/trend/sample-quality annotations + three cross-section flags, so the LLM reasons over pre-validated numbers (Phase 63)
- Shared zone registry (`app/services/endgame_zones.py`) as single source of truth; Python→TypeScript codegen script + CI drift guard prevents narrative-vs-chart drift by construction (Phase 63)
- Generic `llm_logs` table (18 cols, BigInteger PK, JSONB, FK CASCADE, 5 indexes including 3 composites with `created_at DESC`) designed up-front for every future LLM feature; async repo with `genai-prices` per-call cost accounting and `cost_unknown:<model>` soft-fallback (Phase 64)
- Frontend `EndgameInsightsBlock` with parent-lifted mutation state (no Context) — `Endgames.tsx` holds one `useEndgameInsights` mutation; the block + 4 `SectionInsightSlot` instances all observe the same state; inline per-section slot placement achieves H2-ride-along suppression for free (Phase 66)
- Dual-line "Endgame vs Non-Endgame Score over Time" chart with colored shaded gap replaces single-line Score Gap chart; prompt simplified (bumped to endgame_v14) since the chart makes gap composition self-evident (Phase 68)

### What Worked
- **Prompt versioning as the cache-invalidation handle** — bumping `_PROMPT_VERSION` (v6→v15 over the milestone) forced fresh generation without explicit cache flush. Iteration was cheap and auditable via git blame on the prompt file.
- **Zone registry + CI drift guard** — Python-side authoritative constants with a codegen'd TS mirror caught divergence at PR time, not at user-report time. Worth the upfront scaffolding.
- **Parent-lifted mutation state in Endgames.tsx** — avoided a Context provider; 4 slot instances observing the same mutation result was simpler than expected and cleanly survived H2-group re-renders.
- **Generic `llm_logs` over feature-specific** — designing the table up-front for every future LLM feature meant Phase 66 UI + later Insights expansion (Openings/Global Stats) require zero schema changes.
- **Pre-merge v1.11 milestone review by gsd-code-reviewer** — caught a critical failing test, a dead codegen pipeline (Phase 66 half-finished switchover), a stale prompt reference, and a stale CHANGELOG entry. Worth doing before every squash.
- **Quick-task loops for UAT feedback** — 260422-tnb, 260423-a4a, 260424-pc6 quick tasks iterated the prompt/schema without spawning new phases. Right tool for small-but-visible refinements.

### What Was Inefficient
- **Phase 67 descope was implicit, not planned** — insights were enabled for all users via commit `c91478e` without updating the roadmap or requirements. Result: VAL-01 and VAL-02 remained formally unchecked with no explicit tech-debt entry until milestone close. The plan-deviation should have been logged as a roadmap update at decision time.
- **Prompt revision churn inside the milestone** — v6→v15 across phases + multiple UAT quick tasks + a final cleanup pass bump (v15) suggests the initial prompt underspecified what the LLM needed to see. A spike might have paid for itself.
- **Two add-then-drop migrations in the same milestone** (`system_prompt`, `flags` columns) — both columns shipped in Phase 64 and were dropped within days. Decision-by-implementation rather than decision-by-design.
- **UAT artifacts are inconsistent** — Phase 68 HUMAN-UAT.md has 5 pending scenarios at close; Phase 66 VERIFICATION.md is `human_needed`. The `/gsd-verify-work` loop wasn't closed before merge.
- **Stale requirement checkboxes** — LOG-02/LOG-04 were implemented in Phase 65 but left unchecked in REQUIREMENTS.md traceability until milestone close. Phase summaries didn't include "requirements-checkbox-updated" in their definition-of-done.
- **Pre-existing ORM/DB column drift** (REAL→Float on 3 columns) surfaces on every Alembic autogenerate and was manually stripped from 3 v1.11 migrations. Deserves a dedicated cleanup migration, not ongoing handraising.

### Patterns Established
- **Prompt-as-file + prompt_version cache key** — all future LLM features should load system prompts from versioned files and include `prompt_version` in the cache key. Never string-literal prompts in `.py`.
- **One generic log table per LLM feature class** — `llm_logs` hosts every Agent call; `endpoint` column distinguishes consumers. New LLM features don't require new tables.
- **Environment-variable-driven model selection** — use `PYDANTIC_AI_MODEL_<FEATURE>` with startup validation (fail-fast on missing/invalid). Swap models for A/B without code changes.
- **Findings-hash cache + soft-fail rate limit** — 3 misses/hr/user with fallback to last cached report is the pattern for any user-triggered LLM endpoint.
- **Python-side registry with codegen'd TS mirror + CI drift guard** — every semantic constant shared between backend and frontend (zone thresholds, metric IDs, enum values) follows this pattern.
- **Parent-lifted mutation state for multi-slot LLM renderers** — when an LLM result feeds multiple visual slots on one page, hold the mutation in the parent and pass the result down as props rather than using Context.

### Key Lessons
- **Plan-deviations deserve an explicit roadmap update at the moment of the decision, not at milestone close.** Phase 67 was skipped in practice weeks before it was documented as skipped.
- **Every new LLM feature must ship with at least one snapshot regression test** — even if it's a single real-user fixture. Phase 67 was the guard that didn't happen; v1.12 should retrofit one.
- **Zone/threshold constants have exactly one authoritative home — enforced by CI.** The v1.11 consolidation pass retired four-way restatement (Python + codegen'd TS + throwaway regex test + 3 inline FE const blocks) down to one codegen'd source.
- **Pre-merge cohesion reviews catch things phase-level review misses** — files shipped but never imported, docstring-vs-code mismatches, CHANGELOG written before the final pivot. Worth running before every milestone squash.

### Cost Observations
- Prompt iteration (v6→v15) dominated API-cost variance; caching on findings_hash + prompt_version meant repeated testing at stable findings cost near-zero.
- Thinking tokens: diagnosed `thinking_tokens=NULL` as a `GEMINI_THINKING_LEVEL=low` config choice (quick task 260423-a4a), not a code bug.

---

## Milestone: v1.10 — Advanced Analytics

**Shipped:** 2026-04-19
**Phases:** 11 (48, 52-55, 57, 57.1, 59-62; Phase 56 cancelled, 58 moved to backlog) | **Plans:** 28 | **Delivered via:** PRs #38, #43, #47, #49, #50, #51, #52

### What Was Built
- Consolidated `/api/endgames/overview` endpoint serving every endgame chart in one round trip; 2-query timeline (GROUP BY game_id+endgame_class with HAVING count(ply)>=6) replaces 8 sequential per-class queries; pg_stat_statements top-offender dropped from 150-500s to sub-second (Phase 52)
- Endgame Score Gap & Material Breakdown: signed endgame-minus-non-endgame score plus 3-row bucket table (Ahead/Equal/Behind → later renamed Conversion/Parity/Recovery) with Good/OK/Bad verdicts calibrated against overall score (Phases 53, 59)
- Opponent-based self-calibrating baseline for Conv/Parity/Recov bullet charts — opponent's rate against the user (respecting all filters) replaces global-average, muted when opponent sample < 10 games (Phase 60)
- Time pressure analytics: per-time-control clock stats table with Games/My-avg/Opp-avg/Clock-diff/Net-timeout columns (Phase 54); two-line user-vs-opponents score chart across 10 time-remaining buckets per TC (Phase 55)
- Endgame ELO Timeline: skill-adjusted rating per (platform, time-control) combo paired with actual rating, asof-join anchor per combo, weekly volume bars for data-weight transparency, info popover framing it as skill-adjusted rather than performance rating (Phases 57 + 57.1)
- Conv/recov persistence filter: material imbalance required at entry AND 4 plies later, threshold 300cp → 100cp for a larger, less noisy dataset (Phase 48)
- Test suite hardening: `flawchess_test` TRUNCATE on session start, deterministic `seeded_user` module-scoped fixture, aggregation sanity tests (WDL perspective when user plays black, material tally direction on captures, rolling-window boundaries, platform × TC filter intersection, recency cutoff, within-game dedup, endgame transitions), router integration tests with exact integer assertions (Phase 61)
- Admin user impersonation: shadcn Command+Popover user search, POST /admin/impersonate, single auth_backend with ClaimAwareJWTStrategy wrapper preserving every `Depends(current_active_user)` call site, impersonation pill in header (desktop + mobile), last_login/last_activity frozen during impersonation, nested impersonation rejected via current_superuser dep (Phase 62)

### What Worked
- Consolidated overview endpoint + deferred desktop filter apply (matching mobile) solved the prod perf crisis cleanly — one response model, one hook, one round trip
- Single-pass `GROUP BY (game_id, endgame_class)` with Python-side dedup was both faster and simpler than UNION ALL — exploits existing `ix_gp_user_endgame_game` index
- Asof-join anchor on user's real rating (via `bisect_right` per combo) fixed the "Actual ELO as rolling mean confuses users" UAT feedback with one backend change — frontend just swapped to the new field
- ClaimAwareJWTStrategy wrapper pattern kept Phase 62 invisible to every existing auth dep — zero changes at call sites, impersonation enabled entirely in the strategy + admin routes
- Splitting Phase 57 (initial chart) from Phase 57.1 (UAT-driven polish) was the right call — clean history, clear rationale for each change, and Phase 57.1 could reference UAT evidence explicitly
- Seeded_user module-scoped fixture → deterministic integer assertions → router integration tests could be written against *known* numbers rather than shape-only — caught two genuine bugs worth follow-up phases
- Mid-milestone rename to Conversion/Parity/Recovery (via quick tasks 260413-pwv + 260415-q75) was done in small text-only passes rather than a big-bang rename commit — kept git history readable

### What Was Inefficient
- Two naming storms on material buckets (ahead/equal/behind → conversion/even/recovery → conversion/parity/recovery) forced three passes across backend schemas, Pydantic literals, frontend copy, and info popovers — should have nailed terminology in the Phase 53 discuss-phase
- Phase 60-02 and all of Phase 61 have no SUMMARY.md files despite being complete — artifact hygiene gap that makes retroactive extraction harder
- Phase 57 inlined `_endgame_skill_from_bucket_rows` in `endgame_service.py` as a port of the frontend `endgameSkill()` with a TODO to dedup when Phase 56's backend `endgame_skill()` landed — Phase 56 was later cancelled, making the TODO orphaned
- Time pressure analytics required three follow-up quick tasks (260414-u88 aggregate TCs, 260414-pv4 fix whole-game rule, 260416-pkx backend aggregation) before settling — the initial plan underspecified the aggregation layer
- Phase 52's `52-03` prod verification plan was deferred (validated informally post-deploy) — missed the discipline of explicit pg_stat_statements before/after capture
- Phase 48 phase directory appears to have been cleaned from .planning/phases before archive — archive built from roadmap content alone, not from phase artifacts

### Patterns Established
- **One consolidated overview endpoint per tab** — for pages with >3 charts sharing the same filter set, consolidate server-side on one AsyncSession rather than fanning out; use one TanStack Query hook on the frontend
- **Deferred filter apply on desktop matching mobile** — for filter sidebars that can push many filter changes, apply on sidebar close, not on every change; avoids query storm and reduces user confusion
- **Weekly volume bars on timeline charts** — every new timeline chart (Endgame ELO, Clock Diff, Score Diff, Win Rate by Endgame Type) now renders a muted bar series showing per-week games; gives users a weight signal at every point
- **Asof-join for per-combo anchors** — when a timeline needs to anchor on a slowly-changing value (user's rating per platform+TC), pre-sort rows by date and `bisect_right` per emitted date instead of a rolling mean
- **ClaimAwareJWTStrategy wrapper** — feature-flag auth variants (impersonation, future: team membership, SSO claims) behind a strategy wrapper around the base JWTStrategy; keeps every existing `Depends(current_active_user)` call site unchanged
- **Seeded portfolio + router integration tests** — for aggregation-heavy endpoints, a module-scoped fixture with a known ~15-game portfolio (black/white/bullet/blitz/rapid/classical/chess.com/lichess/wins/draws/losses) enables "known seed → known numbers" integration tests
- **TRUNCATE on pytest session start** — deterministic DB state, no flaky accumulation, old runs remain inspectable until next session

### Key Lessons
1. **Nail semantic naming in discuss-phase.** Material buckets went through three rename passes mid-milestone (ahead/equal/behind → conversion/even/recovery → conversion/parity/recovery). Each rename touched backend schemas, Pydantic literals, frontend copy, info popovers, and tests. A 15-minute terminology check in the Phase 53 discuss-phase would have saved ~2 hours of rename churn.
2. **Summary hygiene slips when momentum is high.** Phases 60-02 and all of Phase 61 have no SUMMARY.md. Neither blocks shipping, but retroactive archive extraction is harder and post-mortem learnings are thinner. Consider a git hook or pre-PR check that blocks merge without a SUMMARY.md per plan.
3. **UAT catches what the planner misses.** Phase 57's "rolling-mean Actual ELO" shipped reviewer-approved and verifier-passed, yet was visibly wrong to the user on first interaction. The asof-join fix (Phase 57.1) is a clean demonstration of why UAT is worth the extra phase — and why 57.1 as a separate decimal phase beat a late revision to 57.
4. **Consolidate read paths ruthlessly.** The v1.10 perf crisis came from frontend fan-out — 4 parallel requests × 8-per-class queries each. A single response model + single session + single hook fixed it. Every multi-chart page should start with that shape.
5. **Performance measurements need before/after discipline.** Phase 52's success criterion (9) mentioned pg_stat_statements verification but plan 52-03 was deferred and done "informally." For production perf work, capture the metric explicitly before merging — otherwise post-hoc "feels faster" replaces real evidence.
6. **Phase cancellation and backlog promotion are first-class moves.** Retiring Phase 56 (subsumed by 57) and bumping Phase 58 to backlog (999.6) via one small quick task kept v1.10 focused and honest. Don't force scope to match a pre-written roadmap when the work itself tells you the shape has shifted.

### Cost Observations
- 11 phases, 28 plans, 124 commits across ~12 days (2026-04-07 → 2026-04-19)
- 249 files changed, +54835 / -1852 lines (includes generated artifacts, theme screenshots, and planning docs)
- ~20 quick tasks landed on top of phases for iterative polish (mostly styling, renaming, chart tweaks) — quick tasks worked well as "the code is right, the copy/layout needs a pass" vehicles
- Decimal phase (57.1) was the right structure for UAT-driven scope expansion — separate plan files, separate commit, clear rationale
- Phase 62 (5 plans) was the largest; Phases 48, 53-55, 57, 57.1, 60 were each 2 plans — 2-plan is the median unit for a frontend+backend feature on this project

---

## Milestone: v1.9 — UI/UX Restructuring

**Shipped:** 2026-04-10
**Phases:** 3 (49-51) | **Plans:** 7 | **Delivered via:** PRs #40, #41, #42

### What Was Built
- Openings desktop sidebar: collapsible 48px icon strip + 280px on-demand Filters/Bookmarks panel with overlay/push behavior at the 1280px breakpoint, plus a shared SidebarLayout component used by both Openings and Global Stats
- Openings mobile unified control row: Tabs | Color | Bookmark | Filter lifted outside the board collapse grid so controls stay visible when the board is collapsed; 5-item vertical board-action column with 48×48 touch targets; 44px tappable collapse handle; backdrop-blur sticky surface
- Endgames mobile visual alignment: 44px backdrop-blur sticky row with 44px filter button matching the Openings mobile pattern (EGAM-01)
- Global Stats filters wired end-to-end: `opponent_type` + `opponent_strength` through `/stats/global` and `/stats/rating-history` plus the React hooks/API client layer; bot games now excluded by default
- Stats subtab 2-col layout: explicit leftRows/rightRows grid split for Bookmarked Results at the lg breakpoint; new `MobileMostPlayedRows` component for stacked WDLChartRows on mobile
- Homepage 2-column desktop hero: left hero content + right Interactive Opening Explorer preview (heading + screenshot + bullets); pills row removed; Opening Explorer removed from FEATURES list
- Global Stats rename: "Stats" → "Global Stats" across desktop nav, mobile bottom bar, More drawer, mobile page header, plus new page h1 — all driven via existing label-to-testid auto-derivation so testids updated with zero manual edits

### What Worked
- Label-to-testid auto-derivation meant the "Stats" → "Global Stats" rename needed only 3 label string swaps in `App.tsx`; all nav testids, mobile header title, and More drawer entries updated automatically
- Explicit `leftRows`/`rightRows` array split beat CSS `columns-2` for the 2-col Bookmarked Results — deterministic odd-count behavior, no `break-inside` edge cases
- Unified mobile control row lifted outside the board collapse region (D-03) solved the "controls disappear when board collapsed" problem cleanly — one structural change, no prop plumbing
- Shared SidebarLayout component emerged organically from Phase 49 and was immediately reusable for Phase 51-04's Global Stats FilterPanel placement
- Plan 51-01 wiring opponent filters first, Plan 51-04 enabling the UI controls second — kept each plan small and let the end-to-end path come online in two independent commits
- Static 2-col homepage hero (not a carousel) — simpler, no JS state, preserves scroll-free visibility on a 1280px viewport

### What Was Inefficient
- `gsd-tools milestone complete` hard-coded "Phases completed: 4 phases" and copied the full ROADMAP.md verbatim into the v1.9 archive — required manual rewrite of the archive file plus MILESTONES.md entry
- `summary-extract --fields one_liner` returned null or "One-liner:" for 5 of 7 summary files because the summaries use an H2 heading format rather than the YAML field the CLI expects — accomplishments had to be re-extracted by hand
- ROADMAP.md left `[ ] 51-04-PLAN.md` unchecked even after the phase shipped (PR #42 merged) — post-ship state drift between the roadmap checkbox and the actual commit/summary state
- Worktree Plan 51-04 execution started from the wrong HEAD (`45c5b80` instead of `f77dbf3`) and required a `git reset --soft` + `git checkout HEAD -- .` to recover — worktree initialization edge case worth investigating in `gsd-tools`

### Patterns Established
- **Label-driven testid derivation** — keep `NAV_ITEMS[].label` as the single source of truth and derive testids via `label.toLowerCase().replace(/\s+/g, '-')`; renames cost one label edit
- **Unified control row outside collapse region** — when a collapsible section hides controls needed for navigation (like subtabs), lift them into a sibling of the collapse grid rather than inside it
- **Grid-column push/overlay breakpoint** — at 1280px, the Openings sidebar switches from overlay (for ≤1279px) to push (for ≥1280px); this is now the project's reference breakpoint for sidebar-plus-board layouts
- **Shared SidebarLayout component** — any future page that needs a collapsible left strip with Filters should consume SidebarLayout rather than reimplementing
- **Viewport branch at call site, not via prop** — when desktop and mobile need different variants of a component, branch at the page (`hidden md:block` / `md:hidden`) rather than adding a `mobileMode` prop; keeps the desktop component byte-identical and zero-risk

### Key Lessons
1. **CLI milestone archival is a first draft, not a final document.** `gsd-tools milestone complete` creates skeletal archive files and a MILESTONES.md stub, but the accomplishments list, phase count, and archive structure need human cleanup for every milestone — budget 10-15 minutes for the rewrite
2. **Summary extraction depends on file format discipline.** If summaries use H2 `## One-liner` headings instead of YAML frontmatter fields, the extractor returns null. Either standardize on one format or the tooling needs to fall back between both
3. **Post-ship checkbox drift is the norm unless explicitly maintained.** When a PR merges, the ROADMAP plan checkboxes don't auto-update — the next milestone completion pass must reconcile them or add a tooling gate
4. **Mobile-first visual-alignment passes are cheap once a pattern exists.** Phase 50-02 (Endgames visual alignment) was 3 classname swaps + 1 testid — ~10 minutes because Phase 50-01 had already established the `h-11 bg-background/80 backdrop-blur-md` pattern
5. **The "apply to mobile too" CLAUDE.md rule is load-bearing.** Phase 51-04's FilterPanel visibleFilters change updated both the desktop SidebarLayout and the mobile Drawer instances — missing one would have silently diverged the two viewports

### Cost Observations
- 3 phases, 7 plans, ~21-hour execution window end-to-end (2026-04-09 21:42 → 2026-04-10 18:43)
- 57 files changed, +8692 / -1602 lines
- Each phase was delivered in its own PR (#40, #41, #42) with squash merge — clean main history, easy rollback granularity
- Plans stayed small: median 1 plan per phase for 49, 2 for 50, 4 for 51 — the 4-plan split on Phase 51 was the right call because the 4 concerns (opponent filter wiring, stats layout, homepage hero, Global Stats rename) had distinct code surfaces and minimal coupling

---

## Milestone: v1.8 — Guest Access

**Shipped:** 2026-04-06
**Phases:** 4 | **Delivered via:** PR #37

### What Was Built
- Guest session foundation: is_guest User model flag, JWT-based guest sessions with 30-day auto-refresh, IP rate limiting
- Guest frontend: "Use as Guest" buttons on homepage and auth page, persistent guest banner
- Email/password promotion: backend promotion service, register-page promotion flow preserving all imported data
- Google SSO promotion: OAuth promotion route with guest identity preservation across redirect, email collision handling
- Security: CVE-2025-68481 Google OAuth CSRF vulnerability patched with double-submit cookie validation
- UX polish: import page guest guard, auth page logo linking, delete button disabled during active imports

### What Worked
- Guest as first-class User row (is_guest=True) — promotion is a single UPDATE, no FK migration needed
- Bearer transport for guest JWTs — avoided dual-transport complexity entirely
- Register-page promotion instead of separate modal — reused existing form, cleaner UX, less code
- PR-based workflow (feature branch → squash merge) kept main clean during multi-phase development

### What Was Inefficient
- Entire milestone developed outside GSD discuss→plan→execute workflow — no SUMMARY.md, VERIFICATION.md, or PLAN.md files exist for phases 44-47
- GSD state tracking stayed at 0% despite all work being complete — planning artifacts diverged from actual progress
- Quick tasks (UI polish commits between roadmap creation and PR merge) weren't tracked in any GSD artifact

### Patterns Established
- Guest user pattern: is_guest flag on User model, synthetic email (`@guest.local`), promotion via in-place UPDATE
- OAuth CSRF protection: double-submit cookie pattern for all OAuth callbacks
- Import guard: disable destructive actions (delete) while import is running

### Key Lessons
1. When developing outside GSD's formal workflow (e.g., rapid feature branch work), the planning artifacts become stale immediately — either commit to the workflow or accept the tracking gap
2. Guest-as-User-row is much simpler than a separate guest model — promotion is trivial, no FK migration, no special-casing in queries
3. Register-page promotion beats a dedicated modal — reuses existing validation, error handling, and styling

---

## Milestone: v1.3 — Project Launch

**Shipped:** 2026-03-22
**Phases:** 4 | **Plans:** 10

### What Was Built
- Full rebrand from Chessalytics to FlawChess (20 files, PWA manifest, logo, GitHub org transfer)
- Docker Compose production stack: multi-stage Dockerfiles, Caddy auto-TLS, entrypoint with auto-migrations
- Deployed to Hetzner VPS (CX32, 2 vCPUs, 3.7GB RAM) at flawchess.com
- GitHub Actions CI/CD: test + lint + SSH deploy + health check polling
- Sentry error monitoring on both FastAPI backend and React frontend
- Public homepage with feature sections, FAQ, register/login CTA
- SEO fundamentals: meta tags, Open Graph, robots.txt, sitemap.xml
- Privacy policy page at /privacy
- Per-platform rate limiter (asyncio.Semaphore) for chess.com/lichess import protection
- Professional README with screenshots and self-hosting instructions
- 14 quick tasks: lichess import fix, arrow sorting, tooltip→popover, mobile UX, board controls, tab renaming, filter heights, bookmarks, /api prefix, brown theme, new-user routing, README, time control fix, WDL bar fix

### What Worked
- Deployment-first ordering (Phase 21 before 22/23) meant CI/CD and launch readiness could be tested against the live server
- Cloud-init + Docker Compose gave a reproducible single-command server setup
- Caddy as sole internet-facing entry point simplified TLS and routing (no nginx config)
- asyncio.Semaphore for rate limiting avoided adding Redis/Celery infrastructure
- Quick tasks handled all post-launch polish (14 tasks) without disrupting phase work
- Swap file added reactively when PostgreSQL OOM-killed during large import — proactive monitoring would have been better

### What Was Inefficient
- Plan 21-02 (cloud-init cleanup + deploy checkpoint) was never formally executed — deployment happened organically during 21-01 and manual setup. Skipped at milestone completion.
- Some SUMMARY.md files have poor/missing one_liner frontmatter fields — summary-extract continues to return null
- Phase 22 plan checkboxes in ROADMAP.md were never updated to [x] despite being complete — bookkeeping drift from manual execution
- OOM kill on production required emergency swap file and batch size reduction — should have configured swap in cloud-init from the start

### Patterns Established
- `ENVIRONMENT` env var controlling CORS (disabled in production, enabled in dev)
- Backend `expose` only in docker-compose.yml (no `ports`) — Caddy proxies all traffic
- Sentry DSN injected at Docker build time via `ARG`/`ENV` for frontend bundle
- `_BATCH_SIZE = 10` for import to prevent OOM on constrained servers
- asyncio.Semaphore lazy-init pattern to avoid event loop not started error

### Key Lessons
1. Production memory constraints matter — 3.7GB RAM with PostgreSQL + FastAPI + Caddy is tight; swap is essential from day one
2. Human verification checkpoints (deploy steps) don't fit well into automated execution — they should be separate milestone gates, not plans
3. Caddy is excellent for small deployments — auto-TLS, reverse proxy, static file serving in one config
4. Rate limiter design should match the bottleneck — per-platform semaphore is simpler than global queue for chess.com/lichess with different rate limits

---

## Milestone: v1.2 — Mobile & PWA

**Shipped:** 2026-03-21
**Phases:** 3 | **Plans:** 5

### What Was Built
- PWA with service worker, chess-themed icons, Workbox caching (NetworkOnly for API)
- Mobile bottom navigation bar with direct tabs + "More" drawer (vaul-based)
- Click-to-move chessboard on touch devices with sticky board on Openings page
- 44px touch targets on all interactive elements, overflow fixes at 375px
- Android/iOS in-app install prompts (beforeinstallprompt + manual iOS banner)
- Dev workflow: LAN hosting + Cloudflare Tunnel for HTTPS phone testing
- 7 quick tasks: lichess import fix, arrow sorting, tooltip→popover, mobile card layouts, board controls reorder, tab renaming, filter height consistency

### What Worked
- Frontend-only milestone scope (no backend/API changes) kept complexity low and iteration fast
- Pure Tailwind `sm:` breakpoints for mobile/desktop switching — no JS detection needed
- vaul library for drawer component — handled scroll lock, backdrop, iOS momentum out of the box
- Quick tasks handled all polish (tab renaming, button heights, card layouts) without phase overhead
- Duplicating mobile Openings layout (vs trying to make one layout responsive) avoided fighting sticky positioning

### What Was Inefficient
- react-chessboard drag-and-drop caused persistent black screen on mobile — spent multiple iterations trying to fix before disabling drag entirely
- Touch target sizing required understanding CSS specificity interactions between component libraries (shadcn's data-attribute selectors) and custom classes — `min-h-11` vs `h-11` vs `h-11!` depending on component
- summary-extract CLI still returns null for one_liner — SUMMARY.md files lack the expected frontmatter field

### Patterns Established
- `min-h-11 sm:min-h-0` pattern for ToggleGroupItem/SelectTrigger mobile touch targets (min-height overrides component's fixed height)
- `h-11 sm:h-7` for custom buttons to match ToggleGroup/Select heights exactly
- `h-11!` (Tailwind important) when overriding data-attribute-based component styles (e.g., TabsList)
- `h-11 w-11 sm:h-8 sm:w-8` for icon-only buttons (44px mobile, 32px desktop)
- `allowDragging: false` + onSquareClick for mobile chessboard interaction
- `bg-muted/50 hover:bg-muted! border border-border/40` for collapsible trigger styling

### Key Lessons
1. Disable drag-and-drop early on mobile — HTML5 DnD simply doesn't work on iOS Safari, and react-chessboard's touch handling causes rendering bugs
2. CSS specificity matters with component libraries — shadcn uses `data-[size=sm]:h-7` which beats plain `h-7`; use `min-h` to override or Tailwind's `!` modifier
3. Mobile layout duplication is sometimes the right trade-off — fighting CSS to make one responsive layout work everywhere costs more than maintaining two clear layouts
4. Quick tasks are ideal for mobile polish — button heights, tab names, card layouts are all self-contained changes that don't warrant phase planning

---

## Milestone: v1.1 — Opening Explorer & UI Restructuring

**Shipped:** 2026-03-20
**Phases:** 6 | **Plans:** 15

### What Was Built
- Move explorer: next-move W/D/L stats, click-to-navigate, transposition warnings, board arrows
- UI restructuring: tabbed Openings hub, dedicated Import page, shared filter sidebar
- Enhanced import: clock data, termination, time control fix, username-scoped sync
- Game cards: 3-row layout, lucide-react icons, hover/tap minimap, null-safe metadata
- Bug fixes: data isolation, Google SSO last_login, cache clearing

### What Worked
- Phase dependency chain (11→12→13→14→15→16) allowed clean incremental delivery
- Human verification phase (14-03) caught real issues: hooks ordering bug, tab naming, import page redesign
- Quick tasks (19 total) handled polish effectively without disrupting phase work
- DB wipe decision removed migration complexity entirely for v1.1

### What Was Inefficient
- Phase 15 was renumbered mid-milestone (chart consolidation replaced by enhanced import data) — caused confusion in file naming with two "15-*" directories
- GCUI requirements were left at "Planned" status in traceability table despite being complete — bookkeeping drift
- summary-extract CLI returned null for one_liner fields — summaries lacked structured frontmatter fields

### Patterns Established
- Tab content as JSX variables (defined before return, reused in multiple Tabs instances)
- QueryClient singleton pattern for cross-cutting auth/cache concerns
- Username-scoped sync boundaries for multi-username import
- Single TooltipProvider wrapping lists to avoid per-item context overhead

### Key Lessons
1. Phase renumbering creates file system confusion — prefer adding at end (Phase 16) over replacing existing phase numbers
2. Human verification phases catch real bugs that automated tests miss (hooks ordering, UX issues)
3. Quick tasks are effective for UI polish during milestone execution — keeps phase scope clean

---

## Milestone: v1.6 — UI Polish & Improvements

**Shipped:** 2026-03-30
**Phases:** 6 | **Plans:** 11

### What Was Built
- Centralized theme system: CSS variables, brand-brown/charcoal Tailwind utilities, SVG feTurbulence noise texture class
- Charcoal containers with noise texture applied across all pages, brand subtab highlighting
- Shared WDLChartRow component replacing all inconsistent WDL chart implementations (custom bars, Recharts)
- Openings reference table: 3641 entries from TSV dataset, openings_dedup view, SQL-side WDL aggregation
- Most Played Openings redesign: top 10 per color, filter support, dedicated table UI, minimap popover
- Opening Statistics rework: section reordering, default chart data from most-played when no bookmarks, chart-enable toggle
- Bookmark card redesign: bigger minimap (72px), chart-enable toggle in button row, suggestions from most-played data
- Mobile drawer sidebars: Vaul-based right-side drawers for filters and bookmarks, deferred filter apply on close
- 26 quick tasks across the milestone

### What Worked
- Theme-first phase ordering (34→35→36→37→38→39) meant each phase built on the previous — shared components before consuming features
- WDL chart refactoring (Phase 35) paid off immediately — Phases 36-38 could use WDLChartRow without reimplementing
- SQL-side WDL aggregation (func.count.filter) moved counting from Python loops to SQL, measurable performance improvement
- Deferred filter apply pattern on mobile prevents API spam — filters accumulate, single request on sidebar close
- PR-based workflow for phases kept main clean while allowing iterative development

### What Was Inefficient
- Traceability table in REQUIREMENTS.md went stale — ORT-03 was implemented but unchecked, MOB-01-07 showed "Not started" despite completion
- Phase count in MILESTONES.md shows 8 instead of 6 (includes backlog phases in count) — CLI counting is approximate
- No milestone audit was run before completion — requirement drift went undetected until manual check

### Patterns Established
- `charcoal-texture` CSS class for consistent container styling with SVG noise
- WDLChartRow as single source of truth for all WDL visualizations
- Deferred state pattern: local state in sidebar, commit on close
- Openings reference table with precomputed FEN/ply_count for position lookup
- chart-enable toggle with localStorage persistence for user preferences

### Key Lessons
1. Requirement traceability tables need automated updates — manual status tracking drifts as soon as execution begins
2. Theme/component infrastructure phases early in a UI milestone pay compound dividends across subsequent phases
3. Milestone audits should be run proactively, not skipped — catching stale requirements at completion adds unnecessary friction
4. SQL-side aggregation (func.count.filter) is worth the migration cost — Python-side counting doesn't scale

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 10 | 36 | Established GSD workflow, phase/plan structure |
| v1.1 | 6 | 15 | Added human verification phases, heavy quick task usage |
| v1.2 | 3 | 5 | Frontend-only scope, mobile-first patterns, CSS specificity lessons |
| v1.3 | 4 | 10 | First production deployment, CI/CD, monitoring, launch readiness, 14 quick tasks |
| v1.4 | 1 | 2 | Self-hosted Umami analytics, minimal-scope milestone |
| v1.5 | 9 | 18 | Backend-heavy: position classifier, endgame analytics, engine analysis import |
| v1.6 | 6 | 11 | UI polish: theme system, shared components, openings table, mobile drawers, 26 quick tasks |
| v1.7 | 6 | 11 | Consolidation: ty type checking, knip dead exports, import speed 2x, SQL aggregations |
| v1.8 | 4 | N/A | Guest access via feature branch + PR, outside GSD workflow — no formal plans |
| v1.9 | 3 | 7 | UI/UX restructuring: openings sidebar, mobile layouts, stats subtab |
| v1.10 | 11 | 28 | Advanced endgame analytics: score gap, time pressure, ELO timeline, admin impersonation |
| v1.11 | 5 | 23 | LLM-first endgame insights: pydantic-ai Agent, llm_logs table, dual-line score chart |
| v1.12 | 1 | 6 | Benchmark DB infrastructure & ingestion pipeline; scope-down deferred analysis phases to SEED-006 |
| v1.13 | 3 | 14 | Templated opening insights: SQL transition aggregation, deep-link wiring, subnav refactor |
| v1.14 | 3 | 16 | Score-based opening insights: trinomial Wald confidence, effect size + confidence as orthogonal cues, troll watermark |
| v1.15 | 2 | 10 | Eval-based endgame classification: Stockfish hard cutover, per-position phase column, proxy deleted |
| v1.16 | 5 | 24 | Stockfish eval analyses: opening-stats eval column, transposition WDL, Start-vs-End tiles, LLM prompt awareness |
| v1.17 | 13 | ~54 | Endgame stats card redesign → statistical-rigor pass; inserted-decimal cadence absorbed a 5→13 phase scope expansion; Endgame Skill dropped, ELO rebuilt as invariant-preserving logistic stretch |
| v2.0 | 9 | 24 | Client-side practical-play engine (Maia-weighted expectimax-in-MCTS over a Stockfish.wasm pool); pure-core-first-against-fake-providers build order; scope drifted 153–159 → 153–161 (artifact-free 160 bucket + SEED-088 161); visual UAT batch-deferred to close |
| v2.6 | 3 | 10 | Measurement-as-deliverable milestone; calibrate the anchor scale before measuring on it; phases regrouped into the milestone retroactively (archival CLI needed `--force`) |
| v2.9 | 6 | 31 | First new top-level product surface since v2.0; backend-first against no frontend; blocking human UAT as the last plan of a phase (found 8 real defects across 190/191); a third of the plan budget spent correcting decisions made inside the same milestone (190.1, 192, 193) |

### Top Lessons (Verified Across Milestones)

1. DB wipe for schema changes is worth it in early development — migration complexity slows iteration
2. Human verification catches integration issues that unit tests miss
3. Quick tasks are the right tool for UI polish — confirmed across v1.1 (19 tasks), v1.2 (7 tasks), v1.3 (14 tasks), v1.6 (26 tasks)
4. CSS specificity with component libraries requires understanding the full chain — min-h/h/important patterns now documented
5. Production memory constraints need upfront planning — swap file and batch size tuning should be in initial deployment config
6. Human verification checkpoints (manual deploy steps) don't fit automated plan execution — use milestone gates instead
7. Infrastructure-first ordering pays off — theme/shared components early in UI milestones, DB schema early in backend milestones
8. Requirement traceability tables drift under manual maintenance — consider automated status syncing
9. Compact milestones with one conceptual move ship faster than mixed-theme ones (v1.4, v1.12, v1.14 all shipped in 1-3 days)
10. CI structural assertions (single-implementation, threshold lock-step) catch refactoring drift cheaply (v1.13 + v1.14)
11. Iteration via inline hotfixes / quick tasks is a feature — don't fight it, structure for it (v1.13 + v1.14 both used the inline hotfix loop to land calibrated end states that pre-locked specs couldn't have)
12. Smoke real data before locking statistical specs — v1.14's three confidence-bucket pivots cost real REQUIREMENTS rewrites that a 30-min discuss-phase smoke would have prevented
13. Check derived/peer metrics for algebraic degeneracy before building the UI — v1.17's Conv-Gap ≡ Recov-Gap mirror identity was provable on paper; a composite "skill" number is a trap unless it survives cohort-deconfound + individual-interpretation + temporal-stability + median-coincide simultaneously
14. Keep the ROADMAP `<details>` block current as phases ship even when pushing direct-to-main — v1.17 reconciled 13 stale "planned" entries at close, which is error-prone
15. Test the load-bearing assumption against one real row before building on it — v2.9's "non-gem means several fine moves" was checkable in minutes and instead cost a five-plan correction phase (192)
16. When one search can source every displayed number, make it structural rather than reconciled — the same fix landed twice (v2.0 Phase 158 for `/analysis`, v2.9 Phase 190.1 for Train)
17. A blocking human UAT gate as the last plan of a phase earns its cost — v2.9 Phases 190 and 191 surfaced 8 real defects between them, none reachable from jsdom or pytest
18. Human-verification items need an owner and a due point, not just an honest flag — v2.9 Phase 193's three UAT checks sat unresolved until the milestone close happened to ask
