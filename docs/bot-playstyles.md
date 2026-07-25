# FlawChess Bots: Playstyles Explained

**Audience:** chess players who want to understand what makes each bot tick. No programming knowledge assumed. If you want the full technical story of the underlying engine, see [The FlawChess Engine, Explained](flawchess-engine-explained-2026-07-06.md).

**Purpose:** a plain-language explanation of how the bots choose their moves, and what actually changes when you sit down against an Attacker instead of a Wall.

---

## 1. The bots at a glance

FlawChess ships 24 named bots. Each one is a combination of two independent traits:

1. **A playstyle** — one of four characters: **Attacker**, **Trickster**, **Grinder**, or **Wall**. This shapes *what kind* of moves the bot likes: its openings, its appetite for checks and captures, whether it steers toward chaos or quiet, and how it feels about draws and resignation.
2. **A strength level** — six rungs per style, from beginner to club player. This shapes *how well* the bot plays: how human its errors are and how much it calculates before moving.

The two traits are deliberately separate. A low-rated Attacker and a high-rated Attacker want the same things; the strong one is just much better at getting them.

Every bot displays an honest, measured strength label (e.g. "~1250"). These labels come from letting each bot play thousands of calibration games, not from wishful thinking, so the number you see reflects how the bot actually performs.

---

## 2. How a bot picks a move (the short version)

Under the hood, every bot is built from two ingredients:

- **A human-move predictor.** A neural network (Maia) trained on millions of real online games. Given a position and a rating, it answers: "what would a human at this level most likely play here?" It doesn't return one move, it returns a probability for every legal move — e.g. "40% chance a 1200 plays Nf3 here, 25% Bc4, 10% h3, …".
- **A calculating engine.** A search that looks ahead several moves and scores each candidate by its *practical* winning chances — not "what does perfect play say," but "how well does this move tend to work out against opponents at this level."

Each bot uses these in one of three **calculation modes**:

- **Human mode** (rungs 800–1400): no calculation at all. The bot literally rolls weighted dice over the human-move predictor's probabilities. If a typical 1000-rated player blunders a knight in this position 8% of the time, so does this bot, 8% of the time. This is what makes the lower bots feel like real people instead of a chess engine set to "easy": their mistakes are *human* mistakes.
- **Light mode**: the bot runs the calculating engine, but stays loose about the result. It leans toward the moves that score well while still mixing in second and third choices. Think of a player who calculates a bit but mostly trusts their instincts.
- **Deep mode** (the 1800 bots, plus some 1600s): same engine, but the bot commits much more firmly to whichever move scores best. This is the "sits on their hands and calculates" opponent.

The playstyle then bends this machinery in four specific places, described next.

---

## 3. The four levers of a playstyle

### Lever 1: The opening repertoire

Each style has a small, hand-picked repertoire of real openings for each color (drawn from the standard opening classification). During the opening phase, moves that stay inside the bot's repertoire get a heavy thumb on the scale — enough that the bot almost always plays its pet lines when they're available.

Important honesty rule: the boost only applies to moves a human at the bot's level would plausibly play anyway. A style can prefer its pet line; it can never force a nonsense move just to stay "on brand." Once the game leaves known opening territory, the repertoire stops mattering and the other levers take over.

### Lever 2: Move tastes (the low-rung lever)

In Human mode there is no calculation, so the style expresses itself by nudging the human-move probabilities. Every legal move gets tagged with simple properties any player recognizes at a glance:

