# Feature Research

**Domain:** Own-mistake / spaced-repetition chess training (FlawChess "Train", v2.9)
**Researched:** 2026-07-25
**Confidence:** MEDIUM — cross-referenced web sources (product docs, blogs, forums, Lichess/Chessable/Anki documentation) for 8 comparable products; no official API/internals access for closed products (Aimchess, Noctie, ChessMood). HIGH confidence on Lichess and Anki mechanics (documented/open-source); MEDIUM on Aimchess/Chessable/Noctie/ChessMood (marketing copy + user reports, not source code).

## Scope note

SEED-037's design is **settled**, not up for debate (six `gsd-explore` rounds, final 2026-07-25). This document does not recommend reversing any Rejected Alternative. Its job is to (a) confirm which settled choices match or exceed industry norms, (b) flag genuine table-stakes gaps the design is silent on, and (c) surface expected user behavior (session-length, dropout) that should inform tuning constants the planner will need to pick (N per session, fail-out threshold, etc.), which SEED-037 deliberately left as planner-tunable.

## Comparable Products Surveyed

| Product | Relevant mechanic | Own-mistake sourcing? | SR model |
|---|---|---|---|
| **Aimchess Blunder Preventer** | Two-choice (good move vs. blunder) drills tailored to the user's own past blunders and drill performance | Yes | Unspecified, described only as "adaptive"; Aimchess's separate Opening Improver module is the one that explicitly names spaced repetition |
| **Chessable MoveTrainer** | Course-line drilling, per-move level counter (correct → level up / interval grows; wrong → reset to level 0) | No (course content, not user's own games) — but **Chessable Puzzle Connect** does mine "puzzles from your games" into a personalized SR course | N/A (course) / Leitner-like level ladder (Puzzle Connect) |
| **chess.com Custom Puzzles** | Theme/rating-filtered puzzle sets; a "puzzles you got wrong" replay mode (no rating impact, no timer) | Partial — replays your own *puzzle* misses, not your *game* blunders | None (simple retry queue, not spaced) |
| **Lichess Puzzles (rated)** | One attempt per puzzle; wrong move ends immediately and shows the solution — no retry | No | Puzzle Dashboard tracks per-theme performance; core puzzle rating is Glicko-2, not SR |
| **Lichess Puzzle Storm** | 3-minute timed sprint, combo bonus for consecutive correct, one wrong move loses combo (not the run) | No | None — it's a speed drill, not spaced repetition |
| **Lichess Puzzle Streak** | Escalating difficulty, **one skip per session**, one wrong move ends the whole streak | No | None |
| **Lichess Puzzle Dashboard** | Strengths/weaknesses by theme, tap-through into a themed session | No | None (aggregation UI only) |
| **Anki (generic SR reference)** | Card-level ease/interval algorithm (SM-2 family / FSRS) | N/A | The canonical SR implementation; used here for session-length and dropout norms, not chess specifics |
| **Noctie.ai** | Auto-generates flashcard puzzles from each game's "most instructive mistakes," reviewed via SR alongside human-like AI sparring | Yes | Described only as "spaced repetition learning," no published schedule |
| **ChessMood BugZone** | Mistakes (from courses and, per their in-development AI tool, from the user's games) sit in a "BugZone" until solved correctly, then disappear | Partial (course mistakes today; game-derived is an announced/in-progress feature) | Not a scheduled SR — it's a persistent "unsolved bin," closer to Leitner-lite / re-queue-until-correct than dated SR |
| **Chess Tempo** | Rating-matched tactics trainer, separate ratings per mode (Blitz/Standard/Mixed) | No | Elo-style problem/user rating, not SR |

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist in any spaced-repetition puzzle-solving product. Missing these = the solve loop feels unfinished, regardless of how good the scheduler is.

| Feature | Why Expected | Complexity | SEED-037 status |
|---|---|---|---|
| **Immediate move feedback (correct/incorrect) after the attempt** | Every product surveyed reveals the result instantly — no batch grading | LOW | **Covered.** Client-side WASM grading, immediate reveal. |
| **One clear "next puzzle" action after reveal** | Universal across Lichess/chess.com/Chessable — the loop must not require navigation | LOW | **Covered** (session flow: queue → guess → solve → reveal → Next), but the reveal screen's exact CTA hierarchy (Next vs. "step through the line" vs. "open analysis board") isn't specified — flag for the UI phase to keep "Next" visually dominant so the opt-in stepper doesn't compete with session momentum. |
| **Session progress indicator ("6 of 12", or a progress bar)** | Lichess Streak, chess.com puzzle sets, and Chessable all show position-in-session; without it, "exactly N" sessions feel open-ended and users can't pace themselves or know when they're nearly done | LOW | **Gap.** Not mentioned anywhere in the Settled Design or Phase Decomposition. Cheap to add (client-side counter against the known session N) — should be an explicit UI requirement in Phase 2, not left implicit. |
| **Board orientation to the user's color + last-move highlight** | Standard on every puzzle product (Lichess especially) so the solver doesn't have to reconstruct context | LOW | **Covered**, explicitly specified in the solve loop. |
| **A visible reason the puzzle is "yours"** (e.g., which game, roughly when) | Aimchess/Noctie/ChessMood all sell "these are from *your* games" as the core hook; if that link isn't visible, the differentiator is invisible to the user in the moment | LOW | **Covered on reveal** (game card + analysis-board deep link), correctly deferred off the solve screen (avoids leaking severity). |
| **Session-end summary (score, some kind of rating)** | Lichess Storm/Streak, Chessable decks, chess-tempo — every surveyed product closes a session with a number | LOW | **Covered** (score/2N %, green/yellow/red). |
| **A queue that is never empty when the user shows up on schedule** | The single most common SR dropout cause (see Anki dropout research below) — Anki decks that let review debt compound are the #1 named reason people quit SR apps | MEDIUM | **Covered by design** — cap + backfill from new flaws explicitly cites "the Anki model" and guarantees exactly N. This is the single most important table-stakes item and SEED-037 gets it right. |
| **No-retry / one-attempt-per-item is an accepted norm, not a risk** | Lichess's own *rated* Puzzles mode (not just Streak) fails on the first wrong move with no retry — this is not a fringe choice, it's how the dominant product already works | N/A | **Validates** the "Retry on wrong move — rejected" decision; no gap here. |
| **Mobile touch solving (tap source, tap target)** | Non-negotiable for a mobile-first PWA; Lichess/chess.com apps both support tap-to-move for puzzles | LOW (reuse) | **Covered via dependency** — FlawChess's existing click-to-move board (shipped for the analysis board and Bot Play) is directly reusable; no new work needed here, just confirm the solve-loop board mounts the same component. |

### Differentiators (Competitive Advantage)

Features that set Train apart from every surveyed product, or execute a known idea better than incumbents.

| Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|
| **True per-item spaced repetition over the user's own real blunders, entirely free** | Aimchess ($7.99/mo) does two-choice blunder drills but doesn't ship transparent SR mechanics; Chessable Puzzle Connect caps free users at 10 puzzles and gates the rest behind a $75/yr Pro plan; Noctie is a paid mobile app. No free, transparent, own-game SR blunder trainer exists at this fidelity. | — | This is the core differentiator named in SEED-037's "Why This Matters" — confirmed accurate against the market, not just an internal claim. |
| **Pre-move metacognition guess (critical-move vs. several-fine)** | No surveyed product asks the solver to judge position *character* before committing to a move. It's a genuinely novel layer — closest analog is ChessMood course framing ("find the only move"), but that's static content labeling, not a scored per-puzzle judgment call. | MEDIUM | Real risk called out correctly in the seed's own text: this is untested pedagogy, not a copied pattern — worth extra UAT attention on whether users find the two-step (guess, then move) natural or an added-friction tax on session pace. |
| **Red herrings sourced from the user's own well-handled positions (non-gem `game_best_moves`)** | No surveyed product vaccinates against "if I'm being tested, the move must be critical" pattern-gaming using the solver's *own* well-played positions as the counter-example. Lichess/chess.com red-herring analogs (if any) come from generic puzzle pools, not personal history. | LOW (data already exists) | Genuinely novel; cheap because the source data (`game_best_moves`) already exists from v2.4. |
| **Two-tier exit (mastered vs. parked) surfaced honestly** | ChessMood's BugZone is the closest analog (mistakes vanish when fixed) but has no published "this is too hard, we're setting it aside so it doesn't clog your queue" mechanic — Anki users who hit an unlearnable card have no first-party escape hatch and this is a documented cause of deck abandonment. | LOW (state already modeled) | The "parked" concept — explicit, self-aware, never silently hidden — is ahead of what Anki/Chessable expose to end users. Worth keeping the "3 parked — too hard for now" framing prominent; it is doing real retention work, not just bookkeeping. |
| **Opt-in tactic line stepper reusing `VariationTree`** | Not present in any surveyed product's puzzle reveal screen (Lichess shows the solution move-by-move but not a labeled "tactic in N" countdown tied to a named motif) | LOW (reuse) | Correctly scoped in the seed as a *weaker* substitute for the rejected motif quiz, with the gap honestly logged as a known v1 deferral. Nothing to add here; the seed's own self-assessment is accurate. |
| **Session self-scheduling (weekday picker) rather than a rigid daily habit** | Anki/Duolingo assume daily engagement; chess players are a lower-frequency, higher-session-length audience (chess games themselves aren't daily for most users). A user-set weekly cadence is a better fit for the actual usage pattern than forcing a daily-streak model onto a weekly-play habit. | LOW | Confirmed sound against Anki's own dropout data: the #1 SR abandonment driver is compounding review debt from missed days under a *rigid* daily assumption, not from having a schedule per se. A self-set, sparser schedule sidesteps that specific failure mode by construction. |

### Anti-Features (Rejected in SEED-037, Confirmed Correct by Research)

These are patterns that *look* like table stakes from surveying the market but that SEED-037 already rejected — research confirms the rejections are sound, not shortcuts.

| Feature | Why It Looks Appealing | Why It's Right to Skip (per research) | SEED-037 disposition |
|---|---|---|---|
| **FSRS or another mature memory-model algorithm** | It's the modern Anki default and "more scientific" sounding | FSRS needs volume (dozens+ reps per card) to fit a per-user forgetting curve; SR chess-puzzle items here have a 3–6 rep lifetime by design (3-correct-to-master, 3-fail-to-park). Chessable's own MoveTrainer — a mature commercial SR product — uses a simple level-ladder, not FSRS, for exactly this kind of short-lived item. Corroborates the seed's call. | Rejected — confirmed correct |
| **Multi-move puzzle lines (like standard Lichess puzzles)** | Lichess's flagship puzzles are multi-move and that's the genre norm | Lichess's multi-move lines are curated by a human-reviewed pipeline with verified only-move continuations at every branch; FlawChess's `pv`/eval data isn't curated to that standard. Shipping uncurated multi-move lines risks grading players "wrong" on legitimately fine deviations later in the line — worse UX than a single graded move. | Rejected — confirmed correct |
| **Streak freeze / repair tokens** | Duolingo's streak-freeze cut churn 21% at Duolingo's scale — a strong data point in favor | Duolingo's mechanic exists because Duolingo enforces a *rigid daily* streak on a huge, casual user base. FlawChess's weekly streak is already self-configured by the user (their own realistic cadence), which is a different, lower-friction answer to the same problem Duolingo is solving with freezes. Layering freeze tokens on top of an already-self-forgiving schedule would be solving a problem the design doesn't have. | Rejected — confirmed correct, see Risk to Watch below |
| **Retry-until-correct per puzzle** | chess.com's "puzzles you got wrong" mode and Chessable's level system both effectively allow eventual success via repetition | Both those are *separate, low-stakes replay modes* layered on top of a first-attempt-graded core mode — they don't replace one-attempt grading, they supplement it later. Lichess's rated Puzzles mode (the closest 1:1 analog to Train, since it's also "did you get it right or not, once") is strict one-attempt, matching the seed's choice. | Rejected — confirmed correct |
| **3-way puzzle-type guess (sharp / avoid-blunder / herring)** | Seems more informative than a binary guess | No surveyed product asks solvers to classify puzzle *provenance* (where a puzzle came from) as opposed to *position character* — for good reason: provenance isn't visible from the board, so it tests memory of "have I seen this before," not chess judgment. Nothing in the market does this and the seed's own reasoning (episodic memory vs. chess skill) matches why it doesn't exist elsewhere. | Rejected — confirmed correct |

## Gaps Not Addressed by Research (Genuinely Open, Not Rejected)

Unlike the Anti-Features table above, these are things the settled design is simply *silent* on — not rejected, just unspecified. None require reopening a settled decision; they're implementation details the planner should pin down explicitly rather than leave implicit.

| Gap | Table-stakes or nice-to-have | Complexity | Recommendation |
|---|---|---|---|
| **Session progress bar / counter** | Table stakes | LOW | Add explicit requirement to Phase 2 (solve loop): "N of M" or a progress bar, purely client-side against the already-fixed session size. No backend change. |
| **Any pass/skip affordance for a genuinely-stuck puzzle** | Nice-to-have, NOT table stakes here | — | Not a gap needing action. The design's "always play a move, even on a several-fine-moves guess" rule (and the explicit rejection of "declare herring = done, no move") already forecloses a skip button by design intent — a player who doesn't know the answer just plays their best guess and gets graded, same as playing an uncertain move OTB. Consistent with Lichess's strict rated-puzzle mode (also no skip); only the *gamified* Streak mode offers one skip, and that's to protect an all-or-nothing streak mechanic Train doesn't have (Train doesn't end the session on a miss). No change needed. |
| **Keyboard navigation for desktop solving** | Nice-to-have | LOW, if pursued | Not table stakes in the surveyed products either — chess.com/Lichess ship mouse/touch-first puzzle UIs; keyboard move entry is a browser-extension niche, not the built-in default anywhere. Given FlawChess is explicitly mobile-first, deprioritize; a "spacebar = Next" convenience after reveal would be the highest-value/lowest-cost slice if ever added, but it's not needed for v1 parity. |
| **Explicit reveal-screen CTA hierarchy (Next vs. stepper vs. analysis link)** | Table stakes (session momentum) | LOW | Flag for the UI-SPEC of the solve-loop phase: make "Next puzzle" the visually primary action; the opt-in stepper and analysis-board link should read as secondary, so a user who ignores them (most will, per the seed's own honest deferral note) isn't slowed down. |

## Risk to Watch (Not a Design Flaw, a Production Signal to Monitor)

**Weekly streak has no partial credit within a scheduled week.** If a user's schedule is, say, 3 sessions/week and they complete 2 of 3, the weekly streak breaks entirely — there's no equivalent to a single-day "streak freeze." SEED-037 already considered and explicitly rejected freeze-token mechanics (round 5), reasoning that a self-configured, forgiving-by-construction schedule doesn't need one. That's a defensible call and this document does not recommend reversing it. But Duolingo's own data (21% churn reduction from freezes) is a real signal that *all-or-nothing* streaks are a known point of early dropout even when the cadence itself is reasonable. Recommendation: **not a design change, an observability note** — once Train ships, watch weekly-streak abandonment specifically in the first few weeks post-launch (e.g., % of users whose weekly streak breaks in week 1 or 2 and who don't return the following week). If that number is high, the fix the seed itself already reserves for this exact scenario is available without redesign (the schedule is "a commitment device, not a lock" — ad-hoc off-day sessions already count against the same queue, which is itself a soft safety valve).

## Expected User Behavior: Session Length & SR Schedule Norms

Research question asked specifically about session-length norms, N-per-session defaults, and dropout patterns — findings below, framed as **inputs to the planner-tunable constants** SEED-037 already leaves open (N per session, fail-out count), not as prescriptions.

- **No direct industry default exists for "N puzzles in a personal-blunder SR session."** This is a new-enough category (Aimchess, Noctie, Chessable Puzzle Connect) that none publish a specific N. The closest reference points are generic SR research (Anki) and chess-puzzle UX norms (Lichess), which don't fully transfer because per-item time cost differs a lot:
  - **Anki**: sustainable long-term load is ~100–150 reviews/day (~15–25 min total), because a flashcard review is a 2–5 second recognition task.
  - **Chess puzzle solve+reveal**: materially longer per item — thinking time on the position, the guess step, the move attempt, then reading the reveal (verdict + pv + optional line-stepper) is more like 20–60 seconds per item, an order of magnitude more than an Anki card.
  - **Implication**: a straight Anki-style "100+ items" session would take 30–60+ minutes, well past what a habit-forming daily/weekly session should cost. A defensible starting default is **~10–15 puzzles per session (~2N=20–30 graded events)**, landing in the 10–15 minute range — closer to the "20-minute daily habit beats a 3-hour weekly session" guidance from SR research, scaled down for chess's higher per-item cost. This is a starting point for the planner's default N slider value, not a hard requirement.
- **The #1 documented SR dropout cause is compounding review debt from missed days**, not schedule strictness per se. SEED-037's cap + backfill design ("being caught up never yields an empty session... backlogs drain gradually") is a direct, correct structural defense against this — it caps the worst case at N per session regardless of how large the due-queue has grown, so a lapsed user never faces a punishing "247 puzzles due" wall the way an Anki user can. This is the most important cross-product validation this research surfaced: **the design already solved the dropout mode the literature calls out as dominant.**
- **Escalating-difficulty / streak-ends-on-miss formats (Lichess Streak) intentionally create short, high-tension sessions** (median run likely well under 10 puzzles for most players, since one miss ends it) — that model doesn't map to Train, which is explicitly not all-or-nothing per session. No behavior change indicated; just confirms Train's exactly-N, never-ending-early model is the right choice for a *training* (vs. *competitive/scoring*) context.
- **Recency-weighted new-item introduction (padding sessions from recent games) mirrors Anki's own "new cards per day" cap concept** — capping *both* how many new items enter and how the due-queue is drained per session is precisely the lever Anki users are told to tune to avoid the 30-day-review-debt spiral. SEED-037's "prefer flaws from recent games when padding" plus the fixed N ceiling gives an equivalent safety margin without needing a separate "new items per day" knob.

## Feature Dependencies

```
Train solve loop (Phase 2)
    └──requires──> Pool + scheduler backend (Phase 1)
                       └──requires──> game_flaws (ownership, blunder tier) [v1.24/v1.27, shipped]
                       └──requires──> game_positions.best_move / .pv [v1.26+, shipped]
                       └──requires──> game_flaws.missed_pv_lines / .allowed_pv_lines [Phase 141, shipped]
                       └──requires──> game_best_moves (red herring source) [v2.4, shipped]
                       └──requires──> eval_cp_to_expected_score (winnability floor) [shipped]

Train solve loop (Phase 2)
    └──requires──> Client Stockfish WASM (grading) [v2.3, shipped]
    └──requires──> Click-to-move mobile board component [v1.2, shipped, reuse]
    └──requires──> VariationTree tactic-line-stepper UI [analysis board, shipped, reuse]
    └──requires──> Analysis board (reveal deep-link target) [shipped]

Schedule + progress surface (Phase 3)
    └──requires──> Solve loop result-recording (Phase 2 endpoint)
    └──requires──> Pool + scheduler mastered/parked state (Phase 1)

Session progress indicator (gap, this doc)
    └──enhances──> Solve loop (Phase 2) — no backend dependency, pure frontend addition against known session N

Nav badge / dashboard "N puzzles waiting" (Phase 3)
    └──requires──> Pool + scheduler due-count query (Phase 1)
```

### Dependency Notes

- **All backend data dependencies are already shipped** (confirmed in SEED-037's own "Data Dependencies" section and cross-checked against PROJECT.md's requirement history) — this is a pure feature-build milestone, not a data-pipeline milestone. That materially lowers risk versus a typical new-feature research finding.
- **Session progress indicator requires nothing new** — it's a frontend-only addition against a value (N) the backend already fixes per session, so it should be folded into Phase 2 rather than treated as a follow-up.
- **Mobile solve ergonomics has zero net-new dependency** — tap-to-move is a shipped, reusable component; this materially de-risks the "mobile ergonomics of the solve loop" part of the research question. The only new mobile-specific work is the reveal screen's line-stepper fitting in the smaller viewport (it already exists on the analysis board at desktop width; confirm/adjust for mobile in Phase 2 UAT).

## MVP Definition

SEED-037's own three-phase decomposition already is the MVP scope; this section reframes it strictly through the "what does research say is truly minimum for a v1 SR trainer to not feel broken" lens.

### Launch With (v1) — matches SEED-037 Phase 1–3 scope, plus the one flagged gap

- [x] Pool entry (own blunders, ownership-filtered, winnability floor, answer-key present) — table stakes for credibility ("these are really my mistakes")
- [x] Interval-ladder scheduler with cap+backfill session composition — table stakes; also the #1 documented SR-dropout defense
- [x] One-attempt client-graded solve loop with immediate reveal — table stakes, matches Lichess's own rated-puzzle norm
- [x] Mastered / parked exit doors — differentiator; also prevents the "same unsolvable item every session" failure mode that generic Anki decks are known to suffer
- [x] Session-end score + rating — table stakes
- [x] Weekly self-scheduled cadence + nav badge — table stakes for a habit feature; correctly avoids Anki's rigid-daily assumption
- [ ] **Add: session progress indicator** ("N of M" or a bar) in the solve loop UI — flagged gap above, cheap, should not ship without it

### Add After Validation (v1.x)

- Motif-aggregated progress (already a SEED-037 v2 candidate) — trigger: once real parked/mastered counts exist to show a genuine pattern, per the seed's own reasoning
- Un-parking after cooldown or rating climb (already a SEED-037 v2 lever) — trigger: observed user frustration or requests once parked counts are visible
- Push/email reminders — trigger: in-app nav-badge engagement data showing users aren't returning on schedule without an external nudge

### Future Consideration (v2+)

- Mistakes-tier pool expansion (already listed) — defer until active users run dry on blunders-only pool
- Weekly leaderboard — defer until ≥10–15 weekly-active trainers (already SEED-037's own trigger, and matches this research's general finding that social/competitive layers need a floor of concurrent users to not look empty — confirmed sound, e.g. why Lichess Streak/Storm leaderboards work at Lichess's scale but wouldn't at a cold start)
- Keyboard shortcuts for desktop solving — low priority; not table stakes anywhere surveyed

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---|---|---|---|
| Pool + scheduler backend (cap+backfill, mastered/parked) | HIGH | HIGH | P1 |
| One-attempt client-graded solve loop | HIGH | MEDIUM | P1 |
| Session progress indicator | MEDIUM | LOW | P1 (fold into Phase 2, don't skip) |
| Reveal with verdicts + pv + game card + analysis-board link | HIGH | MEDIUM | P1 |
| Weekly self-scheduled cadence + nav badge | HIGH | LOW | P1 |
| Session-end score/rating + confetti | MEDIUM | LOW | P1 |
| Pre-move metacognition guess | MEDIUM (novel, unvalidated) | LOW | P1 (already committed in seed; monitor via UAT for pace friction) |
| Red herrings (~25%) | MEDIUM | LOW (data exists) | P1 |
| Opt-in tactic line stepper | LOW–MEDIUM (self-acknowledged weak forcing function) | LOW (reuse) | P1 (cheap reuse, ship as-is) |
| Motif-aggregated progress dashboard | MEDIUM | MEDIUM | P2 (v1.x/v2 per seed) |
| Un-parking | LOW (unknown demand) | LOW | P3 (v2 per seed) |
| Push/email reminders | MEDIUM | HIGH (new subsystem) | P3 (v2 per seed) |
| Weekly leaderboard | LOW at launch, rises with active users | MEDIUM | P3 (v2, gated on user-count trigger) |

## Competitor Feature Analysis

| Feature | Aimchess Blunder Preventer | Chessable Puzzle Connect | Lichess Puzzles/Streak | FlawChess Train (this design) |
|---|---|---|---|---|
| Puzzles from your own games | Yes (blunders) | Yes (missed tactics) | No (generic pool) | Yes (blunders + non-gem good moves) |
| True dated spaced repetition | Unclear/unpublished | Level-ladder (Leitner-like) | None | Custom streak-keyed interval ladder |
| Free tier depth | Limited (subscription product, $7.99/mo) | 10 puzzles free, then $75/yr | Fully free | Fully free (open source) |
| Puzzle format | Binary good-move/blunder choice | Move-by-move course line | Multi-move curated line | Single-move, client-graded |
| Pre-move judgment layer | No | No | No | Yes (critical vs. several-fine guess) — novel |
| Explicit "too hard, set aside" mechanic | Unknown | No (level resets, stays in rotation) | N/A | Yes (parked, 3-fail threshold) — ahead of market |
| Session cadence | Unpublished | User-paced deck review | Ad hoc / daily habit push | User-configured weekly schedule |
| Social/competitive layer | No | No | Yes (Streak/Storm leaderboards) | Deferred to v2, gated on active-user count |

## Sources

- [Chess Improvement: Aimchess Blunder Preventer — Medium](https://medium.com/getting-into-chess/chess-improvement-aimchess-blunder-preventer-18434892d070)
- [Aimchess Review — Raindrop Chess](https://www.raindropchess.com/aimchess-review-does-personalized-chess-training-actually-work/)
- [Spaced Repetition for Chess Tactics — Chesswoodie](https://www.chesswoodie.com/blog/spaced-repetition-chess-tactics/)
- [Puzzle Storm & Streak — lichess-org/mobile DeepWiki](https://deepwiki.com/lichess-org/mobile/3.3-puzzle-storm-and-streak)
- [Puzzle Storm — lichess.org](https://lichess.org/page/storm)
- [Puzzle Streak — lichess.org](https://lichess.org/streak)
- [How to Navigate & Use Lichess — RagChess (skip mechanics)](https://www.ragchess.com/navigate-lichess/)
- [Learn From Your Mistakes With Chessable's Epic New Feature — chess.com blog](https://www.chess.com/blog/rat_4/learn-from-your-mistakes-with-chessables-epic-new-feature)
- [How do Puzzles work on Chess.com? — Chess.com Help Center](https://support.chess.com/en/articles/8608686-how-do-puzzles-work-on-chess-com)
- [How does the spaced repetition scheduling work? — Chessable Support](https://support.chessable.com/en/articles/9043598-how-does-the-spaced-repetition-scheduling-work)
- [About MoveTrainer — Chessable](https://www.chessable.com/movetrainer/)
- [Noctie.ai: AI chess coach — Skywork deep dive](https://skywork.ai/skypage/en/Noctie.ai:-A-Deep-Dive-into-Your-Human-like-AI-Chess-Coach/1976112012280393728)
- [Introducing Noctie — noctie.ai](https://noctie.ai/chess/introducing-noctie-ai-chess-helper/)
- [Chess Tempo tactics rating explanation — chess.com forum](https://www.chess.com/forum/view/general/can-someone-explain-the-tactics-trainer-rating-system)
- [ChessTempo Manual](https://chesstempo.com/manual/en/manual.html)
- [Puzzle dashboard: strengths and improvement areas — lichess-org/mobile PR #2651](https://github.com/lichess-org/mobile/pull/2651)
- [BlunderProof course — ChessMood](https://chessmood.com/course/blunderproof)
- [How to improve the quality of your chess training — ChessMood blog](https://chessmood.com/blog/how-to-improve-quality-of-your-chess-training)
- [Anki and Spaced Repetition — Chris Krycho](https://v5.chriskrycho.com/journal/anki-and-spaced-repetition/)
- [Daily Review Load Management: Avoiding Anki Burnout — SmartRecallAI](https://smartrecallai.com/blog/daily-review-load-management)
- [Spaced Repetition Schedule Guide — StudyCardsAI](https://studycardsai.com/blog/spaced-repetition-schedule-guide)
- [Duolingo — Streak System Detailed Breakdown & Design — Medium](https://medium.com/@salamprem49/duolingo-streak-system-detailed-breakdown-design-flow-886f591c953f)
- [App Teardown: How Duolingo's Streak Mechanic Actually Works — Apptitude](https://apptitude.io/blog/how-duolingos-streak-mechanic-actually-works/)
- Internal: `.planning/seeds/SEED-037-train-spaced-repetition-blunder-drills.md` (settled design, read in full)
- Internal: `.planning/PROJECT.md` (shipped-requirement history confirming Data Dependencies)

---
*Feature research for: FlawChess Train (v2.9) — own-mistake spaced-repetition chess drills*
*Researched: 2026-07-25*
