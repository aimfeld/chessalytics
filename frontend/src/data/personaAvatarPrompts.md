# Persona Avatar Prompts

Committed prompts for generating the 24 bot-persona portraits (D-15/D-16/D-17,
AVAT-01/AVAT-02). This document is the single generation source: it carries
every persona's descriptor line AND bio, and nothing else — `scripts/gen_persona_avatars.py`
reads ONLY this doc (never `personaRegistry.ts`) to assemble each generation
prompt.

Real workflow: `scripts/gen_persona_avatars.py` parses this doc (master style
prompt + per-style demeanor notes + the 24 per-persona descriptor bullets
below), generates a webp for every persona that has no existing
`frontend/src/assets/personas/{persona-id}.webp`, chroma-keys the flat
background to transparency, downscales to 512×512, and writes it there (the
UI paints each persona's style tint behind the transparent avatar). `resolveAvatarSrc()` (`personaAvatars.ts`) globs
`assets/personas/*.webp` at build time, so a curated webp is picked up
automatically — no code change needed. Curation loop: tune a bad avatar by
editing its descriptor line below, delete the stale webp, rerun the script
(it only (re)generates missing files, so deleting is what triggers a redo).

## Master Style Prompt

Match `frontend/public/icons/logo-256.png` — FlawChess's cel-shaded cartoon
detective-horse logo — exactly in rendering style:

> A cel-shaded, friendly cartoon animal portrait in the exact visual style of
> the FlawChess logo: clean bold black outlines, warm flat cel-shading with
> soft gradient highlights, big expressive eyes, a slightly oversized head on
> a compact body, square face-and-shoulders composition (crop at the chest,
> not a full body). The whole head, ears, and any accessories sit fully
> inside the frame with a comfortable margin of empty background on every
> side; only the chest may touch the bottom edge, nothing else is cut off.
> The background is a single flat solid magenta (#FF00FF) with no gradients,
> shadows, or props (it gets chroma-keyed to transparency by the generation
> script). No text or watermark. The animal's expression should signal
> its chess playstyle personality — [insert per-persona demeanor/accessory
> notes below]. Render exactly the accessory (or, where the notes name more
> than one, exactly that set) and nothing beyond it; if the notes say
> "none", the animal wears and holds nothing — no scarf, bandana, collar,
> or clothing of any kind. Warm,
> approachable, a little playful; never sinister or photorealistic.

Per-style demeanor to layer on top of the master prompt:

- **Attacker** — alert, forward-leaning posture, a determined or fired-up
  expression; energetic but never overtly aggressive or scary.
- **Trickster** — a mischievous, crooked grin, one eyebrow slightly raised,
  a sly knowing look.
- **Grinder** — gritty and insistent: brows lowered in concentration, jaw
  set, a stubborn line to the mouth, leaning slightly into the work.
  Weathered, unglamorous, visibly willing to keep at this all day. Dogged
  rather than serene — never placid, sleepy, or merely content.
- **Wall** — composed, unbothered, a small confident smile; a sturdy,
  unshakeable character.

Accessory rule: render EXACTLY the accessory (or set of accessories) named
in the persona's own "Accessory:" note below — nothing else. If it says
"none", the animal wears and holds nothing. Never add a default scarf,
bandana, or collar: each
persona's accessory was picked for roster-wide variety, and generation runs
one persona at a time, so any improvised extra collapses the roster back
into sameness.

Size/age cue: within each style, the low-rung (800) persona should read as
visually smaller/younger and the top-rung (1800) persona larger/more
seasoned — matching the species progression below (D-10).

## Per-Persona Descriptors

Each line: `persona-id — Name the Species — demeanor/accessory notes`.

### Attacker (fiery, forward, aggressive/complicating)

- `attacker-800` — Ziggy the Wasp — small, buzzing energy, big eager eyes;
  reads as scrappy and quick. Accessory: tiny flight goggles pushed up on
  the head. Bio: Ziggy buzzes
  toward your king the moment the position opens, sting first, plan later.
  At this level the checks and captures come fast and reckless — watch for a
  hanging piece mid-swarm.
- `attacker-1000` — Duke the Terrier — a scrappy little dog with a
  determined snarl-grin. Accessory: a collar with a small bone-shaped dog
  tag. Bio: Duke barks first and
  calculates second, snapping up any pawn within reach. He is getting better
  at picking his fights, but a loose piece still tempts him more than it
  should.
- `attacker-1200` — Talon the Falcon — sharp-eyed, alert posture, feathers
  slightly ruffled forward, a focused predator gaze (still friendly, not
  scary). Accessory: none — the ruffled feathers and gaze carry it. Bio: Talon circles quietly before diving — checks and captures are
  chosen, not just thrown. Watch for a sudden pawn storm the moment your king
  looks exposed.
- `attacker-1400` — Fury the Wolverine — compact and tough-looking, a
  confident smirk. Accessory: none — a scar-like marking over one eyebrow
  (not gore) is her only mark. Also reused emoji visually for
  `trickster-1600` (Sly the Coyote) — keep the two portraits visually
  distinct despite the shared 🐺 emoji placeholder. Bio: Fury does not wait for a clean opening; she tears into
  any weakness she can find. Her attacks carry real teeth now, but she can
  still overextend chasing one more sacrifice.
- `attacker-1600` — Butch the Ram — sturdy build with curled horns, a
  charging-forward stance, determined expression. Accessory: a red sports
  headband worn between the horns. Bio: Butch charges with
  real calculation behind the horns, softmax-picking the sharpest line on
  the board. He is comfortable trading material for initiative — and
  usually right to.
- `attacker-1800` — Diesel the Bull — the largest Attacker, powerful build,
  calm-but-intense expression (calculated aggression, not wild). Accessory:
  a small brass nose ring (species-natural). Bio: Diesel
  calculates deep before he charges, and by the time you feel the pressure
  it is already too late to retreat cleanly. He accepts the odd wild
  sacrifice as the price of a relentless attack.

### Trickster (mischievous, sly, complicating/swindling)

- `trickster-800` — Miko the Magpie — small glossy black-and-white bird,
  head cocked. Accessory: a small shiny gold ring held in the beak (a nod
  to "collecting" traps). Bio: Miko loves a shiny trap — Bongclouds, Grobs, anything that looks
  silly but bites back. At this level the traps are simple, but they catch
  more players than you would expect.
- `trickster-1000` — Slinky the Ferret — slender, sneaky-cute pose, one paw
  raised as if about to swipe something. Accessory: a palmed white chess
  pawn half-hidden in the raised paw. Bio: Slinky slips into an odd
  opening and waits to see if you notice. His traps are still fairly easy
  to spot if you are paying attention, but plenty of players are not.
- `trickster-1200` — Vix the Fox — classic sly fox grin. Accessory: a small
  dark bow tie for a touch of charm. Bio: Vix mixes real openings
  with the occasional trick line, keeping you guessing about which game you
  are actually in. She is patient enough to wait for the swindle to ripen.
- `trickster-1400` — Riko the Raccoon — a raccoon with a mischievous mask
  marking (natural to the species) and a knowing smirk. Accessory: a small
  golden pocket watch dangling from one paw. Bio: Riko digs through the position looking for
  something to steal — a fork, a pin, a moment of confusion. He plays a
  real game, but never quite gives up on the trap underneath it.
- `trickster-1600` — Sly the Coyote — lean, alert, a wide toothy grin,
  slightly wild-eyed (swindle-mode energy). Accessory: a slightly tilted
  trilby hat. Bio: Sly enters swindle mode
  here, favoring sharp, high-variance lines that are easy to misplay under
  pressure. She is not always objectively best, but she is very good at
  making you second-guess yourself.
- `trickster-1800` — Cackle the Hyena — the largest Trickster, mid-laugh
  expression, confident and a little chaotic — the "swindle master" vibe.
  Accessory: a monocle over one eye. Bio: Cackle hunts for chaos, steering into the sharpest, most unbalanced
  positions the book allows. By this level the swindles are backed by real
  calculation — underestimate her at your own risk.

### Grinder (steady, methodical, trade-happy)

- `grinder-800` — Pip the Ant — tiny but wiry, straining under the load with
  a fierce little scowl of effort; small and outmatched, and refusing to
  notice. Accessory: carries an oversized white chess pawn (twice her
  size) over one shoulder. Bio: Pip trades pieces the
  moment she gets the chance, happiest when the board is empty and simple.
  She is not fighting for the initiative — she is fighting for the endgame.
- `grinder-1000` — Dig the Mole — round and earthy, dirt on the fur, a
  stubborn squint and a set jaw, paws already dug in and working.
  Accessory: exactly two items and no others — small
  round wire-rim glasses, plus a soft slouched beret tilted on the head.
  Bio: Dig burrows toward a
  simplified position, offering trades whenever the exchange is even. He
  rarely storms forward — he would rather grind you down one pawn at a time.
- `grinder-1200` — Otto the Otter — lean and wiry, wet fur slicked back, a
  narrow-eyed working focus and a set mouth; unhurried but never relaxed.
  Accessory: holds a
  small smooth stone in both paws (a nod to its patient, methodical
  nature). Bio: Otto swims calmly
  toward the endgame, trading down whenever the position allows it. He
  never resigns early, choosing to paddle on even in a difficult position.
- `grinder-1400` — Nell the Penguin — a compact, solidly built emperor
  penguin, chest out and braced as if leaning into a headwind; feathers
  wind-ruffled, eyes narrowed against the cold, beak set in a flat
  determined line. Weathered endurance, not cuteness — she has stood
  through worse than this. Accessory: a faded soot-stained knitted wool
  watch cap pulled down snug over the head. Bio: Nell simply outlasts
  people. She trades down without fuss and settles into the endgame like
  it is the part she was waiting for, unbothered by how long it takes.
- `grinder-1600` — Tank the Ox — sturdy and grounded, built like a soldier;
  pushes the Grinder grit all the way to open aggression: brows pulled
  down hard, jaw set, nostrils flared, a defiant "come and try me" scowl
  (still cartoon-tough, never gory or genuinely menacing). Accessory:
  exactly two items and no others — a military ammunition belt of brass
  cartridges slung diagonally across one shoulder and chest, plus black
  aviator sunglasses. Bio: Tank plows through
  complications by simplifying them away, trading pieces until only the
  essentials remain. He is stubborn in a lost position, playing on long
  past the point most bots would resign.
- `grinder-1800` — Gus the Gorilla — the top-rung Grinder: a massive
  silverback, grizzled grey across the back and shoulders, heavy through
  the arms, knuckles planted and leaning forward into the work; brows low,
  jaw set, an unshakeable "I can do this all day" stare with a seasoned
  veteran's calm behind it. Accessory: exactly two
  items and no others — a necklace of a small bleached animal skull on a
  leather cord hanging at the chest, plus a simple dark tribal tattoo
  marking on one side of the neck (flat black line art on the hide, no
  color). Bio: Gus calculates his way into favorable
  trades, steering the game toward the flat, grounded endgames he measures
  best in. He genuinely enjoys a long fight and will not give up a
  difficult position without one.

### Wall (composed, defensive, simplifying)

- `wall-800` — Sheldon the Snail — small, tucked partly into its shell, a
  content sleepy-eyed expression. Accessory: a tiny striped nightcap
  drooping off the shell. Bio: Sheldon retreats into his shell at
  the first sign of trouble, preferring a slow, solid setup over any early
  adventure. He is happy to trade down toward a draw well before things get
  complicated.
- `wall-1000` — Spike the Hedgehog — round and prickly, curled slightly
  defensive, a small content smile. Accessory: none — the quills are the
  armor. Bio: Spike curls into a tight, prickly
  system and dares you to break through it. He welcomes an early draw more
  readily than most, content to hold rather than fight.
- `wall-1200` — Shelly the Turtle — calm, steady, unbothered expression.
  Accessory: half-moon reading glasses perched low on the nose. Bio: Shelly plays the same fixed system regardless
  of what you throw at her, trading pieces whenever the position allows it.
  She never storms forward — patience is the whole plan.
- `wall-1400` — Bruno the Badger — sturdy, a bit stubborn-looking, a
  settled/planted stance. Accessory: a chunky knitted scarf (the roster's
  only scarf). Bio: Bruno digs into his favorite system
  openings and holds his ground, trading down at every opportunity. He is a
  touch too eager to offer a draw, even from a perfectly fine position.
- `wall-1600` — Rocco the Armadillo — armored and solid, a composed,
  immovable expression — "genuinely difficult to crack." Accessory: none —
  the natural armor plating is the whole statement. Bio:
  Rocco calculates deep to keep everything under control, curling into the
  least chaotic line available whenever the position allows it. By this
  level his system openings and simplifying trades add up to a genuinely
  difficult wall to crack.
- `wall-1800` — Hilda the Hippo — the largest Wall by a wide margin: an
  enormous, heavy-jawed hippo filling the frame, thick grey hide, small
  eyes set high. Serenely unbothered, faintly amused, entirely unmoved —
  the look of something that has never once needed to hurry, and quietly
  knows you cannot shift it. Accessory: a small delicate porcelain teacup
  held daintily in one enormous foot (the comic contrast is the point).
  Bio: Hilda
  calculates carefully to keep the position as flat and quiet as possible,
  smothering complications before they start. She is genuinely comfortable
  steering toward a solid, simplified draw, and by this level she is very
  hard to talk out of one.

## Generating and Curating Avatars

- Run `uv run python scripts/gen_persona_avatars.py` (needs `GOOGLE_API_KEY`
  in `.env`) — it parses this doc, generates a 512×512 webp for every persona
  missing one under `frontend/src/assets/personas/`, and writes it there.
  `--dry-run` lists the pending personas and prints their assembled prompts
  with no API key required; `--limit N` caps the run; `--logo-ref` also
  passes the FlawChess logo as a style-reference image.
- Curate for consistency: delete a bad avatar's `.webp` and rerun the script
  — it only (re)generates missing files, so deleting is what triggers a
  redo. Tune the result by editing that persona's descriptor line above
  first (accessory, expression, size cue), then delete-and-rerun.
- File naming: `frontend/src/assets/personas/{persona-id}.webp`, matching
  `PersonaId` exactly (e.g. `attacker-800.webp`).
- `resolveAvatarSrc()` (`personaAvatars.ts`) globs `assets/personas/*.webp`
  at build time, keyed by the filename stem — a curated webp appears on the
  Bots page automatically, no code change needed. Until a persona's webp
  exists, its card falls back to the D-18 emoji placeholder.
