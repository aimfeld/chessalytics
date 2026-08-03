# Phase 200: Train Solve Screen — Board Legend & Inline Sideline Exploration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-01
**Phase:** 200-train-solve-screen-board-legend-inline-sideline-exploration
**Areas discussed:** "Also fine" row scope, Spotlight activation model, What survives the swap, Exploration board rules

Not re-asked (locked by SEED-131): sidebar-as-legend glyphs, spotlight as negative
highlight, inaccuracy→green, "Also fine" compact row, no explore-mode toggle,
exploration seeded from stepped positions, Stockfish-only swap-in card (no Maia, no
FlawChess engine), Solution restores, Analyze deep-link unchanged.

---

## "Also fine" row scope

| Option | Description | Selected |
|--------|-------------|----------|
| Only the drawn green arrows | Legend stays 1:1 with the board — every arrow has an entry, every entry has an arrow, so the spotlight always resolves to something. Costs surfacing a 4th `fineMoves` entry. | ✓ |
| All fine moves, arrows or not | Complete information, but the glyph spotlight becomes a half-truth and extra SANs have no board presence. | |
| All fine moves, drawn ones marked | Completeness plus honesty, at the cost of a second visual state in a row meant to be compact. | |

**User's choice:** Only the drawn green arrows
**Notes:** Narrows ROADMAP success criterion 3's phrasing; LEGEND-04 as written is still satisfied. On sharp puzzles (1-arrow cap) the row does not render.

---

## Yellow removal — scope

| Option | Description | Selected |
|--------|-------------|----------|
| Both — no yellow anywhere | A played inaccuracy renders green too. Consistent with SOLV-03, which already scores it as a correct answer, so the board can't contradict the verdict text. | ✓ |
| Alternatives only — played move keeps yellow | Retains a "you were slightly off" signal on the user's own move, at the cost of one lingering yellow the legend must explain. | |

**User's choice:** Both — no yellow anywhere
**Notes:** Line eval still discloses the drop.

---

## Yellow removal — badge and step highlight

| Option | Description | Selected |
|--------|-------------|----------|
| Treat as 'good' everywhere | Inaccuracy collapses into `good` across arrow, badge, and `TRAIN_STEP_HIGHLIGHT`. One rule; badge can never contradict arrow color. Reveal board loses the good/inaccuracy distinction by design. | ✓ |
| Green arrow, keep severity badge | Retains the distinction, but re-introduces the mixed-signal problem the recolor set out to remove. | |

**User's choice:** Treat as 'good' everywhere

---

## Spotlight activation model

| Option | Description | Selected |
|--------|-------------|----------|
| Hover desktop / tap-toggle mobile | Pointer-enter + keyboard focus on desktop; glyph tap-toggle on mobile with tap-anywhere to clear. No gesture fighting iOS long-press or page scroll. | ✓ (amended) |
| Hover + click-to-pin / tap-toggle | Adds a desktop pin so the spotlight survives the mouse leaving, at the cost of a second desktop state. | |
| Hover desktop / press-and-hold mobile | Self-clearing and mirrors hover exactly, but collides with the iOS long-press menu and forces a finger on the sidebar. | |

**User's choice:** Hover desktop / tap-toggle mobile, **with an amendment**
**Notes:** User specified the structural change alongside it: put the Your Move / Best
Move / Played in game headings and lines into `Card` components with a `CardHeader`;
hovering or tapping highlights **the card itself** as well as filtering the board.
The desktop hover target is the whole card, not just the glyph.

---

## Card treatment follow-ups

| Question | Options | Selected |
|--------|-------------|----------|
| Does "Also fine" become a Card? | Compact row, not a Card / Card for a uniform sidebar | Compact row ✓ |
| Mobile tap target | The glyph only / The whole card | Glyph only ✓ |

**Notes:** Glyph-only on mobile avoids ambiguity between "spotlight this" and "step
this line" — the card body holds the stepper's controls and clickable SAN tokens.

---

## What survives the swap

| Option | Description | Selected |
|--------|-------------|----------|
| Keep header, swap boxes only | Guess verdict, outcome copy, and flaw-fixed banner stay pinned; only the boxes and "Also fine" are replaced. Keeps the just-earned result on screen while branching. | ✓ |
| Full swap to analysis view | Maximum room for engine lines at 375px, but the verdict vanishes until Solution is pressed. | |

**User's choice:** Keep header, swap boxes only

---

## Exit cue / Solution button

| Option | Description | Selected |
|--------|-------------|----------|
| Relabel the button while exploring | "Back to solution" while active. Zero new UI. | |
| Keep the label, no extra cue | Nothing to build, but no signal that this is the way back. | |
| Keep the label, add a hint line | Explicit, but competes for space the mobile layout is short on. | |

**User's choice:** *Other* — "Hide the solution button when the solution is already
active and show it when the user is in exploration mode."

**Follow-up — what gates visibility:**

| Option | Description | Selected |
|--------|-------------|----------|
| Exploring OR a line is stepped (`lineStep !== null \|\| isExploring`) | Both of the button's jobs survive (exit exploration + one-tap stepper reset); visible exactly when it can do something; `lineStep` is already in state. | ✓ |
| Exploring only | Simplest rule, unambiguous label, but a user deep in a stepped line loses the one-tap reset. | |

---

## Exploration board rules

| Question | Options | Selected |
|--------|-------------|----------|
| Reply after an exploration move | Nothing — pure free play / Engine auto-plays the best reply | Pure free play ✓ |
| Move list behavior | Clickable chain, truncates on a new move / Append-only with undo | Clickable chain, truncates ✓ |
| Are PV moves clickable | Yes, plays the line into exploration / No, read-only | Yes ✓ |

**Notes:** Free play is required anyway, since exploration can start from a stepped
position where either side may be to move. The refutation is readable from the engine
card's top PV without a move being made for the user. The clickable-chain model
matches `TrainLineStepper`'s locked single-chain design; `replayPvLine` is already
exported by `EngineLines.tsx` and imported by `TrainReveal.tsx`.

---

## Claude's Discretion

Resolved by inference, recorded in CONTEXT.md for the planner to override if warranted:

- Exploration is reachable only once the verdict has landed; a drag during grading keeps today's behavior.
- Browser-back from the Analyze deep-link restores the pristine reveal, not exploration state (`saveTrainRevealCache` unextended).
- The engine card's in-flight state reuses whatever `EngineLines` already renders.
- Points flash and result sounds are unchanged and do not re-fire on exploration.

## Deferred Ideas

None — discussion stayed within phase scope.

Reviewed but not folded (keyword-matched todos, none touching the Train solve screen):
`WR-01 pt-33 Tailwind Score axis label`, `172-deferred-review-findings`,
`Bitboard storage for partial-position queries`.

## Left open by design

The Stockfish-instance question (reuse the warm `useTrainGradingEngine` vs. mount
`useStockfishEngine` alongside it) was offered and the user chose to leave it as the
phase's research blocker, per the ROADMAP. Constraints it must satisfy are recorded in
CONTEXT.md's `<code_context>`.
