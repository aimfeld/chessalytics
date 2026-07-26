# The FlawChess Engine, Explained

**Audience:** an advanced chess player with some technical curiosity. It assumes you know chess deeply but does not assume you have built a search engine. The tricky ideas (expectimax, MCTS, PUCT, the win-probability curve) are explained from scratch.

**Purpose:** a durable, plain-language explanation of *what this engine does and why it's built the way it is.*

---

## 1. What problem this engine solves

Ordinary chess engines — Stockfish, Leela — answer one question: **what is the objectively best move, assuming both sides play perfectly from here on?** For a tool meant to help humans improve, that is often the wrong question. A 1400 is not going to find the only-move that holds a position, and their opponent is not going to defend like a 3500-rated engine.

The FlawChess Engine answers a different question:

> **What is the best move *you can actually pull off*, against an opponent who defends the way real players at their level actually defend?**

Two situations where this diverges sharply from Stockfish:

- **A line that is objectively winning but inhuman.** It requires a string of quiet only-moves almost nobody at your level finds. Stockfish loves it. This engine discounts it, because *you* probably won't execute it over the board.
- **A move that is objectively second-best but practically strong.** It sets a trap the opponent walks into more often than not. Stockfish ignores it. This engine can rank it **above** the "best" move, because in expectation it scores you more points. This trap and swindle finding is the engine's signature.

The output is a single number per candidate move: an **expected practical score** between 0 and 1 — think "expected fraction of a point," where 1 = you win, 0.5 = draw, 0 = you lose — from your point of view. The interface can show both numbers together: "objectively +3.0, but practically +0.9 for you."

Everything runs in your browser. There is no server doing the thinking.

---

## 2. The two "brains" the engine borrows

The engine does not judge positions itself. It orchestrates two existing chess models, each doing what it is best at.

**Stockfish — the quality axis.** Given a position and a handful of candidate moves, Stockfish returns a shallow evaluation of each ("this leaves you +1.2", "this one is dead lost"). This is the *objective* truth about the position.

**Maia — the probability axis.** Maia is a neural network trained on millions of human games *at specific rating levels*. Given a position and a rating, it returns a **probability distribution over moves**: "at 1400, players play Nf3 here 45% of the time, Bc4 25%, ..." This is the *human behavior* model — it is what lets the engine reason about what a real player would actually do, not what is theoretically best.

The crucial design choice is that the engine queries Maia **asymmetrically**:

```
        Deep in a candidate line...

        Your move?       →  ask Maia: "what does a player
                            at YOUR rating play here?"

        Opponent's move? →  ask Maia: "what does a player
                            at THEIR rating play here?"
```

Modeling *your own future self honestly* — as the fallible player you are, not as an engine — is what prices in the real question: "can I actually follow this line, or will I go wrong three moves from now?"

---

## 3. The core idea in one sentence

> **Expectimax played out inside a smart search-budget allocator. You choose (maximize) only at the position on the board right now; everywhere deeper, the engine takes a probability-weighted average of what humans would actually do.**

That sentence has two separate ideas. They *are* the design, so let's take each slowly.

### 3a. Expectimax: maximize where you choose, average where you can't be sure

Classic engines use **minimax**: I pick my best move, then assume my opponent picks *their* best move (worst for me), and so on. Both sides are treated as perfect.

**Expectimax** replaces "the opponent plays their single best move" with "the opponent plays a *distribution* of moves, so the value of a position is the *weighted average* over what they might do." It is the standard way to reason about a game against an imperfect, probabilistic opponent.

This engine applies that averaging to **both** sides, everywhere except the current move:

- **Opponent to move:** the position's value is the average of the replies, weighted by how likely the opponent is to play each (their Maia distribution). A move that loses for them but that they only find 10% of the time only drags the average down by 10% of its badness.
- **You to move, deeper in a line:** *also* a weighted average, this time under *your* Maia distribution. This is the honest part. Beyond the current move you do not get to assume you'll find the best continuation — you model yourself as the human you are. A brilliant follow-up you'd spot 8% of the time contributes 8% of its brilliance and 92% of whatever you'd more realistically play instead.
- **The move on the board right now is the one exception — here the engine takes the maximum.** This is the single moment you *are* choosing deliberately, with the engine's help. So here it picks the best candidate rather than averaging.

