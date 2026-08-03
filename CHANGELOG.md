# Changelog

All notable changes to FlawChess are documented here.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with releases aligned to GSD milestones rather than individual phases. Dates are
in `YYYY-MM-DD` (Europe/Zurich).

## [Unreleased]

### Fixed

- The Train guess card no longer tells you things that aren't true. Guessing "One critical move" correctly but then playing a losing move used to be answered with "You identified the one critical move", which read as praise for a move you never found; it now separates the two ("Right, and you found it: only one move works here." versus "Right, only one move works here, but that wasn't it."). And a correct "Several fine moves" guess on one of your own blunders used to congratulate you with "You handled this fine in your game" at the exact position where you blundered; it now says several moves were fine, but not the one you played. The same clause was missing when you guessed "One critical move" and the position turned out to be one of your blunders with no single answer: a bare "Several moves are fine here" read as if nothing had gone wrong there.

## [v2.11] Train Solve Surface & Push Reminders — 2026-08-03

### Tests

- Fixed three test flakes that only surfaced under the full parallel suite, each at its real cause rather than by loosening an assertion: the real-Stockfish contract tests now lift `evaluate()`'s 2s wall-clock guard for themselves (the engine runs under `SCHED_IDLE`, so a depth-15 search is starved past 2s when every xdist worker competes for the same cores; the production constant is untouched); the tier-3 residual-fallback lottery test no longer requires that no other eligible backlog row exists anywhere in the database, and its stale fixture moved from 180 to 90 days so both probabilistic assertions sit many sigma from their thresholds; and the three heaviest frontend suites now raise testing-library's `asyncUtilTimeout`, whose 1000ms `waitFor` ceiling is independent of the per-test timeout those files already raised.

### Added

- The Train solve screen now explains itself. After you solve, each move gets its own card carrying a small arrow in the exact color of its arrow on the board, so you can tell at a glance which line is which. Hovering a card (or tapping it on mobile) spotlights just that move and clears every other arrow and badge off the board, and clicking a card snaps the board back to that move from wherever you had stepped to. Drawn alternatives are collected into a compact "Also fine" row. Inaccuracies no longer render in a separate yellow: they read as good moves, while the eval badge still discloses the drop. (Phase 200)

- Your phone no longer dims or locks itself while you are studying a Train puzzle or reading its solution. The screen stays awake for as long as a puzzle is open and goes back to normal on the session's start and score screens. Requires iOS 16.4+ or a recent Android browser, and iOS Low Power Mode overrides it.

