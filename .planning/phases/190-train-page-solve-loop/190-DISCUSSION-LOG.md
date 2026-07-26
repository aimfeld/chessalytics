# Phase 190: Train Page + Solve Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-25
**Phase:** 190-train-page-solve-loop
**Areas discussed:** Train landing & session states, Solve-screen interaction flow, Reveal layout & tone, Progress & interruption

---

## Train landing & session states

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal start screen (Recommended) | "N puzzles waiting" + Start/Resume button; gives Phase 191 a natural place to grow | ✓ |
| Auto-start the session | Visiting /train immediately composes/resumes and drops onto puzzle 1 | |
| You decide | Claude picks during planning | |

**User's choice:** Minimal start screen

| Option | Description | Selected |
|--------|-------------|----------|
| Short session + notice (Recommended) | "5 puzzles ready" plus subtle "More of your games are still being analyzed." | ✓ |
| Only surface full sessions | Block start button until a full session exists while blobs pending | |
| You decide | Whatever degrades most gracefully with opportunistic backfill | |

**User's choice:** Short session + notice

| Option | Description | Selected |
|--------|-------------|----------|
| Score recap + next-session date (Recommended) | Landing shows today's score/rating and "Next session: <date>" | ✓ |
| Simple "done for today" | Checkmark state only; score visible only on session-end screen | |
| You decide | Phase 191's progress surface absorbs this state either way | |

**User's choice:** Score recap + next-session date

| Option | Description | Selected |
|--------|-------------|----------|
| Plain placeholder now (Recommended) | Single honest fallback; Phase 191 builds the designed PROG-05 states | ✓ |
| Pull PROG-05 forward | Build differentiated cold states in this phase (Phase 191 scope) | |
| You decide | Claude picks the split during planning | |

**User's choice:** Plain placeholder now

---

## Solve-screen interaction flow

| Option | Description | Selected |
|--------|-------------|----------|
| Board locked until guess (Recommended) | Position visible for study; pieces unresponsive until guess tapped | ✓ |
| Guess overlay first | Modal asks the guess before the board is interactive | |
| Guess optional until move | Moving without guessing counts the guess as unanswered/wrong | |

**User's choice:** Board locked until guess

| Option | Description | Selected |
|--------|-------------|----------|
| Inline thinking state (Recommended) | "Checking your move…" spinner where the guess buttons were; exact matches skip the wait | ✓ |
| Immediate optimistic reveal | Reveal skeleton first, move verdict pops in when engine finishes | |
| You decide | Based on measured WASM timing during planning | |

**User's choice:** Inline thinking state

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-reveal (Recommended) | Reveal appears as soon as grading + solve POST land | ✓ |
| Tap to reveal | "Show solution" button after grading | |
| You decide | Claude picks during planning | |

**User's choice:** Auto-reveal

| Option | Description | Selected |
|--------|-------------|----------|
| Snap back to puzzle position (Recommended) | Board returns to pre-move position, becomes the stage for stepping lines | ✓ |
| Keep played move on board | User's move stays until the first stepper interaction rewinds | |
| Animate the best move | Board auto-plays the best move as the reveal opens | |

**User's choice:** Snap back to puzzle position

---

## Reveal layout & tone

| Option | Description | Selected |
|--------|-------------|----------|
| Panel beside/below board (Recommended) | Desktop beside (analysis-page pattern), mobile stacked below; one interactive board | ✓ |
| Full-screen reveal card | Dedicated card with mini-board; duplicates board wiring | |
| You decide | Follow analysis-page layout conventions | |

**User's choice:** Panel beside/below board

| Option | Description | Selected |
|--------|-------------|----------|
| Two verdict rows + points (Recommended) | "Guess: ✓ / Move: ✗" rows + explicit "+1 point" tally | ✓ |
| Single combined verdict | One "1 / 2 points" headline with detail beneath | |
| You decide | Claude picks the presentation | |

**User's choice:** Two verdict rows + points

| Option | Description | Selected |
|--------|-------------|----------|
| Neutral-factual (Recommended) | State what happened, no cushioning; matches honest-analytics voice | ✓ |
| Coaching-encouraging | Soften misses with coaching framing | |
| You decide | Match existing reveal-adjacent copy | |

**User's choice:** Neutral-factual

| Option | Description | Selected |
|--------|-------------|----------|
| Small comeback hint (Recommended) | "You'll see this position again in ~3 days" / plain "Mastered — retired"; herrings show nothing | ✓ |
| Hide SR mechanics entirely | Scheduling invisible until Phase 191 | |
| You decide | Claude picks during planning | |

**User's choice:** Small comeback hint

---

## Progress & interruption

| Option | Description | Selected |
|--------|-------------|----------|
| Header text + thin bar (Recommended) | "4 of 12" text near title plus slim progress bar | ✓ |
| Text only | Just the text, no bar | |
| Puzzle dots | Row of dots filling green/red by result (shows a running fail tally) | |

**User's choice:** Header text + thin bar

| Option | Description | Selected |
|--------|-------------|----------|
| Resume via start screen (Recommended) | Landing shows "Resume session — 4 of 12 done"; button drops onto next unsolved puzzle | ✓ |
| Auto-jump into the loop | Skip the landing when a session is open | |
| You decide | Claude picks during planning | |

**User's choice:** Resume via start screen

| Option | Description | Selected |
|--------|-------------|----------|
| No guard (Recommended) | Nav away freely; only the in-flight puzzle's uncommitted guess is lost | ✓ |
| Confirm dialog mid-puzzle | "Abandon this puzzle?" confirm between guess and reveal | |
| You decide | Claude picks during planning | |

**User's choice:** No guard

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, add Train to the dot chain (Recommended) | One-time first-visit dot via the shipped useUserFlag pattern | ✓ |
| No dot in Phase 190 | Phase 191's session-day badge becomes the attention mechanism | |
| You decide | Weigh against Phase 191's badge plans | |

**User's choice:** Yes, add Train to the dot chain

---

## Claude's Discretion

- Nav icon choice (lucide `Target` / `Dumbbell` / `Swords`), start-screen/placeholder copy, spinner and progress-bar styling, score-screen composition details.
- VariationTree reuse vs lightweight stepper (roadmap-flagged spike) and the WASM movetime measurement pass.
- Mechanism for the two payload gaps (pre-attempt `last_move_uci`, reveal pv for untagged items), respecting POOL-10.

## Deferred Ideas

- PROG-05 differentiated cold/empty states, PROG-02/03 celebrations — Phase 191.
- Delete-all modal warning copy (189 D-03) and Welcome.tsx guest copy (189 D-05) — small copy tasks; fold here or in Phase 191, but don't lose them.
- Phase 191's session-day nav badge supersedes the first-visit dot.
