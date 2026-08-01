# Milestones: FlawChess

## v2.10 FlawChess Engine Improvements (Shipped: 2026-08-01)

**Phases completed:** 6 phases (194, 195, 196, 197, 198, 199), 29 plans, 19 squash-merged commits over 3 days (240 files, +48,561 / −602 since `v2.9`)

**Delivered:** The engine got measurably faster where it was structurally wasteful, two attractive-looking optimizations were measured and deliberately *not* shipped, and bot strength was re-verified against the engine that actually ships — so the difficulty labels users see are known-honest rather than assumed-still-valid.

**Key accomplishments:**

- **Phase 194 — Engine main-thread + cache hygiene (SEED-126 Phases 2–5, 4 plans, CACHE-01..06).** Single-pass policy conversion instead of per-move re-parsing, lazily-built board snapshots, abort-aware search so abandoning a position actually cancels queued Stockfish grading instead of letting it run to completion, and right-sized caches so long analysis sessions stop evicting results they are about to need. Two removal candidates SEED-126 flagged were deliberately *retained* with in-code notes naming their downstream consumer (`wdlByElo` → 197, `workerPool` priority queue → 198).
- **Phase 195 — Depth-scaled grading ladder (SEED-126 Phase 1, 6 plans, LADDER-01..05).** Positions deep in the search tree are graded at a shallower Stockfish depth chosen from measurement rather than every position at full depth, preserving move quality. A follow-up measurement tightened the ladder to roughly 1.4× faster searches end to end.
- **Phase 196 — Analysis-board Stockfish root injection (SEED-118, 3 plans, INJECT-01..07).** Stockfish's recommended move is now reliably among the candidates the practical engine considers; it could previously be dropped twice (probability-mass cut, then root-candidate cap), so the "what would the engine play instead" comparison went missing exactly when the disagreement mattered most. The phase also **corrected its own premise in REQUIREMENTS.md**: the disagreement re-run had been specified as "largely a cache replay", and measurement contradicted that for production (the 79.1% harness hit rate assumes two completed searches sharing a cache; the browser aborts ~1.7–2s in, giving a ~4.5% ceiling). Later phases were explicitly barred from assuming a cheap re-run.
- **Phase 197 — Maia WDL leaf values (SEED-126 Phase 6, 4 plans). LEAF-01 rejected at a pre-declared gate.** Using Maia's own win/draw/loss estimate as the value of deep search-tree leaves was measured end to end and rejected: it goes blind to forced tactics. The six supporting requirements shipped; the headline idea did not. A real cache leak was fixed in passing (Moves-by-Rating no longer escapes the shared bounded cache).
- **Phase 198 — mctsSearch continuous dispatch (SEED-127). Closed at 5/8 plans, measured but not shipped.** A modelled 29–35% speedup from overlapping policy and grading, closed on operator risk judgement after the determinism design failed two independent reviews — which surfaced the more valuable finding that browser grades were **never bit-reproducible to begin with** (SEED-130). DISPATCH-03..08 recorded as Rejected rather than quietly dropped.
- **Phase 199 — Bot re-calibration sweep (7 plans, RECAL-01..05). Parity HOLDS.** Re-scoped mid-milestone from a three-change refit to a pre-registered 5-cell parity check, because 197 and 198 both closed unshipped and the grading ladder turned out to be the *only* strength change that actually reached users. Thresholds were committed to git ~10 hours before the first sweep game (D-03), then never edited. Result: Maia pooled shift −57.7 (SE 40.4) vs ±85.0; SF pooled −9.9 vs ±50.0; null control clear; shape guard did not fire. Per D-04 this was stop-and-report — no ladder revert, no refit — so all four shipping calibration artifacts stayed byte-identical, which is precisely how RECAL-02's CI-drift criterion is satisfied.

**Requirements:** 38 rows across the six phases. 31 Complete, 7 Rejected (LEAF-01, DISPATCH-03..08) — every rejection recorded with its measurement rather than silently dropped. Five of six phases carry a passing VERIFICATION.md; Phase 198 has none by design (closed before verification).

**What this milestone got right, and its honest limits:**

- **Three of six phases ended in "measured, not shipped."** 197 rejected its headline idea, 198 closed unshipped, and 199 explicitly declined to refit. That is the pre-registration discipline working as intended, not three failures.
- **Phase 199's timing attribution nearly went wrong and was caught.** The raw 1.72× engine-hours ratio folds in the removed locate-pass; worse, the blend-0 null control — which never invokes the grading ladder at all — showed a 1.69× *per-move* speedup as large as every ladder-exposed cell. Per-move timing therefore cannot isolate the ladder (it conflates it with Phase 194's work). The trustworthy figure is the game-level, locate-pass-adjusted **~1.50×**, which the null control validates at 1.02×, and which sits at or above the ladder fixture's own 1.37× prediction — the first game-level test that fixture claim has ever had.
- **RECAL-04 is recorded as *not observed*, not verified.** Zero crashes fired across 704 games, so the crash-resume path was exercised only by a unit test. A clean run is not proof of a recovery mechanism.
- **Stated fidelity limits (D-09):** SEED-130 browser/harness Stockfish-hash divergence; achieved pooled resolution ±79.1 internal ELO (Maia) / ±66.0 (SF), so a smaller real shift would not have been detectable; and blend-0 immunity leaving 16 of 24 personas structurally unmeasurable by this design.
- **Per D-10, the named revert target is not a safe undo** — the committed curves were measured against flat depth 14 plus a 2500 ms movetime cap, a third configuration distinct from both the live ladder and the revert target.

**Deferred:** SEED-133 — the full 24-persona recalibration against the post-v2.10 engine. Published persona labels still derive from the pre-195 2026-07-22/23 run; Phase 199 found no detectable shift in the two personas it spot-checked, but that check could not resolve below roughly ±70–90 ELO and two of its four family deltas were confounded by auto-locate choosing different anchor brackets. The seed records the run command, two silent-no-op traps, and the bracket-pinning question to settle first.

---

## v2.9 Train — Spaced-Repetition Blunder Drills (Shipped: 2026-07-30)

**Phases completed:** 6 phases (189, 190, 190.1, 191, 192, 193), 31 plans, 107 commits over 6 days (309 files, +68,178 / −2,386 since `v2.8`)

**Delivered:** FlawChess stopped being only an analysis tool — a new import-gated `/train` page re-presents the user's own blunders as spaced-repetition puzzles, graded entirely in the browser, until the patterns stick.

**Key accomplishments:**

- **Phase 189 — Pool + Scheduler Backend (SEED-037, 6 plans).** Four CASCADE-FK tables (`drill_items`, `drill_sessions`, `drill_solves`, `train_settings`), a pure streak-keyed interval ladder (0 → next session / 1 → ~3d / 2 → ~10d, snapped to the next scheduled day; FSRS rejected), pool entry gated on the user's own out-of-book blunders clearing the winnability floor with a complete stored answer key, a sharp-vs-avoid-the-blunder blob classifier, exactly-N session composition (~75/25 SR/herring with honest cross-backfill) plus resume/expiry/eviction, and solve/reveal/settings endpoints — with zero server-side grading, so the pre-attempt payload carries neither the answer key nor the puzzle-type ground truth. Plan 189-06 closed the phase's one verification gap: named total-operator predicates (`answer_key_present`/`answer_key_pending`) rejecting the eval pipeline's empty-array `missed_pv_lines` sentinel, which a plain `IS NOT NULL` gate had admitted.
- **Phase 190 — Train Page + Solve Loop (6 plans).** `/train` wired into all three nav surfaces, six landing states, binary "one critical move vs several fine moves" read, single-move attempt on a lichess-minimal board, grading entirely client-side on the vendored Stockfish WASM at a *measured* movetime budget (with an 8s hard timeout and error/retry UX), auto-opening reveal, opt-in tactic-line stepper, block-and-retry solve persistence, and a score screen with named rating bands. Its blocking live-browser UAT found and fixed three real defects: a 21–27s pool-query planner pathology (LATERAL rewrite, 22s → 40ms), a React-StrictMode-triggered indefinite grading hang, and a resume dead-click.
- **Phase 190.1 — Train Reveal Redesign (inserted from 190 UAT, 5 plans).** The reveal became a self-contained engine-consistent study surface: puzzle-type-capped green good-move arrows plus a distinct played-move arrow and a thin white game-move arrow, answer-stating verdict rows ("Guess: One critical move ✗"), and three coincidence-merged steppable line boxes (YOUR MOVE / BEST MOVE / PLAYED IN GAME) — every eval sourced from one MultiPV-4 client search, so no two displayed numbers can contradict the verdict. `best_move`/`best_move_san`/`pv` retired from the reveal API.
- **Phase 191 — Schedule + Progress Surface (6 plans).** Inline auto-saving weekday + puzzles-per-session pickers (no Save button), a numeric waiting-count nav badge replacing the first-visit dot, a D-18 settled-streak snapshot with lazy settlement, honest mastered/parked counts, a `prefers-reduced-motion`-safe green-session confetti burst and a distinct "Flaw fixed!" mastery banner, and two tailored cold/exhausted empty states chosen purely from a server-computed `pool_state` discriminant. Its human UAT round surfaced five issues, all fixed in-branch, and produced the dev-clock time-travel tooling (`app/core/dev_clock.py`, `TrainDevClock`, `scripts/reset_train_state.py`) that makes calendar-shaped behavior testable in one sitting.
- **Phase 192 — Precomputed Red-Herring Position Pool (SEED-120, correctness defect, 5 plans).** Phase 189's herrings came from non-gem `game_best_moves` rows on the assumption that "not a gem" implies "several fine moves" — it does not. Replaced by a globally shared, phase-balanced, MultiPV-5-confirmed `herring_pool` sampled from all signed-up users' `game_positions`, whose raw 5-move ladder is stored on the row so the qualifiers (≥2 moves within `INACCURACY_DROP`, degenerate-position exclusion) apply at **query** time and stay retunable without re-analysis. Both deferred constants were pinned from a real ~900-candidate measurement rather than guessed. `drill_solves.game_id` became nullable with `ON DELETE SET NULL` — the phase's one-way door — so a herring outlives its source game and a foreign user's deletion can never hole someone else's in-flight session, with deliberately opposite orphan treatment for SR vs herring items.
- **Phase 193 — Session-Tick Streaks with a Depletable Shield (SEED-121, 3 plans).** One `_judge_one_day`/`tick_days` state machine replaced the weekly-fulfillment check, `required_sessions_per_week`, and the 3-rung flame ladder: +1 shield pip (cap 7) and +1 count on a completed scheduled-day session, −1 pip per missed scheduled day, count resets when the shield empties with a persistent state-derived reset notice. Settled days are frozen forever, a `pool_eligible_since` watermark keeps a new user mid-import from losing a streak they never had, the eager completion path settles before layering so a late completion cannot escape intervening drains, and `badge_visible` is computed server-side so neither nav site does client weekday math. Carry-over was a hard reset (no backfill) — verified against `origin/production` that no live streak state existed. The verifier independently mutation-tested the settle-before-layer guard: removed the call, observed the test genuinely fail, restored it.

**Requirements:** 27/27 complete. All six phases verified `passed` — Phase 193's three browser-only UAT items (dev-clock multi-day drain/reset, 7-pip density at 360px, off-day badge at both nav sites) were operator-confirmed at close.

**Deployed to production** incrementally through releases #286–#290; `origin/production` and `main` are identical across `app/`, `frontend/src/`, and `alembic/` at close.

**Closeout:** `override_closeout` on artifacts only — 31 cross-milestone carryover items (2 benign debug sessions, 19 stale quick-task audit miscounts, 3 pending todos, 7 dormant seeds) acknowledged as deferred (see STATE.md Deferred Items). No milestone audit doc generated: all six phases carry a passing VERIFICATION.md, all 27 requirement rows are checked off, and Phases 190/191 both ran blocking human UAT gates whose findings were fixed in-branch. Seeds closed during the milestone: SEED-037 (the milestone itself), SEED-119/120/121/122/123/124/125.

---

## v2.8 Import Filters and Guest Data Cleanup (Shipped: 2026-07-24)

**Phases completed:** 3 phases, 6 plans, 12 tasks

**Key accomplishments:**

- Per-user `user_import_settings` table + grandfathering migration + GET/PATCH API + derived backlog-count query + forward-sync TC filter, proven end-to-end as the phase's tracer slice.
- Two-pass Sync (forward + budget-capped backward backfill) across both platform clients, with an in-memory live-budget stop condition and an incrementally-persisted resumable cursor.
- Import-tab "Import filters" card (TC multiselect + backlog-cap select, auto-save, last-one-standing guard) plus per-(platform,TC) budget-chip rows reading `backlog_counts` from Plan 01's settings endpoint.
- `guest_cleanup_service.py` with a 30-day eligibility query, a per-guest cascade purge reusing `delete_all_games_for_user`/`reset_backfill_cursors`, and a per-tick orchestration loop with isolated per-guest failure handling — all proven by a real-DB integration test.
- `run_periodic_guest_cleanup` daily asyncio loop wrapping Plan 01's purge orchestration, wired as the 4th FastAPI lifespan background task alongside the reaper/eval-drain/full-eval-drain, with the lifespan smoke test's pre-existing task-list drift corrected.
- Import/eval pipeline cleanup (Phase 188, SEED-115): archived 7 completed backfill scripts to `scripts/archive/`, pruned dead tier-2 logic + 3 unused `eval_drain` re-exports, realigned `ix_games_bestmove_backfill_pending` with the tier-4b claim query (migration `c9deb514`), and kept `resweep_holed_games` + tiers 4/4b as permanent safety nets.

**Closeout:** `override_closeout` — Phase 187's D-06 backstop (a ~5M-row `game_positions` cascade delete observed under live prod traffic) abstains by design and is deferred to prod observation (11/11 truths verified, no code gap). Cross-milestone backlog acknowledged as deferred (see STATE.md Deferred Items).

---

## v2.7 Bot Personas & Playstyle Layer (Shipped: 2026-07-23)

**Phases completed:** 4 phases (182, 183, 184, 185), 19 plans

**Delivered:** a roster of 24 named bot personas (4 styles × 6 ELO rungs, 800–1800) on the Bots page, each a complete pinned opponent — preset, calibrated ELO, style params, opening book, resign/draw-offer policy, avatar, bio — with no persona × strength picker. Custom mode keeps the raw (ELO, preset) knobs for power users.

**Key accomplishments:**

- **Phase 182 — Style Levers (SEED-098):** engine-only steering added as new bot-only fields, with `botSampling.ts` kept pure and bot play byte-identical when no style is set. Curated per-style×color opening books (`styleOpeningLines.ts`), signed draw contempt + a hysteresis-gated resign predicate (`botDrawGate.ts`), Maia-policy prior reweighting via a cheap chess.js move classifier (checks/captures/pawn advances/trades) on the Human rungs, and additive score shaping + a `childScoreSpread` variance preference on the Light/Deep rungs before the existing softmax in `selectBotMove`. A headless measurement script backs the per-style tuning with committed evidence.
- **Phase 183 — Persona Registry & Bots Page:** a single typed 24-slot registry mapping each persona to its full config (rung→preset per the measured ranges), a Bots page grid/card/detail UI with placeholder emoji-on-tint avatars + committed generation prompts, one-action Play, and an unchanged Custom mode. In-game persona presence: avatar+name in the clock strip, a draw-offer banner with Accept/Decline, persona-named result copy, and Rematch/New opponent. UAT (roster content, desktop+mobile browse, end-to-end playtest) operator-confirmed passed on the shipped-to-prod roster.
- **Phase 184 — Persona Calibration & Strength Honesty:** the operator overnight calibration sweep (24 cells, supervised resume-on-crash) measured each persona's real strength on the Phase-173 internal anchor scale; `calibration_persona_fit.py` + `gen_persona_calibration.py` refit measured ELO labels from the real ledger (`PERSONA_CALIBRATION_MEASURED=true`), with the D-07 ~1800 ceiling clamp, D-06 floor-acknowledgment popover, and D-04 within-style monotonicity. The CAL-04b gap-fill (`813acd0a`) closed the ~800/~1200 rungs; shipped via PR #274.
- **Phase 185 — Bots roster transpose + win stars:** the grid re-laid-out as a rung ladder (6 rung rows, easiest ~800 on top, × 4 style columns with a single accent-colored style header row) and server-tracked per-persona win stars — a nullable `games.persona_id` (Alembic migration; persona games only), a small aggregation endpoint, and min(wins, 3) gold stars + grey outlines on each card. Added mid-milestone from a 2026-07-22 /gsd-explore session and folded into v2.7 scope at close.