- You can now explore "why didn't my move work" without leaving Train. Once a puzzle is revealed, just move a piece: the cards give way to a Stockfish engine card plus the analysis page's move list, seeded with whatever line you had stepped into. Play freely, click moves inside the engine's lines to play them in, branch off into sidelines that survive as their own blocks, and press Solution (or the card's ×) to return to the full reveal. Next and Analyze leave no residue behind. (Phase 200)

- FlawChess can now remind you on your own devices when it is time for a Train session. It arrives on the days you have scheduled, at the local hour you pick, and never on a day you have already trained. It's off until you turn it on, and nothing in the interface offers it yet — that lands in the next phase. (Phase 201)

- You can now turn those reminders on. Finish a Train session and a "Remind me" button sits beside Done on the score screen; pressing it is the only thing that asks your browser for permission, so the prompt never appears on its own. Once you allow it, the button is replaced in place by a confirmation naming the hour. If you close the prompt without deciding, nothing is recorded and the offer simply stands next time: there is no counter, no second ask, and no path that nudges you toward the one answer your browser will not let you take back. The Train schedule card carries a "Remind me to train" switch and an hour picker that save themselves exactly like the weekday chips, so you can subscribe later even if you declined, and a second device can be added the same way. Turning the switch off silences reminders immediately without giving up the browser permission, so turning it back on is instant. If your browser has notifications blocked, the switch reads off and disabled with the reason rather than pretending it can help. (Phase 202)

- Turning on Train reminders now offers to get FlawChess onto your phone, at the one moment you have clearly said you want them. What you see depends on where you are: on an Android phone, a button that installs the app; on a desktop, a QR code you can scan to open FlawChess on your phone; on an iPhone, a button that records your intent and then shows the two steps Safari requires. If you are already running the installed app, you get nothing extra, which is the point. The QR code also has a permanent home in the Train schedule card, where it becomes an install button on a phone and disappears entirely inside the installed app. (Phase 203)

- If you install FlawChess on an iPhone after asking for reminders, opening it now takes you to Train and offers the permission prompt you never got to answer, instead of leaving you with no way back to it. (Phase 203)

### Fixed

- Declining the install prompt no longer silences it forever. "Not now" now sets it aside for two weeks, and FlawChess will offer at most three times before it stops asking for good. Dismissing it also no longer breaks every later install button in the same visit. (Phase 203)

- If you already run FlawChess from your iPhone home screen, it no longer keeps telling you to add it to your home screen. (Phase 203)

- The install prompt no longer appears while you are training. It stays out of the Train screens entirely, so it can never land on top of the reminder button or steal a tap, unless you got there by scanning the install QR code yourself. (Phase 203)

## [v2.10] FlawChess Engine Improvements — 2026-08-01

### Changed

- Bot moves and analysis-board searches are faster: positions deep in the engine's search tree are now graded at a shallower Stockfish depth, chosen from measurement so move quality is preserved, instead of every position at full depth. A follow-up measurement tightened the ladder further, landing at roughly 1.4× faster searches end to end. (Phase 195)

- The FlawChess engine wastes less work behind the scenes: move probabilities are converted in a single pass instead of re-parsed per move, board snapshots are built only when something reads them, and abandoning a search (moving on, flipping positions) now actually stops the queued Stockfish grading instead of letting it run to completion. The engine's caches were also right-sized so long analysis sessions stop evicting results they are about to need again. (Phase 194)

### Fixed

- Train: pressing Next no longer briefly requests the solution for the puzzle you are about to solve. The reveal panel kept the previous puzzle's verdict for a moment after the transition, which fired a rejected request (and flashed the old solution) on every Next press. (FLAWCHESS-64)

- The analysis board's FlawChess verdict now reliably evaluates Stockfish's recommended move. The move was supposed to always be among the candidates the practical engine considers, but it could be silently dropped twice: once by the probability mass cut and once by the root candidate cap, so the "what would the engine play instead" comparison could be missing exactly when the disagreement mattered most. (Phase 196)

- The Moves-by-Rating chart no longer leaks its engine results past the shared cache's size limit; its lookups now share the same bounded cache as the rest of the analysis page. (Phase 197)

- The Maia panel no longer stops updating after you toggle it off mid-analysis and back on. The analysis board no longer reuses one position's engine hints on a later, unrelated position after switching an engine off and back on. The engine recovers instead of hanging when its Stockfish workers die or stop responding to a request to stop. The board no longer briefly shows the previous position's engine line right after you move. (quick 260731-s0z)

### Tests

- Two engine ideas were measured end to end and deliberately not shipped, with the measurements committed: using Maia's own win/draw/loss estimate as the value of deep search-tree leaves (rejected at a pre-declared move-quality gate: it goes blind to forced tactics) (Phase 197), and rewriting the engine's dispatch loop for continuous policy/grade overlap (a modelled 29–35% speedup, closed as measured-not-shipped after the determinism design failed two independent reviews and surfaced that browser grades were never bit-reproducible to begin with — SEED-130) (Phase 198).
- Re-measured bot strength against the shipped grading ladder with a 5-cell parity sweep plus a game-level timing comparison, since the ladder turned out to be the only strength change of the three originally planned for this milestone. Verdict: parity holds in both anchor families, and real games show at least the wall-clock speedup the ladder's own fixture predicted. No bot-strength labels changed. (Phase 199)
## [v2.9] Train — Spaced-Repetition Blunder Drills — 2026-07-30

### Added

- The homepage now advertises Train: a "Personalized Puzzle Training" section sits right after Game and Tactic Analysis, and a new "How can I improve my chess with FlawChess?" FAQ entry walks through analysis, training, and bot play. The System Opening Filter section was dropped to keep the page from getting crowded, and the README gained the Train, Human-like bots, and Game & tactic analysis entries it was missing. (quick 260729)
- Homepage FAQ answers are now readable by search engines. The accordion no longer renders its answers into the prerendered HTML (collapsed content is unmounted), so the page emits a schema.org `FAQPage` JSON-LD block built from the same source as the accordion itself, which also makes it eligible for FAQ rich results. The page title and meta description now mention puzzle training. (quick 260729)

- Train is now a habit, not just a page: pick which weekdays you train and how many puzzles a session (saved as you toggle, no Save button), and the Train tab carries a count of the puzzles waiting for you. The start screen leads with your progress — a weekly streak flame, how many flaws you've fixed, how many are parked, and how this week is going. Finishing a clean session sets off confetti (respecting reduced-motion), and getting a puzzle right three times shows a "Flaw fixed!" celebration with the position. Nothing to train yet points you at import; everything mastered gets an "All caught up!" screen with the date of your next review. (Phase 191)

- The Train page is live: a new import-gated `/train` tab (desktop header, mobile bottom bar, and More drawer) drills your own blunders as puzzles. Each puzzle asks a quick read of the position (one critical move vs. several fine moves), takes a single move attempt graded right in the browser, then reveals both verdicts with a steppable best line, an optional tactic line, and the source game with an Analyze deep link. Sessions resume where you left off and end on a score screen. (Phase 190)
- Backend groundwork for Train, the upcoming spaced-repetition drill mode: your own blunders that carry a full stored answer key become drill puzzles on a per-user schedule, mixed with red herrings drawn from positions where your move was already fine. Sessions compose, resume, expire, and record results with the interval ladder advancing, retiring mastered puzzles and parking ones you keep missing. (Phase 189)

### Changed

- A Train session now draws at most one puzzle from any single game, so several blunders in the same game no longer produce near-identical puzzles in one sitting. (quick 260728-pgp)

- Train's streak now counts sessions rather than weeks, and is protected by a buffer of up to seven flames that absorbs missed days instead of resetting on the spot; the Train nav badge is quiet on days that aren't scheduled. The flames heat up from yellow through orange to red as the buffer fills, with unearned ones shown as grey outlines, the streak count itself sits in a trophy badge, and the card explains all three rules (a scheduled day counts, an off-day session doesn't, and the streak only resets once the flames run out). The Train landing is now organised into Streak, Statistics, and Schedule cards. The Train tab's waiting-puzzle counter now ticks down as you solve rather than sitting frozen until the session ends, and finishing a session clears it right away instead of on the next page load. Changing the puzzles-per-session setting before starting a session now updates the waiting-puzzle count immediately rather than after pressing Start; changing it during a session still leaves that session's length alone. (Phase 193)

- Train's "several fine moves" puzzles now come from a precomputed, shared pool of positions vetted by a deeper engine search, so a quiet puzzle genuinely has several acceptable moves instead of only looking like one, and positions where everything is fine are filtered out. These puzzles also stand on their own: they keep working after the game they came from is deleted, and when there is no game behind one, the reveal leaves out the opponent line and the Analyze link instead of pointing at a dead end. (Phase 192)

- Redesigned the Train reveal into a self-contained study surface. The board now draws what mattered: green arrows for the moves that were actually good (one on a sharp puzzle, up to three on a quieter one), a distinct arrow for the move you played, and a thin white arrow for the move played in the game. The verdicts spell out the answers you gave rather than showing bare marks, and the game card is replaced by three steppable engine lines — your move, the best move, and the move played in the game — each with its own evaluation, all from the same search so the numbers can never contradict the verdict or each other. A small footer names the opponent and date, Solution / Analyze / Next sit on one row below the board (Analyze opens the analysis board on the exact position the puzzle showed), stepping a line plays move sounds with the same mute toggle as bot games, and your running session score rides along on the progress bar and survives a reload. (Phase 190.1)

- Reworked the bot roster's Grinder and Wall ladders. The Grinder line now runs Ant → Mole → Otter → Nell the Penguin → Tank the Ox → Gus the Gorilla, and the Wall line ends Rocco the Armadillo → Hilda the Hippo, retiring Bo the Buffalo, Yara the Yak, and Dana the Beaver. Grinder portraits also read grittier and more dogged than the previous placid look.

- Train reads better on a phone: the puzzle board is measured against the actual window so it fits without scrolling on short screens, the buttons are thumb-sized, and the page shares the Import tab's width and padding. (Phase 191)

- Train puzzles are now scored out of three instead of two. The position read is still worth one point, and the move is worth two for a clean move, one for a slightly imprecise one, and none for a mistake or blunder, so settling for a second-rate move no longer scores a perfect session. The per-puzzle points badge is now colour-coded by score. Already-recorded sessions keep their original scores. (SEED-119)

- The board you play bots on is 50% larger on desktop, and now measures itself against the window: on a short screen it shrinks to keep the clocks and controls in view instead of pushing them off the bottom. The page also runs closer to the window edges so more of that width reaches the board. (quick 260729-bbd)

- The analysis page now shares a single Maia engine instance across the move-probability chart, the background gem check, and the FlawChess engine instead of running up to three in parallel, cutting its peak memory use roughly in half to a third. (quick 260729-sod)

### Fixed

- The "N of M analyzed" badge on the Library's Stats tab now agrees with the same badge on the Games and Flaws tabs. It had been counting a different set of games: it skipped bot-practice games, followed the page filters, and treated a game as analyzed as soon as it arrived from lichess with computer analysis attached, rather than once FlawChess had actually analyzed it. The same faulty count was also the denominator behind the flaw rates, so players with a lot of lichess-analyzed games saw their flaw rates per game understated, in the worst case by around threefold. Flaw rates and the you-vs-opponent comparison sections are now measured over exactly the games they draw their numbers from.

- Fixed an iOS crash during bot play: when the Maia chess engine's GPU-accelerated path failed to start, it was loading its runtime a second time on top of the first instead of replacing it, roughly doubling memory use and crashing the tab on iPhone. The engine's model and runtime files are now also cached for a month so they aren't re-downloaded on every visit. (quick 260729-sod)

- The Library's Flaws tab loads again, and the Games tab is fast when a tactic filter is on. Both had slowed to a crawl for players with large histories, with the Flaws list often never finishing at all. Two queries were asking the database to compare every position in a game against every flaw in it, and the flaw list was also dragging each game's full move text and stored tactic lines through the sort only to throw them away. On the biggest account in dev, the Flaws tab went from timing out past two minutes to about 0.2s, and a tactic-filtered Games page from 7.8s to 0.15s. (quick 260729)

- Train's "Scored today" now reads the same on every device. The score was kept only in the browser you solved in, so opening Train on your phone after finishing a session on your computer showed "0 of 18 points" instead of the score you actually earned. The score now comes from your account, so it is correct wherever you open it, and the running score during a session no longer counts against the wrong total after switching devices mid-session. (quick 260728-tgc)

- Train's "several fine moves" puzzles are drawn from a far wider range of positions. The pool behind them was being filled from only a handful of players' games, with many puzzles sitting a move or two apart in the same game; it now spans hundreds of players and thousands of games, so repeated or near-identical positions are much less likely. (SEED-124)

- A training session can no longer get stuck on Resume forever. If one of its "several fine moves" puzzles could not be served, the session still counted it as outstanding and refused to finish, so it sat there until it expired the next day. Such a puzzle is now skipped for the purpose of finishing, exactly as it already was for the purpose of serving. (quick 260728-kmu)

- The Train score screen no longer shows a greyed-out "Train again" button that could never be pressed. Sessions run once a day, so the screen now tells you the date of your next one and offers a Done button back to the Train landing, where you can see the streak you just extended. (SEED-122)

- A slow analysis worker no longer restarts its engine when a search times out, which was turning one slow position into a block of missing evaluations for the rest of the game.

- Finishing a training session no longer lets a fresh session be composed the same day, which was quietly defeating the spaced-repetition pacing and could leave a Resume button that did nothing. (Phase 190.1)

- Pressing Analyze from a solved Train puzzle and then going back now returns you to that puzzle's reveal instead of the start screen. (Phase 190.1)

- Train reveals on "several fine moves" puzzles no longer show just the single best-move arrow: alternative moves the grading itself would accept now always appear, with clean alternatives in green and slightly imprecise ones in yellow with the inaccuracy icon. Previously about a third of these puzzles drew no alternative arrow at all because the arrows used a stricter cutoff than the verdict. (quick 260726-fma)

## [v2.8] Import Filters and Guest Data Cleanup — 2026-07-24

### Added

- Import filters — choose exactly which games get imported per platform: filter by color, opponent type, time controls, and a recency window, plus a per-time-control game cap so you can bound how many bullet/blitz/rapid/classical games each import pulls. The Import tab shows a filter card per platform with budget and backlog chips (untimed games appear as an uncapped bucket), settings auto-save as you toggle them, and a save failure surfaces inline near the control (Phase 186).

- Guest data cleanup — guest sessions inactive for 30 days now have their imported games and all associated analysis automatically purged (the long-advertised behavior is finally live). The guest account itself is kept, so a returning guest can log back in and simply re-import a fresh history. A daily background job handles it; registered accounts are never touched (Phase 187).

### Changed

- Realigned the `ix_games_bestmove_backfill_pending` partial index with the current best-move claim query; reframed `resweep_holed_games` as the permanent Path-C hole re-arm tool and trimmed stale tier-2 / legacy-endpoint docstrings (Phase 188).

### Removed

- Archived completed one-shot backfill scripts to `scripts/archive/` and pruned the 3 now-unused `eval_drain` re-exports (Phase 188, SEED-115).

## [v2.7] Bot Personas & Playstyle Layer — 2026-07-23

### Added

- Persona win stars — winning a game against a bot persona now earns a gold star on that persona's roster card (up to three shown per persona), tracked per user on the server and updated as soon as you return to the roster after a win. Custom-setup games don't earn stars (Phase 185).

- **Bot personas on the Bots page** — a roster of 24 named opponents, four play styles (Attacker, Trickster, Grinder, Wall) across six strength rungs each. Every persona is a complete pinned opponent: its own preset and style parameters, opening book, resign and draw-offer policy, avatar and bio. Browse the grid, open a persona for its bio and colour/time-control chips, and start a game in one action; your last colour and time control are remembered per persona. Personas are present in-game too — avatar and name in the clock strip, a draw-offer banner when the bot offers, persona-named result copy, and Rematch / New opponent when the game ends. Custom setup is still there for a hand-tuned bot (Phase 183).

- Persona strength labels are **measured**, not guessed: an overnight calibration sweep played each persona against the internal anchor ladder, and the fitted result feeds a single generated calibration file with a disclosure popover on the detail surface explaining what the number means. Labels honor honest floor/ceiling constraints — the weakest rung acknowledges the measured ~900 floor and no persona claims strength above the ~1800 ceiling. Also adds the operator sweep runbook, the fit and codegen pipeline, and a CI drift gate on the generated file (Phase 184).

- Dev: bot play-style levers — four named styles (Attacker, Trickster, Grinder, Wall) can now steer a bot's play through new bot-only parameters: a curated per-style opening book, signed draw contempt plus a hysteresis-gated resign policy, Maia policy reweighting by move features (checks, captures, pawn advances, trades) on the Human rungs, and additive score shaping with a variance preference on the Light/Deep rungs. A headless measurement script (`scripts/style-lever-measurement.mjs`) backs the per-style tuning with committed evidence. Every lever is optional and gated: with no style set, bot play and Custom mode are byte-identical to before. Dev-only, nothing selects a style yet (the Bots page personas land in Phase 183) (Phase 182).

### Changed

- Finished bot games are now saved with the persona's name and its calibrated strength (e.g. ~800) as the opponent's name and rating, in both the PGN header and the game record, instead of the generic "FlawChess Bot" and the bot's internal engine setting. Custom-setup games are unchanged (Quick 260722-ucc).

- The Bots roster is now organized as a strength ladder: six rung rows (~800 at the top, strongest at the bottom) by four style columns, with a single accent-colored style header row. Each card's own ELO label identifies its rung, so the grid needs no row labels, and the four style names fit on one line down to the narrowest phone widths (Phase 185).

### Fixed

- Lichess games imported with lichess evals no longer wait behind the entire analysis backlog: they now take part in the same fair per-user scheduling as everything else, so your fresh imports get their engine pass promptly even while another user's huge import is being worked through (Quick 260723-j6g).

- Lichess imports work again: lichess began rejecting requests without an identifying User-Agent (returning "user not found" for accounts that exist), which broke every lichess import from 2026-07-22. FlawChess now identifies itself on lichess API requests, as it always has on chess.com (hotfix 2026-07-23).

## [v2.6] Bot Strength Calibration — 2026-07-21

### Added
- Dev: three-preset bot strength-curve calibration harness — builds on the Phase 173 internal anchor scale to measure each play-style preset (Human / Light / Deep) against the 10 fixed Maia/Stockfish anchors. A pure-logic two-pass scheduler (`scripts/lib/calibration-bot-cell-schedule.mjs`) locates each bot cell's rough rating then brackets it with a cross-family (Maia + Stockfish) anchor set on the measured `INTERNAL_RATING` scale; a single-parameter pinned-anchor MLE (`fit_bot_cell_rating` in `scripts/calibration_anchor_fit.py`) produces per-cell `rating_vs_maia`/`rating_vs_sf` with CIs and the cross-family style-inflation gap `G_preset`; the harness also records near-free per-game quality metrics (draw rate, length, ACPL, blunder rate, SF/Maia agreement) and a resumable raw-game ledger. Validated on a real-engine pilot; the full ~18-22h three-preset sweep is an operator-run step. Dev-only, not yet wired into the product (feeds a future preset-strength surface, SEED-104) (Phase 180).

- Dev: per-preset bot strength lookup curves — the Phase 180 sweep's 15 measured cells are now fitted into a shipping artifact that maps a target approximate blitz ELO to a bot setting per preset. `scripts/gen_bot_strength_curves.py` runs a monotone (PAVA isotonic) fit over each preset's measured points, converts to approximate human blitz ELO via the pooled style-gap correction plus a shared literature offset, and inverts it into 100-step lookups with honest per-preset ranges (Human ~900-1400, Light ~1500-1600, Deep ~1600-1800) and an approximate-ELO disclaimer. Emits `reports/data/bot-strength-lookup.json` plus a generated `frontend/src/generated/botStrengthCurves.ts`, both CI drift-checked. A sibling generator writes 7 off-grid confirmation-cell predictions with 95% CI bands and runbook commands for an operator validation run. Dev-only, nothing reads the lookup yet (Phase 181).

### Fixed
- Maia "Human Move Probability" card: when you played a non-best move, the engine's best move is now marked as a gem in the card *before* you play it, matching the gem badge that already appeared once the move was played on the board. The card also classifies that gem at the mover's rating-at-game-time (consistent with the board badge) instead of the ELO slider (Quick 260719-m5g).
- Best/gem move analysis now reaches games it previously skipped forever: lichess-imported games (with their own evals) and guest games are now covered by the best-move pass. This also un-orphans games whose best-move pass was skipped during a Maia-outage window. Gem/great badges on lichess games are now computed against the engine's own evaluation (previously they could be over-awarded).
- Mobile analysis board: when analysis of a just-played bot game finishes, the move-quality icons (blunder/mistake, gem/great, book) now appear in the Moves tab automatically. Previously they stayed hidden until you switched to another tab and back.
- Long analysis and bot-play sessions no longer creep toward an out-of-memory crash: the Maia move-prediction worker now releases each inference's memory instead of leaking it. Most visible on devices without WebGPU, where a marathon session could previously exhaust the WebAssembly heap (Quick 260721-sgb, SEED-113).

## [v2.5] Move Statistics — 2026-07-18

### Added

- Best/Good move tiers now show on the analysis board and the Library game card miniboard, with green star (Best) and thumbs-up (Good) corner glyphs for both players (Quick 260717-rbn).
- Backend: per-game accuracy and ACPL are now computed with lichess's exact formulas from our own per-ply evals and written into the canonical `games` accuracy/ACPL columns, giving one uniform, cross-platform-comparable methodology; the original platform-provided values are preserved in new `*_imported` columns for validation. A single shared compute path runs both at full-eval completion and in a historical backfill, and games with an incomplete eval sequence are left NULL. Backend-only for now — nothing reads the columns for display yet (Phase 178).

### Changed

- The badge rows on the Library game card and the analysis board tags panel are replaced by a single shared **Move Stats** component: a two-sided accuracy strip plus a per-player table counting all seven move categories (Gem, Great, Best, Good, Inaccuracy, Mistake, Blunder) for both you and your opponent. Each count is clickable to cycle through those moves, and on the Library card only your own cells carry the filter ring (Phase 179).
- Play-vs-bot setup: the play-style control is now three preset buttons — **Human** (plays on instinct, no calculation), **Light** (a little calculation, the new default), and **Deep** (calculates hard) — replacing the previous slider plus Human/Engine chips. The presets describe calculation depth rather than a rating; bot strength isn't ELO-calibrated yet (Quick 260717-lr9).

### Fixed

- Gem/great badges: on games imported with Lichess evaluations, the "gem"/"great" marker (and the Library "has gem/great" filter) is now suppressed when our own best-move engine disagrees sharply with the imported Lichess evaluation for the same move, removing spurious badges on sharp positions where our shallower search overrated the line. Applies retroactively to already-analyzed games with no re-analysis (Quick 260717-gmg).

## [v2.4] Backend Gem & Great Detection — 2026-07-17

### Added

- Analysis board: your strong "gem" and rare "great" moves are marked instantly from stored analysis data the moment you open an analyzed game — no background scan, regardless of device or engine load (Phase 175).
- Analysis & Library: eval charts now show violet (gem) and blue (great) dots for your best moves, and clickable "Gem"/"Great" badges step through them. Badge counts and cycling cover your own moves; the analysis board still flags your opponent's gems too (Phase 175).
- Library: filter your games by whether they contain a "gem" or "great" move, composable with every other game filter (Phase 175).
- Backend: gem/great moves are now detected server-side during the full-game analysis pass — Maia-3 inference over your out-of-book best moves stores per-ply best-move candidate rows (a first-class artifact peer to blunder/mistake/tactic tags), so the markers come straight from stored data instead of the browser recomputing them each visit (Phase 174).
- Backend: the existing analyzed corpus is backfilled with gem/great data opportunistically via a tier-4 lottery, so older games gradually become eligible for the new markers and filter without a bulk re-analysis (Phase 176; ships behind an off-by-default flag, enabled in production after rollout).
- Backend: gem/great candidate detection now runs on the remote worker fleet — workers compute the runner-up (MultiPV-2) search themselves and submit it with their results, freeing the server engine pool for fresh analysis. A dedicated lease/submit endpoint pair also lets the fleet backfill gem/great data for already-analyzed games, and the server drain takes a minimal candidate-only path for those backfill games (Phase 177).
- Dev: anchor-vs-anchor self-calibration ladder — a standalone orchestrator (`scripts/calibration-anchor-ladder.mjs`, probe→measure schedule with connectivity guard and resumable ledger) plus a stdlib Bradley-Terry fit (`scripts/calibration_anchor_fit.py`) place all 10 Maia/Stockfish bot anchors on one measured internal scale, published as `INTERNAL_RATING` in `scripts/lib/calibration-internal-scale.mjs`. Key result: the Maia-3 argmax ladder is ~2.8x compressed vs its nominal ELO labels, worst at the top (Phase 173).

### Changed

- Analysis: the client-side gem sweep is retired — gems/greats read from stored analysis data, with the old live scan kept only as a fallback for free-play and unanalyzed positions (Phase 175).
- Library filters: the "Severity" section is now labelled "Flaws" (Phase 175).
- Play-vs-bot board now has a control bar (reset, back, forward, flip board) directly below the board for stepping through the game and flipping orientation. In the single-column layout the name/clock strips always match the board width and the move list is hidden; the two-column layout now appears on narrower windows (from 800px), keeps a small gap between columns, and sizes the move list to line up with the bottom of the board.

## [v2.3] Bot Play — 2026-07-15

### Added
- Bot play groundwork: a single pure move-selection function (`selectBotMove`) blends human-realistic Maia sampling with practical-score argmax across the play-style slider range — the same code the app's bot and the calibration harness use (Phase 166).
- Bot play groundwork: finished bot games can be stored as first-class `platform='flawchess'` Library games via `POST /bots/games`, carrying clocks, full bot settings, and a converted player rating; bot games are excluded from analytics by default and opt-in in the Library (Phase 167).
- Dev: headless calibration harness (`scripts/calibration-harness.mjs`) measures the engine's real playing strength across an (ELO × play-style) grid against Maia and Stockfish anchors — multi-process Stockfish pool, durable per-cell TSV output with `--resume`, an advisory ELO estimate, and a flawchess.com analyze deep-link logged for every game (Phase 168).
- Bot play groundwork: the bot now thinks on a fixed search budget with confidence-based early stopping, so a move lands in seconds rather than minutes; the calibration harness grades deterministically under load and survives a slow engine reply instead of aborting the sweep (Phase 168.5).
- Bot play groundwork: a full clocked game against the bot is playable end to end on an unlinked `/bots` route — dual Fischer-increment clocks, bot pacing that speeds up as its own clock drops, every end condition (checkmate, stalemate, the draw rules, flagging), resign and draw offers, a result dialog, and move sounds. The nav entry and setup screen arrive with the Bots page (Phase 169).
- Bot play groundwork: in the opening the bot now answers from a book instead of searching. It plays moves that keep the game inside the shipped ECO database, picked in proportion to how often humans at its rating play them, so its early moves are near-instant, cost it almost none of its clock, and vary from game to game. It leaves the book once no theory move looks plausible at its rating (or a ply cap is hit) and resumes normal search; the engine warms up during the book window, so the first searched move no longer pays a cold start (Phase 169.5).
- Bot play groundwork: a bot game now survives closing the tab. Returning to `/bots` offers a "Resume game?" prompt showing the position, time control, bot ELO, move count, and how long ago you left, and picks the game up exactly where it stood — the clock is paused while you are away, so only your own thinking time is billed and the bot's interrupted search is refunded. Discarding asks for confirmation first. Abandoned games leave no trace on the server, and a finished game is stored exactly once no matter how many times you reload (Phase 170).
- Play a bot: Bots is now a real top-level page, linked from the nav on desktop and mobile and open to guests as well as logged-in users. A setup screen configures the game (time control, bot ELO, play style, and your colour, including random), remembers your last choices, and seeds the ELO from your own rating. From there the clocked board, resume, and store-on-finish all hang together: a finished game is saved to your Library with a link to it, "New game" returns to setup, and "Analyze this game" opens the analysis board already oriented to the colour you played (Phase 171).
- Analysis: opening a game now quietly scans its past moves in the background and marks the openings you had memorized (a book icon) alongside the strong-but-rare "gem" moves it finds, so hard-to-spot ideas from earlier in the game surface without you stepping through every move. The scan runs on its own and always yields to whatever position you are currently looking at, so it never slows down the board (Phase 172).

### Changed
- Play a bot: your side of the board is now labelled with your real username (your Lichess name, or your chess.com name if you have not linked Lichess) instead of "You", both on the clock while you play and on the saved game in your Library. It still reads "You" if you have linked neither platform (quick 260714-pnk).
- Play a bot: a saved bot game now carries a full PGN header block instead of the empty `[Event "?"]` placeholders, so exporting it to lichess or any other viewer shows the event, a link back to the game, the date and time, both player names, both ratings, the bot's `BOT` title, the opening and its ECO code, and how the game ended. Your rating in the header is your Lichess-equivalent rating for that time control (the same figure the Library stores), and it is left out entirely rather than faked when you have no rating history for that time control (quick 260714-qaj).
- Play a bot: "Analyze this game" now actually analyzes it. One click queues the game for engine analysis and opens it on the analysis board, where you can replay the moves straight away while a "Pending…"/"Analyzing…" badge sits where the eval chart will go. When the analysis lands, the eval chart, the flaw icons in the move list, and the missed/allowed tactic badges appear in place — your position in the game is kept, along with any variations you were exploring. Guests get this too: it is the one kind of analysis a guest can request, so the promise on the result screen is finally true (quick 260714-rj5).

### Fixed
- Library: opening a game that has not been analyzed yet no longer lands you on an empty board. The moves are there to replay immediately, whether or not the engine has looked at the game (quick 260714-rj5).

## [v2.2] Analysis ELO Calibration & Deep-links — 2026-07-11

### Added
- Analysis: you can now open any position directly by passing a `?fen=<fen>` URL param, which seeds that position as a fresh free-play analysis root (works alongside the existing `?line=` deep-link, with game > fen > line precedence) (Phase 165).

### Changed
- Analysis: the Maia ELO slider now seats each player at their Lichess-blitz-equivalent rating (Maia's training scale) instead of their raw platform rating, so chess.com and Lichess non-blitz ratings no longer make the Maia opponent play too strong or too weak. The ELO label carries an info popover explaining the conversion, and an inline reset appears once you drag the slider off the players' rating (Phase 164).
- Analysis: gem moves are now flagged a bit more generously — a played move counts as "hard to find" when its Maia probability is at or below 10% (was 5%), so more of the strong-but-rare ideas surface a gem badge.
- Openings → Analysis: the "Analyze position" action now carries the opening's full move sequence to the analysis board (as a `?line=` URL param) instead of just a snapshot position, so you can step all the way back to move 1 in the variation tree. The board opens at the end of the line (quick 260710-x3d).
- Openings: the "Analyze position" action moved from a full-width button under the board to a compact search-icon button in the sidebar (desktop) and the board's settings column under Bookmarks (mobile), on both the Moves and Games tabs (quick 260710-wub).

### Fixed
- Analysis: the × button now removes a sideline when analyzing a position opened via URL (free-play mode), not only in full-game mode (quick 260710-wub).

## [v2.1] Analysis Eval Reconciliation & Gem Moves — 2026-07-10

### Added

- Analysis page: "gem" moves — moves that are objectively best or good yet hard for a human to find (low Maia probability) — are now flagged with a violet gem badge on the board, in the move list, on the moves-by-rating chart, and in the move popover, so you can spot the strong ideas most players miss (Phase 163).

### Fixed

- Analysis page: all per-move evals now come from one reconciled grading-first Stockfish source, so a move labeled "Good" can never show a higher number than the move labeled "Best", and the Stockfish card, FlawChess Engine card, Maia tooltip, board arrow, verdict, and eval bar all agree on the best move (Phase 162).
- FlawChess Engine verdict: the sharp-divergence sentence no longer calls Stockfish's pick "a trap for humans" or the practical pick "more reliable" — misleading when the objectively best move is the only good one (e.g. a queen sac forcing perpetual). It now names the real mechanism: the best move "demands precise follow-ups" and FlawChess expects better practical results from its pick at your ELO.

## [v2.0] FlawChess Engine — 2026-07-09

### Added

- **FlawChess Engine practical-play analysis on `/analysis`** — a new client-side engine that ranks candidate moves by how well they score *for you in practice*, not just by objective strength. Toggle it on from the analysis header (next to Stockfish and Maia) and each line shows a score pair: the objective Stockfish evaluation alongside the practical-for-you score (e.g. "objectively +3.0, practically +0.9"), plus the modal continuation (your move followed by the opponent's most-likely replies) as clickable chips. Lines appear almost immediately and refine live as the search runs. The engine runs entirely in your browser (a Maia-weighted expectimax search over a Stockfish worker pool and a dedicated Maia policy worker), with no shared-memory headers and pool size adapting to your device. (Phases 153, 154, 155)
- **Engine top moves drawn on the analysis board** — the FlawChess Engine's top practical move now renders as its own amber arrow on the board, alongside Stockfish's blue arrow, so you can see at a glance where the two engines agree or disagree. Each engine's arrow toggles independently with its card, and when both engines pick the same move the arrows nest concentrically instead of collapsing to one. Works identically on the mobile board. (Phase 156)
- **Plain-language agreement verdict on the FlawChess Engine card** — below the ranked lines, a one-line verdict spells out whether the engine's top *practical* move agrees with Stockfish's top *objective* move, or diverges from it, citing both evaluations. When the picks differ it flags whether the practical choice is a safe alternative or a sharp one that concedes objective value. The named moves are hoverable (isolating that move's board arrow in its engine's color) and click-to-play, and the verdict reads identically in free analysis and game review. (Phase 157)
- **"Play style" slider on the FlawChess Engine** — a new slider below the ELO selector on `/analysis` biases the engine's move choices: dragging toward *Human* favors the natural move you'd most likely play, dragging toward *Stockfish* surfaces rarer, objectively stronger moves (a Maia policy temperature). Center is neutral and reads exactly the default; the Maia "Moves by Rating" chart always stays raw regardless of the setting. Present on both desktop and the mobile Human tab. (Phase 159)

### Fixed

- **One consistent Stockfish eval across all analysis cards** — on `/analysis`, the Stockfish card, FlawChess Engine card, and Maia chart could each show a different eval for the same move because each surface ran its own independent search. All displayed evals now resolve through a single shared lookup (the free-running Stockfish search first, one shared grading run second), so any move shown on two or more cards renders the identical number, and the Maia chart colors match the displayed evals. (Phase 158)
- **Maia chart no longer gets stuck or lags when scrubbing the eval slider** — on `/analysis`, dragging the eval-chart slider quickly (especially on mobile) could leave the "Moves by Rating" chart blank and the Maia eval bar frozen at 50%, and dragging to a position loaded noticeably slower than clicking straight to it. Revisiting a position now restores its result instantly from cache, and the human-move worker keeps a single inference in flight and jumps to the position you land on, skipping the intermediate slider positions instead of queuing them. (Quick 260705)
- **Opening a game no longer scrolls the whole Analysis page down** — when opening `/analysis` at a specific move (the "Analyze" button's ply), the move list aligned the selected move to the top by scrolling every scrollable ancestor, which on Firefox dragged the entire page down instead of just the move list. The alignment is now scoped to the move-list container, so the page opens at the top. (Quick 260705)
- **Maia now works on browsers whose WebGPU rejects a shader** — on some devices (e.g. Firefox on Windows) WebGPU accepts the model but fails to compile a compute shader (`Clip`) on the first inference, which left the human-move model silently dead. The worker now runs a warmup inference while probing WebGPU, so a lazy shader failure is detected up front and cleanly falls back to CPU (WASM) instead of breaking Maia. These onnxruntime failures are also now reported to Sentry (they previously only printed to the console). (Quick 260705)
- **FlawChess Engine agreement verdict can no longer contradict the Maia chart** — the "far easier to find and play" wording now renders only when the engine's pick has enough actual Maia probability to back the claim (and is shown in the chart); otherwise a neutral fallback phrasing is used. Previously the prose could assert a move was easy to find while the chart beneath showed it as rare. (Phase 159)
- **FlawChess Engine card now shows forced mates** — on a forced-checkmate line the card's objective eval showed a `…` placeholder instead of `#-4`, and the agreement verdict fell back to "Turn on Stockfish to compare picks." even with Stockfish on. The engine now carries the mate distance through to display, so a mating line reads `#-4` and the verdict narrates the agreement just like a normal eval. The gold practical badge (a saturated `-10.0` on these lines) now also reads `#-N`. In a finished position the card shows a gold `#0` (checkmate) or `½–½` (draw) badge instead of sitting blank with the "Turn on Stockfish" prompt. (Quick 260709)
- **Analysis card prose no longer calls a lost position "safe"** — the Maia card's verdict now leads with your objective standing (winning / better / worse / losing / being mated) before describing move difficulty, instead of only measuring how easy the position is to play. A dead-lost position (e.g. mate-in-4 against you) previously read "this position is safe for you"; it now reads "You're being mated — Qxc1 is the longest resistance." Inline eval chips on both the Maia and FlawChess Engine cards are also shown from your perspective (a mate against you reads `−M4`, not a White-POV number), and the FlawChess card's "safer" alternative is now worded "more reliable." (Quick 260709)
- **Maia and FlawChess Engine cards no longer contradict each other** — at low ratings the FlawChess Engine can recommend a move that Stockfish considers objectively worse (because the opponent won't punish it), which made the Maia card warn "Kd1 walks into trouble" while the FlawChess card recommended exactly Kd1. The Maia verdict now frames itself explicitly as the *objective/accuracy* view ("Kf1 is the accurate move; Kd1 is objectively looser, but a 48% pick here") instead of practical advice, so the two cards read as complementary lenses rather than a direct contradiction. (Quick 260709)

### Changed

- **Analysis page now fits your screen without cutting off** — the desktop `/analysis` layout is locked to the viewport height (like chess.com/lichess): no more page scroll that clipped content at the bottom on small laptops. The board sizes fluidly to the space available (shrinking to fit shorter screens down to a readable floor), the columns reflow into a fluid grid that reclaims horizontal space, and the tactic tags/badges panel moved to the bottom of the right column. Mobile is unchanged. (Phase 161)
- **Opponent tactic arrows no longer clutter the analysis board** — on `/analysis`, the opponent's allowed/missed tactic arrows (crimson and teal) are no longer drawn on the board; they remain available in the eval-chart tooltip. Your own tactic arrows are unchanged. (Quick 260705)
- **FlawChess Engine now recommends the move you'll plausibly find** — the ranking folds in how likely you are to actually play each candidate at your selected rating, so a rare (~5%-findable) tail move can no longer top the list on objective value alone, while the displayed practical score for each move is unchanged. The findability weighting auto-scales with the ELO slider. (Phase 159)

## [v1.32] Maia-3 Human-Move Enrichment — 2026-07-05

A human-model second opinion on the analysis board. Maia-3 (a chess engine trained to predict
what a human at a given rating would actually play) now runs live in your browser on `/analysis`,
alongside Stockfish: a "Moves by Rating" chart shows which moves players at each rating pick, a
Maia win/draw/loss bar sits on the left of the board opposite the Stockfish bar on the right, and
each shown human move is colored by Stockfish quality so the chart surfaces the *human trap* — a
popular move the engine grades as a mistake. Everything runs client-side with nothing stored. The
project also relicensed from MIT to AGPL-3.0 to host the Maia model cleanly.

### Added

- **Prose position verdict below the move-quality bar** — when no bar segment is hovered, the text slot below the move-quality bar on `/analysis` now reads a plain-language verdict of how hard the position is to play at the selected rating (safe, tricky, or highly difficult), based on how much the humans-at-this-rating probability mass falls on Stockfish-graded mistakes or blunders. It names the moves worth knowing — the clean options in a safe position, or the risky ones plus a reliable escape move in a tricky/difficult one — each as a hoverable/tappable word that draws its board arrow and shows its human play-rate + Stockfish eval. (Quick 260705-m3z)
- **Move-quality bar under the human-move chart** — below the Human Move Probability chart and ELO slider on `/analysis`, a stacked bar splits the shown candidate moves by Stockfish-graded severity — Blunders (red), Mistakes (orange), Inaccuracies (yellow), and Good Moves (green) — weighted by how often humans at the selected rating play them. Hover (or tap) a segment to list its moves with their play rates and draw an arrow for each on the board in the matching severity color. (Quick 260705-kfg)
- **Stockfish-graded Maia moves on the "Moves by Rating" chart** — the human-move chart on `/analysis` now colors each shown line (and its end-of-line SAN label) by Stockfish move quality using FlawChess's own thresholds — dark-green best, light-green good, yellow inaccuracy, orange mistake, red blunder — so the chart surfaces the *human trap* (a popular move the engine grades as a mistake), not just which moves people play. The line set is now the moves people actually play (Maia cumulative-probability ≥ 0.95 ∪ the engine's best move) instead of a fixed top-6 cap, so sharp positions show fewer lines and quiet ones more. Played and best moves stay emphasized by stroke width regardless of color, and the hover tooltip adds each move's quality word and eval. Grades stream in and refine as the search deepens; everything runs in your browser with nothing stored, and the eval bar / engine card are unaffected. (Phase 151.1)

### Changed

- **Analysis eval bars are now labeled and color-coded** — the two bars flanking the board carry a small caption ("Maia" in violet on the left, "SF" in blue on the right) and a matching colored frame, echoed in the engine card header and the human-panel header, so it's obvious at a glance which bar is the human-move model and which is Stockfish (the white/black advantage fills are unchanged). The player names and clocks now align with the board's left and right edges to make room for the captions, and on mobile the name/clock strips render above and below the board. (Phase 151.1 UAT)
- **Second-best engine move is now light blue** — the analysis board's second-best Stockfish arrow and its eval badge changed from grey to light blue, so the top two engine lines read as a blue hierarchy (solid blue best, light blue second). (Phase 151.1 UAT)
- **Human-move panel polish** — the panel is titled "Maia - Human Move Probability", the ELO slider moved below the chart, and its accent is now violet (was red, which clashed with move-quality severity colors). The chart's "you are here" ELO marker is now a plain white dashed line (the "You: <elo>" caption was dropped). On mobile the tabs gained icons and read "Moves", "Chart", "Maia", and "Tags", and the Maia tab drops the redundant header and uses a shorter chart. (Phase 151.1 UAT)

### Fixed

- **Maia expected-score bar showed the wrong side when Black was to move** — the human-model eval bar read the position from the mover's perspective, so on Black-to-move positions it filled as if the evaluation were White's. It now always reads from White's perspective, matching the Stockfish bar and the board. (Phase 151.1 UAT)
- **Opening-cache crash on transpositions** — analyzing a game that reaches the same position twice (a transposition or repetition) no longer crashes the opening-eval cache write; duplicate positions in a batch are now collapsed to a single row. Affected games self-heal on the next analysis pass. (FLAWCHESS-8E)

## [v1.31] Pipeline Consolidation — 2026-07-04

Server-side pipeline consolidation: the eval write path now threads through a single code path
instead of 3+ copies, and the dead Gen-1 eval protocol is retired. No change to your evals,
flaw/tactic tags, or stats — this is an internal correctness-and-maintainability milestone with
a handful of user-facing bug fixes folded in.

### Added

- **Flaw tags on the analysis board** — the `/analysis` board (in game mode) now shows the game's flaw tags below the eval chart: a Blunders / Mistakes / Inaccuracies row on top of a three-column Missed | Allowed | Context block, matching the Library game card. Click or tap any badge or tag to step the board through that flaw's positions, with the move list and eval-chart crosshair staying in sync. On mobile the tags live behind a new third "Tags" tab alongside Moves and Eval chart. (Quick 260702-nm8)

### Changed

- **Library Games cards now show all tactic + context tags** — the active tactic/severity/context/depth/orientation filter on the Games tab now only decides which games appear; it no longer hides tags from a shown card. Tactic chips are consistent with context chips (both always show the game's full set), and the active-filter ring lights only on chips that truly match the filter across family, orientation, and depth. (Quick 260702-mnd)

### Fixed

- **Duplicate imports for the same account are now blocked reliably** — starting an import while one is already running for the same platform returns the in-progress job instead of ever launching a second one, now enforced at the database level (closes a race where two near-simultaneous requests could both start). (Phase 149)

- **Malformed game results no longer count as draws** — a chess.com game with an unrecognized result is now skipped (and flagged for review) instead of being silently recorded as a draw, so your win/draw/loss stats aren't polluted by fabricated draws. (Phase 149)

- **Eval-chart gaps from slow analysis workers** — games analyzed by a slower remote worker could keep permanent gaps in the opening portion of the eval chart (the worker timed out on the busiest opening positions and the server gave up after a few retries). The server now fills those openings from its own cache and only re-checks the positions that are genuinely still missing, so weak workers no longer leave games stuck with missing evals. Previously-affected games self-heal on re-analysis. (Quick 260703-nux)

- **Imports no longer abort on a single bad game** — one malformed game from chess.com or lichess could previously abort an entire import; the importer now skips the unparseable game and continues with the rest. (Phase 148)

- **More accurate tactic tags around forced mates** — forced-mate tactic detection now tags truncated mate sequences and reads mate scores correctly from both White's and Black's side, and positions preserve en-passant / castling state so tactics near those moves are recognized. (Phase 148)

- **Opening-eval analysis correctness** — the opening-eval drain stops cleanly when every position in a batch fails instead of retrying in place, and games whose analysis lease has expired are correctly offered back up for re-analysis. (Phase 148)

- **Time-pressure stat significance** — the significance test comparing your time-pressure quintiles now corrects for shared-sample covariance, so differences between overlapping quintiles are no longer overstated. (Phase 148)

## [v1.30] Forcing-Line Tactic Gate — 2026-06-30

### Added

- **Forcing-line tactic gate goes live across your whole game history** — the tactic chips on every already-imported game are being re-tagged through the forcing-line gate, so motifs that weren't on a genuinely forced line stop showing as tags (less noise, same blunder/mistake counts). The bulk MultiPV analysis runs on the remote-worker fleet on spare capacity via a new lowest-priority backfill lottery (live analysis always wins), and each game flips to gated tags the moment its backfill lands (no big-bang switchover). New games analyzed from the live remote-worker drain are gated too. Operator tooling (`backfill_multipv.py` progress/dev-validate, `snapshot_tactic_counts.py` before/after per-motif counts) ships alongside. (Phase 145)

- **Forcing-line tactic gate (foundation)** — internal groundwork for the v1.30 Forcing-Line Tactic Gate: two nullable JSONB columns (`allowed_pv_lines` / `missed_pv_lines`) added to `game_flaws` for storing per-flaw-node MultiPV blobs (deferred-loaded so existing stats scans never fetch them), plus a pure, engine-free and DB-free `forcing_line_gate` module that decides whether a flaw sits on a genuinely forced line (only-move margin, already-winning reject, still-winning floor, trailing-only-move strip, one-mover discard). The MultiPV=2 engine pass (Phase 142) and offline re-tagger (`scripts/retag_flaws.py`, Phase 143) that make re-tagging a seconds-fast engine-free re-derivation land in the same milestone. (Phases 141, 142, 143)

### Changed

- **Live game analysis no longer waits on the server's engine** — when a remote worker submits a freshly-analyzed game, the server now applies the evals and tactic tags immediately instead of running an extra inline Stockfish pass to refine the forcing-line gate. That refinement (the per-flaw MultiPV continuation eval) now happens on the remote-worker fleet through the same backfill lottery as the rest of your history, with freshly-analyzed games prioritized so they get gated promptly. The result: snappier, more reliable analysis submission (worker timeouts and engine contention under load are gone) with no change to your blunder/mistake counts. (Phase 146)

- **Only forcing-line-gated tactic tags are stored** — the tagger now writes a tactic tag only once its forcing-line data is present, so an ungated (raw) motif is never persisted, even transiently; a one-time migration cleared the raw tags left on already-imported games. New games are gated end-to-end via an upgraded remote worker that evaluates and blob-writes each game in a single server-checked transaction. No change to your blunder/mistake counts. (Phase 147)

- **Forcing-line tactic gate calibration** — tuned the gate's two centipawn thresholds from a hand-checked A/B validation over the dev sample: the already-winning reject was relaxed (600 → 800 cp) so genuine conversion tactics played while already ahead (a hanging queen at +6, a clean skewer) are still credited, and the only-move escape was lowered (200 → 100 cp) so clear ~1-pawn-better best moves count as forced. Together these credit noticeably more real tactics without admitting false alarms in the sample. (Phase 144)

### Fixed

- **Forcing-line gate backfill un-stalled** — the spare-capacity backfill that re-tags your whole game history through the forcing-line gate was stuck: after Phase 146 the remote-worker fleet was re-evaluating already-analyzed games in a loop instead of filling the gating data, so the re-tag never progressed. Fixed the routing so idle workers drain the backfill through the dedicated path that actually writes it; the fleet's spare capacity now goes to completing the re-tag instead of redundant re-analysis. No change to your evals, tactic tags, or blunder/mistake counts. (Quick 260701-93s)

## [v1.29] Live-Engine Analysis Page — 2026-06-29

### Added

- **Analyze a whole game on the `/analysis` board** — opening a game from the Games/Library now loads the *entire* game on the live-engine analysis board, positioned at the move you were viewing (`/analysis?game_id=X&ply=Y`). The eval-chart slider scrubs the full game with the board and move list staying in sync; on a sideline the slider dims until you return to the main line. Inline missed/allowed tactic chips unfold the engine's stored line as a branchable sideline with the tactic overlay, and a move played inside a sideline forks a deeper one. Player names, ratings, and each side's remaining clock at the current position show above and below the board. (Phase 140)

- **`/analysis` page with live engine, reachable from the Openings Explorer** — the live-engine analysis board now has a real page. Stepping through a position on the Openings Explorer, you can click "Analyze position" to open it on a dedicated `/analysis` board that loads that exact position, runs Stockfish in your browser, and shows the eval bar, top engine lines, and a branching variation tree. The engine bundle loads only when you visit `/analysis` (not on any other page), so the rest of the app stays light. The page shows a "Loading engine..." state while Stockfish starts, and the board stays usable during that wait. (Phase 138)

- **Live-engine analysis board (foundation)** — internal groundwork for the upcoming `/analysis` page: a branching move tree where a move played mid-line forks a new variation instead of overwriting the line, plus the display components that will render live engine output (an eval bar, the engine's top lines, and a variation move list). Not yet reachable in the app; the page and board wiring land in a follow-up phase. (Phase 137)

### Changed

- **Eval chart tooltip now shows the opponent's tactic** — hovering an opponent flaw (the hollow-square markers) on the eval chart now shows the tactic motif and its depth (the same `missed:` / `allowed:` chips your own filled-square markers already show), on both the Games card and the `/analysis` board. Previously only your own flaws surfaced their tactic. The "Opponent · Blunder/Mistake" header keeps the perspective clear, and your blunder/mistake counts and all other stats are unchanged. (Quick 260628-u7d)

- **Analysis board: engine lines expand, and clicking a line plays the whole move sequence** — each of the two Stockfish lines now has a chevron on the right that expands it to reveal the full principal variation (instead of stopping at five moves); the engine card grows to fit the expanded line. Clicking any move in a line now opens the complete sideline up to that move from your current position, instead of jumping straight to the clicked move and skipping everything before it. (Quick 260628-shc)

- **Analysis board: blunder/mistake icons stay on sideline moves** — when you explore a sideline on the `/analysis` board, the live-engine blunder/mistake icons now stick to every move you've stepped through instead of only the current one (they used to vanish as you played the next move). Each sideline move's grading is cached, so stepping back re-shows its icon without re-running the engine. The two desktop Stockfish engine lines also use the same smaller font as on mobile. (Quick 260628-r5v)

- **Mobile `/analysis` board redesign** — on phones the analysis page now takes over the screen like a dedicated board app: a back button replaces the logo in the header, the bottom nav is replaced by the board controls (reset / back / forward / flip), the two Stockfish engine lines move above the board, and the move list and eval chart share a two-tab view (Moves shown by default) that fills the whole space between the board and the controls. The move list is now a tall scrollable list instead of a single horizontal strip. Desktop is unchanged. (Quick 260628-cjp)

- **Tactic Explorer now opens on the `/analysis` board** — clicking "Explore" on a tagged flaw (Flaws tab) or on a Library game card no longer opens a separate modal/drawer. It now opens the full `/analysis` board in tactic mode: it steps through the engine's principal variation with always-on arrows and an oriented eval bar, and unlike the old modal it lets you branch off into free live-engine analysis from any point in the line. Library game cards also gain an "Analyze position" button that opens the scrubbed position directly on `/analysis`. Explore and Analyze are now real links, so middle-click or ctrl-click opens them in a new tab. The standalone Tactic Line Explorer modal and its hook are retired. (Phase 139)

- **Analysis eval bar polish** — the eval readout now sits inside the bottom of the eval bar (color inverted to match the fill) instead of as separate text beside it, and engine-line evaluations are rounded to one decimal. The board arrow on a stored line shows the next ply of the principal variation with its depth, rather than the move just played. (Phase 139)

- **Tactic tags hidden on already-lost positions** — a tactic motif found or missed in a position that was already decisively lost (the engine had you down by more than a rook, or facing forced mate, *before* the move) no longer shows its tag, depth number, or eval-chart tooltip entry, and is excluded from the tactic-motif and depth filters on the Flaws and Games tabs. These flaws were noise: a "missed fork" teaches nothing when the game was already gone. The blunder/mistake itself still counts in the severity badges and still appears as a marker on the eval chart; only the tactic tagging is suppressed. The tactic explorer keeps full detail. (Quick 260626-bdt)

### Fixed

- **Installed PWA no longer serves a stale layout after a deploy** — the app shell is now fetched fresh from the network whenever you're online (it was previously served from the service worker's cache, which could be many deploys old, e.g. missing the Library nav button until a manual reload). Update checks also now run when you reopen or refocus the installed app, not just on a slow timer, so a backgrounded phone PWA picks up the latest version on resume. (Quick 260629-pq8)

## [v1.28] Tactic Tagging — 2026-06-25

### Added

- **Tactic Line Explorer** — clicking "Explore" on a tagged flaw (one with a missed or allowed tactic motif) opens a walkable board that steps through the engine's principal variation. Both the move you should have played (missed tactic, blue arrows) and the opponent's refutation (allowed tactic, colored arrows) can be walked move by move from the decision position. A depth readout shows your distance from the punchline move. On desktop the explorer opens as a dialog; on mobile as a right-side drawer (with a close button) that places the board and move list side by side. On the Flaws tab each card now has Explore and Game buttons (instead of a header link); on the Games tab the Game modal gains an Explore button below the eval chart, enabled when the slider is parked on a tagged flaw. (Phase 135)

- **Promotion tactic chip now ships** — the `promotion` motif (the winning line queens a pawn) was already detected at 1.000 precision but was the last motif still hidden from the UI, so its tactic depth showed on the miniboard with no chip or tooltip to explain it. Promotion now appears like its sibling under-promotion: as a filter under the Library's "Advanced" tags group (Games and Flaws subtabs, desktop and mobile), as a chip on game and flaw cards, in the eval-chart tooltip, and in the you-vs-opponent comparison. The "allowed" orientation ("you let the opponent queen") is an instructive endgame mistake. The miniboard depth badge now also only shows when its motif has a chip, so no orphaned depth numbers remain.

- **En-passant and under-promotion tactic chips now ship** — both motifs were already detected but suppressed from chip surfacing on the (since-superseded) assumption that they never fire. On the expanded fixture they fire at 1.000 precision, so they now appear as filters under the Library's collapsed "Advanced" tags group (Games and Flaws subtabs, desktop and mobile) and as chips on game and flaw cards, alongside the other tactic motifs. Both fire only as a last resort (when no stronger tactic applies), so they are deliberately low-volume. (Quick 260623)

- **Trapped-piece tactic chip now ships** — the trapped-piece detector was rewritten to a cook-faithful capture-chain-anchored predicate (a piece is trapped only when it appears in an actual capture sequence and every legal escape loses material). TEST precision reached 1.000 with zero false positives, crossing the ship bar with no overfitting. Trapped-piece joins fork, pin, skewer, and the other geometric motifs as a surfaced tactic chip and Library filter. (Phase 134)

- **Advanced tactic motifs surfaced across the Library** — the shipped tier-3 tactics (deflection, intermezzo, interference, clearance, capturing-defender) plus x-ray now appear under a new collapsed-by-default "Advanced" group in the Library tags filter (Games and Flaws subtabs, desktop and mobile), with a selected-count badge and a Tags-icon legend explaining each motif. These motifs now behave like every other tactic tag: they show as chips on game and flaw cards, cycle through their datapoints in the eval chart on click, appear in the eval-chart datapoint tooltip, and are explained in the tags info popover. The you-vs-opponent "Tactic Motifs" comparison section expands to cover them too. Beta-gated on the cards/chart, like the other tactic chips. (Quick 260623-6pd)

- **Tactic filters on the Library Games tab** — the Games tab's Tags panel now offers the same tactic-motif filters as the Flaws tab: pick one or more tactic families (fork, pin, skewer, …) to show only games containing at least one flaw with a selected tactic, plus the Missed/Allowed orientation toggle and the tactic-difficulty depth range. Tactic families combine with the existing severity and context-tag filters (a game must satisfy all). Full mobile-drawer parity. (Quick 260620-pza)

- **Missed and allowed tactic chips on Library game cards** — game cards now surface both tactic orientations as separate chips: the tactic you *allowed* (the opponent's refutation) and the tactic you *missed* (the stronger move you should have played) render as distinct chips, e.g. "allowed: fork" and "missed: fork". Previously only the allowed tactic was shown. Beta-gated. (Quick 260620-pza)

- **Tactic motif comparison in the Library (beta)** — flaw cards now show the tactic that caused each mistake or blunder as a family-colored chip with a plain-English definition popover. The filter panel gains a "Tactic motif" section to narrow flaws by family (fork, pin/skewer, discovery, mate, hanging, combinations), and a new "Tactic Motifs" comparison section shows how often you allow each motif versus your opponents per game, ranked by significance and gated on a minimum number of analyzed games. Beta-gated, with full mobile parity at narrow widths. Backed by a new `GET /api/library/tactic-comparison` endpoint that honors all game filters. (Phase 126)

- **Engine best-move arrow on Library miniboards** — when a game has engine analysis, the Library Game-card and Flaw-card miniboards now show the engine's best move as a translucent blue arrow. On the Game card it updates as you scrub the eval chart (the suggested move from whatever position you're viewing); on the Flaw card it sits next to the red move-played arrow, showing what should have been played at the decision point. Hidden for games with only imported Lichess evals (no stored best move). (260618-oqw)

- **Tactic depth shown on Library miniboards** — the Library Game-card and Flaw-card miniboards now label the tactic depth (1 to 12) right where it happens: the *missed* tactic's depth sits on the blue best-move arrow's target square, and the *allowed* tactic's depth sits at the end of the orange/red move-played arrow. Each badge only appears when that tactic is detected. (Phase 130, Quick 260621-mq4)

- **Tactic cause-of-error tagging (foundation)** — mistakes and blunders are now tagged with the tactical motif that caused them (fork, pin, skewer, discovered attack, back-rank and named mates, plus tier-3 motifs like deflection and x-ray), detected from the engine refutation line already stored at analysis time, so there is no extra analysis cost. Tags are computed for both players and stored precision-first (low-confidence motifs are suppressed rather than mis-tagged). This is internal groundwork; the tags are not surfaced in the UI yet. (Phase 124)

- **Tactic tags applied to existing analyzed games** — backfilled the tactic motif on all already-analyzed games, and wired the live evaluation drain to tag motifs as games are analyzed going forward (previously the drain stored the refutation line but left the tag empty until a manual backfill). Coverage is precision-first: a tag is empty only when there genuinely is no refutation line or no motif fires, never because a game was skipped. (Phase 125, 260618-aiq)

- **`backfill_full_evals.py` script** — operator tool to queue full-game analysis for a single user's not-yet-analyzed games at top priority. It enlists every game still missing full evals as a tier-1 eval job; the running drain worker then evaluates each game and tags flaws, tactic motifs, and blunder/mistake/inaccuracy counts automatically. Idempotent and safe to re-run; supports dev/benchmark/prod targets with `--dry-run` and `--limit`.

- **Missed-vs-allowed tactic tagging (foundation)** — a flawed move can now carry two tactic motifs: the one the player *allowed* (the opponent's refutation) and the one they *missed* (the stronger tactic they should have played instead). Both are tagged from engine lines already stored at analysis time, so there is no extra analysis cost, and a flaw may have neither, one, or both filled depending on line availability. The Library's flaw filter and comparison endpoint can now select either orientation (defaulting to "allowed"), with both surfaced on the flaw schemas; the UI toggle to read missed vs allowed lands in a follow-up phase. (Phase 128, SEED-054)

- **Discovered-check and trapped-piece tactic motifs** — two new Tier-2 tactic motifs are now detected from refutation lines. `discovered-check` (int 25) fires when the checking piece is not the one that moved, splitting the previously merged "discovered attack" detection into two distinct tags. `trapped-piece` (int 26) fires when an opponent piece is under attack and every legal escape lands on a square where pov wins material (D-06 strict gate), distinguishing it from a plain hanging piece. Both outrank Tier-3 and Tier-4 motifs in the dispatcher, and discovered-check ranks above discovered-attack. (Phase 128.1)

- **En-passant, promotion, and under-promotion tactic motifs** — three move-type motifs (ints 27-29) are now detected and stored for lichess-theme parity. They form a new lowest dispatch tier (Tier 5) below hanging-piece, so a real tactic always wins when both fire. Under-promotion dominates promotion: a non-queen promotion tags as `under-promotion` and never as `promotion`. These are stored for coverage and future chip-surfacing; they do not appear in the default motif chip set. (Phase 128.1)

- **Tactic difficulty and missed-vs-allowed filters in the Library** — the Flaws filter panel gains a "Tactic Difficulty" slider (1 to 5 moves deep, defaulting to intermediate) so you can focus on tactics of a given depth, plus an Either / Missed / Allowed toggle to read whether you want the tactic you *allowed* (the opponent's refutation) or the stronger one you *missed*. Flaw cards reflect the chosen orientation, and the "Tactic Motifs" comparison section now shows two rows per family (missed and allowed). Both controls have full mobile-drawer parity. This surfaces the missed-vs-allowed UI toggle that Phase 128 set up. (Phase 129)

### Fixed

- **Library severity filter now narrows tactic chips on game cards** — with "Blunders only" (or "Mistakes only") active in the Games tab Tags panel, game cards still showed tactic chips coming from flaws of the *other* severity. Severity was applied only when selecting which games appear, never to the per-card tactic badges. Tactic chips on the card (and in the "View game" modal) are now gated by the active severity tier, matching how the family/orientation/depth filters and the Flaws tab already behave.

- **Eval-queue background polling no longer scans the whole games table** — the remote analysis workers poll for work roughly once a second, and the tier-3 residual-fallback pick had no matching index, so every poll ran a full sequential scan over all games (~300 ms, churning ~1.8 GB through the database cache each second, usually to find nothing). Added a partial index (`ix_games_pv_backfill_pending`) so the lookup becomes a near-instant index scan. Cuts the single largest source of database load and should noticeably improve cache efficiency for all queries.

- **Google sign-in no longer orphans a guest account** — signing in with Google from the Login tab (or as a logged-in guest) used to create a brand-new account and silently abandon the guest session, losing its already-imported games. Guest sign-in now upgrades the existing guest account in place from any Google entry point: both Google buttons share one guest-aware code path, and the backend `/auth/google/authorize` endpoint promotes any guest whose session reaches it, so the games imported as a guest carry over to the registered account. (Quick 260623-o4f)

- **Google sign-in no longer locks out returning users with a leftover guest session** — the guest-promotion fix above routed the Google button through in-place promotion whenever a `guest_token` was present in storage. Because that token is deliberately kept across logout (so "Use as Guest" can resume), a returning *registered* user who had ever used guest mode (common on the mobile PWA) was pushed into promotion, collided with their own account, and got bounced back to the login screen on every attempt. Promotion is now driven by an explicit one-shot intent set only when a guest chooses "save my data", so returning users always sign straight into their existing account.

- **Tactic tag precision raised across the board (cook-faithful detector pass)** — audited every tactic motif against the reference lichess-puzzler predicates and closed real gaps in seven detectors: pin (0.90→1.00), capturing-defender (0.88→1.00), hanging-piece (0.74→1.00), intermezzo (0.82→1.00, recall 0.03→0.61), interference (0.97→1.00, recall 0.43→0.59), deflection (0.96→1.00, recall 0.14→0.32), and clearance (0.96→1.00, recall 0.39→0.44). Every shipped tactic tag is now at or above 0.95 precision on held-out puzzles (the lone exception, discovered-check at 0.93, is a labelling artifact in the source dataset, not a detector error), so the chips you see are far less likely to be mislabeled — and several detectors now also *catch more* real tactics. The tagger's offline validation now also runs the detector exactly the way live analysis does (with the flaw move in context), so the measured precision reflects real behavior.

### Changed

- **Homepage hero is now "Game and Tactic Analysis"** — the landing page leads with free Stockfish analysis of your entire chess.com and lichess history and the tactic tagging of every blunder and mistake (fork, pin, skewer, and more). The previous hero (Opening Explorer & Insights) and the other features each move down one slot, and the page title / meta description / PWA description were refreshed to match. (Quick 260625-tbg)

- **Tactic tagging is now available to all users** — the tactic-motif feature (cards chips, eval-chart tooltips and depth badges, the Library tactic filters, and the you-vs-opponent "Tactic Motifs" comparison) is no longer beta-gated. Every analyzed game now shows the three-column Missed / Allowed / Context card layout and the full tactic filter set, regardless of beta access. (Quick 260623-tsu)

- **More tactic chips surface, with no loss of accuracy** — the promotion, en-passant, under-promotion, and discovered-check detectors now scan the whole refutation line instead of only its first move, so these tactics are recognized wherever they occur in the solution (matching how lichess labels them). Recall roughly tripled for promotion and quadrupled for en-passant, doubled for discovered-check, while precision held at or near 100%. The three move-type chips also became a strict last-resort fallback: a fork, skewer, or other genuine tactic now always wins the chip over a bare "promotion"/"en-passant" label, which incidentally recovered a few real-tactic tags that were previously mislabeled. (Quick 260623-r7a)

- **Redesigned Library Game and Flaw cards on desktop** — both cards now use a board-left / stacked-right layout with a full-width metadata strip (including the game date) above the board, a larger miniboard, and a more compact eval chart, so the Flaw card visually matches the Game card. Miniboard tactic-depth numbers are now colored by orientation (missed vs allowed), and the tactic column layout stays a stable three columns under active filters. (Phase 130)

- **Tactic Depth filter (renamed) with a depth range** — the Library Flaws filter's tactic control is now labeled "Tactic Depth" (was "Tactic Difficulty") and is a two-handle range slider measured in plies, numbered 1 to 12 (where 1 is an immediate tactic) instead of a single "1 to 5 moves deep" cap. Pick any depth window: Low 1–2, Medium 1–6, High the full range, or drag for a custom range. Forced mates now respect the range like every other tactic rather than always showing. (Phase 130, Quick 260621-mq4, 260621-qz9)

- **Allowed-tactic depth is now decision-anchored, and depth presets renamed Low/Medium/High** — the depth shown for a tactic you *allowed* (the opponent's refutation) now counts from the same decision point as a tactic you *missed*, so the two are directly comparable: an allowed tactic reads one deeper than a missed tactic at the same engine depth, because the opponent must first make a move before the punishment lands. This affects both the miniboard depth badges and the depth filter. The presets are relabeled Beginner/Intermediate/Advanced → Low/Medium/High (default Medium), since depth is only a rough difficulty proxy. (Phase 130, Quick 260621-qz9)

- **Tactic families regrouped into a clearer 10-family taxonomy** — the tactic motif filter and comparison now group motifs into fork, skewer, pin, x-ray, double check, discovered check, discovered attack, trapped piece, hanging, and mate, replacing the previous coarser grouping. Families beyond the top six fold into a "More Tactics" accordion. The catch-all "combinations" group was dropped; old `?tactic=` URLs referencing retired family names are inert rather than erroring. (Phase 129)

- **Flaw stats faster and more accurate on large game libraries** — the analyzed-game gate now uses the pre-materialized `full_evals_completed_at` column instead of recomputing eval coverage across all positions on every request. This eliminates a full-partition scan that caused 135s average / 49-minute max latency under an eval drain on large accounts. Fully-analyzed short games are now correctly counted as analyzed. (260617-pu4)

### Fixed

- **Eliminated trapped-piece false-positive source** — the previous full-board-scan detector produced 153 false positives for every true positive on the expanded fixture (precision near zero). The new capture-chain-anchored predicate tags trapped-piece only when a capture is present in the engine refutation sequence, bringing false positives to zero. (Phase 134)

- **Five more tactic chips now ship: attraction, sacrifice, and the Arabian/Boden/Dovetail mates** — attraction was held back by a one-line off-by-one in its detector that stopped its cook AND-chain from ever firing; fixing it lifts attraction to 1.000 TEST precision. Sacrifice (a greek-gift-style queen/piece offer) is now surfaced on its own rather than suppressed. The three named mating-net motifs (Arabian, Boden, Dovetail) had their geometry ported from cook.py so they fire correctly instead of never firing or only producing false positives. All five clear the 0.90 ship bar and now appear as tactic chips and filters like the other motifs. (Phase 133, SEED-057)

- **Far more accurate tactic chips** — the tactic-motif detector was reimplemented to faithfully follow lichess-puzzler's `cook.py` geometry, dispatch was inverted to "shallowest tactic wins", and a missed-vs-played dest-square gate was added at the call site. Per-motif precision on the held-out puzzle TEST split is now near-perfect for the shipped geometric and mate motifs (fork 0.998, skewer/discovered-attack/back-rank/anastasia/hook ~1.000). Pin tagging in particular was overhauled: restricting the pin scan to the positions that follow your own move (matching cook.py) lifted pin precision from ~0.47 to 0.944 on the TEST split, so pins are now tagged reliably instead of being littered with false positives. A dev re-backfill rewrote tactic tags across already-analyzed games so existing cards and filters show only genuine tactics. (Phase 131, SEED-057)

- **Deflection and clearance tactic chips now ship** — both detectors were rewritten to exact AND-chains matching cook.py's geometry (11 conditions for deflection, 9 for clearance) instead of the previous graded voting scheme. TEST precision jumped from 0.21/0.37 to 1.000/0.952, crossing the 0.90 ship bar for both. Deflection identifies when the opponent's piece was forced away from defending a target; clearance finds when a ray piece clears a line by sacrificing to a poor square. (Phase 132)

- **Capturing-defender and intermezzo tactic chips now ship** — both detectors were rewritten to cook.py's strict relational AND-chains. Capturing-defender (9 conditions) uses an init-board defender test (`boards[k-2]`) to confirm the captured piece was guarding from its starting square. Intermezzo (7 conditions, zwischenzug signature) confirms the opponent interposed between two trades. TEST precision reached 0.903 / 1.000 (both above the 0.90 bar), up from 0.25 / 0.17 with the old voting scheme. (Phase 132)

- **X-ray tactic chip now ships** — the x-ray detector was rewritten to cook.py's three-same-square AND-chain (all three of `moves[k-2].to == moves[k-1].to == moves[k].to` must hold, plus between-square geometry and non-king recapturer). TEST precision jumped from 0.000 to 1.000, crossing the 0.90 ship bar cleanly. Attraction and sacrifice remain suppressed: attraction requires a 4-move lure sequence that rarely survives the PV depth limit (0 TP in corpus), and sacrifice is a co-tag that loses single-winner dispatch to geometrically simpler tactics at shallower depth. (Phase 132)

- **Opening-move tactics now tag on engine-analyzed games** — a mistake or blunder in the opening (first ~20 half-moves) of a non-Lichess game could be detected but left untagged, because the position right after it reused a cached eval that carries no refutation line. Those flaws are now given a refutation line via a small targeted re-analysis, so their tactic motif tags reliably. A one-time backfill (2026-06-18) repaired existing games; this closes the live gap so it no longer re-accumulates. (SEED-056)

- **Tactic tags now stick when analyzing Lichess games** — clicking Analyze (or letting the background drain reach them) on Lichess games imported with Lichess's own analysis left every flaw untagged: the tactic motif was detected correctly but then silently discarded, so the cards and filters showed no tactics. The full-analysis pass now fully replaces the placeholder flaw rows written at import (which carry no tactics because they have no engine lines yet) instead of refusing to overwrite them. Re-analyzing an affected game now tags its tactics; a `backfill_flaws.py` run repairs already-analyzed games. (Phase 130)

- **Tactic-chip and eval-tooltip polish on the Library cards** — selecting a tactic family as a filter now highlights the matching tactic chips on the Games and Flaws cards with the same active-filter ring the context-tag chips already use. The eval-chart flaw tooltip now lists tactic motifs with their missed/allowed prefix (matching the chips) instead of showing only the allowed motif. And opening a game from a Flaw card now shows the flaw tooltip immediately, not just parks the slider on the flaw ply. (Quick 260620-qyh)

- **More accurate pin tactic tags** — fixed a parity bug in the pin relevance gate that left it unable to confirm pov's exploiting capture for the common case, and reordered the gate so incidental pins are pruned before the capture check accepts them. Pin tag precision on the CC0 puzzle fixture rose from 0.413 to 0.440 (false positives 478 → 428) with recall unchanged. Also put the pin's stored difficulty depth on the same move-index scale as every other motif (it was a board index, off by one). (SEED-057, 260619-phr)

- **"Better move" arrow now shows on Lichess-analyzed games** — the blue arrow that points out the move you should have played instead of a blunder was silently missing on games imported with Lichess's own analysis. The engine now also evaluates the position you moved from (not just the position after), so the better alternative is captured and the arrow renders. A one-time backfill fills this in for already-analyzed Lichess games. (SEED-054, 260618-rmk)

- **Opening a game from a Flaw card lands on the flawed move** — the eval-chart slider now opens parked on the flaw's ply, so the board and crosshair start on the flawed move instead of resting at the end of the game. Replaces the previous marker "pulse" attention cue, which had broken.

## [v1.27] Remote Eval Worker Fan-Out & In-App Feedback — 2026-06-16

Scaled off-box eval compute beyond the idle backlog and added a low-friction feedback channel. Trusted remote workers can now claim explicit single-game "Analyze" jobs (server-busy overflow) and fan out import-time (entry-ply) evaluation on big first imports, so a brand-new user sees flaws and endgame stats sooner. A floating in-app feedback button (guests included) ties submissions to the page the user was on and pings the team via Sentry. Bundles the post-v1.26 stabilization work (guest welcome page, analyze-pill UX, import-counter/WAL ops fixes). Phases 121–123.

### Added

- **Faster import-time eval on large imports** — trusted off-box workers can now help drain the import-time (entry-ply) evaluation backlog in parallel batches (up to 50 games per lease), so endgame and time-management stats become available sooner after importing a large game history. Falls back to the in-process server pool near the tail of an import. (Phase 123, SEED-051)

- **In-app feedback button** — a floating "Send feedback" button appears on every authenticated page (bottom-right, mini/secondary weight, 44px touch target). It hides when scrolling down or when any drawer/modal is open, and respects iOS safe-area in installed PWA mode. Clicking it opens a modal with a required freeform text field and an optional 3-point sentiment control (Negative/Suggestion/Positive, toggle-off). Submissions are stored in the database and also push a Sentry signal tagged with ELO bucket and platform for team visibility. (Phase 122, SEED-049)

- **Guest welcome page** — first-time guests now see a short Welcome page before importing that honestly lays out what works without an account (opening explorer and statistics, endgame and time-management analytics, importing Lichess full-game analyses) versus what signing up unlocks (FlawChess's own deep Stockfish blunder/mistake/inaccuracy detection, cross-device access, and data durability). A "Don't show this again" option skips it on future visits, and the Import page keeps a short "Sign up free" prompt for guests. (SEED-047)

- **Tighter analyze feedback: Pending / Analyzing pill** — clicking "Analyze" on a game card now shows a pulsing "Pending…" pill immediately (no wait for a server response). Once a worker leases the job the pill transitions to "Analyzing…". A failed or rejected enqueue rolls back to the "Analyze" button. (260615-q1x)

### Changed

- **Large imports no longer stutter** — tuned PostgreSQL WAL/checkpoint settings (`max_wal_size=8GB`, `wal_compression=on`) so a big dual-platform import no longer triggers a checkpoint I/O storm that periodically paused import progress. (ops)

- **Guests can analyze individual games on demand** — the per-game "Analyze" button is now available to guest users for their own games (tier-1 explicit enqueue). Automatic full-library background analysis remains a signup benefit. (260616-ey1)

- **Eval-chart tooltip is more readable** — the floating tooltip on game eval charts is now less transparent so it stays legible over the eval bar.

### Fixed

- **Faster flaw classification during eval drain** — the entry-ply eval submit/drain path now loads all positions for a batch of games in a single query instead of one query per game, removing an N+1 that Sentry flagged on `/api/eval/remote/entry-submit`. Reduces database round-trips during import-time analysis. (FLAWCHESS-6G)
- **Import counters no longer look stuck during a large import** — the per-platform "N games" header now tracks live import progress in lockstep with the "X fetched, Y saved" line instead of lagging on a slower refresh, and the "Quick Scan" analysis banner refreshes more promptly. Previously the slower counters could appear frozen next to the fast saved count until a page reload. (260616-rm6)
- **Re-imported Lichess games keep their analysis provenance** — Lichess games that arrive with Lichess's own computer analysis are now tagged as such at import time, so they are no longer needlessly re-queued for FlawChess's Stockfish analysis after a re-import. Previously this provenance was only set by a one-time migration, so deleting and re-importing a library could send thousands of already-analyzed Lichess games back through the engine, wasting capacity. (260616-pjh)
- **Guest "Sign up to analyze all games" button now reaches the sign-up page** — clicking it previously bounced guests straight back to the Library, because a guest's session token made the login page treat them as already signed in. The button now drops the guest session first (preserving imported games and bookmarks for promotion) before opening the registration page. (260616-ey1)
- **Eval chart no longer crashes the Library on touch devices** — scrubbing a game's eval chart on some Android / hybrid-pointer devices could throw "Maximum update depth exceeded" and blank the page. The chart slider no longer ties its value to the hover position (a sticky hover could pin it into an update loop), and touch devices are now detected more reliably so the chart's hover scrub stays off on touch. (FLAWCHESS-5F, FLAWCHESS-5Y)
- **Cycling through a tag's flaws can now be dismissed** — after clicking/tapping a flaw tag or severity badge to step through its markers, clicking or tapping anywhere outside the eval chart and flaw chips now clears the highlight and undims the other markers (previously they stayed dimmed with no way to reset).
- **Short fully-analyzed games now count as analyzed** — short games that had actually been fully analyzed were incorrectly still showing the "Analyze" pill and had empty move-quality (blunder/mistake/inaccuracy) columns. The eval-coverage check was counting the final, unevaluable position against the game, so the shortest games fell just under the threshold; they now pass. (260615-rb1)
- **Analysis progress badge can now reach "X of X"** — games that can never be analyzed (those with no moves, e.g. resigned or abandoned before move 1, and games too short for engine coverage) are no longer counted in the badge's total, so the "N of M games analyzed" indicator now finishes at M of M instead of stalling one or more short of the total. (260615-wjz)

## [v1.26] Full-Game Eval Pipeline — 2026-06-14

Turned eval coverage from "endgame-entry plies only" into a **full-game background analysis pipeline**: every move of your imported games is now evaluated by Stockfish at lichess-comparable strength (1M nodes per move), drained by a tiered priority queue that puts your explicit "Analyze" requests first and an idle backlog last, with the results flowing automatically into the Library's flaw surfaces. Includes an on-demand analyze affordance with live coverage badges, a post-move eval-convention fix that corrected flaw stats for chess.com games, honest hole-aware coverage tracking, and an optional off-box headless eval worker for extra compute. Phases 116–120 (incl. inserted 117.1 / 117.2).

### Added

- **Full-game engine analysis (background)** — a new background analyzer evaluates every move of your imported games with Stockfish at lichess-comparable strength (1M nodes per move), beyond the endgame-entry evaluations added in earlier releases. It runs only when no import or endgame-eval work is pending, reuses evaluations for shared opening positions across games, and never overwrites lichess's own analysis. Newest games are analyzed first. (Phase 116)
- **Game Phase flaw filter** — the Library Flaws/Games tag filter now has a Game Phase family (Opening / Middlegame / Endgame, teal) so you can narrow to flaws in a specific phase, combined with the other tag families. Eval-chart markers are outlined to match an active phase filter, and the Flaws subtab now shows each flaw's phase tag in its tag list.
- **Click a tag or severity badge to step through its flaws** — clicking (or tapping) a tag chip or a Blunders/Mistakes/Inaccuracy badge on a game card scrubs the eval chart through those flaws one at a time, parking the slider on each and showing its tooltip; click again to advance. Hovering still highlights all matching markers at once.
- **Analyze a single game on demand** — Library game cards (Games and Flaws subtabs) now show an "Analyze" button on games without engine analysis. Clicking it queues that game for full-game analysis with a localized "Analyzing…" indicator on just that card, which flips to the analyzed view automatically once it finishes, no page refresh. (Phase 118)
- **Analysis coverage at a glance** — the Library Games and Flaws subtabs show an "N of M analyzed" badge (with "· K in progress" while analysis is running) plus an "Analyze more" affordance when coverage is low, so you can see how much of your library has full-game analysis and top it up. (Phase 118)
- **Guest prompt for full-game analysis** — guests now see a "Sign up to unlock full-game analysis" prompt in every analyze slot (badge and per-game button) instead of a silent no-op. (Phase 118)

### Changed

- **Analysis coverage badge pulses while incomplete** — the "N of M analyzed" CPU icon now pulses while analysis is still running (matching the Stockfish progress header and opening-card placeholder), and is static once all games are analyzed. The "K in progress" text indicator and its associated in-flight job count are removed; the pulsing icon is an honest coverage signal for all analysis tiers. (Phase 119)
- **Blunders/Mistakes filter now narrows like the other families** — the Blunders and Mistakes toggles in the Flaws tag filter start inactive (both shown). Activating just one narrows to that severity; activating both is the same as activating neither. Previously both rendered active by default.
- **Eval-chart tooltip polish** — the tooltip lists a flaw's tags with their family-colored icons instead of plain bullets, and shows clock info as "🕐 mm:ss · Move Ns". The Flaws card clock line uses the same format.
- **Smaller top gap on the mobile Stats subtab** — the mobile Library Stats subtab now matches the Games subtab's spacing above the sticky Filters button.
- **`EVAL_AUTO_DRAIN_ENABLED` config flag** — env toggle gating *automatic* background full-eval work (the tier-3 idle-backlog drain). Explicit on-demand single-game analysis is unaffected. Defaults to off so a local dev/CI backend doesn't pin every core on the eval backlog; prod opts in via its compose config. (Phase 117, 118)

### Fixed

- **Analysis coverage badge now advances for returning users** — the background analyzer previously spent ~70% of its capacity re-evaluating lichess-analyzed games (which already had evaluations), so the "N of M analyzed" badge appeared frozen despite engine activity. The drain now skips lichess games entirely and focuses on games that genuinely need analysis; returning users get priority via a recency-weighted lottery so their badge moves briskly after they log back in. (Phase 119, SEED-046)
- **Bookmark WDL stats respect the recency filter** — the WDL bar, game count, and Score % on the Openings Stats bookmark card now reflect only in-window games when a recency or date filter is active (they previously showed frozen full-history numbers). A zero-match window shows "No matching games" and "—" instead. The rolling time-series chart line is filtered to the window while still being warmed up from pre-window games. (quick task 260613-bst)
- **Engine worker recovery after a crash** — when a Stockfish worker process died, the automatic restart could abort and leave that worker slot permanently broken until the next backend restart. The restart path now handles the dead process cleanly. (Phase 116, FLAWCHESS-59)
- **Full-game analysis no longer marks games complete with eval gaps** — the drain now withholds the "fully analyzed" marker while non-terminal, non-mate engine holes remain, retrying up to 3 times; after 3 attempts it stamps anyway (prevents infinite retry on unevaluable positions). Pool outages do not consume retry budget. A backfill sweep (`resweep_holed_games`) re-arms previously-stamped holed games. (Phase 119, SEED-045)
- **Checkmate-ending games no longer count as having an eval gap** — the move that ends a game (checkmate, stalemate, or insufficient material) leaves no position to evaluate after it, so its empty evaluation is expected, not a gap. The analyzer previously treated it as a hole and burned its retry budget before stamping the game complete-with-gaps; it now recognizes the game-ending move and stamps these games complete on the first pass, matching how lichess-analyzed games already behave. The retry mechanism is now reserved for genuinely transient gaps. (quick task 260614-tgs, SEED-049)
- **Refutation lines now captured for lichess-analyzed games** — the full-game analyzer skips re-evaluating positions lichess already scored, but that also skipped capturing the best-play line after each mistake/blunder (lichess provides the evaluation, not the line), so analyzed lichess games were getting no refutation line at all. The analyzer now evaluates exactly the positions right after each flaw to capture the line, without overwriting lichess's own evaluations. (Phase 117, D-117-13)
- **Correct flaw stats for chess.com games** — the full-game analyzer stored each move's evaluation one ply early (the position *before* the move instead of *after* it), so the flaw detector was off by one for every chess.com game: real blunders went unflagged or were attributed to the wrong move. Flaw counts, the eval chart, and the opponent comparison were affected for chess.com games (lichess-analyzed games were already correct). The analyzer now stores evaluations after the move, consistently with lichess, and the affected games are re-analyzed automatically in the background. (Phase 117.1, SEED-044)
- **Games no longer show as "analyzed" with no flaws** — some chess.com games carried evaluations from an older eval-only pass (every move scored, but with no best-play lines or flaw detection), and the Library counted them as fully analyzed, so they appeared analyzed-with-no-flaws. These games are now reset and re-queued, so they correctly show as not-yet-analyzed and then fill in with proper flaws as the background analyzer reaches them. (Phase 117.2, SEED-044)

## [v1.25] Flaw-Stats Opponent Comparison — 2026-06-12

Reworked the Library flaw-stats surface from a self-only descriptive panel into an actionable **you-vs-opponent comparison**. Flaw rates only reveal a *specific* recurring weakness when contrasted against ELO-matched peers, so the panel now compares you against your actual opponents: both sides' flaws are materialized into `game_flaws`, a benchmark §5 chapter computes per-cohort "typical" delta zones, and a new endpoint feeds a uniform 15-bullet grid (your rate minus your opponents', with a confidence interval and a benchmark zone). Phases 113–115 (incl. an inserted `move_count`→exact `ply_count` swap).

### Added

- **Flaws Timeline chart** — the Library Stats panel's trend chart is rebuilt in the Endgame ELO Timeline style: three severity lines (blunders, mistakes, inaccuracies) as flaws per 100 moves over a trailing 100-game rolling window, bucketed by week, with per-week volume bars, inactivity markers, span-aware date ticks, and a toggleable legend. Rates are sourced from the per-game lichess move-quality counts.
- **Opponent-flaw materialization foundation** (Phase 113 Plan 01) — `classify_game_flaws` now records mistakes/blunders for both the player and their opponent (previously player-only). The player/opponent split is derived at query time via `is_opponent_expr(ply, user_color)` — a single tested helper in `query_utils.py` that encodes the ply-parity convention and closes a documented off-by-one trap. Per-mover `subject_result` fixes the `lucky` end-of-game tag for opponent flaws. Foundation for phase-115 flaw-comparison UI.
- **You-vs-opponent flaw comparison backend** (Phase 115 Plan 01) — new `GET /api/library/flaw-comparison` endpoint returning 15 per-metric bullets (severity / tempo / phase / opportunity / impact / combos) with mean per-game delta (you minus opponent, per-100-moves) and a 95% Wald-z CI per bullet. Zone bounds (`zone_lo`/`zone_hi`/`domain`) from the §5 benchmark Q1/Q3 are embedded in the response — no frontend constants required. Below 20 analyzed games the endpoint returns an empty bullet list with `below_gate=True`; zero-event bullets (no events on either side) return `delta=null` rather than 0.0 so absence-of-events is visually distinct from exactly-typical performance. Each bullet now also carries your and your opponent's per-100-move rate and a two-sided p-value.
- **You-vs-opponent flaw comparison UI** (Phase 115) — the Stats tab now opens with a "Flaw Statistics: Blunders & Mistakes" section, followed by "ELO Ratings" and "Results Breakdown". The flaw comparison is laid out as one card per family (Severity, Tempo, Phase, Opportunity, Impact, Combos), three to a row. Each metric shows its you-minus-opponent rate difference, tinted with its zone color only when the result is statistically significant, beside a magnifying-glass tooltip. The tooltip explains the metric, states how many more or fewer events you commit per 100 moves than equally-rated opponents (with both rates), and gives a confidence verdict and 95% confidence interval.

### Changed

- **Library flaw KPI cards now per-100-moves macro** — the blunder/mistake/inaccuracy "per 100 moves" cards now use a macro average (mean of per-game rates) instead of a pooled rate, so they match the you-vs-opponent comparison bullets and the §5 benchmark band. Inaccuracies per 100 moves are now populated (from the per-game lichess move-quality counts) instead of always showing 0; the inaccuracy card label is abbreviated.
- **Mate transitions now graded with the lichess mate ladder** — flaw severity for moves entering or leaving a forced-mate evaluation now follows lichess's own rules (losing a forced mate or stumbling into one is a blunder, downgraded when the position was already decided). Previously these moves were judged by win-probability drop, which missed most "threw away a forced mate" errors. Blunder/mistake counts on analyzed lichess games now match lichess's annotations almost exactly (~100% vs ~92% before).
- **Faster openings explorer & lighter imports** (SEED-041 items 1-8) — the openings explorer query now forces a hash join over the user's games instead of a per-game nested loop, cutting its main cost driver on large accounts; recent-games and pending-evals lookups gain matching indexes; `game_positions` now uses a single composite foreign key (halving per-row FK work during import and enforcing that a position's owner matches its game); and `game_positions` autovacuum + `games` heap density are tuned for cache residency. Schema and performance changes only — no behavior change.
- **Exact half-move counts** (Phase 114.1, SEED-041 item 9) — `games.move_count` (full-move count, accurate only to ±1 half-move) is replaced by an exact `games.ply_count`. This gives an exact per-game user-move denominator without scanning the 190M-row positions table, and lets the benchmark §5 flaw-delta rates drop an ~87M-row join. Game-card "N Moves" labels are unchanged. Internal/schema change, no user-facing behavior change.

## [v1.24] Library Page — 2026-06-09

The **Library** — a new top-level destination and SEED-036's analysis half: an eval-driven mistake/flaw archive over your analyzed games. Import and Overview fold in as subtabs; new Games and Flaws subtabs surface every blunder, mistake, and inaccuracy with per-game eval charts, family-colored flaw tags, a finalized tag taxonomy, and a cross-tab Flaw filter. Phases 104–112.

### Added

- **Library page** (Phase 104) — a new top-level **Library** destination in the main nav that hosts Import and Overview as deep-linkable subtabs (`/library/import`, `/library/overview`). Visiting the Library lands you on Import when you have no games yet and on Overview once you do.
- **Games subtab** (Phase 107) — the Library's headline surface: a filterable game-card archive with a Flaw-Stats panel above it. Each analyzed game card shows blunder/mistake/inaccuracy counts plus family-colored tag chips (miss, lucky, reversed, time pressure, hasty, …), with an explicit "no engine analysis" state for unanalyzed games. The Flaw-Stats panel summarizes per-severity rates (per game and per 100 moves), tag distribution (tempo split, phase histogram), trend over time, and the `% analyzed` denominator. Filters (platform, color, time control, rated, opponent, recency, plus a mistake-severity toggle) drive both the list and the panel together. The Games subtab is now the default landing for returning users with games.
- **Per-flaw platform deep-link** (Phase 108) — each flaw card on the Flaws subtab now shows the platform icon and an external link that opens the board at the exact half-move where the flaw occurred: lichess via the game viewer, chess.com via the analysis board. On lichess the board opens from your side (flipped when you played black).
- **Lichess game links open from your perspective** — "open on platform" links on the Openings and Library game cards now flip the lichess board to your side when you played black, matching the card's miniboard orientation. chess.com links are unchanged (no board-orientation URL parameter).
- **`game_flaws` backfill script** (Phase 108 Plan 06) — `scripts/backfill_flaws.py` recomputes the `game_flaws` materialization table for existing users' analyzed games. Supports `--db {dev,benchmark,prod}`, `--user-id`, `--dry-run`, and `--limit`; batched at 100 games per commit (OOM-safe). `scripts/reclassify_positions.py` now also recomputes `game_flaws` during position reclassification, completing the D-10 single-classify-path invariant across import hook, reclassify, and backfill.
- **Per-game eval chart** (Phase 109) — each analyzed game card on the Library Games subtab now shows an expected-score area chart (white-perspective, lichess sigmoid): light grey above the 50% midline when White is ahead, dark grey below. Dots mark your own flaws (red blunders, orange mistakes, yellow inaccuracies), and vertical lines mark the middlegame and endgame transitions. Hovering any ply shows the eval (pawns or mate), clock, and move time, and scrubs the card's miniboard to that position. The desktop card is restructured into three equal columns (board + info, chart, tags); on mobile the chart stacks full-width. Unanalyzed games keep the existing no-analysis state.

### Changed

- **Flaws subtab card rework** (Phase 112) — the Library Flaws subtab now shows each flaw as a card in a responsive 2-up grid (1 column on mobile, 2 columns on larger screens). Each card shows the miniboard at the pre-flaw position with the flawed-move arrow, the player names and ratings in a banded header, the move notation and user-perspective eval swing, a severity badge, family-colored tag chips, and game metadata. A "View game" button on each card opens a full-game modal with the eval chart and all analyzed positions. The old flat flaw row list is replaced.
- **Consistent game-info line next to miniboards** — the metadata beside the board on every game card (Library Games, Library Flaws, Openings Games) now follows one order: the time control ("Rapid 10+5") and move count ("# 42 Moves") on the first line, then the date, then the termination. The two parts of the first line wrap onto separate lines only when the card is too narrow. The Flaws cards gained the move count and termination (added to the flaws API payload) to match.
- The flaw filter (Blunders/Mistakes severity + tag families) now lives in its own **Flaw filters** panel with a dedicated button, separate from the game-metadata **Filters** panel, on both the Games and Flaws subtabs (Phase 108). On mobile, flaw-filter selections now apply when you close the panel (matching the game filters), fixing tag selections that previously did not reliably take effect on close.
- Import and Overview are no longer standalone nav items; they live inside the Library page. The old `/import`, `/overview`, `/rating`, and `/global-stats` links redirect into the matching Library subtab, and the "no games yet" notification dot now sits on the Library nav item (Phase 104).
- Endgame insights are no longer rate-limited; report caching already keeps the number of fresh AI calls low, so the old hourly limit only got in the way.
- **Flaw-tag taxonomy overhaul** (Phase 110) — the flaw tags shown on game and flaw cards are renamed and rebuilt for clarity. The tempo tags `impatient` and `considered` are now `hasty` and `unrushed`. The impact tags `while ahead` and `result-changing` are replaced by an outcome-independent swing ladder: `reversed` (a winning position that flipped to losing) and `squandered` (a clearly winning position thrown away to roughly equal), so a tag now reflects how far the position swung rather than the eventual game result. Tag chips show the tag's definition on hover or tap, with the exact thresholds, and no longer act as links into the Flaws subtab.
- Library Games cards (Phase 110): tag chips now show how often each tag occurred in the game and are a touch smaller; the inaccuracy badge spells out "Inaccuracies"; the Blunders/Mistakes count badges highlight when you filter to that severity (matching the tag chips); and hovering a tag chip or a Blunders/Mistakes badge highlights the matching flaw dots on that card's eval chart while dimming the rest.
- Library game cards now carry the same banded title-bar header (player names + platform link in a tinted bar above a divider) used by the Openings and Stats cards, for a consistent card look across the app. Card visuals are now driven by a single shared `Card`/`CardHeader`/`CardBody` primitive.
- **Filter panels now apply on demand** — every filter panel (Library Games, Library Tags, Openings, Endgames, Stats) has a Reset and an Apply button at the bottom. Filter changes no longer take effect as you make them; they apply only when you click Apply, which also closes the panel. Closing the panel any other way (the X, clicking outside, or the panel toggle) discards your unapplied changes. Reset clears the panel back to defaults without applying until you press Apply. This replaces the previous mix of live-apply on desktop and apply-on-close on mobile, and the "applies on closing" tip is gone. The Library "Flaw filters" panel is renamed **Tags**. The Openings and Endgames filter panels no longer show the "Played as" tri-state (Openings has a dedicated white/black piece button outside the panel, and endgame stats ignore color entirely); it remains in the Library and Stats panels.

### Fixed

- The Flaws subtab miniboard showed the position one ply too early (the board before the move *preceding* the flaw, rather than the decision point right before the flawed move). The flawed-move arrow still pointed at the right squares, so the mistake was subtle. The materialized flaw position is now stored at the correct ply (Phase 108).
- The severity filter on the Games and Flaws subtabs now selects exactly the chosen tiers (Phase 108). Selecting **Mistakes** only previously also showed blunders, because the filter used a "mistake or worse" threshold; it now uses set-membership, so Mistakes shows mistakes only and Blunders shows blunders only.
- Tag filters now apply on the **Games** subtab (Phase 108). Selecting tag families (time pressure, miss, result-changing, …) previously had no effect on the game list; the Games archive now shows only games containing at least one flaw matching the combined tag filter (same single-flaw, AND-across-families semantics as the Flaws subtab).
- Library eval chart: games ending in checkmate now run the eval bar all the way to the mating move (a flat 100% / 0% bar with a "Checkmate" tooltip) instead of breaking off early, since the engine never evaluates a mated position. Flaw dots at the very top or bottom of the chart no longer get clipped, the white-ahead / black-ahead fills now read as lighter grey vs dark grey, and the 50% midline and hover crosshair share the same grey as the phase lines.

## [v1.23] LLM Endgame-Insights Statistical-Reasoning Rework — 2026-06-03

Reworked the AI endgame report so it reasons over the same statistical signals the page shows. The model now references your peer-relative percentile rank (with cohort framing), narrates time pressure, and the recommendations were sharpened with chess-GM feedback. No new cards: this is a payload + prompt change.

### Added

- Phase 103: the endgame-insights Recommendations card now links to GM Noël Studer's Lichess endgame study (Basic to Advanced) as a fixed study resource.

### Changed

- Phase 102: the AI endgame report now reasons over your peer-relative percentile rank and narrates time pressure. It references the percentile the chip shows ("vs other ~{rating}-rated players") rather than global framing, and narrates Score Gap by Remaining Time, Clock Gap, and Net Flag Rate when the signal warrants it. Whether a metric is mentioned is still gated by its cohort zone (extreme percentiles alone don't trigger narration); the percentile only shapes how it's phrased. The "Data Analysis" overview may run longer when there are genuinely several distinct signals, and stays concise for sparse histories. Prompt vocabulary was audited against the on-page concepts accordion and tooltip hover-help so the report never contradicts them.
- Phase 103: refined the endgame-insights AI recommendations from chess-GM feedback. Time-trouble advice now points at decision speed ("make quicker decisions earlier", "play okay-looking moves faster") instead of opening repertoire; recommendations state what to work on without inventing the how (e.g. "Study the basic checkmates and pawn endgames", "Trade pieces when up material"); and the AI no longer names specific theoretical positions (Philidor, Lucena, opposition, …) as study targets, since the data is type-level and can't confirm you mishandled those exact positions.
- Reduced opening-position index footprint by ~3 GB by capping the move explorer at 28 plies and rebuilding the three Zobrist-hash indexes as partial indexes (`WHERE ply <= 28`). The cap is invisible in normal use (dev DB max bookmark depth: 6 plies). (SEED-033)

### Fixed

- Phase 102: the per-time-control Eval Score Gap (Conversion/Parity/Recovery cards) now shows the true gap value in both its label and tooltip. It previously displayed an internally recentered value measured against a "0%" baseline that was not actually zero, so the tooltip read e.g. "−10.1% … 14.2% below the 0% baseline". It now reads the raw gap against the explicit cohort baseline, e.g. "−14.2% … 10.1% below the −4.1% baseline". The bullet chart is unchanged.

## [v1.22] Maintenance — Test Isolation & Frontend Major Upgrades — 2026-05-31

A maintenance milestone clearing two accrued debts before the next feature work: making the test suite safe under concurrent and parallel runs, and bringing the frontend onto its latest major dependency versions. No user-facing behaviour change.

### Changed

- Phase 101: upgraded 11 frontend dependencies to their latest major versions — lucide-react 0.577 → 1.x, Vite 7 → 8 (+plugin-react 6), jsdom 25 → 29, ESLint 9 → 10 (+@eslint/js, globals 17, react-refresh 0.5), TypeScript 5.9 → 6.0, recharts 2 → 3. shadcn straggler advanced 4.8.3 → 4.9.0. @types/node held at 24.x (CI tracks Node 24). Shipped as six bisectable atomic clusters in low→high risk order, each gated by the full backend+frontend local gate; recharts 3 passed a desktop + mobile visual UAT after one zone-band regression was fixed and locked with a regression test.
- Backend dependency refresh: `uv lock --upgrade`, pinned patched transitives clearing Dependabot alerts, pydantic-ai-slim 1.85 → 1.104 with deprecation cleanup, and Gemini 3 thinking-level support (default low) in the insights path.

### Tests

- Phase 100: each `pytest` run (and each `pytest-xdist` worker) now gets its own database cloned from a migrated template, so multiple test runs can execute at once without deadlocks or cross-run corruption. The hostile session-start `TRUNCATE … RESTART IDENTITY CASCADE` is gone (a fresh clone is already clean), killed runs self-heal, and the template auto-refreshes on Alembic migration changes. `pytest -n auto` is now safe locally and runs about 2x faster than serial — measured 18.56s vs 40.29s (CI stays serial).

## [v1.21] Time-Control-Aware Endgame Metrics — 2026-05-31

Made the entire Endgame Metrics and Endgame Type Breakdown reporting time-control-aware, so a bullet player is judged against bullet norms rather than a blended average. The aggregated Conversion/Parity/Recovery cards became per-time-control cards, the type breakdown became collapsible per-TC accordion cards, and peer-relative percentile chips landed on the per-TC rates. (Phase 99.1 also moved the large generated cohort-percentile lookup table out of Python source into a database table — internal only, no behaviour change.)

### Added

- **Peer-relative percentile chips on the per-TC Conversion, Parity, and Recovery rates** (Phase 99). Each per-time-control card (Bullet, Blitz, Rapid, Classical) now shows a percentile chip on its Conversion, Parity, and Recovery rate alongside the existing engine-adjusted score-gap chip, so you can see how your raw conversion/parity/recovery rate ranks against players in your rating band and time control, not just against the engine. Chips are cohort-matched on your per-time-control rating and only appear once you have enough endgames in that bucket; sparse cells (commonly Classical) stay hidden rather than show a noisy number.
- **Conversion and Recovery gauges back in Endgame Type Breakdown** (Phase 98). Each endgame type tile (Rook, Minor Piece, Pawn, Queen) now shows its Conversion and Recovery gauges again, this time banded against the correct per-(class x time control) benchmark range so a bullet player is judged against bullet norms, not slow-game ones.

### Changed

- **Endgame Metrics section restructured into per-time-control cards** (Phase 97). The single aggregated Conversion / Parity / Recovery cards are replaced by one card per time control (Bullet, Blitz, Rapid, Classical), each with its own Conversion/Parity/Recovery gauges, WDL bar, and Score Gap chart. Conversion and Recovery gauges use time-control-specific neutral bands (they genuinely differ by speed), while Parity and Score Gap keep a shared band; each card self-suppresses below a per-time-control games floor.
- **Endgame Type Breakdown restructured into collapsible per-TC cards** (Phase 98). The 3-column grid of five per-type cards is replaced by full-width vertically-stacked accordion cards, one per time control (Bullet, Blitz, Rapid, Classical). Your primary time control (the one weighted by game count and typical duration) expands by default; others start collapsed. Mixed is no longer shown; each TC card with fewer than 20 games is suppressed. The accordion resets to your primary TC whenever you change filters.
- **Simpler Endgame Type Breakdown cards** (quick-260529-une). Each per-type card (Rook, Minor Piece, Pawn, Queen, Mixed) drops its Conversion and Recovery gauges, leaving the win/draw/loss bar, the type Score, and the Score Gap bullet. The Score Gap already captures conversion and defensive performance in a single engine-adjusted number, and the removed gauges were the only metrics on the card that shifted with time control, so they could mispaint a bullet player against slow-game expectations. AI insights still use the full conversion/recovery breakdown.

### Fixed

- **Endgame Type Breakdown showed "no data" despite a game count** (Phase 98). The per-time-control type cards displayed their header game count but an empty tile grid ("No endgame type data for this time control"). The per-(class x TC) breakdown was computed from one row per game classified by the *first* endgame position, which is almost always a mixed-material position, so nearly every game landed in Mixed (which the cards intentionally drop) and the Rook/Minor/Pawn/Queen tiles came up empty. It now aggregates the same per-class endgame spans the pooled stats use, and Mixed and pawnless are excluded from the computation so each card's header count equals the sum of its four tiles.
- **Endgames page locked forever when few games reach an endgame** (debug endgame-percentiles-missing). A user above the 30-game rating-anchor floor but with too few games that actually reach an endgame (e.g. 33 rapid games rated, only 22 reaching an endgame) clears the anchor floor yet falls below every endgame metric's own 30-game floor, so no percentile rows are written by design. The readiness gate treated this as "still analyzing" and kept the "Analyzing endgames" screen up forever even after Stockfish finished. The gate now recognises that a committed rating anchor with no percentile rows means analysis has run and the player is simply too sparse for benchmarked metrics, and unlocks the page once evals are drained.

## [v1.20] Import Pipeline Hardening Follow-Up and Readiness — 2026-05-29

Two follow-ups to the v1.18 import hardening and v1.19 percentile work, regrouped into a milestone after the fact. Phase 95 closed the last thread of the FLAWCHESS-3Q out-of-memory family by switching the heaviest import write to a binary COPY. Phase 96 replaced the brittle "reload the page when Stockfish finishes" hack with an honest per-page readiness gate, so users land on already-correct openings immediately while endgame analysis finishes in the background.

### Added

- **Import readiness gate** (Phase 96). The app no longer force-reloads the page when background analysis finishes. On a first import you stay on the import screen, which now reads as a live state machine (fetching → importing → "Explore openings" → analyzing endgames X / Y → ready); openings unlock as soon as games are in, and an "Explore endgames" toast reaches you wherever you are once Stockfish eval and percentiles are done. On a later incremental import, Openings and Overview stay usable throughout and only the Endgames page waits, since partial-eval endgame stats would mislead. The Stockfish progress bar now shows on every page during analysis, and each eval-based Openings metric sits behind a pulsating placeholder until its data is ready instead of showing a half-computed value.

### Changed

- **Honest completion messaging and consolidated eval-progress UI** (Phase 96). No message claims full completion while Stockfish is still running. Eval progress is a single global header rather than scattered per-surface banners, and the running eval counter inside the per-metric tooltips was removed (the progress bar and placeholders carry that signal now).
- **Binary COPY for bulk position inserts** (Phase 95). The heaviest insert in the import pipeline (`bulk_insert_positions`) now uses asyncpg's binary `copy_records_to_table` instead of a parameterized multi-row `INSERT`, cutting per-connection Postgres memory during large dual-platform imports. This is the SEED-027 Thread B follow-up to the v1.19 container memory-budget hotfix (PR #144) and finishes closing the FLAWCHESS-3Q OOM family. Behaviour is unchanged; `bulk_insert_games` keeps its `ON CONFLICT DO NOTHING` path and the COPY enrolls in the same transaction so it rolls back atomically.
- **Percentile chip tooltip shows the matched rating anchor inline** (quick-260529-l1i). Each time-control breakdown row now displays the anchor it was matched against ("Bullet — anchored at ~1525 Lichess Elo"), and the separate platform-blend anchor note was dropped.

### Fixed

- **Endgames page locked forever for users with too few games** (quick-260529). A user with games but fewer than the 30-game per-time-control anchor floor (e.g. 13 imported games) produces no rating anchors and therefore no percentile rows by design, so the readiness gate kept the page on the "Analyzing endgames" screen permanently even after Stockfish finished. The gate now recognises a below-floor user as fully processed and unlocks the page once evals are drained, alongside the existing empty-account escape.

- **Percentile-compute query optimization** (quick-260529-cum). The five per-TC builders (`score_gap`, `achievable_score_gap`, `time_pressure_score_gap`, `clock_gap`, `net_flag_rate`) and their shared `endgame_entry_clocks` helper now scope `game_positions` aggregation to the selected user's recent games only. Previously each query scanned the full `game_positions` table and discarded nearly all rows in a later join. Cut is result-equivalent: only `recent_capped` games survive the downstream joins regardless. Addresses the ~6 s/call, ~58 min cumulative server time flagged by the /db-report for the import and eval-drain hot paths.

- **Stale Stage B percentiles after Stage-5c-covered imports** (quick-260527-u3u). The 7 eval-dependent percentile metric families (`achievable_score_gap`, `score_gap_conv`, `score_gap_parity`, `recovery_score_gap`, `clock_gap`, `net_flag_rate`, `time_pressure_score_gap`) now refresh on import completion when the user has no pending evals, not only on Stockfish cold-drain completion. Previously, an incremental import where every new game already carried lichess `%eval` annotations (Stage 5c marked them `evals_completed_at = NOW()` at import time) refreshed `score_gap` via the Stage A trigger but left the 7 eval-dependent families stale until the next drain tick on that user. The existing cold-drain trigger in `eval_drain.py` is unchanged; both sites are idempotent.

## [v1.19] Endgame Percentiles — 2026-05-27

The first peer-relative percentile chips on the Endgames page. The chip compares each user against same-rated-cohort peers (per-(metric, ELO anchor, TC) cohort CDFs built from the Phase 93 / 94.2 pooled benchmark cohort), making the percentile a stable *trait* of the user rather than a *view* of their currently-filtered data. Phases 93 + 94 shipped the underlying CDF + chip primitive (initial global-pool framing); Phase 94.1 made the chip filter-independent via a materialized `user_benchmark_percentiles` table; Phase 94.2 collapsed the per-cell stratified methodology into a one-point-per-user pooled model; Phase 94.3 extended chips to the Time Pressure cards (12 per-TC chips); Phase 94.4 pivoted the framing from global-pool to peer-relative cohort with rating-anchor disclosure and rescued Recovery Score Gap from the v1 drop list.

### Added

- **Recovery Score Gap chip slot on the Endgames page** (Phase 94.4). Rescued from the v1 drop list under peer-relative framing. Cohort comparison normalises the opponent-rating selection bias that drove the v1 drop, surfacing how a user recovers from material deficit vs other same-rated players.
- **Rating-anchor disclosure in the chip tooltip** (Phase 94.4). Tooltip bullet 4 discloses the per-platform anchor composition: mixed-platform users see "blending N chess.com games (median X, converted) with M lichess games (median Y)"; pure-platform users see a shortened single-platform form. chess.com ratings are converted to Lichess-equivalent via a hardcoded ChessGoals snapshot (2026-05-26).
- **Per-TC percentile chips on Time Pressure cards** (Phase 94.3). Each `TimePressureTcCard` (bullet / blitz / rapid / classical) now renders three chips on its header: Clock Gap, Net Flag Rate, and Time Pressure Score Gap. 12 new per-TC metrics added to `user_benchmark_percentiles` with the pooled-per-user methodology parameterised by TC. Net Flag Rate chips bind a `lower_is_better` direction (fewer net timeouts → higher percentile band).
- **Percentile annotations on 4 endgame ΔES rows** (Phase 94). A "Top X%" chip appears next to four metrics: Endgame Score Gap, Achievable Score Gap, Section 2 Conversion ΔES, Section 2 Parity ΔES. Banded color (red <25 / blue 25..75 / green >75), Radix popover with metric-aware copy. Backend gates each percentile at `n ≥ 10` (existing `PVALUE_RELIABILITY_MIN_N` reliability floor); chips don't render when the field is null. Raw % gauges (Conv/Parity/Recov), per-type cards, and any row below the floor keep their existing IQR zone bands and get no chip.
- **Global empirical-CDF benchmark artifact** (Phase 93). `app/services/global_percentile_cdf.py` ships the underlying CDF tables (p1..p99 breakpoints per metric) produced by `scripts/gen_global_percentile_cdf.py` against the benchmark DB. `/benchmarks` SKILL.md gains Chapter 4 documenting the methodology + SQL templates + report shape. Phase 94.4 later replaces the pooled `GLOBAL_PERCENTILE_CDF` with a per-(metric, ELO anchor, TC) `COHORT_PERCENTILE_CDF` family (~1,050 CdfTable instances under 50-Elo sliding-window protocol).
- **Materialized `user_benchmark_percentiles` table + two-stage compute** (Phase 94.1, 94.2). Each user's canonical-slice value and percentile per in-scope metric are persisted (PK widened to `(user_id, metric, time_control_bucket)` at Phase 94.4). Stage A computes the eval-independent `score_gap` at import-job completion (background task); Stage B computes the eval-dependent metrics (`achievable_score_gap`, `score_gap_conv`, `score_gap_parity`, `recovery_score_gap`, the 3 Time Pressure metrics × 4 TCs) at Stockfish cold-drain completion. Chips light up incrementally — `score_gap` is available within seconds-to-minutes of import completion, eval-dependent chips when cold drain wraps. `scripts/backfill_user_percentiles.py --target dev|prod` populates existing users on rollout.
- **`user_rating_anchors` table** (Phase 94.4). Per-(user, TC) rating anchor used to look up the user's cohort CDF cell. Anchor is the game-weighted blended median over the union of converted-chess.com + native-lichess game ratings, with full per-platform game counts and per-platform medians stored for tooltip disclosure. chess.com Daily games dropped at the SQL level.

### Changed

- **Endgame percentile chip pivoted from global-pool to peer-relative cohort framing** (Phase 94.4). The chip now compares each user against same-rated-cohort peers (per-(metric, ELO anchor, TC) cohort CDFs, K=200 sliding windows at 50-Elo anchors). Chip face shrinks to a bare `p23` pill (no flame icons, no direction word); color band (red <25 / neutral / green >75) carries direction. 2400-rated users no longer see globally-low percentiles that misframe honest skill; the percentile is now relative to other 2400s. Tooltip rewrites to a 4-bullet peer-relative form including rating-anchor disclosure.
- **Percentile chip is a trait, not a view** (Phase 94.1). Toggling Recency / Opponent Strength / TC / Platform / Rated / Opponent Type filters no longer changes the chip — it reflects the user's canonical-slice value computed once per Stage A/B trigger from a fixed cohort definition (status='completed' + ±100 ELO opponent at game time + sparse-cell exclusion + 36-month recency + standard variant). The row's filter-applied metric value continues to display per the existing per-request compute; the chip stays still.
- **Pooled-per-user methodology** (Phase 94.2). Phase 94.1's per-cell stratified methodology is replaced with a one-point-per-user pooled model on both the CDF construction side and the per-user lookup side. Games are pooled across TCs (cap 1000/TC, ≤36 months) and the metric is computed once per user; the CDF is `percentile_cont` over those values. Single ≥30-games inclusion floor on the pool.
- **Percentile chip anchor: game-weighted blended median for mixed-platform users** (Phase 94.4 amendment, D-12 reversal). Per-game ChessGoals conversion for chess.com + native passthrough for lichess, pooled median over the union. Mixed-platform users now see an anchor that reflects their full play distribution, not just their lichess ladder position. Pure-platform users are unaffected (median commutativity within the ChessGoals snapshot). See `.planning/notes/percentile-anchor-d12-reversal.md` for the rationale.
- **`ScoreGapRow` layout** (Phase 94). Non-`hasSlots` callers now render via CSS Grid so the new percentile chip can sit at the right edge of the value row on desktop (≥640 px) and on its own line below the bullet chart, left-aligned, on mobile (<640 px). `EndgameTypeCard`'s 3-column variant (`hasSlots`) is unchanged.

### Fixed

- **Postgres container memory budget** (hotfix PR #144, FLAWCHESS-3Q recurrence). Third post-v1.18 occurrence of the same OOM family: user 109's concurrent chess.com + lichess import on 2026-05-26 14:18-14:24 UTC OOM-killed Postgres inside its 10 GB container cgroup. Root cause was a docker-compose misalignment introduced by PR #139, Postgres remained tuned for the 16 GB host (`shared_buffers=4GB`, `effective_cache_size=12GB`) while the container was capped at 10 GB, leaving only ~6 GB of cgroup budget for per-backend work. With 20 active backends during the dual-platform bulk INSERT burst, that budget was exhausted. Hotfix re-tunes Postgres to the container budget and raises the cap: `shared_buffers` 4GB → 2GB, `effective_cache_size` 12GB → 8GB, `mem_limit` / `memswap_limit` 10g → 12g. Per-backend anon-rss headroom grows from ~6 GB to ~10 GB. Also bumps `starlette` 0.52.1 → 1.1.0 to clear PYSEC-2026-161 (transitive dep, surfaced by the CI pip-audit gate). See SEED-027 for Thread B (asyncpg COPY for bulk position insert), which addresses the per-backend pressure side directly and ships as a parallel small phase.

## [v1.18] Import Pipeline Hardening — 2026-05-22

Reactive milestone driven by two production OOM recurrences after v1.17 (FLAWCHESS-56 on 2026-05-16, FLAWCHESS-3Q on 2026-05-21). Phase 90 eliminated the per-batch unique-SQL leak in `_flush_batch` Stage 5 and shipped DB-recovery retry plus a periodic orphan-job reaper. Phase 91 split the import pipeline into two lanes so Stockfish eval no longer blocks the hot path — users see opening explorer, raw WDL, and flag rates within seconds of import start, with eval-dependent metrics filling in via a background cold-drain coroutine. Phase 92 replaced the closed `Recency` string union on the API wire with explicit `from_date` / `to_date` params and added a Custom range… picker. Hotfix PR #139 capped the SQLAlchemy pool, Postgres `max_connections`, and container memory; the production host was upgraded from Hetzner CPX32 to CPX42 (8 vCPU / 16 GB RAM).

### Added

- **Custom date range filter** (Phase 92). A 9th "Custom range..." item in the Recency dropdown opens a two-month range Calendar on desktop (Radix Popover anchored to the Select trigger, auto-closes on full range pick) and a single-month Calendar in a nested Vaul bottom sheet on mobile (Apply CTA, backdrop = cancel). The trigger label updates to the resolved date range once both bounds are set.
- **Eval-coverage banner + per-metric pending caveats** (Phase 91). New `useEvalCoverage` hook polls `GET /api/imports/eval-coverage` every 10 s while Stockfish work is outstanding and stops automatically at 100%. An amber progress banner appears at the top of Endgames Stats, Openings Stats, Openings Explorer, and Openings Insights while engine coverage is incomplete. Stockfish-dependent metric popovers show an AlertTriangle-icon caveat citing the metric's current sample size and the remaining pending count.
- **Dual-import stress harness** (Phase 91). `scripts/measure_dual_import_rss.py` — dev-only acceptance gate that triggers two concurrent imports, polls Postgres + RSS + swap + coverage every 30 s, and exits non-zero on any bound violation.
- Openings and Endgames *Games* subtabs now show the Score and Eval bullet charts below the WDL chart, matching the move explorer's "Results played as" panel. The Endgames Games subtab reports per-category Wilson score and the eval at endgame entry.
- Endgame Type Breakdown cards now show per-type Start and End predicted scores flanking the Gap row (Start on the left with a Cpu icon, Gap centered with its info popover, End on the right). End − Start reconciles exactly with the Gap.

### Changed

- **Two-lane import pipeline** (Phase 91). The import hot path no longer runs Stockfish. Game ingestion (fetch → parse → insert positions → commit) is now eval-free, and a separate in-process cold-drain coroutine (`run_eval_drain`, spawned in the FastAPI lifespan alongside the orphan-job reaper) evaluates entry plies in the background. Opening explorer, raw WDL, endgame type breakdowns, flag rates, and time-per-move are available within seconds of import start; conversion, recovery, score-gap, and time-pressure-vs-performance metrics fill in over the following minutes with honest per-metric sample-size labels. Structurally prevents the 2026-05-16 / 2026-05-20 hot-lane-Stockfish OOM regression — a CI regression guard (`TestHotLaneNoEvalCalls`) fails the build if any future edit reintroduces `engine.evaluate` inside `_flush_batch`.
- **API filter shape** (Phase 92). The closed Recency string union (`week` / `month` / `3months` / `6months` / `year` / `3years` / `5years` / `all`) on the wire is replaced by two optional ISO date params `from_date` / `to_date`. The frontend converts preset labels to dates in the user's local timezone via a shared `presetToDates` utility. Internal LLM windowing (`insights_service.py`) preserves existing semantics via fixed date offsets independent of the dashboard filter.
- **Production OOM hardening + Hetzner CPX42 upgrade** (hotfix, FLAWCHESS-3Q). SQLAlchemy pool reduced from `pool_size=20, max_overflow=30` (50 max) to `10 + 10` (20 max) in `app/core/database.py`. Postgres `max_connections` capped at 30 (was the upstream default of 100). Host upgraded from Hetzner CPX32 (4 vCPU / 7.6 GB RAM) to CPX42 (8 vCPU / 16 GB RAM); Postgres memory settings retuned accordingly (`shared_buffers=4GB`, `effective_cache_size=12GB`, `work_mem=16MB`, `maintenance_work_mem=512MB`). Backend, db, and umami containers given explicit `mem_limit` (4g / 10g / 384m) with `memswap_limit = mem_limit` on backend and db to disable swap and force a contained OOM-restart (~3 s Postgres auto-recovery) instead of host-wide swap thrash. Root cause of the 2026-05-21 13:42 Postgres OOM (job 72a4ca0d, single chess.com import for user 101) was the post-Phase-91 fetch rate doubling, which let a single uvicorn process fan out to 13 active Postgres backends and exhaust host RAM + 4 GB swap.
- The Eval popover on the Endgames Games subtab now reads "average Stockfish eval at the position where the endgame begins" (instead of the openings phrasing), matching the Stats-tab "Endgame Entry Eval" metric.
- **Score Gap by Remaining Time tooltip splits You/Opp game counts** (post-v1.17 polish). The per-bucket hover tooltip now shows your score and your opponents' score on two separate lines, each with its own game count (`You: 38.0% (40 games)` / `Opp: 55.0% (37 games)`). The two figures come from independent clock-pressure splits of the same game-set, so the counts can legitimately differ; the previous single line showed only one count.
- **Time Pressure card help moved to per-section info popovers** (post-v1.17 polish). The single card-title info popover is gone. Each of the two sections now carries its own info trigger next to its subtitle: "Remaining Time at Endgame Entry" explains the pre-endgame time-management stats and net flag rate; "Score Gap by Remaining Time" explains the same-pressure opponent comparison and what the marker size encodes (how many of the bucket's games were yours).
- **Score Gap by Remaining Time markers scale with your sample size** (post-v1.17 polish). Each datapoint dot is now sized by the user/opponent game-count ratio (`n / n_opp`), clamped to a capped range. A bigger marker means more of that bucket's games were yours, so the user-side score is the better-sampled side of the comparison.
- **Endgame chart axis/tooltip label consistency** (post-v1.17 polish). The "Score Gap by Remaining Time" x-axis caption now renders as an HTML caption matching the "Clock Gap at Endgame Entry" chart, so it is the same size on mobile. The Clock Gap chart's datapoint tooltip label was renamed "Avg clock diff" → "Clock Gap" to match the metric name used elsewhere.

### Fixed

- **Import pipeline OOM root cause** (Phase 90, FLAWCHESS-56 / FLAWCHESS-3Q). The 2026-05-16 production OOM-kill is closed out by eliminating the per-batch unique-SQL leak in `_flush_batch` Stage 5: the old `case()+IN` UPDATE, whose SQL text varied with every game-id set, is replaced by two `bindparam` executemany groups against `Game.__table__` whose SQL text is invariant across batches. SQLAlchemy's compile cache and asyncpg's prepared-statement LRU no longer grow unboundedly during long imports. Locally verified: post-warmup RSS plateau at 577 MB across +1044 games (≈0 MB/game), vs the pre-fix ~0.48 MB/game linear growth.
- **Per-batch session scoping** (Phase 90). `run_import` is restructured into three `AsyncSession` scopes — bootstrap, per-batch, completion. The identity map, transaction state, and per-connection statement cache are now released after every batch, capping the secondary accumulation surface alongside the Stage 5 fix.
- **DB-recovery window no longer strands import jobs** (Phase 90). Adds a bounded-retry helper (`_record_failure_with_retry`, 5 attempts, 2/4/8/16 s backoff with `engine.dispose()` pool invalidation between retries) so a brief Postgres restart no longer leaves a job stuck `in_progress`. The retriable-error classifier covers `sqlalchemy.exc.OperationalError`, `InterfaceError`, `DBAPIError`, raw asyncpg `CannotConnectNowError` / `ConnectionDoesNotExistError`, and OS-level `ConnectionRefusedError`. Sentry capture fires only on final exhaustion (last-attempt rule).
- **Periodic orphan-job reaper** (Phase 90). A new background task (`run_periodic_reaper`, 5-minute tick, 3-hour age threshold) wired into the FastAPI lifespan picks up any `in_progress` job left stranded by an outage longer than the retry budget. `fail_orphaned_jobs` accepts an `orphan_age_threshold` so the reaper does not touch live healthy imports; the startup-time call is unchanged (no threshold).

### Removed

- **Bookmark time-series `recency` field** (Phase 92, D-19). The `TimeSeriesRequest` schema and its corresponding frontend type no longer accept a `recency` field. The time-series endpoint always covers the full game history; the field was unused at the UI call boundary.

### Security

- Bumped transitive dependency `idna` 3.11 → 3.15 to clear CVE-2026-45409 (flagged by the CI `pip-audit --strict` gate). Lockfile-only; no behavior change.

### Tests

- **Real-DB regression coverage for the import pipeline** (Phase 90). New `TestFlushBatchStage5RealDb` (rollback-scoped `db_session` fixture) pins the Stage 5 Table-level executemany contract against actual SQLAlchemy execution; the previous mock-only tests could not catch the ORM bulk-update fragility this PR resolves. New `TestRecordFailureWithRetryDbOutage` (6 tests) pins each retriable exception class plus the pool-invalidation and dispose-failure-resilience contracts.
- **Date-filter boundary integration tests** (Phase 92). Seven new tests cover `from_date` inclusive lower bound, `to_date` inclusive-of-full-day upper bound, game exclusion for dates past `to_date`, no-filter pass-through, 422 validation on `from_date > to_date` via the Pydantic body path (POST /openings/positions) and via the inline HTTPException path (GET /stats/global), and the insights LLM gate blocking message "Clear Custom date range filter" when any date filter is active.

## [v1.17] Endgame Stats Card Redesign — 2026-05-19

### Added

- **Inactivity-gap annotations on all timeline charts** (Phase 88.3). Every ordinal-by-activity timeline chart now marks long inactive stretches with a palm-tree break glyph plus a compact label ("1.1y", "3mo") at each gap longer than 8 weeks, so a flat stretch on the x-axis no longer reads as continuous play. Applied consistently to six charts: Endgame Score Gap over Time, Endgame ELO Timeline, Bookmarked Openings Score over Time, Average Clock Gap over Time, and the Chess.com and Lichess rating charts. Charts with no long gap are unaffected.
- **Endgames page: restored the "Average Clock Difference over Time" line chart** (Phase 88-15, post-UAT polish). Plots the rolling 100-game mean of (your clock minus opponent's clock) at endgame entry, per ISO week, with per-week game volume bars behind the line and three zone-tinted bands (danger / neutral / success). White line with zone-colored dots. Y-axis auto-expands past the ±30% baseline when a real point would otherwise sit at the edge. Vertical "Clock diff %" Y-axis label on desktop (hidden on mobile). Sits ABOVE the Time Pressure cards grid so the trend story reads first and the per-TC cards act as drilldown. User-approved scope amendment to ROADMAP Phase 88 SC #1 ("replace the line chart with bullet cards"): the bullet-card grid is retained as the primary surface, and the line chart returns alongside as a complementary trend view that the cards (a single time-window snapshot) cannot show.
- **Endgame Type Score Gap row on each per-type card** (Phase 87.1). Each Endgame Type Breakdown card (rook, minor piece, pawn, queen, mixed) gains a new "Score Gap" row showing the average per-span gap between exit score and Stockfish-baseline expected score at span entry. Positive means the user outperformed expectation in that endgame type; negative means they gave back expected score. The new row uses the same `ScoreGapRow` bullet primitive as the page-level Achievable Score Gap (Phase 85.1), with per-class typical bands and a `MetricStatPopover` info trigger. LLM Insights now references the per-type Score Gap per class; prompt version bumps `endgame_v28` → `endgame_v29` to invalidate cached reports so newly generated narration uses the new metric.
- **Endgame Type Breakdown: 5 per-type cards** (Phase 87). Replaces the grouped `EndgameWDLChart` and the gauge-only `EndgameConvRecovChart` with a new "Endgame Type Breakdown" section: 5 per-type cards (rook / minor_piece / pawn / queen / mixed; pawnless hidden) in a 1 / 2 / 3-col responsive grid. Each card carries side-by-side Conv + Recov gauges (per-class p25/p75 bands from `PER_CLASS_GAUGE_ZONES`), a WDL bar (toggle `SHOW_WDL_BAR_IN_TYPE_CARDS`), a Games deep-link to `/endgames/games?type=<slug>`, and a per-class chess-score bullet ((W + 0.5·D)/N vs 50%, Wilson 95% whiskers, Wilson score-test p-value gating the sig-paint triple). The page-level h2 carries an `InfoPopover` covering the taxonomy, Conv/Recov definitions, gauge-band explainer, and per-type one-sentence descriptions. `?type=<slug>` URL hydration pre-seeds the type filter on direct visits and SPA navigations. Design deviation: the original SC1 called for two peer bullets per card (Conv peer diff + Recov peer diff); these were collapsed into a single chess-score bullet because the mirror identity (`oppConv = recovery_losses/recovery_games` and its symmetric Recov counterpart) makes the two bullets render the same magnitude — two rows, one signal. Backend exposes `EndgameCategoryStats.score_p_value: float | None` (null when `total < PVALUE_RELIABILITY_MIN_N` = 10).
- **Endgame Score Differences: hypothesis tests + 95% CI whiskers** (Phase 85.1). The Endgame Score Gap (Endgame Score − Non-Endgame Score) and the Achievable Score Gap (Endgame Score − Achievable Score) now report a two-sided p-value vs 0 and a 95% CI on the difference. CI whiskers render around the bullet on both `ScoreGapRow` rows. Achievable Score Gap is now server-computed from per-game `(actual, expected)` pairs via a paired one-sample z-test (replaces the previous client-side `endgame_score − achievable_score` derivation). Independent n-gates apply per signal: p-value gated to None when `n < 10`; CI gated to None when `n < 2`. Font coloring stays zone-only (Phase 85 D-04 kept) — the CI whiskers carry the new uncertainty signal.

### Changed

- **Time Pressure cards redesigned for readability** (Phase 88.4). The per-time-control Time Pressure cards now use a responsive grid (full-width 3×1 or 2×2 with multiple cards, half-width with a single card, no horizontal scroll at any width). "Remaining Time at Endgame Entry" is now a single three-stat header row directly above the Clock Gap bullet — your time left, the gap (with its info popover), and your opponent's time — with Net flag rate unchanged below. The four stacked per-bucket "Score Gap by Remaining Time" bullets are replaced by one zone-banded, zero-centered line chart across the four time-pressure buckets, with confidence-interval whiskers on each point and the per-bucket numbers surfaced in a hover tooltip (the old per-bucket info icons are gone). Same underlying numbers, clearer layout.
- **Endgame ELO Timeline now defaults to your most-active series** (Phase 88.3). On first render the chart shows only the single most-active (platform × time-control) series instead of stacking several at once; every other series stays one click away in the existing legend. No tabs added; behaviour is unchanged when only one series exists.
- **"Endgame Overall Performance" restructured into one responsive card** (Phase 88.3). The arrow-flow layout and the empty black flanking boxes are gone, replaced by a single bordered card: two equal-height columns split by a vertical divider on desktop ("Games without / with Endgame" and "Eval at Endgame Entry / Endgame Score Differences"), stacking with horizontal dividers on mobile. Pure layout change, no metric or chart-content change.
- **Time Pressure cards: restored the per-card top zone with my avg clock time, opp avg clock time, and net flag rate** (Phase 88-14). User-approved scope amendment to Phase 88 SC #1: these three stats were deleted with the old Time Pressure at Endgame Entry table in Phase 88-07 and are now restored on each per-TC card as a top zone above the quintile bullets. The Clock Gap bullet sits in the same top zone; a thin horizontal separator divides the zone from the per-quintile score-delta bullets below. The net flag rate cell zone-tints green or red when it crosses the calibrated `NEUTRAL_TIMEOUT_THRESHOLD` (5%), and renders an em-dash when no game in the time control has clock data.
- **Time Pressure cards: qualitative labels, hidden 80-100% bin, wider axis, separate per-TC containers** (Phase 88-13). The per-quintile rows on each Time Pressure card now use qualitative names — post-UAT relabel format is "0-20% | High Pressure", "20-40% | Medium Pressure", "40-60% | Low Pressure", "60-80% | Very Low Pressure" (range reads first, qualitative as an annotation). The 80-100% clock-remaining bin is intentionally hidden as a low-signal tail (backend keeps computing it; the filter is frontend only). The score-delta bullet axis widens from ±20% to ±30% so real-world deltas exceeding ±20% are no longer clipped (the ±0.06 neutral band is unchanged, so the colored side-zones grow). Each TC card now sits in its own charcoal container instead of being nested inside an outer section wrap. Post-UAT structural refinements layered on top: time-control icon next to the TC label in the card title, "Remaining Time at Endgame Entry" subtitle on the top section, "Score by Remaining Time" subtitle on the quintile-bullets section, redundant `(N games)` suffix dropped from the Clock gap row, MiniBulletChart bars rendered with `barColor="neutral"` to match the Endgame Type / Opening Stats cards.
- **Calibrated time-pressure card zones** (Phase 88.8). `PRESSURE_BIN_SCORE_NEUTRAL_ZONES` (4 TC × 5 quintiles = 20 cells) and the `clock_gap_pct` neutral band are now set from the Lichess benchmark cohort (2026-05-17 snapshot, n=1,743–1,912 users depending on cell). Bands are pooled across ELO inside each (TC, quintile); the ELO gradient inside the band surfaces as visibly higher (greener) values for stronger players, which is the intended behavior — stronger players score better against their opponents at every TC. Cap of ±0.06 half-width applied symmetrically around p50 (activated in 12 of 20 cells). `clock_gap_pct` band updated from symmetric ±5% to the calibrated asymmetric (−6.5%, +4.7%) because users tend to enter endgames with a slight clock deficit.

- **Phase 87.6: Endgame ELO Timeline hides rarely-played combos by default.** With up to 8 platform/TC combinations on one chart the timeline got crowded. The chart now defaults to showing the top 3 combos by total games, after filtering out combos whose active weeks fall below 33% of the leader's active weeks (active week = ISO week with at least one qualifying endgame game). Active-weeks-not-games as the denominator keeps a legitimately co-played rapid/classical line from being drowned out by bullet/blitz volume. Hidden combos still appear in the legend (dimmed + line-through) and can be re-activated by clicking; switching filters resets the default.
- **Phase 87.6: Endgame ELO and Non-Endgame ELO now sit symmetrically around your Actual ELO.** Amends the initial Phase 87.6 FIDE Performance Rating mapping (UAT against prod showed it violated the "Actual ELO surrounded by the two lines" invariant in ~88% of weekly points because the 100-game trailing PR estimator lagged the live Glicko snapshot). Both sides are now derived from a logistic stretch around Actual ELO — `endgame_elo + non_endgame_elo == 2 * actual_elo` for every emitted point. The "lifting / holding back" sign convention and the Non-Endgame ELO data point introduced in 87.6 are preserved; the chart popover and LLM glossary are rewritten to drop Performance Rating framing. Prompt version bumps `endgame_v34` → `endgame_v35` to invalidate cached reports.
- **Phase 87.5: Endgame ELO Timeline rebuilt on Endgame Score Gap.** The timeline now uses an additive formula `endgame_elo = round(actual_elo + K · eg_score_gap)` where `eg_score_gap` is the per-week windowed difference between endgame and non-endgame game scores (the same series that drives the Endgame Score Gap over Time chart). This replaces the Phase 87.4 Conv ΔES + affine recenter input and the Phase 57 multiplicative formula, eliminating the sigmoid bias that caused strong players' chart values to diverge from actual ELO by hundreds of points (benchmark §3.2.2 Conv ΔES ELO Cohen's d = 1.62 vs §3.1.6 Endgame Score Gap d = 0.17). At `eg_score_gap = 0` the chart shows the value equal to Actual ELO; positive Endgame Score Gap means your endgame is lifting your rating, negative means it is holding it back. The chart is renamed back to "Endgame ELO Timeline" and relocated from the "Endgame Metrics and ELO" section to "Endgame Overall Performance", directly below the "Endgame Score Gap over Time" chart. LLM Insights updated end-to-end; prompt version bumps `endgame_v32` → `endgame_v33` so prior cached reports regenerate with the restored "lifts up / holds back" framing. See `.planning/notes/endgame-elo-rebuild-on-score-gap.md` for the full rationale.
- **Phase 87.4: Endgame ELO Timeline renamed to Conversion ELO Timeline.** The timeline is now fed by the Conversion Score Gap (Phase 87.2) routed through a frozen affine recenter into the unchanged Phase 57 formula. Conversion ELO answers: what your ELO would be if everyone played the way you do when up material. LLM Insights prompt updated end-to-end; prompt version bumps `endgame_v31` → `endgame_v32` so prior cached reports regenerate with the new framing. See `.planning/notes/endgame-skill-dropped-conversion-elo.md` for the full rationale.
- **Phase 87.4: Conversion, Parity, and Recovery Score Gap bullets are now display-centered on the typical-population result.** A display-only affine shift is applied to each bullet (Conversion −0.055, Recovery +0.06, Parity 0) so a player at the cohort midpoint renders at the chart center instead of the top of the band. Underlying LLM zone bands, cohort thresholds, and zone-color cutoffs are unchanged.
- **Phase 87.2: Section 2 cards (Conversion, Parity, Recovery, Endgame Skill) now show a per-bucket Score Gap bullet anchored to the Stockfish baseline instead of the previous rate-based peer-diff bullet.** Conversion shows score gap on spans you entered ahead; Recovery on spans you entered behind; Parity on balanced spans; Skill is the equal-weighted average of the three. Auto-generated endgame insights reference the new Section 2 Score Gap family.
- **Endgame Stats: concept terminology title-cased.** The "Endgame statistics concepts" panel and every reference to the panel's terms across the Endgames Stats page (concept accordion, info popovers, aria-labels, headings, gauge labels, Home page FAQ) now uses title case for the named concepts: Endgame Phase, Endgame Type(s), Endgame Sequence, Endgame Entry Eval, Achievable Score, Endgame Score, Non-Endgame Score. The LLM Insights prompt is updated to match (UI-label table + glossary + prose) and the prompt version bumps `endgame_v27` → `endgame_v28` to invalidate cached reports so newly generated narration uses the capitalized terms.
- **Endgame "Overall Performance" section redesigned as 3-card composite (Phase 85).** Replaces the legacy `EndgamePerformanceSection` table and the "Start vs End" twin-tile layout with three cards: "Games ending in Middlegame" (WDL + score), "At Endgame Entry" (entry eval + Stockfish achievable score, no WDL), and "Endgame results" (WDL + score). The Endgame Score Gap tile sits under Card 2 on desktop and stacks at the bottom on mobile. Card scores use sig-gated tinting (Wilson confidence on n>=10 cohorts) and per-row info popovers explain Endgame Score Gap and Achievable Score Gap. Backend exposes `non_endgame_score_p_value` alongside the existing endgame p-value for symmetric gating.

### Removed

- **Phase 87.4: Endgame Skill concept dropped end-to-end.** No composite definition (arithmetic mean, percentile composite, rate aggregate) survived scrutiny on cohort de-confounding, individual absolute-skill interpretation, per-window temporal stability, and the Phase 57 median-coincide invariant. The Endgame Skill card, the Skill Score Gap card, the `endgame_skill` / `section2_score_gap_skill` LLM payload findings, and the Endgame Skill glossary entries in the LLM prompt are all removed. The Conversion ELO Timeline now stands in as the headline composite measure of endgame strength. See `.planning/notes/endgame-skill-dropped-conversion-elo.md` for the full rationale.
- **Phase 87.2: Rate-based peer-diff bullet on Section 2 cards (the `You / Opp / Gap` row).** The prior framing produced mathematically identical Conversion and Recovery values by construction; the new Stockfish-anchored framing yields genuinely independent per-bucket signals.

### Fixed

- **Game imports could fail or hang during large/concurrent imports.** A Postgres OOM-kill mid-import (driven by an oversized import batch size combined with the per-batch Stockfish evaluation pass) could drop the database connection, failing the import and in some cases leaving the job stuck "in progress". Reduced the import batch size and per-engine memory, and raised production swap, to keep imports within the server's memory budget. Hotfix shipped via the new GitLab Flow `production` branch. (Further resilience improvements — automatic recovery of stuck jobs and prevention of duplicate concurrent imports — are tracked as a follow-up.)
- **Opening Insights query plan regression for small users.** The `query_opening_transitions` standard-start filter used a correlated `EXISTS` subquery. For users with a few hundred games the planner picked `ix_gp_user_white_hash` for the inner scan (only `user_id` as index cond, row-by-row filter on `ply=0 AND full_hash=STARTING_HASH`), scanning ~25k rows per outer row × ~8k outer rows ≈ 188M shared buffer hits and ~88 s wall time. Heavy users (~20k+ games) coincidentally landed on `ix_gp_user_full_hash_move_san` and ran in ~1 s. Rewriting as an explicit `INNER JOIN` to a subquery pins the planner to the right index for both regimes: ~65 ms on the 499-game test user, equal-or-faster on a 23k-game user (928 ms vs 988 ms warm-cache).
- **Opening Insights timeout fully resolved via planner extended statistics.** PR #89's JOIN-over-EXISTS fix addressed index choice on a 499-game test user but left a separate planner pathology on adjacent cardinality bands (e.g. user 84 with 718 games / ~50k positions, 137 s wall time, 400M shared buffer hits). The PG planner estimated `rows=1` for `(user_id=X, ply BETWEEN 0 AND 17)` because column-level stats treat `user_id` and `ply` as independent, which cascaded into Nested Loop joins at every level of the opening transitions query. Two `CREATE STATISTICS ... (dependencies, ndistinct, mcv)` objects on `game_positions (user_id, ply)` and `games (user_id, user_color)` give the planner correct cardinality (12,834 rows estimated vs `rows=1` before), which flips the cascading Nested Loops into Index Scans on the primary key. Same query goes from 137 s → 36 ms (~3,800× speedup). No code or index changes; pure statistics fix shipped as Alembic migration `e925558020b9`.

## [v1.16] Stockfish Eval Analyses — 2026-05-11

Downstream consumers of v1.15's Stockfish eval substrate (endgame span-entry + middlegame-entry `eval_cp` / `eval_mate` on `game_positions`). Adds opening-stats eval bullets with t-test confidence, transposition-inclusive Move Explorer + Opening Insights WDL, the Endgame Start vs End twin-tile section with 2×2 grid for Stockfish-baseline achievable score, and LLM narration of all three new metrics. Five phases (80, 80.1, 81, 82, 83) shipped via PRs #80, #82, #85, #86, #88.

### Added

- **Endgames: Stockfish-baseline achievable score** (Phase 83): the "Endgame Start vs End" section restructures into a 2×2 grid. Tile 1 "Where you start" gains a second row showing each user's mean **achievable score** at endgame entry: the Lichess winning-chances sigmoid applied to the Stockfish eval at the first endgame ply (mate positions map directly to 0 or 1, mate-INCLUDED), aggregated per user, sig-tested against 50% via the same Wilson code path as Tile 2's achieved score. Tile 2 "What you do with it" gains a top-row mini WDL bar; bottom row stays the existing W+0.5D score bullet. The two bottom rows share the same axis (`SCORE_BULLET_CENTER`) and cohort band (`[0.45, 0.55]`, calibrated from `reports/benchmarks-2026-05-11.md` §7), so the **achievable-vs-achieved gap** reads directly across the two tiles — a user can see "the engine baseline predicts 49% from these positions, you scored 52%" at a glance. Backend `EndgamePerformanceResponse` gains five `entry_expected_score*` fields. LLM narrates the new metric from day one (`_PROMPT_VERSION` bumped to `endgame_v25`, new "Achievable score" vocab entry, gap framing). New shared `app/services/eval_utils.py` module (Lichess sigmoid + mate→0/1, no business logic). New `ENTRY_EXPECTED_SCORE_ZONES` registry entry; `entryExpectedScoreZoneColor` codegen'd to `frontend/src/generated/endgameZones.ts`.

- **Endgames: "Endgame Start vs End" twin-tile section** (Phase 81): new section above the existing Endgame Overall Performance WDL table renders two tiles — Tile 1 "Where you start" (avg Stockfish eval at endgame entry, in pawns from your perspective, sig-tested against 0 via Wald-z) and Tile 2 "What you do with it" (absolute endgame score, sig-tested against 50% via Wilson score test). Both tiles use three-state color (sig positive → green, sig negative → red, not sig → neutral) at p<0.05 and reuse the Openings score-bullet visual. The concept-explainer accordion gains paragraphs for both new tested metrics with "we can't tell" framing for non-significant results. Mobile: tiles stack with entry-eval first (chronological setup → execution); per-tile chart drops below the label-row for full-width readability. Backend `EndgamePerformanceResponse` gains six fields (entry-eval mean, n, p-value, CI low/high, endgame-score p-value); aggregation runs against bucket_rows so `entry_eval_n + mate_excluded + null_excluded == endgame_wdl.total` by construction. WDL table, Score Gap column, and time-series chart unchanged.

- **Endgame Insights LLM narrates "Endgame Start vs End" tiles** (Phase 82): the LLM-generated Endgame Overall Performance narration now mentions both Phase 81 tiles, `entry_eval_pawns` ("where you start") and `endgame_score` ("what you do with it"), alongside the existing Conv / Parity / Recovery and score-gap-timeline narration. The pair frames as "setup → execution"; the prompt cross-links to the Time Pressure section so a user with strong entry-eval but weak endgame-score reads as "may be losing on the clock, not the board". Closes the gap left by Phase 81 (which shipped the visible tiles but not the LLM hookup). Internal: a new `endgame_start_vs_end` subsection in the insights pipeline; `_PROMPT_VERSION` bumped to `endgame_v23` (auto-invalidates v22 caches).

- **Openings: Stats subtab** (Phase 80): five new column cells on bookmarked-openings and most-played-openings tables -- average Stockfish evaluation at middlegame entry (signed from your perspective, with 95% CI whisker on a bullet chart), one-sample t-test confidence pill for the middlegame metric, average clock difference at middlegame entry (% of base time + absolute seconds), average Stockfish evaluation at endgame entry (parallel bullet chart with its own wider domain), and a separate confidence pill for the endgame metric. Outlier evaluations (>= 20 pawns) are trimmed from the means. Mobile rows get two stacked lines: middlegame triple (bullet + pill + clock-diff) and endgame pair (bullet + pill). The chess board is hidden on the Stats subtab on desktop to make horizontal room.

### Changed

- **Openings significance discipline + neutral bullet bars + grey neutral arrows** (quick task 260508-dcp): on every Openings subtab, Score % and Stockfish eval text only render in zone color (red/green) when the value falls in the red/green zone AND the result is in a confident bucket (confidence is `'medium'` or `'high'`, not `'low'`); otherwise it reads in the default foreground. The gate keys on the categorical confidence bucket so the underlying p-value thresholds in `scoreConfidence.ts` can move without touching every call site. Bullet-chart bars on the Openings Moves "current position" panel and across all three Endgames Stats sections (WDL, Performance, Score Gap) now use the neutral light-grey bar mode that was already applied on the Stats and Insights cards. The categorical "neutral" Move Explorer board arrow (used for the in-between band, low-data, or low-confidence rows) was recolored from blue to a transparent grey so reliable red/green arrows dominate visually.
- **Code organization** (Phase 80): extracted `<ConfidencePill>` to a shared component (used by Opening Insights cards and the new Openings Stats columns) and extracted clock-formatting helpers (`formatSignedSeconds`, `formatSignedPct1`) to `frontend/src/lib/clockFormat.ts` so the two clock-diff cells across the app render identically.
- **Openings: Insights tab** evidence floor raised from n=10 to n=20 per (entry, candidate) transition. The SQL pre-filter on score <= 0.45 OR score >= 0.55 selects on the same statistic the Wald p-value then tests, so at small n the score-vs-50% test is anti-conservative; n>=20 mitigates the worst of that post-selection inflation. The explorer's arrow-color threshold (`MIN_GAMES_FOR_COLOR`) stays at 10 — the two thresholds are now decoupled.
- **Score-confidence p-value migrated from trinomial Wald to Wilson score test.** The Wilson 95% CI (`wilson_bounds`) was already used for ranking and display; the p-value driving the confidence bucket was still trinomial Wald, which produced internal inconsistency (CI/test could disagree at boundary scores) and a degenerate SE=0 case at all-wins / all-losses. Wilson's null SE = 0.5/sqrt(n) is well-defined for any n > 0, so the special-case branch is gone and the CI and test are now inversions of each other. Bucket thresholds (p<0.01 high, p<0.05 medium) and the n>=10 gate are unchanged. Tooltips and Field doc-comments updated. Eval-side (`eval_confidence.py`) intentionally stays on Wald-z — Wilson does not apply to continuous one-sample mean tests.
- Move Explorer rows and Opening Insights findings now show win/draw/loss stats and score across all games reaching the resulting position (including transpositions), so the row's headline matches the position summary on click-through. (Phase 80.1)
- **Endgame Start vs End: tile color rule + tightened neutral band** (Phase 82): the entry-eval tile's neutral band tightens from ±0.75 to ±0.5 pawns (cohort-IQR was wider, but half-a-pawn average swings at endgame entry are narratable). The tile-color rule changes from "significant → green/red, not significant → neutral" (Phase 81) to "value in green/red zone AND p < 0.05 → colored, otherwise neutral". Result: borderline-but-significant cases (e.g. +0.46 pawns at p<0.001) now read as neutral on the tile AND are not narrated as "above null" by the LLM, so the tile and the prose agree on what counts as a meaningful pattern. The endgame-score tile reuses the existing Openings score-bullet 45–55% band for visual parity.
- **MetricId rename: `endgame_score` → `endgame_score_timeline`, `non_endgame_score` → `non_endgame_score_timeline`** (Phase 82): the score_timeline subsection's two metrics get a `_timeline` suffix to free the clean `endgame_score` name for the new `endgame_start_vs_end` subsection. User-facing impact: none directly (these names appear only in the internal LLM prompt). Internal: glossary entries renamed in `app/prompts/endgame_insights.md`; finding `metric=` Literal values updated in `_findings_score_timeline`; `_PROMPT_VERSION` bump invalidates v22 caches automatically.

## [v1.15] Eval-Based Endgame Classification — 2026-05-03

Replaces the material-imbalance + 4-ply persistence proxy for endgame
conversion / parity / recovery classification with direct Stockfish-eval
thresholding (±100 cp on `eval_cp`, color-flipped to user perspective;
`eval_mate` short-circuits to ±1,000,000 cp). Hard cutover, proxy code path
removed entirely. Closes the structural gap on Queen and pawnless classes
(~24% miss rate on substantive material-edge sequences per the 2026-05-02
baseline). Phase 79 folds in a per-position `phase` SmallInteger column
(0=opening, 1=middlegame, 2=endgame) computed via a Python port of lichess
`Divider.scala`, plus middlegame-entry Stockfish eval — substrate for v1.16
opening-stats analyses. Combined Phase 78 + Phase 79 cutover delivered via
PR #78; follow-on PR #79 parallelises the import-time eval pass via
`EnginePool`. VAL-01 / PHASE-VAL-01 (re-run `/conv-recov-validation` for
~100% agreement) rescinded as moot — once the proxy was deleted the
agreement metric became undefined; the `/conv-recov-validation` skill was
deleted.

### Added
- Phase 79: Per-position `phase` column on `game_positions` (`0=opening`, `1=middlegame`, `2=endgame`) computed via a Python port of [lichess `Divider.scala`](https://github.com/lichess-org/scalachess/blob/master/core/src/main/scala/Divider.scala) using existing `piece_count`, `backrank_sparse`, and `mixedness` inputs (no second board scan). Populated on every new import and backfilled across benchmark + prod.
- Phase 79: Middlegame entry position (`MIN(ply)` of `phase = 1` per game) is now Stockfish-evaluated at depth 15 alongside endgame span-entry positions, populated into the existing `eval_cp` / `eval_mate` columns. Substrate for v1.16 opening-stats analyses.
- Phase 78: Pinned Stockfish sf_17 AVX2 binary in the backend Docker image (SHA-256 `6c9aaaf4...341cdde`); CI installs `stockfish` via apt so engine wrapper tests run. `STOCKFISH_PATH` env var threaded end-to-end.
- Phase 78: `app/services/engine.py` — async-friendly Stockfish wrapper with FastAPI lifespan integration (`start_engine` / `stop_engine`, idempotent, depth-15 `evaluate()` API).
- Phase 78: `scripts/backfill_eval.py` — idempotent + resumable backfill driver (skip-where-NULL, COMMIT-every-100, `--db dev/benchmark/prod`, `--user-id`, `--limit`, `--dry-run`, `--workers N` for parallel evaluation, `--timeout` per-eval override).

### Changed
- Phase 78: Endgame Conversion / Parity / Recovery classification migrated from the material-imbalance + 4-ply persistence proxy to direct Stockfish-eval thresholding (±100 cp on `eval_cp`, color-flipped to user perspective; `eval_mate` short-circuits to ±1 000 000 cp). Hard cutover, proxy code path removed entirely. Closes the structural gap on Queen and pawnless classes where the proxy underperformed (~24% miss rate on substantive material-edge sequences per the 2026-05-02 baseline).
- Phase 78: New game imports populate `eval_cp` / `eval_mate` on per-class span-entry rows during the import pass (post-`bulk_insert_positions`, same transaction). Adds well under 1 s to the typical-game import path. Existing lichess `%eval` annotations preserved, never overwritten.
- Phase 78: `_classify_endgame_bucket(eval_cp, eval_mate, user_color)` is now the single helper for endgame conv/parity/recov classification. SQL projects raw white-perspective eval; service layer applies the user-color sign flip.
- Phase 78: Alembic `c92af8282d1a` reshapes `ix_gp_user_endgame_game INCLUDE` from `material_imbalance` to `eval_cp` / `eval_mate` so rewritten endgame queries stay index-only.
- Quick task 260501-s0u: Clock-pressure neutral band tightened from ±10pp to ±5pp based on pooled benchmark data (reports/benchmarks-2026-05-01.md).
- Quick task 260501-s0u: Recovery gauge typical band widened from [25%, 35%] to [25%, 40%] across all endgame classes based on pooled p25/p75 from benchmark data.
- Quick task 260501-s0u: Endgame type breakdown replaces grouped WDL bar chart with six per-class Conversion/Recovery mini-gauge cards, each using class-specific typical bands sourced from benchmark data (Queen Conversion ~78%, Minor Piece Recovery ~36%, etc.).
- Quick task 260501-s0u: LLM endgame insights prompt (v18) reframes Conversion/Recovery narration as delta-from-class-baseline rather than absolute percentages, so observations like "65% Conversion" are contextualised against the class-specific typical midpoint.
- Quick task 260503: Endgame gauge typical bands recalibrated from the 2026-05-03 benchmark report (recovery upper bound 0.40 → 0.36, endgame_skill 0.45 → 0.47 lower bound, per-class rook + pawn recovery and pawn conversion bands tightened in lockstep).
- Quick task 260503-fef: `/benchmarks` skill §2/§3/§6 now apply an equal-footing opponent filter (`abs(opp_rating - user_rating) ≤ 100`) so population baselines reflect peer-vs-peer matchups rather than mixed-strength noise.
- Quick task 260503-0t8: `scripts/backfill_eval.py` parallelised via a new `EnginePool` (`--workers N`), batched UPDATE writes, and group-by-game PGN parsing.
- Quick task 260503-pool: Import-time eval pass parallelised. The module-level engine now wraps an `EnginePool` of `STOCKFISH_POOL_SIZE` workers (default 1, prod ships 2 via `docker-compose.yml`) and `app/services/import_service.py` collects eval targets across an import batch and fans them out via `asyncio.gather`. Sequential `await` callers see no change; parallel callers gain ~`POOL_SIZE`× throughput. Behaviour preserved: lichess `%eval` precedence, bounded Sentry context, same UPDATE shape per row.

### Removed
- Phase 78: `_MATERIAL_ADVANTAGE_THRESHOLD`, `PERSISTENCE_PLIES`, and the `array_agg(... ORDER BY ply)[PERSISTENCE_PLIES + 1]` contiguity case-expression — no proxy-classification path remains in the codebase. `material_imbalance` column retained on `game_positions` for other consumers (e.g. `tests/test_aggregation_sanity.py`).
- Quick task 260501-s0u: Win Rate by Endgame Type timeline chart removed from the Endgame page.

### Tests
- Phase 78: TDD coverage for `app/services/engine.py` (idempotent start/stop, restart-failure swallow, evaluate-without-start contract); for `scripts/backfill_eval.py` (idempotency, dry-run, resume); for the import-time eval pass (`tests/services/test_import_service_eval.py`).
- Phase 79: 11 Divider-sourced parity assertions in `tests/test_position_classifier.py` (matches lichess `Divider.scala` output on a curated FEN fixture set); Wave-0 RED/GREEN tests for `PlyData.phase` (`tests/test_zobrist.py`) and bulk-insert phase writes (`tests/test_import_service.py`).

## [v1.14] Score-Based Opening Insights — 2026-04-29

Replaces the loss/win-rate framing of v1.13 with a calibrated discovery surface
built on chess score `(W + 0.5·D)/N`. Effect size decides what shows up,
confidence annotates how sure we are. Trinomial Wald 95% half-width drives a
low/medium/high confidence badge surfaced on Insights cards and Move Explorer
moves-list rows. `MIN_GAMES_PER_CANDIDATE` drops 20 → 10 — the badge calibrates
trust where the hard floor used to gate. Phase 77 adds a frontend-only
troll-opening watermark on Insights cards and Move Explorer rows. INSIGHT-UI-04
(soften titles per SEED-008) descoped on close: severity word never appeared
as user-facing text; confidence badge + sort calibration deliver SEED-008's
intent without rewriting "Weakness/Strength" titles.

### Added
- Phase 75: Trinomial Wald 95% confidence interval per opening insight finding using the actual variance of the chess result distribution `X ∈ {0, 0.5, 1}` — variance `(W + 0.25·D)/N − score²`, not the binomial-Wilson approximation. Pure-Python `math` only, no scipy. Half-width buckets `≤ 0.10 → high`, `≤ 0.20 → medium`, else `low`.
- Phase 75: `OpeningInsightFinding` API contract extended with `confidence: "low" | "medium" | "high"` and `p_value: float` (two-sided Z-test of observed score vs 0.50, tooltip-grade significance). `severity` retained.
- Phase 76: Move Explorer "Conf" column showing low / med / high confidence per move so you can tell how well-sampled each next-move statistic is.
- Phase 76: `NextMoveEntry` API contract extended with `score`, `confidence`, and `p_value` for moves-list parity with Insights findings.
- Phase 76: Opening Insights cards each show a "Confidence: low / medium / high" line with a hover tooltip explaining how to read it.
- Phase 76: Opening Insights section titles each gain a small `?` icon that opens a popover explaining score, the 5%-from-pivot effect-size gate, and what confidence means.
- Phase 77: Troll-opening watermark — `troll-face.svg` renders as a 30%-opacity bottom-right watermark on Opening Insights cards (mobile + desktop) and a small inline icon next to qualifying SAN rows in Move Explorer (desktop only). Pure visual easter egg; matching is frontend-only via a side-only FEN piece-placement key — no backend schema, no API contract change.

### Changed
- Phase 75: Opening insight classification migrated from loss/win rate to chess score `(W + 0.5·D)/N`. Effect-size gate against a 0.50 pivot with strict `≤`/`≥` boundaries — minor at `score ≤ 0.45` / `≥ 0.55`, major at `≤ 0.40` / `≥ 0.60`. Symmetric on weakness and strength sides, eliminating the prior `loss_rate > 0.55` asymmetry.
- Phase 75: `MIN_GAMES_PER_CANDIDATE` dropped 20 → 10 to enable discovery framing — confidence badge replaces hard-floor gate.
- Phase 76: Move Explorer arrows and row tints now reflect chess score `(W + 0.5·D)/N` rather than separate win/loss rates. Color encoding stays effect-size only — arrows show how far from a 50% break-even your performance sits.
- Phase 76: Opening Insights card prose reframed from "You lose / win X%" to "You score X% as &lt;color&gt; after &lt;move&gt;" — same form for both weakness and strength sections.
- Phase 76: Opening Insights cards within each section now sort by confidence first, then by distance from 50% — high-confidence findings rise to the top.
- Phase 76: Low-confidence (or low-game-count) Move Explorer rows and Opening Insights cards are visually muted at 50% opacity to flag treat-as-a-hint findings without hiding them.
- Quick task 260428-v9i: Opening Insights ranking now uses the Wilson 95% score interval bound instead of Wald. Fixes degeneracy at boundary scores (Wald upper bound for 0/11 was 0.000; Wilson is ~0.259) and demotes small-N extreme findings in favor of large-N moderate findings within each section. Backend constant `OPENING_INSIGHTS_WALD_Z_95` renamed to `OPENING_INSIGHTS_CI_Z_95` (value unchanged at 1.96). The trinomial Wald p-value in `score_confidence.py` (separate procedure for the confidence badge) is unchanged.
- PR #71 (post-Phase-76 inline hotfix): Move Explorer arrows for low-confidence moves are forced grey and the row tint is skipped — board reads cleaner; low-confidence findings still surface in the table with the badge but don't visually claim authority on the board.
- Quick task 260429-gmj (PR #73): Opening Insights cards now render an arrow on the mini board showing the after-move position rather than the entry position — clearer at-a-glance read of which candidate move the finding is about.

### Fixed
- Phase 76: Opening Insights cards no longer break when the backend stops returning the (now removed) `loss_rate` / `win_rate` fields — cards read `score` directly per the Phase 75 contract.

### Removed
- Phase 75: `loss_rate` and `win_rate` fields removed from the `OpeningInsightFinding` API payload. Score is the canonical metric; raw `w / d / l / n_games` remain as the literal-data display.

### Tests
- Phase 75: CI consistency test `tests/services/test_opening_insights_arrow_consistency.py` rewritten to assert score-based threshold lock-step between backend classification and `frontend/src/lib/arrowColor.ts`.
- Phase 76: CI structural assertion ensures `compute_confidence_bucket` has only one implementation across the codebase. `arrowColor.ts` boundary tests cover all six effect-size regions; `OpeningFindingCard` tests cover confidence indicator + tooltip + opacity mute; `OpeningInsightsBlock` tests cover the four `InfoPopover` triggers.
- Phase 77: 9 new test cases under `OpeningFindingCard.test.tsx` (`describe('Phase 77 — Troll-opening watermark')`) asserting watermark gating per CONTEXT.md decisions D-02..D-05; Move Explorer inline-icon tests under `MoveExplorer.test.tsx`.

## [v1.13] Opening Insights — 2026-04-27

First user-facing analytics layer for openings. Each user gets a curated list of
their opening weaknesses (loss rate > 55%) and strengths (win rate > 55%) with
deep-links into the Move Explorer pre-positioned at the implicated entry FEN
and the candidate move highlighted. Pure templated/rule-based; LLM narration
is deliberately deferred. v1.13 also restructures the Openings page subnav to
match the Endgames pattern. Phases 72 (inline bullets on Moves), 73
(meta-recommendation, stretch), and 74 (bookmark-card weakness badge, stretch)
were descoped on close after the live UI showed Phases 70 + 71 + 71.1 already
delivered the actionable signal.

### Added
- Phase 70: `POST /api/insights/openings` returning `OpeningInsightFinding[]`. Single SQL transition aggregation per (user, color) over `game_positions` for entry plies in `[3, 16]`, `MIN_GAMES_PER_CANDIDATE = 20` evidence floor enforced at SQL HAVING level, strict `>` 0.55 win/loss boundary classifying weakness / strength, severity tier major (`>= 0.60`) / minor in `(0.55, 0.60)`. Two-pass attribution (direct hash lookup plus parent-prefix walk via `ctypes.c_int64`-converted polyglot Zobrist hashes) drops findings that match neither rather than surfacing `<unnamed line>` placeholders. Findings are deduplicated by entry hash with deepest-opening attribution and ranked by `(severity desc, n_games desc)` capped at 5 weaknesses + 3 strengths per color.
- Phase 70: Alembic migration `80e22b38993a_add_gp_user_game_ply_index` — partial composite covering index `ix_gp_user_game_ply (user_id, game_id, ply) INCLUDE (full_hash, move_san) WHERE ply BETWEEN 1 AND 17`. First project use of `postgresql_concurrently=True` + `autocommit_block`. Keeps the LAG-window scan an Index Only Scan with Heap Fetches: 0 at ~9% of `game_positions` size.
- Phase 71: `OpeningInsightsBlock` component on Openings → Stats subtab — charcoal-texture card with four-state rendering (loading skeleton, error, empty block with threshold copy, populated four-section grid: white weaknesses, black weaknesses, white strengths, black strengths).
- Phase 71: `OpeningFindingCard` per-finding card with severity-accented border (DARK_RED / LIGHT_RED / DARK_GREEN / LIGHT_GREEN from `frontend/src/lib/arrowColor.ts`), dual mobile/desktop layout, opening name + ECO + entry SAN sequence prose, and explicit "Moves" + "Games" deep-links.
- Phase 71: `LazyMiniBoard` shared module extracted from the inline `GameCard` definition into `frontend/src/components/board/LazyMiniBoard.tsx` for reuse by `OpeningFindingCard` and future insight surfaces. IntersectionObserver lazy render preserved byte-for-byte.
- Phase 71: `useOpeningInsights` TanStack Query hook + `frontend/src/lib/openingInsights.ts` helpers (`trimMoveSequence`, `getSeverityBorderColor`, threshold copy constants).
- Phase 71: Deep-link wiring in `Openings.tsx` — clicking the Moves link replays `entry_san_sequence` through `chess.loadMoves()`, flips the board if the finding is for the black side, applies the matching color filter with `matchSide: 'both'`, navigates to Openings → Move Explorer, and scrolls to top.
- Phase 71.1: Openings page subnav restructured to match the Endgames pattern. Desktop: `<Tabs>` now wraps `<SidebarLayout>` with `<TabsList>` spanning the full board column + main content above. Mobile: sticky 4-tab subnav with an icon-only filter button on the right edge; the chevron-fold collapsible board is gone; the board, controls, and moves field are non-sticky on Moves + Games and hidden entirely on Stats + Insights. Subtab switching resets scroll to top on both viewports.
- Phase 71.1: Notification dot on the Openings tab gated behind first-import state (lights up after first game import completes); Endgames-tab dot similarly gated. Non-Import tabs lock until first game import completes.
- Tests: `tests/services/test_opening_insights_service.py` covers classification boundaries, evidence floor, deduplication, attribution (direct and parent-prefix), ranking formula, caps per color, color-optimization short-circuits, and bookmarks-not-consumed regression. `tests/services/test_opening_insights_arrow_consistency.py` enforces backend/frontend threshold lock-step via a CI gate. Plus `tests/repositories/test_opening_insights_repository.py` and `tests/routers/test_insights_openings.py`.

### Changed
- "Most Played Openings as White/Black" info popovers describe position-based counting, the 3-half-move minimum, and the `vs.` prefix introduced by PRE-01.
- Endgames repository: replaced fragile self-joins with `array_agg` aggregation for endgame-class series queries, prepping the analytics layer for further per-class breakdowns.
- Backend: opening-insights algorithm reframed mid-Phase-70 from a top-10-most-played × per-position next-moves scan to a single first-principles SQL transition aggregation over `game_positions` for entry plies in `[3, 16]` with `n_games >= 20` evidence floor. Classifier `score = (W + D/2)/n >= 0.55` replaced by separate `loss_rate > 0.55` (weakness) / `win_rate > 0.55` (strength) thresholds aligned with `frontend/src/lib/arrowColor.ts`. Bookmarks no longer consumed by the discovery algorithm.

### Fixed
- PRE-01: Top-10 most-played openings now include opponent-defined openings (e.g. `vs. Caro-Kann Defense: Hillbilly Attack` for a Black user) which were previously hidden by a ply-parity filter. Off-color rows render with a `vs. ` prefix; same-color rows are unchanged. 1599 of 3301 white-defined ECO openings were previously invisible in the black top-10 (and vice versa).
- PRE-01 follow-up: Top-10 most-played openings now rank by position-based game count (games passing through the named position, including games that continued into deeper variations), matching the count displayed in the UI. `MIN_PLY_WHITE` and `MIN_PLY_BLACK` raised from 1/2 to 3/3 so trivial trunks like `1.d4` and `1.e4` don't dominate the new ranking.
- Opening insights `IllegalMoveError` when `entry_san_sequence` does not start from the initial position (#71 hotfix). Quick task `260427-g4a`.
- Mobile: Moves/Games links beside the mini board in `OpeningFindingCard` (whole-card target reverted to explicit links). Quick task `260427-h3u`.
- Move Explorer: candidate row carries a sticky severity-colored border and one-shot pulsating arrow when arriving from an Insights deep-link; highlight clears on position or filter change. Quick task `260427-j41`.

### Removed
- Database: dropped the redundant `ix_gp_user_full_hash` and the unused `ix_gp_user_endgame_class` indexes.
- Frontend: chevron-fold collapsible board state on Openings mobile (`boardCollapsed`, `setBoardCollapsed`, `touchStartY`, `handleHandleTouchStart`, `handleHandleTouchEnd`, `MIN_SWIPE_DISTANCE`) removed entirely along with the associated swipe-handler logic.

## [v1.12] Benchmark DB Infrastructure & Ingestion Pipeline — 2026-04-26

Developer-facing infrastructure milestone with no user-visible changes. Ships the
groundwork for SEED-006 (population-based zone recalibration): a separate
`flawchess-benchmark` PostgreSQL 18 instance, a third read-only MCP server, and a
resumable Lichess monthly-dump ingestion pipeline that subsamples players
stratified on (rating × time_control). v1.12 was scoped down from the original
five-phase plan to Phase 69 only — the multi-day full ingest is operational, not
a milestone gate, and the analytics phases (classifier validation, Parity
proxy validation, zone recalibration, `/benchmarks` skill upgrade) move to a
future SEED-006 milestone once the populated DB is ready.

### Added
- Phase 69: Isolated `flawchess-benchmark` PostgreSQL 18 container on `localhost:5433`
  via `docker-compose.benchmark.yml`, with `bin/benchmark_db.sh start/stop/reset`
  lifecycle wrapper. Same Alembic migration chain as dev/prod/test (no
  benchmark-only schema additions on canonical tables). Read-only role
  `flawchess_benchmark_ro` (SELECT-only, with `ALTER DEFAULT PRIVILEGES` for future tables).
- Phase 69: Third MCP server `flawchess-benchmark-db` (read-only, queryable via
  `mcp__flawchess-benchmark-db__query`) documented in CLAUDE.md §Database Access.
  RO password lives in user-level `~/.claude.json` only; committed
  `deploy/init-benchmark-db.sql` keeps a `<PASSWORD>` placeholder.
- Phase 69: `scripts/select_benchmark_users.py` — streaming Lichess monthly-dump
  scan (zstandard) that buckets players by median Elo and modal time control,
  then persists a stratified selection into `benchmark_selected_users`.
- Phase 69: `scripts/import_benchmark_users.py` — SIGINT-safe orchestrator that
  re-uses the production import pipeline against synthetic stub users and
  `import_jobs` rows, with checkpoint resume tracked in
  `benchmark_ingest_checkpoints` (terminal-status idempotency).
- Phase 69: `BenchmarkSelectedUser` and `BenchmarkIngestCheckpoint` ORM models
  (benchmark-DB only, isolated from canonical schema).
- Phase 69: `zstandard>=0.22` added to dev dependency group for streaming
  decompression of Lichess monthly dumps.
- Phase 69: Smoke-test verification report at
  `reports/benchmark-db-phase69-verification-2026-04-26.md` (20-cell selection
  ≈ 8.6k players, ~274k games, ~19.4M positions; pipeline correctness verified
  in lieu of multi-day full ingest).

### Tests
- Phase 69: `tests/test_benchmark_ingest.py` — Wave-0 unit tests covering
  centipawn convention, (Elo × TC) bucketing including boundaries, dump-scan PGN
  parser, and ingest-orchestrator scaffolding.

## [v1.11] LLM-first Endgame Insights — 2026-04-24

First LLM-backed feature. On-demand Endgame Insights via `POST /api/insights/endgame`,
backed by a deterministic findings pipeline, a generic `llm_logs` Postgres table,
and a dual-line Endgame vs Non-Endgame Score timeline chart. Phase 67
(Validation & Beta Rollout) was descoped — insights shipped to all users rather
than behind a beta cohort flag.

### Added
- LLM-backed endgame insights endpoint (`POST /api/insights/endgame`) returning a structured `EndgameInsightsReport` (overview + up to 4 section insights). Cached on a findings hash, rate-limited to 3 misses/hr/user, soft-fails to the last cached report (Phase 65).
- Phase 63: Findings pipeline foundation for LLM Endgame Insights — deterministic `compute_findings` service produces per-subsection-per-window `EndgameTabFindings` with zone, trend, and sample-quality annotations over the existing `/api/endgames/overview` data
- Phase 63: Shared zone registry (`app/services/endgame_zones.py`) as the single source of truth for thresholds and the 3-zone schema (weak/typical/strong) that backs both narrative and chart visuals
- Phase 63: Python→TypeScript zone codegen (`scripts/gen_endgame_zones_ts.py`) with CI drift guard so frontend gauge constants can never silently diverge from the Python registry
- Phase 64: Generic `llm_logs` Postgres table (18 columns, BigInteger PK, JSONB for filter_context/flags/response_json, FK CASCADE to users) with 5 indexes, designed to host every future LLM feature (not endgame-specific)
- Phase 64: Async `LlmLogRepository.create_llm_log` that opens its own session scope, so log rows persist even when the caller's request-scoped transaction rolls back; `get_latest_log_by_hash` stub ready for Phase 65's findings-hash cache
- Phase 64: Automatic per-call cost accounting via `genai-prices` with `LookupError` soft-fallback (`cost_usd=0`, `error=cost_unknown:<model>`) so unknown models never break logging

### Changed
- `SubsectionFinding` gains optional `series: list[TimePoint] | None` for the four timeline subsections, populated with weekly (last_3mo) or monthly weighted-mean (all_time) resampled points (Phase 65).
- Phase 63: Recovery gauge typical band re-centered to 0.25–0.35 per D-10 (previously 0.3–0.4)
- Endgame insights prompt bumped to `endgame_v6`: rate/percent metrics rendered on the 0-100 scale end-to-end so narration matches the page (no more `0.65` prose next to `65%` charts); pawnless findings filtered from the LLM payload to match the hidden UI row; system prompt rewritten with a UI-vocabulary block, a `win_rate`-citation ban, and rules for staleness, latest-bucket anchoring, activity-gap narration, intra-type asymmetry hunting, grounding checks, and within-noise delta handling.
- Endgame insights payload now ships precomputed signals so the LLM stops redoing math: `## Payload summary` header, `STALE:` markers on series trailing >6mo behind the newest bucket, `# trend:` direction tags under every series, `# asymmetry` flags on opposing-zone Conversion/Recovery pairs per endgame type, `# low-time gap` scalar on the time-pressure chart, `# delta` annotations for paired all_time↔last_3mo scalars with a `within-noise` flag on small-sample shifts.
- Endgame insights prompt bumped to `endgame_v7`: all rate/percent values rendered as whole-number `%` in both prompt and UI (drops the confusing `pp` unit); `net_timeout_rate` switched to `higher_is_better` with no internal sign flip (positive raw = strong, matching the UI's coloring); the within-noise rule promoted to a global constraint that binds the overview paragraph text as well as bullets; new precomputed tags (`# weakest type`, `# recovery pattern`, `[near edge]` proximity hints inline on bullets); flat-trend series collapsed to a single stable-around line; stale `endgame_elo_gap` combo series blocks dropped when a live combo exists; redundant `last_3mo` scalar bullets dropped when the delta is within-noise; prompt intensifier forbidden list expanded to block "severe"/"critical"/"drastic"-style overclaims; system prompt redundancy trimmed and Series-interpretation rules consolidated.
- Endgame insights prompt bumped to `endgame_v9`: `EndgameInsightsReport` gains first-class `player_profile` (paragraph) and `recommendations` (2-4 short bullets) fields, surfaced as stacked top-of-page cards above the data-analysis overview; recommendations are allowed to be more directive than the overview but stay grounded in weak/typical-zone metrics with a register calibrated to the most-played combo's Elo (theory jargon ≥1200, named positions ≥1800). The `score_gap` scalar bug is fixed: the misleading `score_gap (all_time)` bullet inside `score_gap_timeline` (which was actually the latest weekly-bucket value mislabeled as an aggregate) is dropped, and the `## Subsection: overall` scalar always emits alongside the `overall_wdl` chart so the all-time number matches the chart row math. Payload format cleaned up: dropped the always-on `Filters:` header (only `## Scoping caveat` remains, when opponent_strength is set) and the redundant `Conversion/Recovery asymmetries detected: N` count.
- Endgame page: "Time Pressure at Endgame Entry" table and mobile cards gain a weighted "All time controls" aggregate row when multiple time controls are present, mirroring the weighted mean the LLM narrates so users can reconcile the written summary with the visible data.
- Phase 68: Endgame tab now shows a dual-line "Endgame vs Non-Endgame Score over Time" chart (both absolute Score series, with a shaded band between them, green when endgame leads, red when it trails) in place of the old single-line "Score Gap over Time" chart. The backend subsection was renamed from `score_gap_timeline` to `score_timeline` and now emits three findings per window — one each for `endgame_score`, `non_endgame_score`, and `score_gap` — each with its own `[summary …]` + `[series …]` block (deterministic order: endgame_score, non_endgame_score, score_gap). Prompt bumped to `endgame_v14`, dropping the now-redundant `score_gap` framing rule (the two-line chart makes gap composition self-evident) and introducing a `[n=<N> for every point]` disclosure that replaces per-point `(n=<N>)` suffixes when N is constant across a series. The info popover drops the "Score Gap is a comparison, not an absolute measure" caveat.
- v1.11 cleanup pass: `endgame_v15` prompt bump drops the stale `Filters:` header reference from the `avg_clock_diff_pct` glossary entry (the header itself was removed in v9). Zone-threshold consolidation finishes the Phase 66 switchover — three chart components now import numeric zone boundaries from `frontend/src/generated/endgameZones.ts` (codegen'd from `app/services/endgame_zones.py`) instead of maintaining inline duplicates; gauge band colors moved to `frontend/src/lib/theme.ts`.

## [v1.10] Advanced Analytics — 2026-04-19

Endgame-focused advanced analytics pass: score gaps, material breakdowns,
time-pressure analysis, skill-adjusted Endgame ELO, plus test hardening and
admin impersonation.

### Added

- Endgame Score Gap & Material Breakdown — signed endgame vs non-endgame score
  difference plus material-stratified WDL table (Conversion / Parity / Recovery)
  with Good / OK / Bad verdict calibration (Phases 53, 59).
- Opponent-based self-calibrating baseline for Conv / Parity / Recov bullet
  charts — opponent's rate against the user replaces global average, muted when
  sample < 10 games (Phase 60).
- Time pressure analytics — per-time-control clock stats table (Phase 54) and
  two-line user-vs-opponents score chart across 10 time-remaining buckets with
  backend aggregation (Phase 55).
- Endgame ELO Timeline — skill-adjusted rating per (platform, time-control)
  combination with paired Endgame ELO / Actual ELO lines, asof-join anchor on
  user's real rating, weekly volume bars for data-weight transparency (Phases
  57, 57.1).
- Admin user impersonation — superusers can impersonate any user via new
  `/admin` page with shadcn Command+Popover search, single `auth_backend` +
  `ClaimAwareJWTStrategy` wrapper (zero call-site changes), last_login /
  last_activity frozen during impersonation, persistent impersonation pill in
  header (Phase 62).

### Changed

- Endgame tab performance — 8 per-class timeline queries collapsed into 2,
  consolidated `/api/endgames/overview` serving every endgame chart in one
  round trip on a single `AsyncSession`, deferred filter apply on desktop
  (Phase 52).
- Conversion / recovery persistence filter — material imbalance required at
  endgame entry AND 4 plies later, threshold lowered 300cp → 100cp, validated
  against Stockfish eval analysis (Phase 48).
- Sentry Error Test moved from Global Stats to Admin tab; superuser-gated nav
  entry.

### Tests

- Test suite hardening — `flawchess_test` TRUNCATE on session start,
  deterministic 15-game `seeded_user` fixture, aggregation sanity tests (WDL
  perspective, material tally, rolling windows, filter intersections, recency
  boundaries, within-game dedup, endgame transitions), router integration tests
  asserting exact integer counts (Phase 61).

## [v1.9] UI/UX Restructuring — 2026-04-10

Responsive sidebar restructuring for Openings, mobile control-row alignment,
Stats subtab redesign, and a global Stats → Global Stats rename with opponent
filters wired end-to-end.

### Added

- Openings desktop sidebar — collapsible left-edge 48px icon strip + 280px
  on-demand Filters / Bookmarks panel with overlay / push behavior at the
  1280px breakpoint, live filter apply on desktop.
- Openings mobile unified control row — Tabs | Color | Bookmark | Filter
  lifted outside the board collapse region so controls stay visible when the
  board is collapsed; 44px tappable collapse handle; backdrop-blur translucent
  sticky surface.
- Global Stats filters — `opponent_type` and `opponent_strength` wired
  end-to-end through `/stats/global` and `/stats/rating-history`, bot games
  excluded by default.

### Changed

- Endgames mobile visual alignment — 44px backdrop-blur sticky row with 44px
  filter button matching the Openings mobile pattern.
- Stats subtab layout — 2-column Bookmarked Openings: Results on desktop (lg
  breakpoint), stacked WDLChartRows for mobile Most Played replacing the
  cramped 3-col table.
- Homepage 2-column desktop hero — left = hero content, right = Interactive
  Opening Explorer preview (heading + screenshot + bullets); pills row removed,
  Opening Explorer removed from FEATURES list.
- Stats renamed to "Global Stats" across desktop nav, mobile bottom bar, More
  drawer, mobile header, plus new page h1.

## [v1.8] Guest Access — 2026-04-06

Free try-before-signup: users can play with FlawChess as a guest, then promote
their guest account into a full account without losing any imported data.

### Added

- Guest session foundation — `is_guest` User model, JWT-based guest sessions
  with 30-day auto-refresh, IP rate limiting on guest creation.
- Guest frontend — "Use as Guest" buttons on homepage and auth page,
  persistent guest banner indicating limited access.
- Email / password promotion — backend promotion service, register-page
  promotion flow preserving all imported data.
- Google SSO promotion — OAuth promotion route with guest identity
  preservation across redirect, email collision handling.

### Security

- Patched Google OAuth for CVE-2025-68481 CSRF vulnerability (double-submit
  cookie validation).

### Fixed

- Import page guest guard, auth page logo linking, delete button disabled
  during active imports.

## [v1.7] Consolidation, Tooling & Refactoring — 2026-04-03

Tooling and code-quality consolidation: static type checking, dead-code
detection, import pipeline speedup, and naming cleanup.

### Added

- Astral `ty` static type checker in CI — zero backend type errors, all
  functions annotated.
- Knip dead export detection + TypeScript `noUncheckedIndexedAccess` — zero
  dead code, strict index-access safety.

### Changed

- Import pipeline ~2x faster — unified single-pass PGN processing, bulk CASE
  UPDATE, batch size 10 → 28.
- SQL aggregation (`COUNT().filter()`) replacing Python-side W/D/L counting
  loops.
- Consistent naming and deduplication — router prefixes, shared
  `apply_game_filters`, frontend `buildFilterParams`.
- CSS variable brand buttons (`.btn-brand`) replacing JS constant, typed
  Pydantic response models on all endpoints.

### Removed

- 7 dead files deleted, unused shadcn/ui re-exports cleaned, -1522 lines.

## [v1.6] UI Polish & Improvements — 2026-03-30

Centralized theme system, shared WDL chart component, a new Openings reference
table from 3641 curated openings, and mobile drawer sidebars.

### Added

- Centralized theme system with CSS variables, charcoal containers with SVG
  noise texture, brand subtab highlighting.
- Shared `WDLChartRow` component replacing all inconsistent WDL chart
  implementations.
- Openings reference table (3641 entries from TSV) with SQL-side WDL
  aggregation and filter support.
- Most Played Openings redesign — top 10 per color, dedicated table UI with
  minimap popovers.
- Mobile drawer sidebars for filters and bookmarks with deferred filter apply
  on close.

### Changed

- Opening Statistics — smart default chart data from most-played openings,
  chart-enable toggles on bookmarks.

## [v1.5] Endgame Analytics & Engine Data — 2026-03-28

Game phase classification at import, material signatures for endgame
categorization, engine analysis metrics ingestion, and the first cut of the
Endgames tab.

### Added

- Game phase classification (opening / middlegame / endgame) per position at
  import.
- Material signature, imbalance, and endgame class per position at import.
- Engine analysis data import (eval, accuracy, move quality) from chess.com
  and lichess.
- Endgame performance statistics in a dedicated Endgames tab, filterable by
  type (rook, minor piece, pawn, queen, mixed).
- Conversion stats (win rate when up material) with timeline charts.
- Recovery stats (draw / win rate when down material) with timeline charts.
- Homepage refresh with feature showcase, FAQ, and acknowledgements.

## [v1.4] Web Analytics — 2026-03-28

### Added

- Web analytics via self-hosted Umami.

## [v1.3] Project Launch — 2026-03-22

Production launch: rebrand to FlawChess, Hetzner deployment, CI/CD, Sentry,
public homepage, rate limiting, and privacy policy.

### Added

- Complete Docker Compose stack (FastAPI + Caddy 2.11.2 + PostgreSQL) deployed
  to Hetzner VPS with auto-TLS.
- GitHub Actions CI/CD pipeline — test + lint + SSH deploy + health check
  polling.
- Sentry error monitoring on backend (`sentry-sdk[fastapi]`) and frontend
  (`@sentry/react`) with Docker build-time DSN injection.
- Public homepage with feature sections, FAQ, and register / login CTA; SEO
  meta tags, sitemap.xml, robots.txt.
- Per-platform rate limiter (`asyncio.Semaphore`) protecting chess.com /
  lichess imports from concurrent bans.
- Privacy policy page at `/privacy`; professional README with screenshots and
  self-hosting instructions.

### Changed

- Full codebase renamed from Chessalytics to FlawChess across 20 files — PWA
  manifest, logo, GitHub org transfer.

## [v1.2] Mobile & PWA — 2026-03-21

Installable PWA with mobile-first navigation, touch interactions, and a phone
testing dev workflow.

### Added

- Installable PWA with service worker, chess-themed icons, Workbox caching
  (NetworkOnly for API routes).
- Mobile bottom navigation bar with direct tabs and slide-up "More" drawer
  (vaul-based).
- Click-to-move chessboard on touch devices with sticky board layout on
  Openings page.
- 44px touch targets on all interactive elements, no horizontal scroll at
  375px.
- Android / iOS in-app install prompts (`beforeinstallprompt` + manual iOS
  instructions).
- Cloudflare Tunnel dev workflow for HTTPS phone testing.

## [v1.1] Opening Explorer & UI Restructuring — 2026-03-20

Interactive move explorer with W/D/L stats per position, tabbed Openings hub,
dedicated Import page, enriched import data, and redesigned game cards.

### Added

- Move explorer with next-move W/D/L stats, click-to-navigate, transposition
  handling.
- Chessboard arrows showing next moves with win-rate color coding.
- Tabbed Openings hub (Moves / Games / Statistics) and dedicated Import page.
- Enhanced import — clock data, termination reason, time control fix,
  multi-username sync.
- Game cards — 3-row layout with icons, hover / tap minimap showing final
  position.

### Fixed

- Data isolation bugs between users.
- Google SSO last_login not being updated.
- Stale cache on auth transitions.

## v1.0 Initial Platform — 2026-03-15

First public version of FlawChess: multi-user chess analysis with game import
from chess.com and lichess, Zobrist-hash position matching, interactive board,
bookmarks, game cards, and rating / stats pages.

### Added

- Import pipeline with incremental sync (chess.com + lichess).
- Position analysis via precomputed Zobrist hashes (white / black / full) for
  indexed integer equality lookups.
- Interactive chess board to specify search positions by playing moves.
- Filters: time control, rated / casual, recency, color, opponent type,
  position color.
- Position bookmarks with drag-reorder, mini boards, piece filter.
- Auto-generated bookmark suggestions from most-played openings.
- Game cards with rich metadata and pagination.
- Rating history, global stats, openings W/D/L charts.
- Multi-user auth with data isolation.

[Unreleased]: https://github.com/flawchess/flawchess/compare/v2.11...HEAD
[v2.11]: https://github.com/flawchess/flawchess/compare/v2.10...v2.11
[v2.10]: https://github.com/flawchess/flawchess/compare/v2.9...v2.10
[v2.9]: https://github.com/flawchess/flawchess/compare/v2.8...v2.9
[v2.8]: https://github.com/flawchess/flawchess/compare/v2.7...v2.8
[v2.7]: https://github.com/flawchess/flawchess/compare/v2.6...v2.7
[v2.6]: https://github.com/flawchess/flawchess/compare/v2.5...v2.6
[v2.5]: https://github.com/flawchess/flawchess/compare/v2.4...v2.5
[v2.4]: https://github.com/flawchess/flawchess/compare/v2.3...v2.4
[v2.3]: https://github.com/flawchess/flawchess/compare/v2.2...v2.3
[v2.2]: https://github.com/flawchess/flawchess/compare/v2.1...v2.2
[v2.1]: https://github.com/flawchess/flawchess/compare/v2.0...v2.1
[v2.0]: https://github.com/flawchess/flawchess/compare/v1.32...v2.0
[v1.32]: https://github.com/flawchess/flawchess/compare/v1.31...v1.32
[v1.31]: https://github.com/flawchess/flawchess/compare/v1.30...v1.31
[v1.30]: https://github.com/flawchess/flawchess/compare/v1.29...v1.30
[v1.29]: https://github.com/flawchess/flawchess/compare/v1.28...v1.29
[v1.28]: https://github.com/flawchess/flawchess/compare/v1.27...v1.28
[v1.27]: https://github.com/flawchess/flawchess/compare/v1.26...v1.27
[v1.26]: https://github.com/flawchess/flawchess/compare/v1.25...v1.26
[v1.25]: https://github.com/flawchess/flawchess/compare/v1.24...v1.25
[v1.24]: https://github.com/flawchess/flawchess/compare/v1.23...v1.24
[v1.23]: https://github.com/flawchess/flawchess/compare/v1.22...v1.23
[v1.22]: https://github.com/flawchess/flawchess/compare/v1.21...v1.22
[v1.21]: https://github.com/flawchess/flawchess/compare/v1.20...v1.21
[v1.20]: https://github.com/flawchess/flawchess/compare/v1.19...v1.20
[v1.19]: https://github.com/flawchess/flawchess/compare/v1.18...v1.19
[v1.18]: https://github.com/flawchess/flawchess/compare/v1.17...v1.18
[v1.17]: https://github.com/flawchess/flawchess/compare/v1.16...v1.17
[v1.16]: https://github.com/flawchess/flawchess/compare/v1.15...v1.16
[v1.15]: https://github.com/flawchess/flawchess/compare/v1.14...v1.15
[v1.14]: https://github.com/flawchess/flawchess/compare/v1.13...v1.14
[v1.13]: https://github.com/flawchess/flawchess/compare/v1.12...v1.13
[v1.12]: https://github.com/flawchess/flawchess/compare/v1.11...v1.12
[v1.11]: https://github.com/flawchess/flawchess/compare/v1.10...v1.11
[v1.10]: https://github.com/flawchess/flawchess/compare/v1.9...v1.10
[v1.9]: https://github.com/flawchess/flawchess/compare/v1.8...v1.9
[v1.8]: https://github.com/flawchess/flawchess/compare/v1.7...v1.8
[v1.7]: https://github.com/flawchess/flawchess/compare/v1.6...v1.7
[v1.6]: https://github.com/flawchess/flawchess/compare/v1.5...v1.6
[v1.5]: https://github.com/flawchess/flawchess/compare/v1.4...v1.5
[v1.4]: https://github.com/flawchess/flawchess/compare/v1.3...v1.4
[v1.3]: https://github.com/flawchess/flawchess/compare/v1.2...v1.3
[v1.2]: https://github.com/flawchess/flawchess/compare/v1.1...v1.2
[v1.1]: https://github.com/flawchess/flawchess/compare/47cca4c...v1.1