Picture a tiny two-ply tree. You are to move (`MAX`), and for each of your candidate moves the opponent has a distribution of replies (`AVG`):

```
                       ┌─────────────┐
                       │  YOU (MAX)  │   ← pick the best of these
                       └──────┬──────┘
             ┌────────────────┼────────────────┐
          move A            move B            move C
             │                │                │
       ┌─────┴─────┐    ┌─────┴─────┐    ┌─────┴─────┐
       │ OPP (AVG) │    │ OPP (AVG) │    │ OPP (AVG) │   ← weighted average
       └─────┬─────┘    └─────┬─────┘    └─────┬─────┘     by how likely each
        60% ╱ ╲ 40%      30% ╱ ╲ 70%      50% ╱ ╲ 50%      human reply is
           ╱   ╲            ╱   ╲            ╱   ╲
        0.9    0.4       0.2    0.5       0.7    0.6

   value(A) = .60·0.9 + .40·0.4 = 0.70
   value(B) = .30·0.2 + .70·0.5 = 0.41
   value(C) = .50·0.7 + .50·0.6 = 0.65

   YOU pick move A  (max of 0.70, 0.41, 0.65)  →  practical score 0.70
```

Move A wins here even if, say, move C led to a higher score *when the opponent defends perfectly* — because the opponent usually won't. That is the swindle instinct, expressed as arithmetic.

This asymmetry (maximize at the current move, average everywhere below) is the genuinely unusual piece, and it is deliberately kept to a few lines of code so it can't quietly turn into something else (more on that in §6).

One refinement rides on top of this maximize step, added after the core was built: the *value* of each root candidate is still exactly the expectimax number above, but the engine no longer ranks candidates by that number alone. It also weighs **how likely you are to find the first move in the first place**, so an objectively strong move you'd almost never play doesn't top the list. That is a ranking-layer adjustment — it never touches the value math — and it gets its own explanation in §6 ("findability weighting").

### 3b. Why a "smart budget allocator" — MCTS

Why not just build the full tree to, say, eight half-moves deep and average everything upward? **Cost.** Each Stockfish evaluation takes a meaningful fraction of a second. A few seconds of thinking buys only a few hundred evaluations in total. A uniform depth-eight tree would burn almost all of them on lines that were already dead two moves in.

**Monte Carlo Tree Search (MCTS)** is a budgeting strategy that fixes this. Rather than expanding everything uniformly, it grows the tree *where it looks promising*. It repeatedly:

1. walks from the current position down to the most promising unexplored spot,
2. expands just that one spot (evaluating its candidate moves),
3. propagates the result back up so the whole tree's estimates improve.

Promising lines get explored ten-plus half-moves deep; junk gets abandoned after a single look. Same budget, far better spent.

```
   Uniform search (wasteful):        MCTS (adaptive):

     every branch the same             the promising main line
     shallow depth, good               runs deep; dead lines
     and bad alike                     barely touched

           o                                o
        ╱╱╱│╲╲╲                          ╱  │  ╲
       o o o o o o o                    o   o   o
       │ │ │ │ │ │ │                    │       │
       o o o o o o o                    o       o     ← budget flows
       (all depth 2)                    │                to what matters
                                        o
                                        │
                                        o
                                     (depth 5+)
```

So the design in full is: **use MCTS's smart budget allocation, but swap its usual bookkeeping rule for our custom expectimax rule.** That swap is the whole trick — the search *spends* its budget like MCTS, but *values* positions like the human-aware expectimax of §3a.

---

## 4. How a single "think" unfolds

Here is one full cycle of the search, start to finish. Repeat this a few hundred times and you have the engine.

```
   ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │  SELECT  │──▶│ TERMINAL? │──▶│  EXPAND  │──▶│  BACK UP │──▶│ SNAPSHOT │──┐
   └──────────┘   └───────────┘   └──────────┘   └──────────┘   └──────────┘  │
        ▲                                                                      │
        └──────────────────────── repeat until budget spent ──────────────────┘
```

1. **Select.** Starting from the current position, walk down the tree, at each step choosing the child that best balances "looks good already" against "hasn't been explored much" (the PUCT rule, §6). Stop when you reach a spot not yet expanded — the most promising frontier.