**Scope note:** deployed to production incrementally (PRs through #275) rather than as a single release tied to the `v2.7` tag.

**Requirements:** 12/13 complete; AVAT-01 (24 real AI-generated portraits) deferred per locked D-16 — placeholder emoji-on-tint avatars + committed prompts shipped instead. CAL-04/CAL-05 were completed after the initial "provisional labels" framing via the operator sweep + CAL-04b gap-fill.

**Known verification overrides:** closed as `override_closeout` — cross-milestone carryover acknowledged and deferred (2 benign debug sessions, 19 stale quick-task audit miscounts, 3 todos, 8 dormant seeds; see STATE.md → Deferred Items). All four v2.7 phases carry a passing VERIFICATION.md; Phase 184's `184-04` SUMMARY + phase VERIFICATION were reconstructed at close from the committed measured calibration artifacts (24 cells, drift-clean, shipped via #274). No `/gsd-audit-milestone` doc was generated (seed-driven milestone).

**Deferred (tracked fast-follows):** Phase 183 WR-01 (dangling bot draw-offer banner when a game ends via resign/flag while an offer is live), IN-02 (wall-1200/1800 share a turtle emoji + tint), AVAT-01 (real portraits). SEED-114 (ladder extension above ~1900) stays dormant.

---

## v2.6 Bot Strength Calibration (Shipped: 2026-07-21)

**Phases completed:** 3 phases (173, 180, 181), 10 plans

**Delivered:** the bot's three play-style presets now sit on a measured strength scale, derived end to end without a single human game — an internal anchor rating scale, three measured strength curves on it, and a shipping `target_blitz_elo → bot_elo` lookup with honest ranges.

**Key accomplishments:**

- **Phase 173 — Anchor ladder self-calibration (SEED-101):** a standalone probe→measure orchestrator (`scripts/calibration-anchor-ladder.mjs`, connectivity guard + resumable ledger) round-robins all 10 Maia-argmax and Stockfish-skill anchors against each other, and a stdlib Bradley-Terry fit (`scripts/calibration_anchor_fit.py`) places them on one common internal scale published as `INTERNAL_RATING`. Headline verdict: the Maia-3 argmax ladder is **~2.8x compressed** relative to its nominal ELO labels, worst at the top — the assumption that broke every earlier calibration attempt.
- **Phase 180 — Three-preset strength curves (SEED-102):** an engine-free two-pass bot-cell scheduler windows anchors by *measured* `INTERNAL_RATING` rather than nominal `bot_elo`, fixing the bug that clamped the 2026-07-12 run. A single-parameter pinned-anchor MLE (`fit_bot_cell_rating`) yields per-cell `rating_vs_maia` / `rating_vs_sf` with CIs plus the load-bearing cross-family style-inflation gap `G_preset`. The harness runs both anchor families, records near-free per-game quality metrics (draw rate, length, ACPL, blunder rate, agreement), and resumes byte-identically from a raw ledger. Gate green + pilot operator-approved 2026-07-19; the full 15-cell sweep landed 2026-07-21.
- **Phase 181 — Per-preset lookup curves (SEED-104):** `scripts/gen_bot_strength_curves.py` fits each preset with hand-rolled PAVA isotonic regression over its 5 measured points, converts to approximate human blitz ELO via the pooled per-preset style gap plus a shared `BLITZ_OFFSET_C = 40` literature constant, and inverts lowest-`bot_elo`-wins into 100-step lookups. Ships `reports/data/bot-strength-lookup.json` + a generated, knip-clean `frontend/src/generated/botStrengthCurves.ts`, both CI drift-checked. A sibling generator emits 7 off-grid confirmation-cell predictions with inverse-variance-pooled 95% CI bands and runbook commands.
- **The honest numbers:** measured approximate-blitz ranges are **Human 900–1400, Light 1500–1600, Deep 1600–1800** — well below SEED-102's expected ~2600 ceiling. Deep plateaus at ~1950–1970 internal, and Light's raw curve is genuinely non-monotone (a real measured dip at bot_elo 1300, pooled into a PAVA plateau rather than smoothed away by a spline that would invent strength the data doesn't show). Raising the ceiling is captured as SEED-114.

**Scope note:** dev-only. The lookup artifact ships and is CI drift-checked, but nothing in the product reads it yet — it is the single source of truth for future labeled bot-strength claims (custom bot builder, preset cards, SEED-098 personas). No production deploy is required for this milestone.

**Known verification overrides:** closed as `override_closeout` — 35 open artifact items acknowledged and deferred (see STATE.md → Deferred Items). No v2.6 milestone audit was run: the milestone is seed-driven with no mapped requirements (all "TBD"), and both interactive phases carry a VERIFICATION.md.

**Deferred (operator/HUMAN-UAT):** the overnight off-grid confirmation run validating the inversion at the 7 predicted cells; pass criterion and runbook commands are committed in `reports/data/bot-strength-confirmation-predictions.json`.

**Also bundled:** quick 260721-sgb — dispose Maia ORT tensors in `maia-worker.js` (SEED-113 app half, closing the wasm-heap leak that crashed multi-hour calibration sweeps).

---

## v2.5 Move Statistics (Shipped: 2026-07-18)

**Phases completed:** 2 phases, 7 plans, 14 tasks

**Key accomplishments:**

- `app/services/accuracy_acpl.py` — a pure stdlib port of lichess's Win%/per-move-accuracy/windowed-game-accuracy/ACPL formulas, proven against lichess game 296343's real eval sequence (exact ACPL match, accuracy within ±1).
- Wired the Plan 02 shared compute path into `eval_apply.py::_classify_and_fill_oracle`'s existing atomic `UPDATE games` statement, so every full-eval completion (server drain + remote atomic-submit) now writes lichess-compatible `white_accuracy`/`black_accuracy`/`white_acpl`/`black_acpl` atomically with oracle counts, correctly leaving them NULL on an interior eval hole.
- during the full dev-DB backfill run, `skipped_none` for user 2's earliest games was much higher than the RESEARCH.md-cited ~0.5% (222 of 279 games on a `--limit 20000` smoke run). Investigation traced this to older chess.com games whose `white_blunders`/`black_blunders`/etc. oracle counts were populated from chess.com's own game-review data at import time (a documented v1.5 feature, "Engine analysis data import ... from chess.com/lichess") rather than our full-ply Stockfish drain — these games have `full_evals_completed_at IS NULL` and **zero** `game_positions.eval_cp`/`eval_mate` values at any ply, so the compute's Complete-Sequence Gate correctly returns `None` for all of them. This is the coarse-SQL-candidate-filter-over-includes / Python-gate-is-authoritative design working exactly as intended (178-RESEARCH.md Pitfall 6) — no code change was needed, and the full unlimited backfill's aggregate numbers (11495/14331 filled, ~80% overall) confirm the earlier ~20% holed rate was concentrated in this one older user's chess.com-review-only games, not representative of the whole corpus.
- Added `white_accuracy`/`black_accuracy: float | None` to the shared `GameFlawCard` Pydantic model and its frontend TS mirror, sourced exclusively from Phase 178's canonical `Game.white_accuracy`/`black_accuracy` columns via the existing single `_build_card()` construction site — zero new queries, repositories, or migrations.
- Shared `MoveStats.tsx` presentational component — accuracy strip + always-7-row Gem/Great/Best/Good/Inaccuracy/Mistake/Blunder two-sided count table — plus the pure client-side `moveStatsCounts.ts` derivation module and two new circular Best/Good badge icons, all unit-tested and ready for Plan 03's consumer wiring.
- Wired the shared `MoveStats` component into both `LibraryGameCard.tsx` and `AnalysisTagsPanel.tsx`, replacing the old badge rows: (category x side) cell cycling, a user-scoped filter ring on player-side cells, mobile compact/expandable behavior, and the analysis-panel empty-state early return dropped. `GemGreatBadge.tsx` deleted knip-clean; `SeverityBadge.tsx` preserved. Followed by a round of live-browser UAT polish.

---

## v2.4 Backend Gem & Great Detection (Shipped: 2026-07-17)

**Phases completed:** 3 phases (174, 175, 176), 14 plans

**Key accomplishments:**

- **Phase 174 — Backend Maia Inference + Best-Move Storage (spike-gated):** gem detection moves off the brittle client-side sweep into the backend full-game analysis pass. A spike-gated Python port of the client's 12-plane board→tensor encoding runs Maia-3 (`onnxruntime`) at eval-apply, parity-checked against the client's onnxruntime-web output before any downstream work. Every newly analyzed game stores a `game_best_moves` candidate row (peer to `game_flaws`, unique on `(game_id, ply)`) for each out-of-book ply where the played move equals Stockfish's best AND clears the `INACCURACY_DROP` (0.05) margin — each row holds `maia_prob` plus best/second eval as floats, never a gem/great boolean, so Gem (`maia_prob ≤ 0.20`) / Great (`(0.20, 0.50]`) thresholds are a constants-only retune with zero re-analysis. Maia inference is pinned to the mover's lichess-blitz-equivalent rating at game time, clamped to [600, 2600], and runs backend-only (no worker-protocol change); `onnxruntime`/`numpy` are isolated behind a `maia-inference` uv group so the worker image stays lean. Two gap-closure plans (SEED-109) retired the lichess-eval special-case lane for uniform full-ply coverage and added an opportunistic ES-weighted backfill of the existing ~43k lichess-eval games through the unified pass.
- **Phase 175 — Board & Filter — Gem/Great Consumption:** the analysis board, eval chart, and move-cycling badges now read gem/great markers straight from `EvalPoint`'s stored fields, appearing instantly with no background-sweep delay and no dependency on device power or live-engine load — the client-side `useGemSweep` is demoted to a documented free-play-only fallback (SEED-107 closes as superseded). Adds a second "Great" tier of primitives (theme colors, icons, badges) across board / badge / popover / variation tree. The Library Games filter panel gains "has gem" / "has great" toggles built on the existing flaw/tactic `EXISTS`-based game-filter machinery, composing correctly with every other game filter. A user-requested wave-5 extension added gem/great eval-chart dots + click-to-cycle badges, all user-scoped via a shared mover-parity helper.
- **Phase 176 — Backfill:** a backend-only tier-4b opportunistic ES-weighted lottery (`_claim_tier4_bestmove`) drains the already-analyzed corpus through the Phase 174 pipeline (global + random, no deterministic sweep, no ETA), gated behind a dedicated `BEST_MOVE_BACKFILL_ENABLED` kill-switch (default off) plus a Maia-absence guardrail that stamps `best_moves_completed_at` only when Maia actually ran — never inferred from an empty candidate set, so no game is permanently locked out of the lottery.

Also bundled: a CI fix installing the isolated `maia-inference` group (`uv sync --locked --group maia-inference`) so `ty` can resolve the `onnxruntime`/`numpy` imports in the backend suite.

The tier-4b backfill flag ships **OFF** (D-05) — enabling `BEST_MOVE_BACKFILL_ENABLED` in prod is a separate, deliberately observed flag flip after deploy, not part of this merge.

## v2.3 Bot Play (Shipped: 2026-07-15)

**Phases completed:** 9 phases (166, 167, 168, 168.5, 169, 169.5, 170, 171, 172), 46 plans

**Key accomplishments:**

- **Phase 166 — Bot Move Selection Core (`selectBotMove`):** one pure, provider-agnostic function chooses the bot's move by blending the play-style slider from raw-Maia sampling (one inference, no MCTS) at the full-human end to argmax practical score at the full-Stockfish end, with practical-score-weighted sampling in between. Symmetric and non-adaptive (strength stays fixed and measurable), deterministic under an injected RNG seed, and always returns a legal fallback. The same code the app's bot and the calibration harness run.
- **Phase 167 — Backend Store-on-Finish:** finished bot games persist as first-class `platform='flawchess'` Library games via a new `normalize_flawchess_game` feeding the existing persistence path (`POST /bots/games`), carrying both-color `[%clk]` clocks (rejected if missing), full bot settings in a side-table, and a save-time converted lichess-scale player rating. Idempotent on a client-owned game UUID; excluded from default analytics but opt-in in the Library; analyzable like imported games (guests get the save-but-no-auto-analyze caveat).
- **Phase 168 — Headless Calibration Harness (spike-gated):** a Node harness (`scripts/calibration-harness.mjs`) plays the bot against raw-Maia 1100–1900 argmax rungs and Stockfish skill levels across a coarse (ELO × play-style) grid, reusing the exact `selectBotMove` via the `@/` alias (zero reimplementation), and emits a durable per-cell strength-map TSV with `--resume`, an advisory ELO estimate, and a logged analyze deep-link per game. A feasibility spike first confirmed Maia ONNX runs headlessly in Node and locked the `onnxruntime-node` version.
- **Phase 168.5 — Bot Move Pacing & Search Budget (SEED-096):** settled the clock/fixed-strength fork, made harness Stockfish grades deterministic under load (depth-only `go` + Clear Hash, SEED-095) with watchdog headroom, and added grade-margin confidence-based early stopping plus a retuned `MAX_NODES` to `mctsSearch` so a move lands in seconds rather than ~110s, with the shipped budget mirrored into the harness (app == harness).
- **Phase 169 — Clocked Board + Game Loop (`useBotGame`):** a full clocked game against the bot end to end — dual Fischer-increment clocks on a wall-clock delta model (accurate across tab backgrounding, paused while hidden during the bot's turn so the debited value is fair), bot pacing via a per-move think deadline derived from its remaining clock (it speeds up in time trouble and can lose on time), every end condition (checkmate, stalemate, threefold, 50-move, insufficient material, flag), resign and draw offers, a result screen, and move/capture/check/end sounds with mute.
- **Phase 169.5 — Bot Opening Book:** in the opening the bot answers from a Maia-policy-weighted ECO book (`frontend/public/openings.tsv`) instead of searching — near-instant, search-free, clock-cheap, varied across games — leaving the book once no theory move looks plausible at its rating (or a ply cap is hit); the engine prewarms during the book window so the first searched move pays no cold start.
- **Phase 170 — localStorage Resume:** a bot game survives closing the tab. Returning to `/bots` offers a "Resume game?" prompt (position, time control, ELO, move count, elapsed) and picks up exactly where it stood with the clock paused while away (only your own thinking time billed, the bot's interrupted search refunded). Discarding confirms first; abandoned games leave no server trace; a finished game is stored exactly once regardless of reloads.
- **Phase 171 — Bots Page + Setup Screen + Nav:** Bots is a real top-level page linked from desktop and mobile nav, open to guests and logged-in users. A setup screen configures time control, bot ELO (seeded from your own rating), play style, and colour (incl. random), remembers your last choices, and ties board + resume + store-on-finish together: a finished game saves to the Library with a link, "New game" returns to setup, and "Analyze this game" opens the analysis board oriented to your colour.
- **Phase 172 — Background Gem Sweep on Analysis (SEED-106):** opening a game now quietly scans its past mainline plies in the background (free `played === best_move` + out-of-book prefilter → Maia C1 → Stockfish parent grade) and marks memorized openings (book icon) alongside strong-but-rare gem moves, so hard-to-spot ideas surface ahead of the cursor. The sweep pins the gem rung to the mover's own seeded rating, raises `GEM_MAIA_MAX_PROB` 0.10 → 0.20, adds `opening_ply_count` (computed on-read, no migration) for book markers (precedence severity > gem > book), always yields to the position you're viewing, and tears its workers down once every candidate resolves. An `/analysis` feature bundled into v2.3 by explicit choice.

Also bundled: quick tasks 260714-pnk (real-username board label), 260714-qaj (full PGN header block on saved bot games), 260714-rj5 (analyzable bot games / "Analyze this game" queues + opens, incl. guests), and 260715-als (WR-04 book marker on inaccuracy-severity book plies).

## v2.2 Analysis ELO Calibration & Deep-links (Shipped: 2026-07-11; deployed to production, PRs #253/#254)

**Phases completed:** 2 phases (164, 165), 6 plans

**Key accomplishments:**

- **Phase 164 — Maia ELO Lichess-blitz normalization (SEED-093):** the analysis-board Maia ELO slider now seats each player at their Lichess-blitz-equivalent rating (Maia-3's training scale) instead of their raw platform rating, so chess.com and Lichess-non-blitz ratings no longer make the Maia opponent play too strong or too weak. Backend `_invert_table2_column` + `normalize_to_lichess_blitz` converter (including a `classical` → `rapid` mapping for chess.com's long real-time games), two nullable `*_lichess_blitz` fields computed on-read in `_build_card`, and a frontend `deriveRawDefault` read-with-raw-fallback. The ELO label carries an info popover explaining the conversion, with an inline reset once the slider is dragged off the players' rating. Verified 13/13 truths; UAT signed off. Released to production via PR #253.
- **Phase 165 — Gem-move ELO calibration harness + restore `?fen=` analysis deep-link (SEED-094):** restored an additive `?fen=<fen>` analysis deep-link (`buildAnalysisFenUrl` / `parseAnalysisFenParam` + Analysis.tsx seeding, precedence game_id > fen > line) so arbitrary mid-game positions are directly openable alongside the existing start-anchored `?line=`. Built a headless Node gem-ELO calibration harness (onnxruntime-web Maia across six ELO rungs {600, 1000, 1400, 1800, 2200, 2600} + vendored Stockfish WASM C2 grade + stratified CSV sampling → TSV in `reports/data/`) that imports the real `classifyGem` / `evalToExpectedScore` / `MISTAKE_DROP` for zero reimplementation drift — the empirical basis for an ELO-scaled iso-rarity gem-move ceiling (Phase 163 D-08). Gem badges were also made a touch more generous (Maia probability ≤ 10%, was 5%). Released to production via PR #254.

Both phases shipped as individual GitLab-Flow single-phase releases (#253, #254) and were bundled retroactively into the v2.2 milestone at close. Also bundled: the Openings → Analysis `?line=` handoff and Analyze-position button relocation (quick 260710-x3d / 260710-wub).

## v2.1 Analysis Eval Reconciliation & Gem Moves (Merged to main: 2026-07-10; deploy pending)

**Phases completed:** 2 phases (162, 163), 7 plans

**Key accomplishments:**

- **Phase 162 — grading-run-authoritative eval reconciliation (SEED-090):** flipped `buildEvalLookup` to grading-first precedence, so a move present in both the free run and the grading run resolves to the deeper grading value (the free run only fills not-yet-graded moves). Every "Good" label can no longer show a higher number than "Best".
- Extended `unionSans` with the free run's top-2 root SANs (gated on `freeRunCommitted`) so the grading union covers every displayed Stockfish-card move by construction, closing the "uncovered displayed move" gap without making `bestSan` circular (D-11 anti-circularity preserved).
- New canonical `resolveReconciledBest` / `reconciledBestUci` — a single reconciled-argmax resolver that the board arrow, agreement verdict, eval bar, and Best/Good labels all consume instead of re-deriving their own argmax, killing the Phase 158 anti-pattern.
- Routed the Stockfish card's PV-line evals, the off-main-line eval bar (`reconciledBestEval` → `useGameOverlay`, itself byte-unchanged), and the agreement verdict's `stockfishLine` through the reconciled lookup, closing two RESEARCH Pitfall-1 bypasses. Frontend-only; no worker/depth changes.
- **Phase 163 — gem moves (SEED-092):** badge the rare move that is both the engine's clearly-only good move AND hard for a human at the player's rating to find. New `gemMove.ts` with two-condition `classifyGem` (rating-matched Maia probability ≤ `GEM_MAIA_MAX_PROB` = 0.03 AND expected-score gap ≥ `MISTAKE_DROP`), mover-agnostic, covering mainline and free variations either color.
- `MoveQuality` widened to a 6th positive `'gem'` bucket (folded into `'good'` for bucket keying, overriding "best"); `FlawSeverity` stays negative-only.
- Gem surfaces in Maia-violet (`MAIA_ACCENT`): board-corner `SquareMarker.gem` variant + move-list `GemIcon` (lucide `Gem` SVG-icon variant alongside the text-glyph markers), a violet gem curve + label in `MovesByRatingChart`, and a short `UnifiedMovePopover` gem row. Two page-level per-FEN caches (`maiaCurveByFen`/`gradeSummaryByFen`) make parent-position data reachable after navigation; `gemByNode` sticky cache behind a min-depth stability gate. Pure frontend, no backend, no cross-game statistics.

## v2.0 FlawChess Engine (Shipped: 2026-07-09)

**Phases completed:** 9 phases, 24 plans, 51 tasks

**Key accomplishments:**

- Locked `SearchRunner`/`EngineProviders`/`SearchBudget`/`RankedLine`/`EngineSnapshot` contract plus `leafExpectedScore()`, a root-relative wrapper around the existing lichess sigmoid, proven mirrored across root colors by a 5-case fixture test.
- `backup.ts` — the single genuinely novel file in the v2.0 milestone: a Maia-prior-weighted expectation over the full truncated top-k set for non-root nodes, and a plain max for the root, proven against a hand-computed 0.637 fixture and two negative-assertion baselines that make the "silently degenerates into textbook MCTS" bug structurally testable.
- `select.ts` — Maia top-k mass-truncation/renormalization (independent 90% constant, no hard cap), deterministic root/non-root PUCT selection with canonical UCI tie-break, and a root-only floor-boosted exploration prior that never touches backup values — all as three distinct, independently unit-tested pure functions.
- `mctsSearch.ts` — the select→terminal→expand→backup→snapshot orchestrator composing Plans 01-03's primitives into the frozen `SearchRunner` contract, with a private in-memory node tree, chess.js-driven terminal detection, and a concurrency-safe buffer-then-apply-in-canonical-order dispatch loop proven bit-identical at concurrency 1 and 2 via a 9-test suite (ranked output, both-color ELO oracle, truncation, leaf-sigmoid match, depth cutoff, mate-in-1 and forced-mate-in-2 terminal fixtures, and full snapshot-sequence determinism).
- `fallbackExpectimax.ts` — a sequential depth-limited expectimax implementing the identical `SearchRunner` contract as `mctsSearch.ts`, reusing `backup.ts`/`leafScore.ts`/`select.ts` verbatim, proven via a same-variable SC5 swap-in test with the full Phase 153 gate (lint/tsc/knip/1439 tests) green.
- `workerPool.ts` — a lazily-spawned, device-adaptive 2-4 Stockfish.wasm worker pool implementing `EngineProviders.grade()` with a priority-queued, pv[0]-keyed, abortable dispatch surface
- `maiaQueue.ts` — a dedicated, lazily-spawned Maia policy Web Worker implementing `EngineProviders.policy()` with deduped narrow-ELO batching, a separate `(fen, elo)` cache, and a no-drop async FIFO queue
- Closed two reproduced lifecycle promise-hang defects (CR-01 stopAll, CR-02 terminate) plus abort/input/observability gaps in the Stockfish worker pool, so no `grade()` promise can be left permanently unresolved.
- Closed the reproduced CR-03 pre-ready worker-init-error deadlock in maiaQueue.ts and added the missing async worker.onerror handler (WR-03), so a Maia ONNX worker failure now self-heals instead of permanently hanging every policy() promise.
- Two new brand-accent theme tokens, a mate-boundary-guarded inverse-sigmoid `expectedScoreToWhitePovCp` pure function, a hand-rolled `Switch` UI primitive, and compiling Wave 0 test scaffolds for the hook and card Plans 02/03 will build.
- `useFlawChessEngine({ fen, enabled, elo })` wires the frozen `mctsSearch` SearchRunner against the real Phase 154 `WorkerPool`/`MaiaQueue` providers, throttling live `onSnapshot` output into React state at ~150ms while guaranteeing near-instant first paint and a Pitfall-1-safe abort+stopAll on every FEN navigation.
- `FlawChessEngineLines.tsx` renders the top 3 FlawChess Engine ranked practical lines as a structural sibling of `EngineLines.tsx`, with a two-number objective/practical score-pair badge and clickable modal-path SAN chips — the visible surface of DISPLAY-02 and DISPLAY-03.
- Mounted `useFlawChessEngine` on `/analysis`, placed the `FlawChessEngineLines` card above Maia in both desktop and mobile layouts, replaced the single Stockfish toggle with three independent accent-tinted header Switches, and wired the D-04 eval-bar precedence (FC>Maia left, objective-eval handoff right) — the FlawChess Engine is now visible and live on the free-analysis board.
- Pure `computeFlawChessVerdict` classifier module scoring FlawChess's practical #1 pick against Stockfish's objective #1 pick into aligned/safe/sharp tiers via the app-wide win%-drop scale, with a strict null-gate for incomplete snapshots
- Prose agreement/divergence verdict below the FlawChess ranked lines, comparing FlawChess's practical #1 pick against Stockfish's objective #1 pick (aligned/safe/sharp tiers), with hoverable click-to-play move spans, board-arrow isolation, and an engine-labeled popover — wired once into the shared `flawChessCard` for automatic game-review parity
- Measured a real GRADING_MOVETIME_SAFETY_CAP_MS=4000 (no depth cap) via headless WASM sweep, and found/fixed a genuine UCI go-command bug: `searchmoves` must be the LAST clause, or trailing `movetime` is silently dropped.
- Pure UCI-keyed eval-lookup module (`buildEvalLookup`/`getByUci`/`getBySan`) merging the free-run's `pvLines` and the grading-run's SAN-keyed `gradeMap` with strict free-run-first precedence, structurally excluding the MCTS pool grade as a display source
- Wired the plan-158-02 evalLookup into Analysis.tsx: promoted the shared grading run to gate on `maiaEnabled || flawChessEnabled` over the FC∪Maia SAN union, added `evalLookup`/`reconciledRankedLines` memos, reconciled `qualityBySan`, and threaded reconciled values into the FC card + agreement verdict — making the Qc7-class "FC pick grades higher than the objective best" misread impossible by construction.
- New `policyTemperature.ts` implements the standard `p^(1/T)` softmax-temperature reshape (T=1 no-op, T>1 flattens, T<1 sharpens), applied only on the root-mover's own side before the existing 0.9-mass truncation in both `mctsSearch.ts` and `fallbackExpectimax.ts`, with a named `ROOT_CANDIDATE_HARD_CAP=15` guarding the fixed visit budget against pathological flattening — the temperature-adjusted `child.prior` composes with Plan 01's findability ranking automatically, with zero third combiner function.
- New `TemperatureSelector.tsx` (log-symmetric 0.5-2.0 slider, exact center at 1.0) threaded through `useFlawChessEngine`'s `SearchBudget.policyTemperature` and rendered once in `Analysis.tsx`'s shared ELO-selector block, giving both the mobile Human tab and the desktop human column a "Play style" (Sharper <-> More human) knob that re-runs the FlawChess search and reshapes its ranking live, while the Maia "Moves by Rating" chart keeps showing raw data.
- Locked the /analysis desktop frame to `100dvh` with a fluid `grid-cols-[360px_1fr_360px]` 3-column layout, a height-aware `ChessBoard` (`clamp(420, min(width,height), 600)`), and the Tags panel relocated to the right column — fixing the small-laptop eval-chart cutoff (SEED-088).

---

## v1.32 Maia-3 Human-Move Enrichment (Shipped: 2026-07-05)

**Phases completed:** 2 phases (151, 151.1), 10 plans. Phase 151.1 was inserted from SEED-083 (Stockfish-graded Maia moves) and shipped alongside the base phase. Both shipped to `main` via local squash-merge (151.1 = `099b9138`). Phase 152 (Flaw Overlay, Pillars A + B) was demoted to SEED-084 at close — judged not needed for this milestone.
**Stats:** 111 files changed `v1.31..main`, +15,532/−161 (dominated by planning docs + the vendored `maia3_simplified.onnx` model and onnxruntime-web WASM assets); real code ~56 files, +7,448/−91; 16 commits (inflated by the squash + v1.31 forward-port + the SEED-081 spike/explore doc trail); 2026-07-04 → 2026-07-05. **No Alembic migrations, no new schema, no persistence** — the one backend touch is a read-only `current_rating` field on `/users/me/profile`. Everything else is browser-only, client-side onnxruntime-web inference.
**Milestone goal:** Add Maia-3 (a human move-prediction engine) as a second, in-browser engine on the `/analysis` board — where Stockfish says "what is objectively best," Maia says "what a player at *your* rating would actually do here" — the missing half of coaching, directly on-brand ("Engines are flawless, humans play FlawChess"). Relicense MIT → AGPL-3.0 so the AGPL Maia model hosts with zero combined-work ambiguity. Sourced from SEED-081; feasibility settled by spikes 004–006.

**Key accomplishments:**

- **Relicense + visible AGPL attribution** (Phase 151, LIC-01/02) — the repo relicensed MIT → AGPL-3.0 (verbatim FSF boilerplate, How-to-Apply appendix filled) and an always-visible (non-hover-gated) `MaiaAttribution` component citing the CSSLab source repo, the AGPL-3.0 license text, the model artifact, and the Chessformer paper (arXiv:2605.19091), mounted on every desktop + mobile Human surface.
- **Client-side Maia-3 inference core** (Phase 151, MAIA-01/02/03/05/06) — the version-pinned, unmodified `maia3_simplified.onnx` (sha256 `405bf76c…`) loads via onnxruntime-web in a lazy-loaded Web Worker with no unsupported-op errors; original MIT glue (`maiaEncoding.ts`, "NOT derived from CSSLab") does board→tensor encoding, ELO input, legal-move masking, and softmax to a normalized, deterministic per-legal-move distribution + WDL from a FEN + ELO — zero server round-trip, nothing persisted (ephemeral, board-session-scoped cache only).
- **All-position surfaces** (Phase 151, SURF-01..05, MAIA-04) — a "Moves by Rating" chart (one probability line per candidate across the ELO ladder, "you are here" marker at rating-at-game-time, played/best emphasized) plus a Maia WDL eval bar on the LEFT of the board and the Stockfish bar on the RIGHT, both recomputing live on every board navigation; wired into a 3-column desktop `/analysis` layout and a mobile "Human" tab, with a backend read-only `current_rating` for the free-play ELO default.
- **VALID-01 live calibration gate** (Phase 151) — Maia's calibration + the best-effort 4352-entry policy-vocab move-label reconstruction were eyeballed and signed off live across representative positions (bar-direction/WDL-sign, per-ELO calibration, correct SANs); the smallest model (D-10) retained.
- **Stockfish-graded human moves** (Phase 151.1, SEED-083) — the chart now colors each shown line + SAN label by Stockfish move quality on FlawChess's *own* expected-score-drop thresholds (`liveFlaw.ts`/`flawThresholds.ts`): dark-green best → light-green good → yellow inaccuracy → orange mistake → red blunder, so the chart surfaces the *human trap* (a popular move the engine grades a mistake), not just which moves people play. Color encodes quality, SAN labels carry identity, played/best stay emphasized by stroke width (decoupled from color).
- **Adaptive candidate set + isolated grading worker** (Phase 151.1) — the fixed top-6-by-peak cap replaced by the Maia cumulative-probability ≥ 0.95 set ∪ {Stockfish-best} (top-5 hard-capped), so sharp positions show few lines and quiet ones more; grading runs via a *second, fully independent* Stockfish WASM Web Worker doing ONE `searchmoves`-restricted MultiPV root search (pv[0]-keyed, white-POV-normalized grade cache), structurally isolated from the primary eval-bar engine (git-confirmed it never touched `useStockfishEngine.ts`) and proven under a MockWorker harness reproducing Plan 01's confirmed multipv-reordering landmine. Follow-on UAT polish added a move-quality severity bar + a plain-language position-difficulty verdict below the chart (quick 260705-kfg / 260705-m3z).

**Known gaps at close:** **MAIA-06 latency measurement is a documented override** — per-device (desktop/mobile) cold-load and per-position latency numbers were never recorded (`151-MAIA-MEASUREMENTS.md` §2 is entirely "NOT YET MEASURED"); the D-10 smallest-model decision rests on the qualitative VALID-01 "felt responsive" sign-off, not a numeric board-response budget (none was ever defined). Phase 151 verified `passed_with_override` on this single non-functional clause; 151.1 verified clean `passed`. **Pillars A + B (Flaw Overlay, FLAW-01..04) deferred → SEED-084**; Pillar C (history-wide aggregate rollup, AGG-01/02) and SEED-082 (human-playable-line engine) remain persistence-gated future work. **Not yet deployed to production** — and v1.31 also still sits on `main` undeployed (last prod release #244); both ship on the next `bin/deploy.sh`. v1.32 is fully independent of the eval pipeline, but v1.31 should ship first. Standing cross-milestone backlog noise (2 debug sessions, 2 todos, 8 dormant seeds, 19 older quick-task tracking artifacts) carried forward per STATE.md → Deferred Items.

See `.planning/milestones/v1.32-ROADMAP.md` and `.planning/milestones/v1.32-REQUIREMENTS.md`.

---

## v1.31 Pipeline Consolidation (Completed: 2026-07-04)

**Phases completed:** 3 phases (148, 149, 150), 14 plans. Server-side-only consolidation milestone — no worker protocol change, no fleet redeploy. Phase 148 was SEED-080's hard prerequisite (five 2026-07-02 code-review correctness fixes on the same files), grouped in retroactively. **Merged to `main`; prod deploy (`bin/deploy.sh`) is the next step** — the last prod release was #242; the v1.31 changes are pending deployment.
**Stats:** ~48 files changed since the last prod release, +6,579/−6,156 (net-neutral, as expected for a consolidation — `eval_drain.py` alone shrank 3188 → 1074 lines). Alembic migrations: `worker_heartbeats` table + `import_jobs` partial unique index (149). No schema change to the eval/flaw data path.
**Milestone goal:** Retire the dead Gen-1 eval protocol and unify the copy-pasted eval write path so new pipeline work threads through one code path instead of 3+, removing the seams that generated FLAWCHESS-8D and the Phase 146/147 ungated-tag bugs. Sourced from SEED-080 (Tier-A/B recommendations of `reports/pipeline-review-2026-07-04.md`).

**Key accomplishments:**

- **Pipeline & tactic correctness fixes** (Phase 148, CORR-01..06) — five silent-data-loss / production-only defects fixed with tests + verify loops: a truncated forced-mate PV now tags generic `mate` (was a no-op drop) and the detector's `fen_map` carries full board FEN so ep/castling flaws replay correctly (persisted `game_flaws.fen` stays piece-placement-only); the entry-ply drain refuses to stamp `evals_completed_at` on a dead-pool all-fail tick; the endgame quintile significance test adds the covariance term for overlapping cohorts; a single malformed platform game is skipped (per-game try/except) instead of aborting the import; the entry-submit endpoint enforces a batch-scoping lease-expiry guard.
- **Retire the dead Gen-1 protocol** (Phase 149, PRUNE-01) — deleted `/lease` + `/submit` + `_apply_submit` (`eval_remote.py`) + the worker's `_handle_full_ply_response` handler + `test_eval_worker_endpoints.py`, after first porting the only end-to-end job_id→eval_jobs stamp + lichess-eval-release coverage to the atomic lane; `/flaw-blob-*` retained (tier-4 backfill still draining). Prod-traffic-zero confirmed (11.3h grep) before deletion.
- **Remove dead weight** (Phase 149, PRUNE-02) — `hashes_for_game` (`zobrist.py`), the `chesscom_to_lichess` Table-3 lookups, the caller-less `Game.needs_engine_full_evals` hybrid, and `TIER_AUTO_WINDOW`, with zero live-path behavior change (full backend suite green, 3158 passed).
- **Import + fleet durability** (Phase 149, PRUNE-03..06) — `_normalize_chesscom_result`'s silent-draw fallback replaced with an explicit "unknown" skip + Sentry (no fabricated draws); `worker_schema_version` recorded on every submit; a durable `import_jobs` guard (row created in the request handler + partial unique index on `(user_id, platform) WHERE status IN ('pending','in_progress')`) closes the concurrent-duplicate-import TOCTOU race at the DB level; a server-side `worker_heartbeats` table populated from existing submit headers, zero worker-side change.
- **Consolidate the write path** (Phase 150, WRITE-01..03) — the Path A/B/C completion decision + guarded `eval_jobs` stamp unified into one `apply_completion_decision()` (3 verbatim copies → 1); the classify preamble unified into one overlay-parameterized `_classify_with_overlay` (4 sites → 1); `_classify_and_fill_oracle` replaces delete-then-insert with a per-ply 4-way diff/upsert driven by one `FLAW_BLOB_COLUMNS` constant, so blob/tactic-tag preservation is native to the write and the `_snapshot_preserved_flaw_blobs`/`_restore_preserved_flaw_blobs` compensation layer (the FLAWCHESS-8D + Phase 146/147 ungated-tag seam) is deleted — proven byte-identical by a committed golden-snapshot harness across 8 incremental-retry scenarios.
- **Module split + ride-alongs** (Phase 150, WRITE-04..06) — shared write-path primitives (~1770 lines) relocated into a new `app/services/eval_apply.py` (`apply_full_eval`) consumed by both `_full_drain_tick` and the router's atomic-submit lane; entry-ply primitives split into `app/services/eval_entry.py`; `eval_drain.py` shrank 3188 → 1074 lines and the router's 21-symbol private-helper leak is gone (one narrow deliberate residual: `_load_pgns_for_games`). `EnginePool`'s 3 near-identical analyse methods collapsed into one generic `_acquire_and_analyse`; the tier-3/tier-4 Efraimidis–Spirakis lottery parameterized into shared weighted-pick building blocks.

**Known gaps at close:** User-visible contract is **no behavior change** (byte-identical eval/flaw/tag output through the consolidated path). R14 tier-3 lease (double-claim hardening) deferred to SEED-072. The v1.30 carryover — the local in-process drain re-mints ~9/3.36M ungated cp tags (self-heals via tier-4, not rollback-class, `project_local_drain_ungated_tactic_tags`) — is untouched by this milestone (the consolidation preserved existing behavior exactly). **Not yet deployed to production**; prod deploy is the next step. Standing cross-milestone backlog noise (2 debug sessions, 2 todos, 8 dormant seeds, 19 older quick-task tracking artifacts) carried forward per STATE.md → Deferred Items.

See `.planning/milestones/v1.31-ROADMAP.md` and `.planning/milestones/v1.31-REQUIREMENTS.md`.

---

## v1.30 Forcing-Line Tactic Gate (Shipped: 2026-06-30)

**Phases completed:** 7 phases (141–147), 25 plans. Phases 141–145 shipped the gate end-to-end (release #229); Phases 146–147 grouped in at close per the standalone-then-regroup pattern (cf. v1.27/v1.28) — the actual prod rollout is the Phase 146 upgraded-fleet deploy, and Phase 147 hardened the persist-only-gated-tags invariant. Releases: #229 (141–145 gate live across the corpus), #230 (146 live-submit offload), #231 (SEED-072 tier-4 routing fix), #234 (147 write-time gate).
**Stats:** ~175 files changed `v1.29..main`, +47.9k/−2.0k (dominated by planning docs + the A/B validation reports); 53 commits (inflated by squash + the v1.29 forward-port); phases completed 2026-06-29 → 2026-06-30, post-ship hardening through 2026-07-01. Alembic migrations: `allowed_pv_lines`/`missed_pv_lines` JSONB on `game_flaws` (141), tier-4 partial index (145), suppress-ungated corpus data migration `eb341e836ee9` (147).
**Milestone goal:** Harden the v1.28 tactic "cause-of-error" axis so its tags reflect *real forced tactics*, not incidental geometry in the non-forced tail of an engine PV — via an "only-move" forcing-line gate (lichess-puzzler-modeled) and persisted MultiPV=2 evals that make every threshold change a seconds-fast offline re-tag with no engine re-pass.

**Key accomplishments:**

- **JSONB forcing-line storage + engine-free gate** (Phase 141) — `allowed_pv_lines`/`missed_pv_lines` per-node blobs (best/second cp+mate + second-best UCI) via one Alembic migration with a `deferred=True` structural leak guard; a pure, independently unit-testable `forcing_line_gate` module: only-move win-prob margin (`ONLY_MOVE_WIN_PROB_MARGIN=0.35` via `eval_utils.LICHESS_K`), already-winning reject (+300 cp), still-winning floor (+200 cp), trailing-only-move strip, one-mover discard, all named constants. Every `select(GameFlaw)` query site audited to explicit column projections so blobs never leak into stats scans.
- **MultiPV=2 engine pass** (Phase 142) — `_analyse_multipv2` EnginePool method (per-node best+second evals + second-best UCI; `list[InfoDict]` return forbids reusing `_analyse_with_pv`), wired into the eval drain + an *additive* remote-worker lease/submit contract (backward-compatible with un-upgraded workers), reusing the module-level pool within the 4g container budget; node budget validated by a margin histogram on ≥200 dev positions before merge.
- **Offline re-tagger** (Phase 143) — `scripts/retag_flaws.py` re-derives tactic tags from stored JSONB in seconds with no engine (`--dry-run`/`--margin`/`--user-id`/`--db`), idempotent via the single gated classify path (`_classify_tactic_gated`). Mate-priority hierarchy runs *before* the sigmoid (mate-in-1 never suppressed); defender-node ambiguity does not kill a line (branch-then-reconverge treated as forced).
- **Engine-free A/B validation** (Phase 144) — old-vs-new tagger replayed over identical stored blobs for user 28 (isolating the gate from `eval_cp` cross-machine variance), per-motif removed/survived + depth distribution + hand-checked dropped cases; final margin committed. A depth-aware Bug-B fix (quick 260630-jsr) later exempted the winning conversion tail so a tactic that already fired and won material is not rejected by near-equal follow-ups.
- **Corpus backfill + rollout** (Phase 145) — `backfill_multipv.py` (WHERE `allowed_pv_lines IS NULL` idempotency, module-level pool reuse, no second EnginePool), a tier-4 blob-backfill lottery, and `/flaw-blob-lease` + `/flaw-blob-submit` endpoints; gated tags live across the corpus (release #229). The MultiPV pass is NOT gated on `lichess_evals_at` (second-best is new data, not a lichess freebie).
- **Live-submit offload to the remote fleet** (Phase 146, SEED-071) — moved the forcing-line continuation eval off the blocking live `/submit` path (`blob_map={}` unconditional, D-03); full-ply worker pass reduced to MultiPV-1, second-best only on the dedicated tier-4 blob rung; `HTTP_TIMEOUT_S` restored to 30.0 (120s stopgap removed). Follow-ons: SEED-072 idle-`/lease` routing fix (release #231), and a two-stage Efraimidis-Spirakis tier-4 lottery replacing the top-50 window so the whole analyzed corpus drains.
- **Write-time gate — only gated tags persist** (Phase 147, SEED-074, A+B) — go-forward `blobs_pending` suppression at the `_apply_submit` write site + an Alembic data migration (`eb341e836ee9`) suppressing raw ungated cp-based tags across the pre-existing corpus + a server-authoritative atomic eval+blob worker pipeline (`/atomic-lease`, `/atomic-submit`, `_apply_atomic_submit`, server-side sentinel re-derivation, token tamper guard) with over-cap DoS sentinels (SEED-073). Versioned contract lives alongside the old pair so a mixed fleet runs with instant rollback (release #234).

**Known gaps at close:** **Phase 147's strict-zero "no ungated tags" invariant is broken in prod** — the local in-process server-pool drain calls the classify path with default `blobs_pending=False` and re-mints raw cp-based tactic tags (~9 of 3.36M rows); tiny, self-heals as tier-4 fills blobs, **not rollback-class** (only the in-process drain leaks; the atomic-submit worker path is correctly gated). Tracked in project memory `project_local_drain_ungated_tactic_tags`. Phase 147-06 full atomic gated-write e2e is HUMAN-UAT-pending (dev DB has no queued eval_jobs; automated dry-run confirmed the wiring). v2 gate refinements deferred (GATEX-01..04). Standing cross-milestone backlog noise (2 debug sessions, 5 todos, 9 dormant seeds, 19 older quick-task tracking artifacts) carried forward per STATE.md → Deferred Items.

See `.planning/milestones/v1.30-ROADMAP.md` and `.planning/milestones/v1.30-REQUIREMENTS.md`.

---

## v1.29 Live-Engine Analysis Page (Shipped: 2026-06-29)

**Phases completed:** 5 phases (136–140), 14 plans. Released to production via PR #227 (commit `e3f652ab`); production tree matches `main` at close.
**Stats:** ~370 files changed `v1.28..main`, +28k/-4k (dominated by the vendored ~7 MB WASM engine + planning docs); 61 commits (inflated by squash + the v1.28 forward-port); phases completed 2026-06-26 → 2026-06-27, post-ship hardening through 2026-06-29. No Alembic migrations, no new endpoints (milestone D-4: analysis state is ephemeral and lives in the URL).
**Milestone goal:** Ship a standalone `/analysis` board where the user makes any legal move from any position and an in-browser single-thread Stockfish (WASM) evaluates it live, subsuming the static Tactic Line Explorer (Phase 135) as a tactic mode of that one shared board.

**Key accomplishments:**

- **Live in-browser engine** (Phase 136) — `useStockfishEngine` hook wrapping single-thread lite-single WASM Stockfish (~7 MB NNUE) in a Web Worker as a clean UCI state machine: eval bar, top 1–2 MultiPV lines, best-move arrow, depth; debounced auto re-analysis with a movetime/node cap and a two-layer stale-eval guard. Platform-hardened: no site-wide COOP/COEP (OAuth + iOS safe, CI-guarded), PWA `*.wasm` exclusion, tab-hide pause.
- **Branching analysis board** (Phase 137) — `useAnalysisBoard`, a new move-tree hook where a mid-line move forks a variation instead of being rejected; O(1) navigation; URL-encoded state (no server persistence). New display components: EvalBar (sigmoid centipawn gradient), EngineLines, VariationTree.
- **Standalone `/analysis` route** (Phase 138) — the app's first `React.lazy` + Suspense boundary, so the engine bundle loads only on this route; reachable from the Openings Explorer via "Analyze position".
- **Tactic mode subsumes the Phase 135 explorer** (Phase 139) — TacticModeOverlay replicates every Tactic Line Explorer behavior at parity (regression-gated on 4 behaviors), then `TacticLineExplorer.tsx` + `useTacticLine.ts` + their 26 tests were deleted; all "Explore" entry points repointed to `/analysis`. Explore/Analyze are now real links (middle-click / ctrl-click open in a new tab).
- **Full-game analysis board** (Phase 140) — a single unified `Analyze` entry on game + flaw cards loads the *whole* game (`?game_id&ply`) at the carried ply; eval chart relocated below the board with a slider that scrubs the main line and parks at the fork on a sideline; inline missed/allowed tactic chips unfold stored PVs as two-level navigable sidelines with a contextual overlay; the standalone Game modal code path was deleted. Player names, ratings, and per-side clocks shown around the board.
- **Post-ship production hardening** (quick tasks 260628 / 260629) — both-color tactic tooltips, engine-line expansion + full-PV click-through, sideline blunder/mistake icon persistence, a mobile board-app redesign, and two Sentry-driven crash fixes: a Stockfish WASM `unreachable` trap from sending `position`+`go` during the `stopping` state (FLAWCHESS-7V), and a duplicate-React-key crash from board arrows sharing a from→to during live streaming.

**Known deferred items at close:** Phases 136/138/140 VERIFICATION and Phase 138 UAT (4 scenarios) were human-signed-off at close (feature shipped to production and exercised live). v2 backlog: paste-a-FEN/PGN, full nested variation tree, promote/demote/delete variation, multi-thread WASM (D-3). Standing cross-milestone backlog noise (dormant seeds, todos, older quick-task tracking artifacts) carried forward — see STATE.md → Deferred Items.

---

## v1.28 Tactic Tagging (Shipped: 2026-06-25)

**Phases completed:** 14 phases (123.1, 124–135 incl. 128.1; 130 superseded by 131–134), 45 plans, 51 tasks. Phase 123.1 (standalone SEED-053 enabler) grouped in at close per the standalone-then-regroup pattern (cf. v1.20/v1.27).
**Stats:** ~531 files changed `v1.27..main`, net additions dominated by the committed CC0 puzzle + tagger fixtures; 154 commits (inflated by squash + forward-port); phases completed 2026-06-17 → 2026-06-25 since v1.27. Alembic migrations: tactic columns on `game_flaws` (124), `*_tactic_depth` (127), `allowed_*`/`missed_*` rename+add (128), `opening_position_eval` cache table (123.1). Phases 124–134 deployed via release #214 (2026-06-23); Phase 135 ships with this milestone close.
**Milestone goal:** Add a "cause of error" tactic axis to the flaw taxonomy — name the tactical motif behind every mistake/blunder from the already-stored refutation line (no new engine pass), then let players compare their tactic rates against their opponents'.

**Key accomplishments:**

- **Tactic-motif detector** (Phase 124) — cook.py-faithful heuristics reimplemented in original code (no AGPL copied), pure-CPU off the stored `game_positions.pv`, both colors, precision-first (NULL on low confidence). New nullable `tactic_motif`/`tactic_piece` columns on `game_flaws`, written inside the single classify path.
- **Precision hardened to ship-grade** (Phases 127, 131–134, SEED-064) — per-motif precision raised to ≥0.95 on a held-out CC0 lichess-puzzle TEST split for every shipped motif (fork/skewer/pin/back-rank/named-mates/tier-3/trapped-piece all ~1.000); a self-contained validation harness replaced the circular self-labeled fixtures; sub-floor motifs suppressed rather than mis-tagged.
- **Missed-vs-allowed dual orientation** (Phase 128, SEED-054) — `allowed_*` (the refutation) and `missed_*` (the stronger line) tagged via a second PV pass, distinguished without a perspective column through `is_opponent_expr`.
- **You-vs-opponent comparison** (Phase 126) — `GET /api/library/tactic-comparison` per-motif rates with the project's Wilson chess-score significance gating, honoring all game filters.
- **Full Library tactic UI** (Phases 126, 129) — family-colored chips with definition popovers, a 10-family taxonomy, depth-range filter, Either/Missed/Allowed toggle, two-bullet comparison grid + "More Tactics" accordion; later de-beta'd to all users and made the homepage hero.
- **Tactic Line Explorer** (Phase 135, SEED-065) — walkable PV stepper (desktop dialog / mobile drawer) stepping the missed and allowed lines on a large board + SAN ladder with a depth-to-punchline counter, entry points on flaw + game cards.
- **`opening_position_eval` cache table** (Phase 123.1, SEED-053) — position-keyed dedup cache replacing the cross-user self-join, cutting the per-game opening-eval lookup from ~8.4 s to sub-ms.

**Known deferred items at close:** see STATE.md → Deferred Items (Phase 135's 2 manual UAT scenarios on a now-shipping feature + standing cross-milestone backlog noise).

---

## v1.27 Remote Eval Worker Fan-Out & In-App Feedback (Shipped: 2026-06-16)

**Phases completed:** 3 phases (121, 122, 123), 6 plans. Grouped at close per the standalone-then-regroup pattern (cf. v1.20) — each phase shipped to prod standalone and soaked before grouping; released to production across PRs #199 (121), #202 (122), #203 (123) plus follow-on ops/quick-task releases through #208. Production code tree matches `main` at close.
**Stats:** 55 code files changed (`app` + `frontend/src` + `scripts`), +2,847 / −308 lines (`v1.26..main`); 9 `feat(...)` commits; phases completed 2026-06-14 → 2026-06-16 since v1.26. Two Alembic migrations (122 `feedback` table; 123 `games.entry_eval_lease_expiry` / `entry_eval_leased_by` lease columns).
**Milestone goal:** Scale off-box eval compute beyond the idle tier-3 backlog and add a low-friction feedback channel. Two phases extend the v1.26 remote-eval-worker contract (SEED-048 / Phase 120); the third adds in-app feedback. Built from three independent seeds (SEED-048/049/051).

**Key accomplishments:**

- **Remote-worker tier-1 claiming** (Phase 121, SEED-048) — a remote eval worker can claim **tier-1 single-game "analyze" jobs**, not just the tier-3 idle backlog, so when the server pool is mid-game a second idle machine shortens click-to-pickup latency. FCFS overflow (the server in-process drain still wins tier-1 when idle); an opaque `job_id` is threaded lease→submit (carrying `eval_jobs.id`, `None` for tier-3) with a `status='leased'` stamp guard, and the worker idle poll dropped 5s→1s. No DB migration. Prod soak: no tier-1/tier-3 double-claim; submit correctly stamps `eval_jobs`. VERIFICATION passed.
- **In-app feedback button** (Phase 122, SEED-049) — a low-friction channel (guests included) tying submissions to the exact page. New `feedback` table + thin `POST /api/feedback` (service → repository, per-user rate-limit + max-length guard), a **floating auto-hiding button** (hides on scroll-down / open overlays, `env(safe-area-inset-bottom)`, ≥44px tap target) + modal (required text + optional 3-point sentiment), and a **Sentry signal** tagged `source="feedback"` + username / ELO-bucket / platform so feedback pings the team. All 5 human-gated UAT items confirmed on prod (iOS safe-area, overlay-yield, live Sentry tags, bottom-bar clearance, keyboard-dismiss draft retention).
- **Remote-worker entry-ply fresh-import drain** (Phase 123, SEED-051) — extends the headless worker pool to also drain **entry-ply (import-time, depth-15) eval** in parallel on **big first imports**, cutting first-import latency by ~the worker fan-out factor via a **three-rung priority ladder** (tier-1 > entry-ply fresh-import drain > tier-3, checked between full-ply games, no preemption). One nullable `games` lease column + `SKIP LOCKED` LIFO claim (queue predicate unchanged), batched `/entry-lease` + `/entry-submit` endpoints (server derives targets; worker stays a dumb Stockfish-over-HTTP node), and a **D-5 backlog-depth gate** (`LIMIT 1 OFFSET 299`) so incremental syncs stay server-pool-only and only big imports pay the lease tax. Verified on a real **5,132-game first import** (user 28): drain split server-pool 2,573 / worker `ws80` 1,800 at identical 3.7 evals/game density, 100% `evals_completed_at`, zero stuck/expired-unstamped leases; CR-01 zero-target lease livelock fixed live; mixed-fleet backward compat held (un-upgraded workers drain full-ply only). UAT 2/2 pass.

**Scope notes:** grouped post-hoc at close — the three phases shipped standalone (releases #199/#202/#203) across 2026-06-15…06-16. Seed-driven, so no milestone REQUIREMENTS.md (cf. v1.20). The CHANGELOG v1.27 section also bundles the post-v1.26 stabilization work that shipped in the same window: guest welcome page (SEED-047), analyze Pending/Analyzing pill (260615-q1x), guest on-demand analyze (260616-ey1), and import-counter / WAL / lichess-provenance / N+1 ops fixes (FLAWCHESS-6G, 260616-rm6/pjh, ops).

**Deferred (owned by seeds):** biasing tier-1 to the faster box + interruptible tier-3 (SEED-048 follow-ons); entry-ply lease TTL sizing, routing `run_eval_drain` through the same lease, backlog-gate threshold tuning against live throughput (SEED-051 open items); macOS background-scheduling caveat for off-box workers (SEED-048).

See `.planning/milestones/v1.27-ROADMAP.md`.

## v1.26 Full-Game Eval Pipeline (Shipped: 2026-06-14)

**Phases completed:** 7 phases (116, 117, 117.1 INSERTED, 117.2 INSERTED, 118, 119, 120), 18 plans (+ the 117.2 data migration and the SEED-049 quick task). All landed on `main` via local squash-merge / gated commits; released to production across PRs #187/#188/#190/#191 and follow-on releases through #195. Production code tree matches `main` at close.
**Stats:** 94 code files changed (`app` + `frontend/src` + `scripts`), +12,555 / −494 lines (`v1.25..main`, excluding `.planning`); 20 `feat(...)` commits; phases completed 2026-06-12 → 2026-06-14 (3 days) since v1.25. Several Alembic migrations (116 completion marker + dedup index; 117 best_move/pv/lichess_evals_at/full_pv_completed_at + `eval_jobs` lease table; 117.1 clean-slate NULL; 117.2 residue wipe; 118 `ix_eval_jobs_user_active`; 119 `games.full_eval_attempts` + tier-3 partial index + drop the 118 index).
**Milestone goal:** Turn eval coverage from "endgame-entry plies only" into a **full-game background analysis pipeline** — every move of a user's imported games evaluated by Stockfish at Lichess-parity strength (1M nodes/move), drained by a tiered priority queue (explicit > recent windows > idle backlog), with results flowing automatically into the Library's flaw surfaces. Server-first v1 of SEED-012 (client analysis deferred); decisions locked 2026-06-12.

**Key accomplishments:**

- **All-ply engine core** (Phase 116, EVAL-01/02/03/05, QUEUE-07) — the eval drain analyzes every ply at the **1M-node / NNUE / multiPV=1 Lichess-parity budget** (replacing the depth-15 entry-ply convention for this pipeline), storing `eval_cp`/`eval_mate` on every `game_positions` row with a **ply≤20 `full_hash` dedup transplant** (the shared opening region stays cheap, eval charts get no opening gap, no openings-table dependency) and a **distinct full-analysis completion marker** (`full_evals_completed_at`) separate from the entry-ply `evals_completed_at`. Per-worker RSS was measured at the 1M-node budget and the pool footprint bounded against the backend container's 4g limit before raising `STOCKFISH_POOL_SIZE`.
- **Tiered priority queue + flaw integration** (Phase 117, EVAL-04/06, QUEUE-01/02/03/05/06/08) — a **PostgreSQL SKIP-LOCKED tiered priority queue** (tier-1 explicit > tier-2 recent windows > tier-3 idle backlog) with **round-robin per-user fairness** + TC-weighted within-user order, a **lease/report contract** (a future browser/external worker is additive), **tier-1 ~10s fan-out** across the whole pool, **`best_move` (PV[0]) for every position** + full PV only adjacent to flaws (engine-best-move step-through for free; full-PV-for-all rejected at ~5 GB), automatic **`classify_game_flaws` flow-through** (flaws appear without user action; the hot import lane stays fast), and **guest exclusion** on every path. Verified 14/14 must-haves; SECURED 13/13 threats (117-SECURITY.md).
- **Post-move eval convention fix + residue wipe** (Phases 117.1 + 117.2 INSERTED, SEED-044, EVALFIX-01..05) — fixed an off-by-one where the engine drain stored the **pre-push** position's eval while the classifier assumed **post-move**, which mis-scored flaws for *every* chess.com game. Canonicalized storage to **post-move everywhere** (one rule, no per-source branch), added a terminal-position eval so the last move is flaw-assessable, reworked the dedup transplant with a one-ply donor shift, and re-evaluated affected games from a clean slate. 117.2 then wiped 3,497 eval-only-residue engine games (3 users) that were showing as analyzed-with-no-flaws. Both gated on `lichess_evals_at IS NULL` — lichess data untouched throughout.
- **Demand UX + on-demand analysis** (Phase 118, QUEUE-04, EVUX-01/02/03) — explicit **per-game and bulk "Analyze" affordances** with localized "Analyzing…" indicators that flip to the analyzed view without a page refresh, **"N of M analyzed" coverage badges** + an "analyze more" CTA when coverage is low, in-flight status, and **guest promotion** ("Sign up to unlock full-game analysis") in every analyze slot instead of a silent no-op.
- **Eval-drain coverage hardening** (Phase 119, SEED-045/046) — **bounded-retry hole-filling** (withhold the "fully analyzed" marker while genuine non-terminal/non-mate holes remain; retry up to MAX_EVAL_ATTEMPTS then stamp + one aggregated Sentry event; a `resweep_holed_games` backfill re-arms previously-stamped games); a **recency-weighted Efraimidis–Spirakis tier-3 lottery** so returning users' coverage badge ticks briskly (τ/floor tunable for prod); the **lichess-%eval leak fix** (the drain previously burned ~70% of capacity re-evaluating already-analyzed lichess games — now it skips them entirely); and an **honest pulsing coverage badge** with `in_flight_count` removed end-to-end. Follow-on SEED-049 (quick task `260614-tgs`) excluded the game-ending ply from the hole definition.
- **Headless remote eval worker** (Phase 120, SEED-048, D-1..D-7) — off-box CPU for the tier-3 drain via an **operator-token-authed lease/submit HTTP contract** + a **headless Python CLI worker** running the existing `EnginePool` natively and posting evals back, with server-side **SF-version-mismatch rejection** and **weighted-random within-user game pick** to cut multi-worker collisions. Trusted-operator write scope only; idempotent duplicate tier-3 work accepted for v1.

**Scope amendments during the milestone:** the roadmap bullet originally read "Phases 116–119"; widened to **116–120 (incl. 117.1/117.2)** at close to cover the full shipped body of work. Two correctness phases (117.1, 117.2) were inserted from SEED-044 when the pre/post-move off-by-one surfaced. Phase 118's **tier-2 auto-enqueue was dropped** in Phase 119 in favour of an explicit on-demand model (`EVAL_AUTO_DRAIN_ENABLED` gates automatic background drain — off in dev/CI, on in prod). The original REQUIREMENTS.md covers 116–118 + 117.1 (EVAL/QUEUE/EVUX/EVALFIX); Phases 119 and 120 were seed-driven additions tracked via their seeds.

**Deferred (v2, owned by seeds):** browser WASM workers on the same queue (SEED-012 D-8 phase 2); tactic-motif classification over the captured PVs (SEED-039); spaced-repetition blunder drills (SEED-037); cloud eval APIs (ruled out 2026-06-12); τ/floor prod-tuning for the tier-3 lottery (SEED-046 timing caveat).

**Known deferred items at close:** see STATE.md Deferred Items (open-artifact audit at close: 27 items — 15 quick tasks [mostly `unknown` status, the known stale-count false-positive], Phase 117 human-needed verification + Phase 119 UAT on features now live in prod, 5 long-range todos, 5 dormant seeds incl. SEED-039/037/012 which are explicitly Out-of-Scope; none block the release).

See `.planning/milestones/v1.26-ROADMAP.md` and `.planning/milestones/v1.26-REQUIREMENTS.md` (22/22 in-scope requirements complete; Phases 119/120 seed-driven; SEED-039/037/012 deferred to v2).

## v1.25 Flaw-Stats Opponent Comparison (Shipped: 2026-06-12)

**Phases completed:** 4 phases (113, 114, 114.1 INSERTED, 115), 8 plans. All landed on `main` via local squash-merge / gated commits; released to production 2026-06-12 via PR #185 (`78c19514`).
**Stats:** 56 code files changed (`app` + `frontend/src` + `scripts`), +4,635 / -1,393 lines across the phase work; phases completed 2026-06-10 → 2026-06-11, shipped to prod 2026-06-12. One Alembic migration (114.1: `move_count` → `ply_count`); Phase 113 added no schema (query-time `is_opponent_expr`).
**Milestone goal:** Rework the Library flaw-stats surface from a self-only descriptive panel into an actionable **you-vs-opponent comparison** — flaw rates only reveal a specific recurring weakness when contrasted against ELO-matched peers.

**Key accomplishments:**

- **Opponent-flaw materialization** (Phase 113, FLAWX-01/02/04) — `game_flaws` now records both sides' mistakes/blunders for every analyzed game, with the player/opponent split **derived at query time** via a single tested `is_opponent_expr(ply, games.user_color)` helper — no `is_opponent` column, no migration, no index (113-CONTEXT D-01/D-02/D-03 voided FLAWX-03). All three classify paths persist opponent flaws without a second engine evaluation (D-10 preserved); every existing reader was retrofitted with a player-only gate so opponent rows don't leak into the self-only UI. Dev users 28 & 44 + the benchmark cohort backfilled idempotently; prod ships empty.
- **Benchmark flaw-delta zones** (Phase 114, FLAWBMK-01..04) — the `/benchmarks` skill gained a §5 chapter computing per-(metric, ELO×TC) Q1/Q3 quartile "typical" delta zones for all 15 flaw-delta metrics with ELO/TC marginals and per-axis Cohen's-d collapse verdicts — the lightweight delta-IQR zone, deliberately not the heavy 99-breakpoint endgame CDF.
- **Exact `ply_count`** (Phase 114.1 INSERTED, SEED-041 §9) — replaced `games.move_count` (±1 half-move accurate) with an exact `games.ply_count` via one hand-written migration (add + backfill + drop, ~10s on prod, no NULL window). Display stays full-moves; payoff is an exact per-game user-move denominator with zero `game_positions` access, speeding both the §5 benchmark chapter and the Phase 115 live endpoint.
- **You-vs-opponent comparison API + bullet grid** (Phase 115, FLAWCMP-01/03/04/05 + FLAWUI-01..06) — a new `GET /api/library/flaw-comparison` endpoint returning the full 15-bullet inventory via a **unified per-100-moves paired per-game delta** estimator with a bootstrap/normal CI (114-CONTEXT D-01/D-04 superseded the SEED-040 count-rate/proportion split; FLAWCMP-02 Wilson method voided), honoring all game filters + severity. The old tag-distribution zone is replaced by a uniform `MiniBulletChart` grid (measure + CI error bar + benchmark "typical" blue zone), family-grouped, with per-bullet tooltips disclosing definition, sign convention, tempo caveat, and filter×zone interaction. Section-level sample gate below floor N; responsive + `data-testid`/ARIA parity.

**Deferred (v2, owned by seeds):** tactic-motif comparison families and the literal `missed-X` upgrade (FLAWTAC — SEED-039); analyzed-game coverage raising via client-side `stockfish.wasm` / server idle-time analysis (FLAWCOV — SEED-012). The feature ships for the ~37–51 heavy-analysis users.

**Known deferred items at close:** see STATE.md Deferred Items (open-artifact audit at close: 26 items — 13 quick tasks all shipped [false-positive `unknown` status], Phase 115's 2 manual UAT scenarios + human-needed verification on a feature now live in prod, 5 long-range todos, 4 dormant seeds incl. SEED-040's delivered scope; none block the release).

See `.planning/milestones/v1.25-ROADMAP.md` and `.planning/milestones/v1.25-REQUIREMENTS.md` (18/18 active requirements complete; FLAWX-03 + FLAWCMP-02 voided; FLAWTAC / FLAWCOV deferred to v2).

## v1.24 Library Page (Shipped: 2026-06-09)

**Phases completed:** 9 phases (104–112), 37 plans. All landed on `main` via local squash-merge or direct gated commits. Phase 111 (Library UI polish) shipped via direct commits with no GSD plan/summary artifacts — its record lives in `milestones/v1.24-ROADMAP.md` + git history.
**Stats:** 131 code files changed (`app` + `frontend/src` + `scripts`), +13,182 / -1,242 lines, ~105 commits over 6 days (2026-06-03 → 2026-06-09) since v1.23 (`a3585d6c` → `4192f4b9`). Four Alembic migrations (create `game_flaws`, alter impact columns, rename `lucky`, drop display columns).
**Milestone goal:** Introduce the **Library** as a top-level destination and build out SEED-036's analysis half — an eval-driven mistake/flaw archive over the user's analyzed games. What began as a pure-frontend shell + route migration grew into a full-stack flaw layer: an on-the-fly classifier, a materialized `game_flaws` table, Games and Flaws subtabs, per-card eval charts, a finalized flaw-tag taxonomy, and a cross-tab Flaw filter.

**Key accomplishments:**

- **Library shell + migration** (Phase 104, LIB-01..09) — a new top-level **Library** page hosting Import and Overview as deep-linkable URL-routed `<Tabs variant="brand">` subtabs (`/library/import`, `/library/overview`), mirroring the Openings/Endgames pattern. Top-level nav dropped to Library · Openings · Endgames (+ Admin); `/import`, `/overview`, `/rating`, `/global-stats` redirect into the matching subtab; the `totalGames === 0` dot moved to Library; state-dependent landing. Pure frontend, no backend changes.
- **On-the-fly mistake kernel** (Phases 105–106, LIBG-02/06/07/08/09) — a server-side `flaws` service deriving per-ply severity (Lichess-aligned 0.05/0.10/0.15 ES-drop thresholds, mate via ±1000 cp-equivalent Option B) + attribution tags from stored `eval_cp`/`eval_mate`, with no schema change; two endpoints (`GET /api/library/games` mistake-filtered archive + per-game B/M/I counts/chips, `GET /api/library/mistake-stats` aggregates) over an `apply_game_filters` `EXISTS` and a SQL window-scan.
- **Games subtab** (Phase 107, LIBG-01/03) — the headline surface: a filterable game-card archive + a Flaw-Stats panel (per-severity rates per game / per 100 moves, tag distribution, trend over time, explicit `% analyzed` + N), now the returning-user default subtab.
- **Flaws subtab + materialization** (Phase 108, SEED-038) — the Flaws subtab (one card per flawed position) backed by a new derived **`game_flaws`** table (composite PK `(user_id, game_id, ply)`, typed tag-family columns + display payload, M+B-only), a per-flaw list endpoint, and a shared cross-tab **Flaw filter** (single-flaw `EXISTS`, OR-within-family / AND-across-family). `apply_game_filters` migrated off the on-the-fly window-scan onto `game_flaws`; `scripts/backfill_flaws.py` + a single classify path (D-10) across import hook / reclassify / backfill. Also fixed: flaw position stored one ply too early; severity filter leaking "or worse"; tag filters not applying on Games.
- **Per-card eval chart** (Phase 109, LIBG-10) — each analyzed Games card gains a recharts expected-score area chart (white-perspective lichess sigmoid, 50% midline, advantage shading) as a new middle column (three equal thirds), with your-flaw dots, phase-transition lines, checkmate-to-mate bar, and per-ply tooltips that scrub the miniboard. Delivered inline on the existing payload (no new endpoint, no migration).
- **Flaw-tag taxonomy overhaul** (Phase 110) — tempo `impatient`→`hasty` / `considered`→`unrushed`; impact family rebuilt from the outcome-dependent `result-changing`/`while-ahead` to the outcome-independent ladder `reversed` (ES ≥70%→≤30%) / `squandered` (ES ≥85%→≤60%); canonical `lowercase-with-dash` chip names + restored definition popovers (thresholds interpolated from shared constants, codegen'd to `flawThresholds.ts` under a CI drift gate); chip→Flaws deep-links dropped; active-filter chip emphasis. New alter migration, dev-only backfill (users 28 & 44).
- **Filter-UX polish + Flaws-card rework** (Phases 111–112) — a staged **Apply-only** filter model across every filter panel (Reset + Apply footer; closing any other way discards changes); the Library "Flaw filters" panel renamed **Tags**. The Flaws subtab reworked into a responsive 2-up `Card` grid matching the Games visual language (banded header, 132px miniboard with flaw arrow, move notation + user-POV mate-aware eval swing, family-colored chips), with a **View game** modal backed by a new `GET /api/library/games/{game_id}` single-game endpoint.

**Deferred (still in SEED-036):** the Analysis detail viewer (LIBG-04) and the on-demand best-move endpoint (LIBG-05) — intentionally left for a later phase.

**Tech debt (carried forward, informational):**

- Phase 111 has no GSD plan/summary artifacts (shipped direct).
- Dev-only `game_flaws` backfill (users 28 & 44); `game_flaws` ships empty to prod on the v1.24 release.
- SEED-030 Track A (split oversized multi-concern modules) remains open.

**Known deferred items at close:** see STATE.md Deferred Items (open-artifact audit at close: 24 items — 3 phase UATs human-passed-at-ship with stale frontmatter, 10 quick tasks, 5 long-range todos, 6 dormant seeds incl. SEED-036's deferred half; none block the release).

See `.planning/milestones/v1.24-ROADMAP.md` and `.planning/milestones/v1.24-REQUIREMENTS.md` (16/16 in-scope requirements complete; LIBG-04 / LIBG-05 deferred).

---

## v1.23 LLM Endgame-Insights Statistical-Reasoning Rework (Shipped: 2026-06-03)

**Phases completed:** 2 phases (102, 103), 3 plans. Phase 102 landed on `main` via local squash-merge (PR #173 closed in favour of the squash) after full HUMAN-UAT; Phase 103 landed as direct gated commits.
**Stats:** 39 code files changed, +4,144 / -3,032 lines, 37 commits over 3 days (2026-06-01 → 2026-06-03) since v1.22 (commit `3943b893` → `89403360`).
**Milestone goal:** Rework the endgame-insights LLM payload + prompt so the model reasons explicitly over the v1.17–v1.21 statistical-rigor metric set and the v1.19 peer-relative percentile annotations, with guardrails that prevent narrating small-but-significant findings. The cohort `zone` field stays the sole gate on *whether* a metric is narrated; percentile informs only *how*. No new frontend cards.

**Key accomplishments:**

- **Phase 102 — Endgame LLM Statistical-Reasoning Rework** (LLM-01..07): wired cohort-framed peer-relative **percentile annotations** (the page-level, game-count-weighted value the chip shows) into the endgame-insights payload alongside the existing `zone` + `sample_quality` fields, and taught the prompt to weave them in naturally ("vs other ~{anchor}-rated players"). Added **LLM narration of time pressure** — Score Gap by Remaining Time (restored from the payload after Phase 88.1 stripped it), Clock Gap, and Net Flag Rate. Relaxed the `overview` ("Data Analysis" card) word cap so longer narration fires only when ≥3 distinct signals genuinely exist, keeping the no-fabrication / within-noise guards. Audited prompt vocabulary against both the Endgame Statistics Concepts accordion and the tooltip info-icon popovers. **p-values + CI bounds stayed OUT** (redundant with the zone band; conflicts with `feedback_llm_significance_signal`). Prompt walked `endgame_v35` → `endgame_v43` across the auto-chain (per-TC metrics_elo, per-TC time-pressure chart block, per-TC type_breakdown), each cache-invalidating via `_PROMPT_VERSION`. HUMAN-UAT (LLM-07) was the primary verification — multiple passes against short-history / sparse-section / full-history production users, signed off 2026-06-02.
- **Phase 103 — Endgame report LLM prompt refinements** (unplanned follow-on, direct commits): three recommendation-quality fixes from chess-GM feedback — time-trouble advice reframed to decision speed (not opening repertoire), a new register item banning the "do X → effect Y" fabricated-mechanism construction (state the WHAT, leave the HOW to the player), and a ban on naming specific theoretical positions (Philidor, Lucena, opposition, …) as study targets at every Elo since the data is type-level aggregate. Added a fixed GM Noël Studer Lichess endgame study link to the Recommendations card (frontend-only; the prompt does not emit the URL). Prompt then condensed ~35% (`endgame_v44`), payload shape unchanged.

**Tech debt (carried forward, informational):**

- SEED-030 Track A (split oversized multi-concern modules) remains open.
- SEED-033 explorer ply-cap + partial Zobrist indexes (quick task 260601-og7) landed in this window (~3 GB prod index-footprint reduction); prod reindex ops tracked in the quick task.

See `.planning/milestones/v1.23-ROADMAP.md` and `.planning/milestones/v1.23-REQUIREMENTS.md` (7/7 LLM-01..07 complete).

---

## v1.22 Maintenance — Test Isolation & Frontend Major Upgrades (Shipped: 2026-05-31)

**Phases completed:** 2 phases (100, 101), 3 plans. Landed directly on `main` (gated per-cluster), no release PR per phase.
**Stats:** 132 files changed, +7,748 / -3,104 lines, 31 commits on 2026-05-31 since v1.21 (commit `45d882c7` → `db8eca80`). The two phases plus small direct-to-`main` backend dependency / insights maintenance.
**Milestone goal:** Clear two accrued maintenance debts before the next feature milestone — make the test suite safe under concurrent runs and `pytest -n auto`, and bring the frontend onto its latest major dependency versions. Backend had no outstanding major bumps.

**Key accomplishments:**

- **Phase 100 — Isolated Test DB Per Run** (SEED-031): each `pytest` run (and each `pytest-xdist` worker) now gets its own database cloned from a migrated template via `CREATE DATABASE … TEMPLATE`. The hostile session-start `TRUNCATE … RESTART IDENTITY CASCADE` whole-schema `ACCESS EXCLUSIVE` lock is retired (a fresh clone is already clean); the template auto-refreshes on Alembic head drift under a `pg_advisory_lock`; killed runs self-heal (drop-if-exists on next create); per-run DBs drop at teardown. Two full suites run simultaneously with zero deadlocks / zero cross-run corruption; `pytest -n auto` green at 18.56s vs 40.29s serial (2.2x). CI stays serial (D-02).
- **Phase 101 — Frontend Major Dependency Upgrades** (SEED-032): 11 majors-behind frontend deps brought to latest major across six atomically-committed clusters in low→high risk order (lucide-react 1 → Vite 8 + plugin-react 6 → jsdom 29 → eslint 10 stack → TypeScript 6 → recharts 3), each gated so a failure bisects to one cluster. recharts 2 → 3 earned a desktop + mobile visual UAT, which caught one zone-band regression (fixed + regression-tested). typescript-eslint ↔ TS6/eslint-10 peer-compat clean (escape hatch not needed); shadcn straggler 4.8.3 → 4.9.0; `@types/node` held at 24.x. Final gate: backend 2198 passed / 16 skipped, frontend 745 passed, build + knip clean, npm audit 0 high.
- **Backend / insights maintenance** (direct-to-`main`, same window): `uv lock --upgrade` + pinned patched transitives clearing Dependabot alerts, pydantic-ai-slim 1.85 → 1.104 with deprecation cleanup, Gemini 3 thinking-level support (default low).

**Tech debt (carried forward, informational):**

- TS7 `baseUrl`-removal follow-up suppressed via `ignoreDeprecations "6.0"` (REVIEW IN-01) — revisit at the TypeScript 7 bump.
- SEED-030 Track A (split oversized multi-concern modules) remains open.

**Known deferred items at close:** 13 (see STATE.md Deferred Items — all dormant seeds / long-range todos, none v1.22-scoped).

See `.planning/milestones/v1.22-ROADMAP.md`. No formal requirements (both phases standalone, sourced from SEED-031 / SEED-032 — no requirement IDs); `REQUIREMENTS.md` was kept in place (not archived/deleted) because it tracks the deprioritized LLM Statistical Reasoning scope now parked at backlog Phase 999.7 (see `v1.22-REQUIREMENTS.md`).

---

## v1.21 Time-Control-Aware Endgame Metrics (Shipped: 2026-05-31)

**Phases completed:** 4 phases (97, 98, 99, 99.1), 15 plans. Delivered via PRs #160 (Phase 97), #163/#164 (Phase 98), #167 (Phase 99), #168 (Phase 99.1); benchmark-generator side work in #166.
**Stats:** ~383 files changed, +156,697 / -101,643 lines (dominated by the Phase 99 cohort-CDF regen and the Phase 99.1 demotion of that generated data), 54 commits over 3 days (2026-05-29 → 2026-05-31) since v1.20 (commit `dcd22fef` → `83fe9f01`).
**Milestone goal:** Make the entire Endgame Metrics and Endgame Type Breakdown reporting time-control-aware, so a player is judged against the norms of the speed they actually play rather than a blended average.

**Key accomplishments:**

- **Phase 97 — Endgame Metrics by Time Control** (PR #160): replaced the single aggregated Conversion/Parity/Recovery cards with one card per time control (bullet/blitz/rapid/classical), each carrying its own gauge trifecta, WDL bar, and Score Gap chart. Conversion/Recovery gauges use TC-specific neutral bands (benchmark TC d≈0.9); Parity and Score Gap keep the shared global band (both collapse on TC). Cards self-suppress below a per-TC games floor. New backend `_compute_per_tc_metric_cards` + a `TC_METRIC_BANDS` registry codegen'd into `endgameZones.ts`.
- **Phase 98 — Per-TC Collapsible Endgame Type Cards** (PR #163, release #164): restructured the Endgame Type Breakdown from a 3-col grid of five per-type cards into full-width vertically-stacked collapsible cards, one per TC, primary TC (time-weighted) expanded by default. Each card holds a 2×2 grid of four type tiles (rook/minor_piece/pawn/queen — Mixed dropped); Conv/Recov gauges return, banded against each card's own per-(class × TC) IQR, Score Gap banded per-TC for one consistent card grammar.
- **Phase 99 — Percentile Badges for Conversion, Parity, and Recovery** (PR #167): added peer-relative percentile chips to the per-TC Conv/Parity/Recov rate cards. 12 new per-(metric, TC) ENUM values computed via the shared pooled-per-user `canonical_slice_sql.py` builder parameterised by TC, cohort-matched on the per-(user, TC) rating anchor, 4-bullet disclosure tooltip. Prod backfill deferred to deploy (todo `2026-05-31-phase-99-prod-backfill-rate-percentiles`).
- **Phase 99.1 — Move Cohort CDF Out of Source into a DB Table** (PR #168; INSERTED): relocated the generated `COHORT_PERCENTILE_CDF` registry (3.1 MB / ~130k lines) out of `app/services/global_percentile_cdf.py` into a `benchmark_cohort_cdf` DB table seeded from a compact `app/data/` artifact via `scripts/seed_cohort_cdf.py`; the module shrank to ~250 lines. Internal refactor, byte-for-byte chip parity, no behaviour change. Closes SEED-030 Track B.

**Tech debt (carried forward, informational):**

- Prod backfill of the 12 new rate-percentile metrics deferred to deploy.
- SEED-030 Track A (split oversized multi-concern modules) remains open.

See `.planning/milestones/v1.21-ROADMAP.md`. No formal requirements (all phases standalone endgame-stats UX refinements / internal refactor — no requirement IDs); REQUIREMENTS.md continues to track the pending v1.22 LLM Statistical Reasoning scope.

---

## v1.20 Import Pipeline Hardening Follow-Up and Readiness (Shipped: 2026-05-29)

**Phases completed:** 2 phases (95, 96), 5 plans. Delivered via PRs #148/#149 (Phase 95) and #151 (Phase 96). Two standalone phases regrouped post-hoc into a milestone on 2026-05-30.
**Milestone goal:** Finish closing the FLAWCHESS-3Q OOM family (asyncpg COPY for the heaviest import write) and replace the eval-coverage auto-reload hack with an honest per-page readiness gate.

**Key accomplishments:**

- **Phase 95 — asyncpg COPY for `bulk_insert_positions`**: switched the heaviest INSERT in the import pipeline to asyncpg binary `copy_records_to_table`, the SEED-027 Thread B follow-up to the Thread A container-memory-budget hotfix (PR #144). Enrolled in the active session transaction for atomicity; `bulk_insert_games` keeps its `ON CONFLICT DO NOTHING` path.
- **Phase 96 — Import Readiness Gate**: replaced the `window.location.reload()`-on-eval-complete hack with a two-tier per-page gate — Tier 1 (hot lane drained) unlocks Openings + Overview, Tier 2 (evals drained + Stage A/B percentiles persisted) unlocks Endgames. Consolidated eval-progress UI into a single global header.

See `.planning/milestones/v1.20-ROADMAP.md`. No requirements archive (both phases standalone hardening/UX — no requirement IDs).

---

## v1.19 Endgame Percentiles (Shipped: 2026-05-27)

**Phases completed:** 6 phases (93, 94, 94.1, 94.2, 94.3, 94.4). 26/26 PCTL/TPCTL/PRPCR requirements satisfied. Final phase merged via PR #145.
**Milestone goal:** Surface peer-relative percentile annotations on Endgame metrics so users see how their performance compares to same-rated cohort peers.

**Key accomplishments:**

- **Phase 93 — Global Percentile Benchmark Artifact** and **Phase 94 — Backend & Frontend Percentile Annotations**: the cohort-percentile pipeline + the `PercentileChip` primitive.
- **Phase 94.1/94.2 — Canonical-Slice / Pooled-Per-User Percentile Materialisation**: redesigned per-user percentile computation so CDF construction and per-user lookup share one SQL path (drift structurally impossible).
- **Phase 94.3 — Per-TC Percentile Chips on Time Pressure Cards** (INSERTED, SEED-025) and **Phase 94.4 — Peer-Relative Percentile Chip Refinement** (INSERTED, SEED-026 v2 + D-12 reversal): the per-TC chip pattern later reused by Phase 99.

Phase 95 (LLM Statistical Reasoning) was split out into v1.20 on 2026-05-27 (commit `dd88ffda`) before milestone close. Audit at `.planning/v1.19-MILESTONE-AUDIT.md`; traceability in `.planning/milestones/v1.19-REQUIREMENTS.md`.

---

## v1.18 Import Pipeline Hardening (Shipped: 2026-05-22)

**Phases completed:** 3 phases (90, 91, 92), 17 plans, delivered via PRs #130, #137, #138 (plus the production-branch hotfix #139 capping DB pool / max_connections / container memory for FLAWCHESS-3Q).
**Stats:** 240 files changed, +30,193 / -9,406 lines, 54 commits over 3 days (2026-05-19 → 2026-05-22) since v1.17 (commit 114211c2 → f5224b4f).
**Source:** Two prod-side OOM recurrences after v1.17 (FLAWCHESS-56 2026-05-16, FLAWCHESS-3Q 2026-05-21) — single-import RSS climbing linearly under heavy fetch, Postgres OOM-killed when one uvicorn process fanned out to 13 active backends. Seeds SEED-017/018/022/023 captured the diagnostic; this milestone retired all four.

**Key accomplishments:**

- **Phase 90 — Import pipeline memory leak fix + resilience** (PR #130): replaced the literal `case()`+`IN` bulk UPDATE in `_flush_batch` Stage 5 with bound-parameter `executemany` (root cause of the linear RSS climb — a per-batch unique SQL statement that the prepared-statement cache kept forever). Scoped `AsyncSession` per batch in `run_import`. Promoted `cleanup_orphaned_jobs()` from a startup-only call to a periodic + on-DB-reconnect reaper so a Postgres-only restart no longer strands jobs `in_progress`. Bounded-retry-with-backoff around the failure-state UPDATE.
- **Phase 91 — Two-lane import: defer Stockfish eval to in-process cold drain** (PR #137 + follow-on #134/#135): added `games.evals_completed_at` + partial index. Hot path now does fetch → parse → insert positions → commit with no Stockfish work; a separate `run_eval_drain()` lifespan coroutine picks 10 games per tick from the partial index and evaluates outside any session scope. Frontend Stockfish-coverage header bar + per-metric "based on N of M eligible games" caveat on every eval-dependent stat. Dual-20k stress-test harness in `scripts/measure_dual_import_rss.py`.
- **Phase 92 — Custom date range filter** (PR #138): replaced the closed `Recency` string union on the API wire with `from_date` / `to_date` params; added a 9th "Custom range…" entry to the recency dropdown with a desktop Popover + mobile nested Drawer, shadcn Calendar component installed. `Recency` → `RecencyPreset` UI-only type. LLM insights prompts derive human window labels from absolute dates. Closes a pending bookmark-timeseries cleanup todo (`2026-05-02-remove-recency-from-bookmark-timeseries`).
- **Hotfix PR #139 (FLAWCHESS-3Q)**: SQLAlchemy pool 20+30 → 10+10, Postgres `max_connections` 100 → 30, backend/db container `mem_limit` + `memswap_limit` set, Hetzner CPX32 → CPX42 (4→8 vCPU, 7.6→16 GB RAM). Postgres tuned for the 16 GB host (`shared_buffers=4GB`, `effective_cache_size=12GB`, `work_mem=16MB`).

**Tech debt (carried forward, informational):**

- SEED-024 (`ProcessPoolExecutor` for chess.com fetch lane) planted but deferred — pure throughput win, blocked on per-worker RSS measurement after the CPX42 RAM upgrade.
- Concurrent-import admission control (SEED-022 option F), scheduled backend-restart cadence (option G), and idempotent `on_game_fetched` (option A′) intentionally not shipped — hot-lane batches now too cheap to OOM under realistic concurrent load.

---

## v1.17 Endgame Stats Card Redesign (Shipped: 2026-05-19)

**Phases completed:** 13 phases (84, 85, 85.1, 86, 87, 87.1, 87.2, 87.4, 87.5, 87.6, 88, 88.3, 88.4), ~54 plans. Phase 87.3 superseded by 87.4; Phase 89 (Polish) dropped from scope. Delivered via PRs #89–#117.
**Stats:** 603 files changed, +82,473 / -9,393 lines, 203 commits over 8 days (2026-05-11 → 2026-05-19) since v1.16 (commit 4075431d → 114211c2).
**Known deferred items at close:** 164 open audit items acknowledged and deferred (see STATE.md Deferred Items) — same historical carry-forward as v1.11–v1.16 (155 misclassified quick-task dirs, 1 diagnosed debug session, 5 long-range todos, 3 dormant SEED-002/006 seeds).

**Definition of done:** Three table-driven Endgames-page sections replaced with the WDL + ScoreBullet card pattern, plus a full statistical-rigor pass (eval-based ΔES Score Gap, hypothesis tests + CIs, Endgame Skill dropped, Endgame ELO rebuilt, Time Pressure reworked).

**Key accomplishments:**

- **Section 1 (Phase 85/85.1)** — 3-card composite (Middlegame / At Entry / Endgame results) replacing the perf table + Start-vs-End twin-tile; two-sample z + paired one-sample z hypothesis tests with 95% CI whiskers on the Score Gap rows.
- **Section 2 (Phase 86/87.2)** — 4-card Endgame Metrics layout; retired the mathematically degenerate rate-based mirror-bucket peer-diff (Conv-Gap ≡ Recov-Gap) for an eval-based ΔES Score Gap anchored to the Stockfish baseline.
- **Section 3 (Phase 87/87.1)** — 5 per-type breakdown cards (rook/minor/pawn/queen/mixed) with Conv+Recov gauges, WDL bar, sig-gated chess-score bullet, per-span ΔES Score Gap row, `?type=` deep-links.
- **Endgame ELO rebuilt (Phase 87.4→87.5→87.6)** — Endgame Skill concept dropped end-to-end; timeline rebuilt as a logistic stretch around Actual ELO (`endgame_elo + non_endgame_elo == 2·actual_elo`), eliminating the sigmoid bias and the violated "Actual ELO between the lines" invariant.
- **Time Pressure rework (Phase 88/88.4)** — per-TC cards with benchmark-calibrated zones, 3-stat header row, and a zone-banded zero-centered line chart with CI whiskers replacing the stacked per-bucket bullets.
- **Viz polish (Phase 88.3)** — inactivity-gap break annotations on all 6 ordinal-axis timeline charts; ELO Timeline defaults to the single most-active series; Overall Performance restructured into one responsive 2-column card.

---

## v1.16 Stockfish Eval Analyses (Shipped: 2026-05-11)

**Phases completed:** 5 phases (80, 80.1, 81, 82, 83), 24 plans, delivered via PRs #80, #82, #85, #86, #88.
**Stats:** 267 files changed, +47,752 / -4,427 lines, 118 commits over 7 days (2026-05-05 → 2026-05-11) since v1.15 (commit 64441744 → 46f78231).

**Definition of done:** Downstream consumers of v1.15 Stockfish evals (endgame span-entry + middlegame-entry `eval_cp`/`eval_mate` on `game_positions`), plus opportunistic UX fixes that fall in the same area.

**Key accomplishments:**

- **Phase 80** — Opening Stats subtab: avg eval at middlegame entry ± std (user POV) with one-sample t-test confidence pill and CI-whisker MiniBulletChart; later restructured into a two-column card grid (quick task `260506-rtk`) replacing MostPlayedOpeningsTable.
- **Phase 80.1** — Move Explorer + Opening Insights WDL/score now reflect resulting-position (transposition-inclusive) instead of move-played only. New `query_transposition_wdl` + `query_resulting_position_wdl` repo helpers; `game_count` and the n≥10 surfacing gate stay move-played for honest disclosure.
- **Phase 81** — Endgame Start vs End twin-tile section above the WDL table: entry-eval (cp, sig-tested vs 0) + endgame score (sig-tested vs 50%), three-state color with Wald-z / Wilson tests, n≥10 gate, "we can't tell" framing for non-significant verdicts.
- **Phase 82** — LLM prompt pipeline (`endgame_v23` → `endgame_v24`) gains awareness of both Phase 81 metrics: `MetricId` + `SubsectionId` Literal extensions, `ZONE_REGISTRY` entries for `entry_eval_pawns` (band ±0.5 after D-08 tightening) + `endgame_score` (band [0.45, 0.55]); fixed two `_SECTION_LAYOUT` / `_format_zone_bounds` regressions during live UAT.
- **Phase 83** — Stockfish-baseline predicted endgame score (Lichess sigmoid k=0.00368208) with 2x2 grid restructure of Start vs End; `entry_expected_score` + `_n` / `_p_value` / `_ci_low` / `_ci_high` schema fields; LLM narrates achievable-vs-achieved gap as headline diagnostic (`endgame_v25` → `endgame_v26`). Closes SEED-014.

**Tech debt (carried forward, informational):**

- Phase 80: 8 informational UAT scenarios on UI superseded by two-column card grid (quick task `260506-rtk`).
- Phases 80.1 + 82: clerical `VALIDATION.md status=draft` / `nyquist_compliant=false` despite passing verification with all required tests in place.
- Pre-existing: stale `test_min_games_per_candidate_floor_at_10` (Phase 79 raised floor 10→20); project-wide `ruff format` drift on 89 files (not CI-gated).

---

## v1.15 Eval-Based Endgame Classification (Shipped: 2026-05-03)

**Phases completed:** 2 phases (78, 79), 10 plans, delivered via PR #78 (combined Phase 78 + Phase 79 cutover) plus follow-on PR #79 (`EnginePool` parallelisation).
**Stats:** 214 files changed, +21,125 / -4,336 lines, 68 commits over 5 days (2026-04-29 → 2026-05-03) since v1.14 (commit 50c16e5 → 42cddf5).
**Source:** `reports/conv-recov-validation-2026-05-02.md` flagged the material-imbalance + 4-ply persistence proxy at ~81.5% agreement vs Stockfish on the populated subset, missing ~24% of substantive material-edge sequences (queen + pawnless classes underperformed structurally).

**Key accomplishments:**

- Endgame Conversion / Parity / Recovery classification migrated from material-imbalance + 4-ply persistence proxy to direct Stockfish-eval thresholding (±100 cp on `eval_cp`, color-flipped to user perspective; `eval_mate` short-circuits to ±1,000,000 cp). Hard cutover, proxy code path removed entirely. Closes the structural gap on Queen and pawnless classes where the proxy underperformed (Phase 78 REFAC-01..03)
- Pinned Stockfish sf_17 AVX2 binary in the backend Docker image with SHA-256 supply-chain verification (later bumped to sf_18); CI installs `stockfish` via apt; `STOCKFISH_PATH` env var threaded end-to-end (Phase 78 ENG-01)
- `app/services/engine.py` — async-friendly Stockfish wrapper with FastAPI lifespan integration (`start_engine` / `stop_engine`, idempotent, depth-15 `evaluate()` API). Shared by import path and backfill script (Phase 78 ENG-02, ENG-03)
- `scripts/backfill_eval.py` — idempotent + resumable CLI driver (skip-where-NULL, COMMIT-every-100, `--db dev/benchmark/prod`, `--user-id`, `--limit`, `--dry-run`, `--workers N` for parallel evaluation). FILL-02 relaxed mid-plan to drop `full_hash` dedup — added complexity for marginal CPU savings on a one-shot backfill (Phase 78 FILL-01..04)
- Import-time eval pass: per-class span-entry rows + middlegame entry row populated on every new import in `_flush_batch` between `bulk_insert_positions` and the `move_count` UPDATE, in the same transaction. Adds well under 1s to the typical-game import path (Phase 78 IMP-01..02; Phase 79 PHASE-IMP-02)
- Alembic `c92af8282d1a` reshapes `ix_gp_user_endgame_game INCLUDE` from `material_imbalance` to `eval_cp` / `eval_mate` so rewritten endgame queries stay index-only. `_classify_endgame_bucket(eval_cp, eval_mate, user_color)` is the single helper; SQL projects raw white-perspective eval, service applies the user-color sign flip (Phase 78 REFAC-04, REFAC-02)
- Phase 79: `game_positions.phase` SmallInteger column (0=opening, 1=middlegame, 2=endgame) computed via Python port of [lichess `Divider.scala`](https://github.com/lichess-org/scalachess/blob/master/core/src/main/scala/Divider.scala) using existing `piece_count`, `backrank_sparse`, `mixedness` inputs — no second board scan. 11 Divider-sourced parity assertions in `tests/test_position_classifier.py` lock output to lichess reference (Phase 79 CLASS-01..02, SCHEMA-01..02; Alembic `1efcc66a7695`)
- Phase 79: Middlegame entry position (`MIN(ply)` of `phase = 1` per game) Stockfish-evaluated at depth 15 alongside endgame span-entry positions, populated into the same `eval_cp` / `eval_mate` columns. Substrate for v1.16 opening-stats analyses (Phase 79 PHASE-IMP-02, PHASE-FILL-02)
- Combined Phase 78 + Phase 79 operator cutover (D-79-10): single benchmark + prod backfill pass, single PR #78, single deploy. Saved an operational round-trip and consolidated the deployment risk window (Phase 79 plan 79-04)
- Follow-on PR #79 (quick task 260503-pool): import-time eval pass parallelised via module-level `EnginePool` of `STOCKFISH_POOL_SIZE` workers (default 1, prod ships 2 via `docker-compose.yml`). `import_service.py` collects eval targets across an import batch and fans them out via `asyncio.gather`. Sequential callers see no change; parallel callers gain ~POOL_SIZE× throughput
- Inline quick tasks during the milestone window: 260501-s0u (endgame UI rebuild from benchmark report — clock-pressure neutral band ±10pp → ±5pp, recovery typical band [25%, 35%] → [25%, 40%], grouped WDL chart replaced with six per-class Conversion/Recovery mini-gauges, LLM endgame insights prompt v18 reframes Conv/Recov as delta-from-class-baseline); 260503 (gauge typical bands recalibrated from the 2026-05-03 benchmark report); 260503-fef (`/benchmarks` skill applies equal-footing opponent filter `abs(opp_rating - user_rating) ≤ 100`); 260503-0t8 (`backfill_eval.py` parallelised via `EnginePool`)
- VAL-01 / PHASE-VAL-01 rescinded as moot 2026-05-03: once REFAC-03 deleted the proxy code path, the agreement metric became undefined. The `/conv-recov-validation` skill was deleted

**Known deferred items at close: 5**

- VAL-01 / PHASE-VAL-01 — rescinded, not deferred (see above)
- `STOCKFISH_POOL_SIZE` defaults to 1 outside prod; prod ships 2. No autotune. Worth re-visiting if import latency p99 regresses
- `STOCKFISH_PATH` env-var setup is ad-hoc for standalone runs (documented in CLAUDE.md). A wrapper in `bin/` could harden the local-dev experience
- Carried forward: 9 stale debug session entries (March-April), 135 quick-task directory entries without status frontmatter (audit misclassifies as open — both historical), 5 long-range todos, 1 dormant seed
- SEED-002 (benchmark population baselines) and SEED-006 (zone recalibration) — dormant, gated on full benchmark ingest. SEED-010 (Library milestone) now eligible to open post-v1.15

---

## v1.14 Score-Based Opening Insights (Shipped: 2026-04-29)

**Phases completed:** 3 phases (75, 76, 77), 16 plans, delivered via PRs #69, #70, #71 (inline confidence-mute hotfix), #72, #73 (quick task).
**Stats:** 123 files changed, +18,701 / -787 lines over 2 days (2026-04-28 → 2026-04-29) since v1.13 (commit f15b3cc → fa5ac64).
**Source:** SEED-007 (Option A only — Wilson on score, 0.50 pivot, no user-baseline) + SEED-008 (label reframe). Both seeds folded into this milestone and closed.

**Key accomplishments:**

- Migrated Opening Insights and Move Explorer color coding from loss-rate to chess score `(W + 0.5·D)/N`. Score is now the canonical metric in `opening_insights_service.py`, `openings_repository.py`, `arrowColor.ts`, and the `NextMoveEntry` / `OpeningInsightFinding` API payloads. `loss_rate` / `win_rate` removed cleanly. Effect-size gate against a 0.50 pivot with strict `≤`/`≥` boundaries — minor at 0.45/0.55, major at 0.40/0.60 (Phase 75)
- Trinomial Wald 95% confidence interval per finding using the actual variance of the chess result distribution `X ∈ {0, 0.5, 1}` — `(W + 0.25·D)/N − score²` rather than the binomial Wilson approximation that over-states uncertainty when draws are common (standard formula in BayesElo / Ordo). Pure-Python `math` only, no scipy dependency. Half-width buckets `≤ 0.10 → high`, `≤ 0.20 → medium`, else `low`. Pivoted from Wilson per Phase 75 D-05 (Phase 75)
- API contract extended with both `confidence: "low" | "medium" | "high"` (the half-width bucket, user-facing badge) and `p_value: float` (two-sided Z-test of observed score vs 0.50, tooltip-grade significance). `severity` retained so the frontend renders effect size + precision + significance per finding without overloading any one cue. `MIN_GAMES_PER_CANDIDATE` dropped 20 → 10 to enable discovery framing (Phase 75)
- Frontend score-based coloring shipped end-to-end: `arrowColor.ts` migrated to score (effect-size only, no confidence cue on arrows); Move Explorer moves-list row tint by score with extended mute rule `(game_count < 10 OR confidence === 'low')`; new Conf column with sort key `(confidence DESC, |score - 0.50| DESC)`; `OpeningFindingCard` renders score-based prose with level-specific confidence indicator and directional p-value tooltip; `UNRELIABLE_OPACITY` mute applied when `n_games < 10` OR `confidence === 'low'`. Mobile parity at 375px (Phase 76)
- Four `InfoPopover` triggers on `OpeningInsightsBlock` section headers cover the score / sample-size / confidence framing (Phase 76 D-17)
- INSIGHT-UI-04 descoped 2026-04-28 per Phase 76 D-04: severity word never appears as user-facing text (only drives border color); confidence badge + sort calibration deliver SEED-008's intent without rewriting "Weakness/Strength" titles
- Post-Phase-76 inline hotfix (PR #71): force grey arrow + skip row tint when `confidence === 'low'`. Board reads cleaner; low-confidence findings still surface in the table with the badge but don't visually claim authority on the board
- Phase 77 troll-opening watermark — frontend-only matching via side-only FEN piece-placement key (no backend schema, no Zobrist hash, no API contract change). `troll-face.svg` renders as 30%-opacity bottom-right watermark on `OpeningFindingCard` (mobile + desktop) and a small inline icon next to qualifying SAN rows in `MoveExplorer` (desktop only via `hidden sm:inline-block`). Curation is offline via a Node/TS script that emits per-ply candidates (both colors) for human pruning per CONTEXT.md D-01. Decorative `<img>` idiom (`alt=""` + `aria-hidden="true"`, `pointer-events-none`) keeps the asset cacheable and out of the accessibility tree (Phase 77)
- Single `compute_confidence_bucket` shared module across `opening_insights_service` and the move-explorer payload — CI structural test asserts there's only one implementation. CI consistency test `test_opening_insights_arrow_consistency` updated to enforce score-based threshold lock-step between backend classification and `frontend/src/lib/arrowColor.ts`
- Inline quick tasks during the milestone window: 260428-doc-framing-refresh (PROJECT/CLAUDE/README lead sections), 260428-oxr (replaced Wald half-width buckets with p-value thresholds), 260428-tgg (sort by Wald CI bound), 260428-v9i (switched ranking from Wald to Wilson score interval bound), 260429-gmj (after-move arrow on insight finding mini board, PR #73)

**Known deferred items at close: 6**

- INSIGHT-UI-04 — descoped 2026-04-28 (Phase 76 D-04). Severity word never user-facing; confidence badge + sort carry SEED-008 intent.
- Phase 77 HUMAN-UAT (3 open scenarios) and VERIFICATION (`human_needed`) — automated gates green, phase shipped via PR #72; remaining UAT captured in `77-HUMAN-UAT.md`, not blocking close.
- LLM narration of opening insights — future seed; v1.14 shipped the calibrated data plumbing (effect size + confidence + p_value) that LLM narration would consume.
- Population-relative weakness signals — gated on full benchmark ingest (SEED-006). Deliberately not part of v1.14 because the design rejects user/population baselines.
- Carried forward: 9 stale debug session entries (March-April), 133 quick-task directory entries without status frontmatter (audit misclassifies as open — both historical), pre-existing ORM/DB column drift (`game_positions.clock_seconds`, `games.white_accuracy`, `games.black_accuracy`), 2 long-range todos (bitboard-storage; phase-70-amendments already landed but todo file not pruned).
- SEED-002 (benchmark population baselines) and SEED-006 (zone recalibration) — dormant, gated on full benchmark ingest.

---

## v1.13 Opening Insights (Shipped: 2026-04-27)

**Phases completed:** 3 phases (70, 71, 71.1), 14 plans, delivered via PRs #66, #67, #68 (squash merges). Phases 72, 73, 74 descoped 2026-04-27.
**Stats:** 106 files changed, +19,246 / -561 lines over 2 days (2026-04-26 → 2026-04-27)
**Source:** SEED-005 — Opening weakness and strength insights, fulfilled by templated/rule-based v1; LLM narration deferred.

**Key accomplishments:**

- Backend `opening_insights_service` with `POST /api/insights/openings` — single SQL transition aggregation per (user, color) over `game_positions` for entry plies in [3, 16], LAG-window CTE + `array_agg` over windowed rows passes `entry_san_sequence` straight to the service. Strict `>` 0.55 win/loss threshold, `MIN_GAMES_PER_CANDIDATE = 20` evidence floor, severity tier major (≥ 0.60) / minor (Phase 70)
- Two-pass attribution with parent-prefix Zobrist lookup (ctypes c_int64 signed-int64 conversion to match python-chess polyglot hashes). Findings with neither direct nor parent-lineage match are dropped, never surfaced as `<unnamed line>` placeholders. Sentry tag captures unmatched drops for diagnosis (Phase 70)
- Database migration `80e22b38993a_add_gp_user_game_ply_index` — first project use of `postgresql_concurrently=True` + `autocommit_block`. Partial composite covering index `ix_gp_user_game_ply (user_id, game_id, ply) INCLUDE (full_hash, move_san) WHERE ply BETWEEN 1 AND 17` keeps the LAG-window scan an Index Only Scan with Heap Fetches: 0 at ~9% of table size (Phase 70)
- Frontend `OpeningInsightsBlock` on Openings → Stats subtab — per-finding cards (`OpeningFindingCard`) with severity-accented border (DARK_RED / LIGHT_RED / DARK_GREEN / LIGHT_GREEN from `arrowColor.ts` for stroke-aligned colors), shared `LazyMiniBoard` thumbnail extracted from `GameCard`, dual mobile/desktop layout, four-state rendering (loading skeleton, error, empty, populated). CI test `test_opening_insights_arrow_consistency` enforces backend/frontend threshold lock-step (Phase 71)
- Deep-link wiring — clicking a finding's Moves link replays `entry_san_sequence` through `chess.loadMoves()`, flips the board if the finding is for the black side, applies the matching color filter with `matchSide: 'both'`, navigates to Openings → Move Explorer pre-positioned at the entry FEN with the candidate move highlighted (sticky severity tint + one-shot pulse from quick-task 260427-j41) (Phase 71)
- Openings page subnav layout refactor — desktop subnav lifts above `SidebarLayout` to span the full board+main columns mirroring Endgames; mobile gains a sticky 4-tab subnav with filter button, board becomes non-sticky on Moves+Games and hidden on Stats+Insights, chevron-fold collapsible removed entirely. Subtab switching resets scroll to top on both desktop and mobile (Phase 71.1)
- Pre-v1.13 quick task PRE-01 — dropped the parity filter from `query_top_openings_sql_wdl`, surfacing 1599 of 3301 white-defined ECO openings in the black top-10 (e.g. Hillbilly Attack — 816 black games previously invisible). Off-color rows now prefixed with `vs.` for clarity

**Known deferred items:**

- INSIGHT-MOVES-01..03 (inline weakness/strength bullets on Moves subtab), INSIGHT-META-01 (meta-recommendation aggregate finding), INSIGHT-BADGE-01 (bookmark-card weakness badge) — all descoped 2026-04-27. Move Explorer row tinting via `getArrowColor` already conveys the signal at the displayed position; per-finding cards in Phase 71 deliver the actionable signal at finer granularity than an aggregate; bookmark-badge density risked alert fatigue with Endgames + Openings nav dots already present
- Phase 71 UAT (18 open scenarios), Phase 71.1 HUMAN-UAT (9 open scenarios), Phase 71.1 VERIFICATION (`human_needed`) — automated gates green, deferred for asynchronous review; phases shipped via PRs #67 and #68
- LLM narration of opening insights — revisit as v1.13.x or v1.14 once templated findings are in real users' hands and we know which findings are worth narrating
- Population-relative weakness signals — gated on full benchmark ingest (SEED-006); deliberately not part of v1.13 because book-move equality makes population baselines redundant for opening insights
- Carried forward: 8 stale debug session entries (March-April), 129 quick-task directory entries without status frontmatter (audit misclassifies as open — both historical), pre-existing ORM/DB column drift, `_compute_score_gap_timeline` / `_finding_time_pressure_vs_performance` grep noise from v1.11

---

## v1.12 Benchmark DB Infrastructure & Ingestion Pipeline (Shipped: 2026-04-26)

**Phases completed:** 1 phase (69), 6 plans (5 fully executed + 1 with descoped sub-tasks), delivered via PR #65 (squash merge).
**Stats:** 98 files changed, +13,440 / -1,740 lines, 51 commits over 2 days (2026-04-24 → 2026-04-26)
**Scope-down (2026-04-26):** Originally Phases 69-73. Phases 70-73 (classifier validation at scale, rating-stratified offsets, Parity validation, `/benchmarks` skill upgrade & zone recalibration) moved to SEED-006, gated on the full benchmark ingest. Pipeline correctness is the v1.12 deliverable; populating the DB is ops.

**Key accomplishments:**

- Isolated `flawchess-benchmark` PostgreSQL 18 container on port 5433, deployed via `docker-compose.benchmark.yml` with read-only MCP role `flawchess_benchmark_ro`, lifecycle script `bin/benchmark_db.sh` (start/stop/reset), and Alembic-driven schema parity with dev/prod/test (Phase 69-01)
- Third read-only MCP server `flawchess-benchmark-db` registered and documented in `CLAUDE.md` Database Access section alongside the existing two MCP DB servers (Phase 69-03)
- Eval-presence pre-filter via streaming `zgrep` scan over the Lichess monthly PGN dump, so the ~85% of dump games without `[%eval` headers never reach the python-chess parser, dropping selection-scan walltime by an order of magnitude (Phase 69-04)
- Stratified subsampling at the player-opportunity level on (rating_bucket × time_control). 5 rating buckets × 4 TCs, with separate `WhiteElo` / `BlackElo` bucketing per side (no game-level rating rollup); 90M games scanned, 491k qualifying, 8,628 distinct players persisted across 20 cells, 17/20 hitting the 500-user cap (Phase 69-04)
- Resumable ingest orchestrator with per-user checkpoint table, idempotent inserts via the existing `(platform, platform_game_id)` unique constraint, SIGINT + SIGKILL safe. Pending in-flight users are picked up first on resume; 0 duplicate game rows verified (Phase 69-05)
- Smoke-test ingest at `--per-cell 3` ran end-to-end against the live Lichess `/api/games/user` endpoint. 60 terminal rows: 56 completed, 3 over_20k_games skips, 1 unexplained failure deferred to SEED-006; 274,143 games and 19.4M positions imported in 3h 6min wall-clock (Phase 69-06)
- Pipeline-correctness verification report at `reports/benchmark-db-phase69-verification-2026-04-26.md` covering all four Dimension-8 evidence sections (selection scan, smoke ingest, resumability, eval coverage) plus storage budget projection (~205 GB at full `--per-cell 100` ingest, flagged for SEED-006 disk sizing) (Phase 69-06)
- Hot-patch mid-plan: dropped `games.eval_depth` and `games.eval_source_version` columns (added in plan 69-02 migration `b11018499e4f`, dropped in `6809b7c79eb3`) after the smoke confirmed Lichess's `/api/games/user` endpoint emits bare `[%eval cp]` annotations with no depth field. Both columns were dead weight; reintroduce when an actual second eval source exists. INGEST-06 reduced to "centipawn convention verified", already covered by `tests/test_benchmark_ingest.py::test_centipawn_convention_signed_from_white` running in CI (Phase 69-06)
- Centipawn convention verified, signed from white's POV (`pov.white().score()` / `.mate()`): centipawns vs pawn-units (`[%eval 2.35]` → +235 cp), mate annotations (`[%eval #4]` → mate=4) all asserted via the centipawn-convention test in CI

**Known deferred items:**

- Plan 69-06 sub-tasks 06-05 (`--per-cell 30` interim ingest) and 06-08 (manual cleanup of the 2026-03 Lichess dump file from local disk), descoped per the 2026-04-26 v1.12 scope-down. Full-scale population is operational ops work, not a milestone gate.
- VAL-01 from v1.11 (insights snapshot test), explicitly out of v1.12 scope per REQUIREMENTS.md. Promote via `/gsd-quick` when ready (no dependency on benchmark infra).
- Phases 70-73, moved to SEED-006 (benchmark population zone recalibration). Surface when full benchmark ingest completes.
- Pre-existing ORM/DB column drift (`game_positions.clock_seconds`, `games.white_accuracy`, `games.black_accuracy` REAL→Float), deferred again from v1.11 close. Deserves a dedicated cleanup migration.

---

## v1.11 LLM-first Endgame Insights (Shipped: 2026-04-24)

**Phases completed:** 5 phases (63, 64, 65, 66, 68), 23 plans, delivered via PR #61 (squash merge). Phase 67 (Validation & Beta Rollout) descoped — insights enabled for all users via commit `c91478e` instead of the beta-cohort validation loop. Phase 68 was added mid-milestone after UAT feedback.
**Stats:** 166 files changed, +42,078 / -262 lines, ~190 commits over 5 days (2026-04-20 → 2026-04-24)

**Key accomplishments:**

- LLM-backed Endgame Insights: `POST /api/insights/endgame` returns a structured `EndgameInsightsReport` (overview paragraph + up to 4 Section insights) produced by a pydantic-ai Agent, cached on a findings hash, rate-limited to 3 misses/hr/user, with soft-fail to the last cached report (Phase 65)
- Deterministic findings pipeline: `compute_findings` turns `/api/endgames/overview` into per-subsection-per-window `EndgameTabFindings` with zone/trend/sample-quality annotations and three cross-section flags (baseline-lift mutes score gap, clock-entry advantage/no-advantage) so the LLM reasons over pre-validated numbers (Phase 63)
- Shared zone registry as single source of truth: `app/services/endgame_zones.py` drives both narrative and chart visuals; Python→TypeScript codegen with CI drift guard so frontend gauge constants can never silently diverge (Phase 63)
- Generic `llm_logs` Postgres table (18 columns, BigInteger PK, JSONB for filter_context and response_json, FK CASCADE to users, 5 indexes including 3 composites with `created_at DESC`) designed to host every future LLM feature. Async repository with `genai-prices`-powered per-call cost accounting and `cost_unknown:<model>` soft-fallback (Phase 64)
- Provider-agnostic model selection via `PYDANTIC_AI_MODEL_INSIGHTS` env var; backend refuses to start if env var is missing/invalid. System prompt loaded from `app/prompts/endgame_insights.md` at startup — no string literals in `.py` files (Phase 65)
- Frontend `EndgameInsightsBlock` with parent-lifted mutation state pattern (Endgames.tsx holds one `useEndgameInsights` mutation; EndgameInsightsBlock + 4 SectionInsightSlot instances observe the same state without a context provider). Single retry affordance on any failure path (Phase 66)
- Dual-line "Endgame vs Non-Endgame Score over Time" chart replaces the single-line Score Gap chart — both absolute Score series rendered with a colored shaded area between them (green when endgame leads, red when trails). Prompt's `score_gap` framing rule simplified since the chart makes gap composition self-evident (Phase 68)
- Pre-merge milestone cohesion review — critical failing frontend test fixed, dead codegen pipeline completed (Phase 66 switchover finished: 3 FE chart components now import from generated zone constants), stale `Filters:` prompt reference removed (bumped to `endgame_v15`)

**Known deferred items:**

- Phase 67 descoped — VAL-01 (ground-truth regression test against SEED-001 canonical user fixture) and VAL-02 (admin-impersonation eyeball validation across 5 real user profiles) not executed. Insights were enabled for all users via commit `c91478e`. Recommended follow-up in v1.12: retrofit snapshot test against one real production user fixture.

---

## v1.10 Advanced Analytics (Shipped: 2026-04-19)

**Phases completed:** 11 phases (48, 52-55, 57, 57.1, 59-62), 28 plans, delivered via PRs #38, #43, #47, #49, #50, #51, #52 — all squash merged. Phase 56 cancelled, Phase 58 moved to backlog (999.6).
**Stats:** 249 files changed, +54835 / -1852 lines, 124 commits over ~12 days (2026-04-07 → 2026-04-19)

**Key accomplishments:**

- Endgame tab performance — 8 per-class timeline queries collapsed into 2, consolidated `/api/endgames/overview` serving every endgame chart in one round trip on a single AsyncSession, deferred filter apply on desktop (Phase 52)
- Endgame Score Gap & Material Breakdown — signed endgame vs non-endgame score difference plus material-stratified WDL table (ahead/equal/behind at endgame entry, later renamed Conversion/Parity/Recovery) with Good/OK/Bad verdict calibration (Phases 53, 59)
- Opponent-based self-calibrating baseline for Conv/Parity/Recov bullet charts — opponent's rate against the user replaces global average, muted when sample < 10 games (Phase 60)
- Time pressure analytics — per-time-control clock stats table (Phase 54) + two-line user-vs-opponents score chart across 10 time-remaining buckets with backend aggregation (Phase 55 + iteration via quick tasks)
- Endgame ELO Timeline — skill-adjusted rating per (platform, time-control) combination with paired Endgame ELO / Actual ELO lines, asof-join anchor on user's real rating, weekly volume bars for data-weight transparency (Phases 57 + 57.1)
- Conversion/recovery persistence filter — material imbalance required at endgame entry AND 4 plies later, threshold lowered 300cp → 100cp, validated against Stockfish eval analysis (Phase 48)
- Test suite hardening — `flawchess_test` TRUNCATE on session start, deterministic 15-game `seeded_user` fixture, aggregation sanity tests (WDL perspective, material tally, rolling windows, filter intersections, recency boundaries, within-game dedup, endgame transitions), router integration tests asserting exact integer counts (Phase 61)
- Admin user impersonation — superusers can impersonate any user via a new /admin page with shadcn Command+Popover search, single auth_backend + ClaimAwareJWTStrategy wrapper (zero call-site changes), last_login/last_activity frozen during impersonation, persistent impersonation pill in header with × to end session (Phase 62)
- Sentry Error Test moved from Global Stats to Admin tab; superuser-gated nav entry

---

## v1.9 UI/UX Restructuring (Shipped: 2026-04-10)

**Phases completed:** 3 phases (49-51), 7 plans, delivered via PRs #40, #41, #42
**Stats:** 57 files changed, +8692 / -1602 lines, ~21-hour execution window

**Key accomplishments:**

- Openings desktop sidebar — collapsible left-edge 48px icon strip + 280px on-demand Filters/Bookmarks panel with overlay/push behavior at the 1280px breakpoint, live filter apply on desktop
- Openings mobile unified control row — Tabs | Color | Bookmark | Filter lifted outside the board collapse region so controls stay visible when the board is collapsed; 44px tappable collapse handle; backdrop-blur translucent sticky surface
- Endgames mobile visual alignment — 44px backdrop-blur sticky row with 44px filter button matching the Openings mobile pattern (EGAM-01)
- Global Stats filters wired end-to-end — `opponent_type` and `opponent_strength` through `/stats/global` and `/stats/rating-history`, plus hooks/API client layer; bot games now excluded by default
- Stats subtab layout restructuring — 2-column Bookmarked Openings: Results on desktop (lg breakpoint), stacked WDLChartRows for mobile Most Played replacing the cramped 3-col table
- Homepage 2-column desktop hero — left=hero content, right=Interactive Opening Explorer preview (heading + screenshot + bullets), pills row removed, Opening Explorer removed from FEATURES list
- Global Stats rename — "Stats" → "Global Stats" across desktop nav, mobile bottom bar, More drawer, mobile header, plus new page h1; FilterPanel opponent controls enabled

---

## v1.8 Guest Access (Shipped: 2026-04-06)

**Phases completed:** 4 phases (44-47), delivered via PR #37
**Stats:** 56 files changed, +3915 / -1294 lines, 3 new test files (1193 lines of tests)

**Key accomplishments:**

- Guest session foundation — `is_guest` User model, JWT-based guest sessions with 30-day auto-refresh, IP rate limiting
- Guest frontend — "Use as Guest" buttons on homepage and auth page, persistent guest banner indicating limited access
- Email/password promotion — backend promotion service, register-page promotion flow preserving all imported data
- Google SSO promotion — OAuth promotion route with guest identity preservation across redirect, email collision handling
- Security fix — patched Google OAuth for CVE-2025-68481 CSRF vulnerability (double-submit cookie validation)
- UX polish — import page guest guard, auth page logo linking, delete button disabled during active imports

---

## v1.7 Consolidation, Tooling & Refactoring (Shipped: 2026-04-03)

**Phases completed:** 6 phases, 11 plans, 17 tasks

**Key accomplishments:**

- Astral `ty` static type checker integrated into CI — zero backend type errors, all functions annotated
- Knip dead export detection + `noUncheckedIndexedAccess` — zero dead code, strict TypeScript index safety
- Import pipeline ~2x faster — unified single-pass PGN processing, bulk CASE UPDATE, batch size 10→28
- SQL aggregation (COUNT().filter()) replacing Python-side W/D/L counting loops
- Consistent naming and deduplication — router prefixes, shared apply_game_filters, frontend buildFilterParams
- Dead code removal — 7 dead files deleted, unused shadcn/ui re-exports cleaned, -1522 lines
- CSS variable brand buttons (.btn-brand) replacing JS constant, typed Pydantic response models on all endpoints

---

## v1.6 UI Polish & Improvements (Shipped: 2026-03-30)

**Phases completed:** 6 phases, 11 plans

**Key accomplishments:**

- Centralized theme system with CSS variables, charcoal containers with SVG noise texture, brand subtab highlighting
- Shared WDLChartRow component replacing all inconsistent WDL chart implementations across the app
- Openings reference table (3641 entries from TSV) with SQL-side WDL aggregation and filter support
- Most Played Openings redesign: top 10 per color, dedicated table UI with minimap popovers
- Opening Statistics rework: smart default chart data from most-played openings, chart-enable toggles on bookmarks
- Mobile drawer sidebars for filters and bookmarks with deferred filter apply on close

---

## v1.3 Project Launch (Shipped: 2026-03-22)

**Phases completed:** 4 phases, 10 plans, 12 tasks

**Key accomplishments:**

- Full codebase renamed from Chessalytics to FlawChess across 20 files — PWA manifest, logo, GitHub org transfer
- Complete Docker Compose stack (FastAPI + Caddy 2.11.2 + PostgreSQL) deployed to Hetzner VPS with auto-TLS
- GitHub Actions CI/CD pipeline: test + lint + SSH deploy + health check polling
- Sentry error monitoring on backend (sentry-sdk[fastapi]) and frontend (@sentry/react) with Docker build-time DSN injection
- Public homepage with feature sections, FAQ, and register/login CTA; SEO meta tags, sitemap.xml, robots.txt
- Per-platform rate limiter (asyncio.Semaphore) protecting chess.com/lichess imports from concurrent bans
- Privacy policy page at /privacy; professional README with screenshots and self-hosting instructions

---

## v1.2 Mobile & PWA (Shipped: 2026-03-21)

**Phases:** 17–19 (3 phases, 5 plans)

Made the application work great on smartphones as an installable PWA with mobile-optimized navigation, touch interactions, and dev workflow for phone testing.

**Key accomplishments:**

- Installable PWA with service worker, chess-themed icons, and Workbox caching (NetworkOnly for API routes)
- Mobile bottom navigation bar with direct tabs and slide-up "More" drawer (vaul-based)
- Click-to-move chessboard on touch devices with sticky board layout on Openings page
- 44px touch targets on all interactive elements, no horizontal scroll at 375px
- Android/iOS in-app install prompts (beforeinstallprompt + manual iOS instructions)
- Cloudflare Tunnel dev workflow for HTTPS phone testing

---

## v1.1 — Opening Explorer & UI Restructuring

**Shipped:** 2026-03-20
**Phases:** 11–16 (6 phases, 15 plans)

Added interactive move explorer with W/D/L stats per position, restructured UI with tabbed Openings hub and dedicated Import page, enriched game import data, and redesigned game cards.

**Key accomplishments:**

- Move explorer with next-move W/D/L stats, click-to-navigate, transposition handling
- Chessboard arrows showing next moves with win-rate color coding
- UI restructured: tabbed Openings hub (Moves/Games/Statistics) + dedicated Import page
- Enhanced import: clock data, termination reason, time control fix, multi-username sync
- Game cards redesigned: 3-row layout with icons, hover/tap minimap showing final position
- Data isolation fixes, Google SSO last_login, cache clearing on auth transitions

---

## v1.0 — Initial Platform

**Shipped:** 2026-03-15
**Phases:** 1–10

Built the complete multi-user chess analysis platform: game import from chess.com/lichess, Zobrist hash position matching, interactive board with W/D/L analysis, position bookmarks with auto-suggestions, game cards, rating/stats pages, and browser automation optimization.

**Key capabilities:**

- Import pipeline with incremental sync (chess.com + lichess)
- Position analysis via precomputed Zobrist hashes (white/black/full)
- Position bookmarks with drag-reorder, mini boards, piece filter
- Auto-generated bookmark suggestions from most-played openings
- Game cards with rich metadata and pagination
- Rating history, global stats, openings W/D/L charts
- Multi-user auth with data isolation