- Is it a **check**?
- Is it a **capture**?
- Is it a quiet **pawn advance**?
- Is it a **pawn storm** (a pawn pushing into the opponent's half)?
- Is it a roughly even **trade** (a pawn for a pawn, minor piece for minor piece)?
- Is it a **retreat** (a piece stepping back toward its own side)?

Each style multiplies the probability of moves with the properties it likes and shrinks the ones it dislikes. An Attacker nearly doubles the chance of playing a check; a Wall cuts pawn storms to a third of their natural frequency. The bot still plays human moves with human errors — it just gravitates, game after game, toward the moves that fit its character.

### Lever 3: Sharpness preference (the high-rung lever)

In Light and Deep modes the bot calculates, and the style instead tilts *how the calculation's verdicts are read*. Alongside each candidate move's practical score, the search also knows how **volatile** the resulting positions are — whether the game stays calm or whether the evaluations swing wildly depending on the next few choices.

- Sharp-loving styles (Trickster most of all, Attacker mildly) add a bonus to volatile lines: given two roughly equal moves, they choose the mess.
- Quiet-loving styles (Wall most of all, Grinder too) do the reverse: given two roughly equal moves, they choose the one where nothing much can go wrong for either side.

Styles also carry a small general optimism or caution adjustment — the Attacker is a touch overconfident in its positions, the Wall a touch pessimistic.

### Lever 4: Temperament — draws and resignation

The last lever has nothing to do with move choice. It governs the bot's attitude at the negotiating table:

- **Draw contempt.** A neutral bot values a draw at exactly half a point. A high-contempt bot (Grinder) treats a draw as worth *less* than that, so it declines draw offers and plays on unless its position is genuinely worse. A negative-contempt bot (Wall) is slightly happy to split the point even a shade before full equality.
- **Resignation policy.** Each style sets how hopeless a position must be before resignation is even considered, and for how many consecutive moves it must stay that hopeless. This prevents any bot from resigning over one bad-looking moment — and lets one style (Grinder) essentially never resign at all.

---

## 4. The styles, one by one

### ⚔️ Attacker — "sting first, plan later"

*The ladder: Ziggy the Wasp (800) → Duke the Terrier (1000) → Talon the Falcon (1200) → Fury the Wolverine (1400) → Butch the Ram (1600) → Diesel the Bull (1800).*

**Openings.** Gambits, always. As White: the King's Gambit, Danish Gambit, Smith-Morra against the Sicilian, and the Evans Gambit. As Black: the Englund, the Latvian, the Budapest, and the Albin Countergambit. Expect to be offered a pawn by move three.

**In the middlegame.** The Attacker's tastes are the most pronounced of any style: checks come almost twice as often as a neutral player's, captures half again as often, and pawn storms against your king are its single strongest habit. It hates retreating — repositioning a piece backward happens far less than normal.

**When it calculates** (upper rungs), it stays slightly biased toward sharp, double-edged lines and is a touch overconfident in its own attacking chances.

**Temperament.** Mildly draw-averse, but nothing dramatic. Resigns like a normal player when genuinely lost.

**How to beat it.** The Attacker's aggression is genuine but not always sound — especially at lower rungs, where the extra checks and captures arrive without any verification that they work. Take the material, weather the storm, and the endgame is usually yours. One quirk worth knowing: the underlying human-move model underestimates long sacrifice follow-ups, so a low-rung Attacker will sometimes sacrifice and then fail to find the punch line. That's accepted as part of its character.

### 🃏 Trickster — traps, trolls, and swindles

*The ladder: Miko the Magpie (800) → Slinky the Ferret (1000) → Vix the Fox (1200) → Riko the Raccoon (1400) → Sly the Coyote (1600) → Cackle the Hyena (1800).*

**Openings.** The internet's greatest hits: the Bongcloud, the Grob, the Hammerschlag, the Halloween Gambit, the Napoleon Attack, the Sodium Attack. As Black: the Borg Defense, the Drunken Knight, the Fried Fox. The Trickster follows its repertoire more devotedly than any other style — the troll opening *is* the identity.

**In the middlegame.** Its move tastes are deliberately mild — a few extra surprise checks, a slight reluctance to trade pieces (simplification kills the chaos a swindler needs) — because the real personality lives elsewhere.

**When it calculates**, the Trickster has the strongest chaos preference of all four styles. From 1600 up it switches into full swindle mode: among moves of similar practical value, it consistently picks the one that leads to the most volatile, trap-laden positions, and it calculates deeply enough to navigate them. Sly the Coyote and Cackle the Hyena are the bots most likely to be objectively lost and win anyway.

**Temperament.** Completely indifferent to draws — its identity is complications, not the scoreboard. It hangs on slightly longer than normal before resigning, on the theory that one more swindle chance might appear.

**How to beat it.** Don't play its game. Trade pieces at every reasonable opportunity, keep the position simple, and its edge evaporates. The Trickster feeds on opponents who get annoyed by the Bongcloud and overpress to punish it.

### 🪨 Grinder — trades now, endgame later

*The ladder: Pip the Ant (800) → Dig the Mole (1000) → Otto the Otter (1200) → Nell the Penguin (1400) → Tank the Ox (1600) → Gus the Gorilla (1800).*

**Openings.** Exchange variations, on principle: the Ruy Lopez Exchange, the Slav Exchange, the Queen's Gambit Declined Exchange, the French Exchange. As Black it heads for the Petrov, the Berlin, and the Slav — openings famous for trading down early.

**In the middlegame.** One dominant habit: **even trades**. Where a piece can be swapped fairly, the Grinder swaps it, almost twice as often as a neutral player. It doesn't rush attacks and rarely storms with pawns; the plan is always the same — simplify, reach an endgame, and outplay you there.

**When it calculates**, it prefers calm positions over sharp ones and is quietly confident in the simplified structures its trades produce. From 1600 up it calculates deeply — the Ox and the Gorilla are grinding you down *with precision*.

**Temperament.** This is the style where temperament matters most. The Grinder has the strongest draw contempt of the four: it wants meaningfully more than equality before it will ever split the point, so don't bother offering draws in level positions. And it essentially **never resigns** — the position must be utterly lost, and stay utterly lost for many consecutive moves, before it will tip its king. If you're winning against a Grinder, you will have to prove the full technique.

**How to beat it.** Keep pieces on the board and deny the trades, or embrace the endgame and simply be better at it. Either way, be ready to convert a won position all the way to mate — the Grinder makes you earn every point, which is precisely why playing it trains the endgame skills FlawChess measures.

### 🛡️ Wall — the fortress builder

*The ladder: Sheldon the Snail (800) → Spike the Hedgehog (1000) → Shelly the Turtle (1200) → Bruno the Badger (1400) → Rocco the Armadillo (1600) → Hilda the Hippo (1800).*

**Openings.** Systems, not theory battles: the London and the Colle as White — the same setup nearly regardless of what you play. As Black: the Caro-Kann and the Stonewall Dutch. You will recognize the structure by move four.

**In the middlegame.** Everything simplifies and nothing lunges. The Wall has the strongest single move-taste of any style: a heavy preference for even trades. It almost never pawn-storms ("a wall never storms"), gives fewer checks than normal, pushes pawns less than normal, and is the one style that actually *likes* retreating — a piece dropping back to hold the structure fits the character.

**When it calculates**, it has the strongest quiet-position preference of the four and a small pessimistic streak: it would rather be slightly worse in a dead position than slightly better in a wild one.

**Temperament.** The Wall is the only style that's mildly draw-*friendly* — it will accept a draw a shade before full equality. It's also the most pragmatic about lost positions: once clearly worse for a few moves running, it concedes rather than grinding on. Solid, unbothered, and unsentimental.

**How to beat it.** Patience. The Wall won't self-destruct, but system openings concede the center's flexibility, and its aversion to pawn breaks means it rarely fights back at the critical moment. Build up slowly, prepare a well-timed break, and don't expect tactics to fall in your lap.

---

## 5. Strength, honestly

Two things about the strength labels are worth understanding:

- **The rung is a menu position, not a promise.** A bot's slot on the ladder (800, 1000, …) organizes the roster. The strength shown on its card (e.g. "~1250") is the *measured* value from calibration games, rounded and tilde-prefixed because any such measurement has error bars. Style genuinely affects strength — deliberately playing the Bongcloud costs rating points, and the calibration reflects that instead of hiding it.
- **The bots never adapt to you.** A bot's strength is fixed by its own settings and nothing else. It cannot see your rating, doesn't ease up when losing, and doesn't clamp down when winning. By construction, it plays the same against everyone.

---

## 6. Summary table

| | ⚔️ Attacker | 🃏 Trickster | 🪨 Grinder | 🛡️ Wall |
|---|---|---|---|---|
| **Openings** | Gambits (King's, Danish, Evans, Smith-Morra) | Troll lines (Bongcloud, Grob, Halloween) | Exchange variations (Ruy, Slav, QGD, French) | Systems (London, Colle, Caro-Kann, Stonewall) |
| **Loves** | Checks, captures, pawn storms | Complications, traps, volatile positions | Even trades, endgames | Even trades, quiet positions, solid structure |
| **Avoids** | Retreating | Simplifying trades | Rushed attacks, pawn storms | Pawn storms, checks, unnecessary pawn moves |
| **Sharp or quiet?** | Sharp | Sharpest of all | Quiet | Quietest of all |
| **Draw offers** | Slightly reluctant | Indifferent | Strongly declines — wants more than equality | Slightly willing — settles a shade early |
| **Resignation** | Normal | Hangs on a bit, hoping for a swindle | Almost never resigns | Concedes lost positions quickly |
| **Beat it by** | Taking the material and defending | Trading down, staying calm | Out-teching the endgame, converting fully | Patient buildup and a timed pawn break |