2. **Terminal check.** If that spot is checkmate, stalemate, or a draw, it gets a fixed value (a win for you = 1, a loss = 0, any draw = 0.5) and is never expanded. Same if the line has hit the depth ceiling. These dead ends cost nothing — no model calls.

3. **Expand.** For a genuine new position: ask Maia for the candidate moves, keep the most likely ones (see "truncation" in §6), then make **one batched Stockfish call** to evaluate all of them at once. Each candidate becomes a new child, seeded with its Stockfish-derived score.

4. **Back up.** Recompute this spot's value from its fresh children using the expectimax rule (average for a normal node, maximum at the current move), then walk back up the path applying the same recomputation to every ancestor. The estimate for the move on the board is now a touch sharper than before.

5. **Snapshot.** Emit the current ranking so the interface can refresh live. This is what makes the engine *anytime*: it shows a rough answer almost immediately and keeps improving it while you watch, rather than making you wait for a final verdict.

When the budget runs out, the engine reports, for each candidate move on the board: its **practical score**, its **objective Stockfish evaluation**, its **most likely line** (your probable moves plus the opponent's most probable replies, shown as "the line"), and how many times the search visited it. Candidates are ranked by a **findability-weighted** version of the practical score (§6) — the displayed practical score itself is unchanged — with exact ties broken alphabetically so the result is perfectly reproducible.

### Turning a Stockfish evaluation into a score

At the bottom of a line the engine needs a number between 0 and 1, but Stockfish speaks in pawns ("+1.5") or mate ("mate in 3"). The conversion uses the well-known **win-probability curve** — the same S-shaped mapping lichess uses to turn an evaluation into a win percentage. Roughly, small edges near equality matter a lot and huge edges saturate (going from +6 to +9 barely changes your practical winning chances). This is not a new invention; it's the standard curve, reused unchanged.

```
   expected
   score
   1.0 ┤                           ╭─────────────
       │                      ╭────╯
   0.5 ┤ ─ ─ ─ ─ ─ ─ ─ ─╭─────╯ ─ ─ ─ ─ ─ ─ ─ ─ ─
       │           ╭────╯
   0.0 ┤ ──────────╯
       └────┬──────┬──────┬──────┬──────┬────  Stockfish eval
          −6      −3      0      +3     +6      (from your side)
```

---

## 5. Which moves get considered, and how the search steers them

Before anything else, a fair question: where does the short list of candidate moves at each position even come from? **In the current implementation, entirely from Maia.** Maia proposes the moves — the ones a human at the relevant rating would actually consider — and Stockfish's only job is to *score* that list. Stockfish contributes no moves of its own.

Concretely, at every position the engine takes Maia's probability distribution over all legal moves and keeps the most likely ones until they add up to about 90% of the probability, which usually leaves three to five moves (this is the "truncation" detailed below). That truncated set *is* the candidate list.

One thing the user *can* now shift is how that distribution is shaped before truncation. A **"Play style" slider** (§6) lets you tell the engine how much credit to give you for finding less-obvious moves: pulled toward *Human* it sharpens your distribution onto the natural move you'd most likely play, pulled toward *Stockfish* it flattens the distribution so rarer, stronger moves carry enough weight to surface. It reshapes *your own* Maia distribution — the raw list of moves is still Maia's, just re-weighted — and it only affects the modeling, never the "Moves by Rating" chart you see, which always shows Maia's untouched numbers.

There is also a dormant capability worth knowing about, because the machinery for it is already built (and referenced in the "exploration floor" below). The engine *can* inject one extra move into the root's candidate set — typically Stockfish's objective top choice — so that a strong move Maia rates as near-impossible still gets searched. When enabled, that move is unioned in *after* truncation (so the mass cut can't drop it) and kept alive by the exploration floor. **This injection is switched off in the current build**, so nothing changes the "pure Maia" answer above; the hook simply exists for the day a specific move needs to be forced in.

---

## 6. The judgment calls inside the search

A few decisions inside the search deserve a plain explanation, because they are where a naive version would go wrong.

**Which branch to walk down — PUCT.** At each step of the "select" walk, the engine scores every child by combining two urges:

- *exploit* — go where the results already look good, and
- *explore* — try branches you haven't examined much, in case they're better,

with a bonus that is larger for moves Maia thinks are likely and smaller for moves already visited a lot. This standard formula is called **PUCT** ("Predictor + Upper Confidence bounds applied to Trees" — the classic UCT tree-search rule with a policy predictor's priors folded in). The engine uses it in full only at the move on the board (where you're genuinely choosing the best option). Deeper in the tree it drops the "looks good" term and steers purely by "which human-likely move still has the most uncertainty" — because down there the value is a fixed average you're trying to *refine*, not an option you're trying to *pick*. The practical effect is that the search naturally deepens the most probable line.

**Keeping only the moves worth searching — truncation.** Maia assigns a probability to *every* legal move, but the long tail of near-hopeless moves is not worth searching. The engine keeps the most likely moves until they add up to about 90% of the probability, drops the rest, and rescales the survivors. This keeps each position branching into a manageable three-to-five moves instead of thirty.

**Making sure a strong-but-rare move still gets a look — the exploration floor.** Sometimes you want to force a specific move into consideration — say, Stockfish's top choice — even though Maia gives it almost no human probability. Left alone, the branch-selection rule would never spend any visits on a move with ~0 probability, so its score would stay a single shallow guess. The fix: for the *current move only*, and *only* when deciding where to spend visits, treat every candidate as if it had at least a 10% probability. This guarantees the injected move actually gets searched. Critically, this nudge affects only *where the search looks* — it never touches the actual score math, which always uses Maia's true probabilities. Visit allocation is steered; the reported numbers are never distorted.

**Recommending the move you'll actually find — findability weighting.** This is the answer to a real failure that showed up in testing. At 600, the engine's top pick was once **Nb5** — objectively strong, but a move a 600-rated player finds only about 5% of the time. Telling someone to play a move their peers almost never find is "Stockfish with extra steps," the exact thing this engine exists to avoid. The cause was subtle: the value of a root move is the expectation *below* it, which deliberately leaves out the odds that you find the root move *itself*. So a barely-findable move with a good follow-up could win the ranking.

The fix keeps the value math untouched and only changes the *ordering*. Alongside each move's practical score, the engine now looks at how often a player at your level actually plays that first move, and compares it against a **findability bar** it sets from your rating: a fairly forgiving bar at 600 (roughly one-in-eight — below that, a move counts as one you'd rarely find), sliding down to almost nothing at master level, where nearly every good move is findable. Clear the bar and a move keeps its full practical score in the ranking. Fall well under it and the move gets pushed down the list — the further under, the harder the push — but its *displayed* score never changes, only its position.

The rule is carefully built *not* to do one tempting thing: recommend your single most *likely* move. In the 600 case that most-likely move was a 57%-of-the-time blunder. So the bar can only ever push a hard-to-find move *down*; it can never lift your most-frequent move *up*. That keeps the engine between two failures:

```
   the strong move you'll never find        →  too much Stockfish   ✗
   your most likely move (often a blunder)  →  too much Maia        ✗
   the best move you'll plausibly find      →  what we want         ✓
```

The engine's identity shifts a little with this: from an **oracle** that hands you the ideal move to a **coach** that hands you the best move within your reach. And because it is purely a ranking adjustment, the practical score shown next to each move never changes — only which move sits on top.

**The play-style dial — policy temperature.** The slider from §5 is a single knob on how much credit the engine gives *you* for finding less-obvious moves. Technically it applies a "temperature" to your Maia move distribution, and the crucial thing to hold onto is that Maia's distribution models *human* choice: its peak is the move players like you reach for most often, which in sharp positions is rarely the objectively best move. So the two ends read backwards from the usual "low temperature = precise" intuition:

- Toward **"Human,"** the distribution is *sharpened* onto its peak — you're modeled as simply playing your most natural move. Rare-but-strong candidates fall further under the findability bar and get pushed down the ranking, and deep in a line the engine won't credit you with the one hard follow-up. It settles on the ordinary move a player at your level actually reaches for.
- Toward **"Stockfish,"** the distribution is *flattened*, spreading probability onto the rarer moves. Now a strong move you'd only occasionally find clears the findability bar and competes on raw quality, and deep only-moves carry more weight in the averaging. It drifts toward the objectively best move, trusting you to find the sharp continuations.

Dead center is exactly today's behavior. The dial applies to **your side only** — the opponent is always modeled at their true rating, since the slider is about how much precision to assume from *you*, not how well your opponent defends. The temperature-adjusted distribution feeds both the search and the findability weighting above, so the two compose instead of fighting.

**Keeping the novel rule honest.** The one genuinely unusual idea — maximize at the current move, human-weighted average everywhere else — lives in a tiny, isolated piece of arithmetic. There's a good reason for that. A famous pitfall is that this kind of custom rule can *silently* slide back into textbook MCTS, which weights children by how often they were *visited* rather than by *how likely a human is to play them*. Those produce different answers, and the wrong one still looks plausible. By isolating the rule and building it so that visit counts physically cannot enter the averaging, the mistake becomes impossible to make by accident.

---

## 7. A simpler backup engine, kept in reserve

Alongside the MCTS search there is a **second, simpler engine** that produces the same kind of answer through a plainer method: it just expands *every* candidate of *every* position down to the depth limit — no clever budgeting, no exploration heuristics. It wastes effort on doomed lines, but it is predictable and easy to reason about.

It exists for two reasons. First, **insurance**: if tuning the MCTS search ever became a time sink, this plainer engine is a proven drop-in replacement. Second, and more importantly, both engines share the *exact same* core pieces — the maximize/average rule, the fixed-perspective conversion, the same 90% truncation. Because those pieces are shared, the two engines *cannot* quietly disagree about what a "practical score" means. Having a second implementation that provably agrees is what makes the whole approach trustworthy rather than merely plausible.

---

## 8. What the engine deliberately does *not* do

Restraint is part of the design. Some limits are worth stating plainly.

- **It never says "best move" unqualified.** The output is always "best *practical* move for you." When it disagrees with Stockfish, that disagreement is the point, and the interface is meant to make it read as intentional.
- **It keeps the search shallow — on purpose.** The explicit lookahead is only six to ten half-moves. Here is the honest reason: Maia's move predictions get *less* reliable the deeper you go. Every probability carries some error, and multiplying those errors along a long line compounds them — while at the same time, deep positions look less and less like the real human games Maia learned from, so it drifts out of its comfort zone exactly where the errors pile up. Keeping the tree shallow and letting the win-probability curve absorb everything past the horizon is the deliberate defense. Do not trust an impressive-looking fifteen-move "practical" line; by design the engine won't hand you one.
- **It treats conversion beyond the horizon generically.** Past the searched depth, everyone is modeled as an average player converting an advantage. Within the horizon, the realism comes from the explicit Maia modeling. Rating-specific conversion curves are a plausible future refinement, not a current feature.
- **It ignores the clock — for now.** Modeling time pressure (players get weaker and less precise when low on time) is not yet automatic. The *mechanism* it would use already exists, though: the "Play style" dial (§6) is exactly this axis — a low clock would push it toward the **Human** end, modeling you as reaching for the obvious move and less able to pull off hard-won resources — but today it is a manual slider, not something the engine sets from the clock itself.

---

## 9. The whole thing in one paragraph

The FlawChess Engine ranks moves by **expected practical score** — how well a move actually does *for you*, given that you and your opponent both play like real humans at your respective ratings rather than like perfect engines. It borrows Stockfish for objective quality and Maia for human move-probability, and fuses them with **expectimax** (you maximize at the move on the board; every deeper position is a probability-weighted average that honestly prices in fallibility on both sides) run inside an **MCTS** budget allocator that spends its scarce, expensive evaluations on the lines that matter instead of splitting them evenly across good and bad alike. The novel maximize-here-average-everywhere rule is kept tiny and isolated so it can't drift into ordinary MCTS, and a simpler reserve engine that provably agrees on scoring stands behind the same door. On top of that, the final ranking weighs **how likely you are to find the recommended move in the first place** — auto-scaled to your rating — so at low levels it recommends the best move within your reach rather than a strong one you'd almost never find, and a "Play style" dial lets you tune how fallible it models you as being. The result is a search that will rank an objectively second-best move first when it sets a trap the opponent walks into, or when it is simply the strongest move you'll realistically play — the one thing no conventional engine will ever tell you.
