/**
 * personaRegistry — the 24-slot exhaustive persona registry (Phase 183, D-02,
 * PERS-03) — 4 styles (`Attacker`/`Trickster`/`Grinder`/`Wall`, imported from
 * `styleOpeningLines.ts`) x 6 rungs (800/1000/1200/1400/1600/1800), each
 * slot a complete pinned `BotGameSettings` fragment: `botElo`, `blend`,
 * `style` (a plain `Style` key, resolved by the caller via
 * `BOT_STYLE_BUNDLES[persona.style]` — NEVER embedded/cloned here, Pitfall
 * 4), plus authored identity (`name`/`species`/`bio`/`avatarEmoji`).
 * `PERSONA_REGISTRY` is typed `Record<PersonaId, Persona>` over the
 * template-literal `PersonaId` union, so TypeScript enforces exhaustiveness
 * at compile time — omitting any of the 24 slots is a type error, mirroring
 * `botStyleBundles.ts`'s `Record<Style, BotStyleParams>` convention.
 *
 * Calibration provenance (Phase 184, CAL-04/CAL-05): `botElo` and
 * `calibratedLabel` are sourced per-persona from the generated
 * `frontend/src/generated/personaCalibration.ts` (`PERSONA_CALIBRATION`,
 * keyed by `PersonaId`), produced by `scripts/calibration_persona_fit.py` +
 * `scripts/gen_persona_calibration.py` from the operator-run overnight
 * sweep (`bin/run_persona_calibration_sweep.sh`). `botElo` is the
 * RETARGETED engine-facing ELO input (Phase-181 lookup, D-01) — it is no
 * longer `=== rung`. `calibratedLabel` is the honest, tilde-prefixed,
 * round-50 measured/extrapolated display value a user sees (D-03/D-06/D-07).
 * `rung` is UNCHANGED in meaning: it stays the structural grid-position key
 * this registry is organized by, never a strength value.
 *
 * STALENESS (D-11): changing `botStyleBundles.ts`'s style params or the
 * anchor ladder invalidates this calibration — re-run the persona sweep
 * (`bin/run_persona_calibration_sweep.sh`) and regenerate
 * `personaCalibration.ts` before trusting these values again. No hash-guard
 * automation enforces this; it is a documented operator policy only.
 *
 * Rung -> preset mapping (`RUNG_BLEND`, per `reports/data/bot-strength-lookup.json`'s
 * measured ranges — Human 900-1400, Light 1500-1600, Deep 1600-1800):
 *   800/1000/1200/1400 -> HUMAN_BLEND (no search, raw Maia policy sample)
 *   1600                -> the measured Light/Deep bands overlap exactly at
 *                          this boundary rung, so RUNG_BLEND[1600] holds one
 *                          canonical default (LIGHT_BLEND) for shape
 *                          completeness, but each of the 4 personas AT rung
 *                          1600 picks its own preset explicitly below
 *                          (Claude's discretion, justified per-style in the
 *                          persona's own doc comment) — RUNG_BLEND[1600]
 *                          alone is not read by every 1600-rung entry.
 *   1800                -> DEEP_BLEND (Deep's measured ceiling, per the
 *                          milestone's strength-honesty constraint)
 */

import type { Style } from '@/lib/engine/styleOpeningLines';
import { HUMAN_BLEND, LIGHT_BLEND, DEEP_BLEND } from '@/lib/playStyle';
import { PERSONA_CALIBRATION } from '@/generated/personaCalibration';
// quick-260722-ucc: matches PERSONA_CALIBRATION's `label` shape — a tilde
// followed by an integer (e.g. "~800", "~1850"). Named so the parse intent
// reads clearly at the call site rather than a bare regex literal.
const CALIBRATED_LABEL_INTEGER_PATTERN = /\d+/;
// Type-only import: `verbatimModuleSyntax` (tsconfig.app.json) erases this at
// compile time, so it introduces no runtime circular dependency even though
// `useBotGame.ts` also imports `PersonaId` from this module.
import type { BotGameSettings } from '@/hooks/useBotGame';

/** The 6 ELO rungs every style ships (200-ELO steps, 800-1800). */
export type Rung = 800 | 1000 | 1200 | 1400 | 1600 | 1800;

/** All 6 rungs, ascending — the single source of truth `personasForSection`
 * and the registry-construction helpers below iterate over. Exported
 * (Phase 185) so `PersonaGrid` can iterate rung-rows without duplicating
 * this ordering. */
export const RUNGS: readonly Rung[] = [800, 1000, 1200, 1400, 1600, 1800];

/** Derived persona id: `${lowercase style}-${rung}`, e.g. `'attacker-800'`,
 * `'trickster-1600'`. A template-literal type over `Style`/`Rung` so every
 * valid id is enumerable and a typo is a compile error. */
export type PersonaId = `${Lowercase<Style>}-${Rung}`;

/** A single persona slot: a complete, named, pinned opponent identity. */
export interface Persona {
  id: PersonaId;
  style: Style;
  rung: Rung;
  /** Engine-facing ELO input — RETARGETED per the persona's own preset via
   * the Phase-181 lookup (see the calibration-provenance note above), read
   * from `PERSONA_CALIBRATION[id].botElo`. No longer `=== rung`. */
  botElo: number;
  /** Honest, tilde-prefixed, round-50 measured/extrapolated display label
   * (D-03/D-06/D-07), read from `PERSONA_CALIBRATION[id].label`. This is
   * what `PersonaCard`/`PersonaDetailSurface` render — never `~${rung}`. */
  calibratedLabel: string;
  /** The search-preset blend (`HUMAN_BLEND` / `LIGHT_BLEND` / `DEEP_BLEND` —
   * see `playStyle.ts`). Always one of those 3 named constants, never a raw
   * literal, so a persona's preset is traceable back to its named regime. */
  blend: number;
  name: string;
  species: string;
  bio: string;
  /** Placeholder-avatar glyph (D-18) — species-appropriate emoji rendered on
   * the persona's per-style tint (`personaAvatars.ts`). */
  avatarEmoji: string;
  /**
   * Forward-compat only (D-17, RESEARCH.md Pitfall 6): reserved for the
   * future real-art PR's Vite-imported WebP portrait path
   * (`frontend/src/assets/personas/{persona-id}.webp`). No import machinery
   * is built this phase — every persona below omits this field, so it is
   * always `undefined` today. `personaAvatars.ts`'s `resolveAvatarSrc`
   * consumes it as the single seam the future PR will need to touch.
   */
  avatarSrc?: string;
}

/**
 * Rung -> preset blend lookup. `Record<Rung, number>` enforces every rung
 * resolves to SOME defined blend (PERS-03) even though, per the header note,
 * `RUNG_BLEND[1600]` is a canonical default rather than a value every
 * 1600-rung persona actually reads (those pick explicitly, justified inline
 * per persona below).
 */
export const RUNG_BLEND: Record<Rung, number> = {
  800: HUMAN_BLEND,
  1000: HUMAN_BLEND,
  1200: HUMAN_BLEND,
  1400: HUMAN_BLEND,
  1600: LIGHT_BLEND,
  1800: DEEP_BLEND,
};

/** Builds a persona's derived id from its style + rung — the single place
 * the `${lowercase}-${rung}` shape is constructed, so every entry below and
 * every test stay in lockstep. */
function personaId(style: Style, rung: Rung): PersonaId {
  return `${style.toLowerCase() as Lowercase<Style>}-${rung}`;
}

// ─── Attacker — Wasp -> Terrier -> Falcon -> Wolverine -> Ram -> Bull ──────
// Small, fast, biting animals at the low rungs growing into larger,
// full-force chargers at the top — matches the style's aggressive,
// complicating identity (D-10 size-ladder convention).

const ATTACKER_PERSONAS: Record<`attacker-${Rung}`, Persona> = {
  'attacker-800': {
    id: personaId('Attacker', 800),
    style: 'Attacker',
    rung: 800,
    botElo: PERSONA_CALIBRATION['attacker-800'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['attacker-800'].label,
    blend: RUNG_BLEND[800],
    name: 'Ziggy the Wasp',
    species: 'Wasp',
    bio: 'Ziggy buzzes toward your king the moment the position opens, sting first, plan later. At this level the checks and captures come fast and reckless — watch for a hanging piece mid-swarm.',
    avatarEmoji: '🐝',
  },
  'attacker-1000': {
    id: personaId('Attacker', 1000),
    style: 'Attacker',
    rung: 1000,
    botElo: PERSONA_CALIBRATION['attacker-1000'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['attacker-1000'].label,
    blend: RUNG_BLEND[1000],
    name: 'Duke the Terrier',
    species: 'Terrier',
    bio: 'Duke barks first and calculates second, snapping up any pawn within reach. He is getting better at picking his fights, but a loose piece still tempts him more than it should.',
    avatarEmoji: '🐕',
  },
  'attacker-1200': {
    id: personaId('Attacker', 1200),
    style: 'Attacker',
    rung: 1200,
    botElo: PERSONA_CALIBRATION['attacker-1200'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['attacker-1200'].label,
    blend: RUNG_BLEND[1200],
    name: 'Talon the Falcon',
    species: 'Falcon',
    bio: 'Talon circles quietly before diving — checks and captures are chosen, not just thrown. Watch for a sudden pawn storm the moment your king looks exposed.',
    avatarEmoji: '🦅',
  },
  'attacker-1400': {
    id: personaId('Attacker', 1400),
    style: 'Attacker',
    rung: 1400,
    botElo: PERSONA_CALIBRATION['attacker-1400'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['attacker-1400'].label,
    blend: RUNG_BLEND[1400],
    name: 'Fury the Wolverine',
    species: 'Wolverine',
    bio: 'Fury does not wait for a clean opening; she tears into any weakness she can find. Her attacks carry real teeth now, but she can still overextend chasing one more sacrifice.',
    avatarEmoji: '🐺',
  },
  // 1600 -> Light (Claude's discretion): an attacker's identity is carried
  // mostly by the feature multipliers + gambit book, not by heavy search —
  // Light keeps the pace sharp without slowing into a calculating Deep bot.
  'attacker-1600': {
    id: personaId('Attacker', 1600),
    style: 'Attacker',
    rung: 1600,
    botElo: PERSONA_CALIBRATION['attacker-1600'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['attacker-1600'].label,
    blend: LIGHT_BLEND,
    name: 'Butch the Ram',
    species: 'Ram',
    bio: 'Butch charges with real calculation behind the horns, softmax-picking the sharpest line on the board. He is comfortable trading material for initiative — and usually right to.',
    avatarEmoji: '🐏',
  },
  'attacker-1800': {
    id: personaId('Attacker', 1800),
    style: 'Attacker',
    rung: 1800,
    botElo: PERSONA_CALIBRATION['attacker-1800'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['attacker-1800'].label,
    blend: RUNG_BLEND[1800],
    name: 'Diesel the Bull',
    species: 'Bull',
    bio: 'Diesel calculates deep before he charges, and by the time you feel the pressure it is already too late to retreat cleanly. He accepts the odd wild sacrifice as the price of a relentless attack.',
    avatarEmoji: '🐂',
  },
};

// ─── Trickster — Magpie -> Ferret -> Fox -> Raccoon -> Coyote -> Hyena ─────
// Cheap trap lines at the low rungs, full swindle mode + high variance from
// 1600 up (SEED-098's "swindle mode + high variance at 1600+").

const TRICKSTER_PERSONAS: Record<`trickster-${Rung}`, Persona> = {
  'trickster-800': {
    id: personaId('Trickster', 800),
    style: 'Trickster',
    rung: 800,
    botElo: PERSONA_CALIBRATION['trickster-800'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['trickster-800'].label,
    blend: RUNG_BLEND[800],
    name: 'Miko the Magpie',
    species: 'Magpie',
    bio: 'Miko loves a shiny trap — Bongclouds, Grobs, anything that looks silly but bites back. At this level the traps are simple, but they catch more players than you would expect.',
    avatarEmoji: '🐦',
  },
  'trickster-1000': {
    id: personaId('Trickster', 1000),
    style: 'Trickster',
    rung: 1000,
    botElo: PERSONA_CALIBRATION['trickster-1000'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['trickster-1000'].label,
    blend: RUNG_BLEND[1000],
    name: 'Slinky the Ferret',
    species: 'Ferret',
    bio: 'Slinky slips into an odd opening and waits to see if you notice. His traps are still fairly easy to spot if you are paying attention, but plenty of players are not.',
    avatarEmoji: '🐿️',
  },
  'trickster-1200': {
    id: personaId('Trickster', 1200),
    style: 'Trickster',
    rung: 1200,
    botElo: PERSONA_CALIBRATION['trickster-1200'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['trickster-1200'].label,
    blend: RUNG_BLEND[1200],
    name: 'Vix the Fox',
    species: 'Fox',
    bio: 'Vix mixes real openings with the occasional trick line, keeping you guessing about which game you are actually in. She is patient enough to wait for the swindle to ripen.',
    avatarEmoji: '🦊',
  },
  'trickster-1400': {
    id: personaId('Trickster', 1400),
    style: 'Trickster',
    rung: 1400,
    botElo: PERSONA_CALIBRATION['trickster-1400'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['trickster-1400'].label,
    blend: RUNG_BLEND[1400],
    name: 'Riko the Raccoon',
    species: 'Raccoon',
    bio: 'Riko digs through the position looking for something to steal — a fork, a pin, a moment of confusion. He plays a real game, but never quite gives up on the trap underneath it.',
    avatarEmoji: '🦝',
  },
  // 1600 -> Deep (Claude's discretion): SEED-098's "swindle mode + high
  // variance at 1600+" reads as needing real search to conjure a genuine
  // swindle chance, not just book knowledge — Deep pairs the highest
  // varianceBonus of the 4 styles with the calculation to exploit it.
  'trickster-1600': {
    id: personaId('Trickster', 1600),
    style: 'Trickster',
    rung: 1600,
    botElo: PERSONA_CALIBRATION['trickster-1600'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['trickster-1600'].label,
    blend: DEEP_BLEND,
    name: 'Sly the Coyote',
    species: 'Coyote',
    bio: 'Sly enters swindle mode here, favoring sharp, high-variance lines that are easy to misplay under pressure. She is not always objectively best, but she is very good at making you second-guess yourself.',
    avatarEmoji: '🐺',
  },
  'trickster-1800': {
    id: personaId('Trickster', 1800),
    style: 'Trickster',
    rung: 1800,
    botElo: PERSONA_CALIBRATION['trickster-1800'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['trickster-1800'].label,
    blend: RUNG_BLEND[1800],
    name: 'Cackle the Hyena',
    species: 'Hyena',
    bio: 'Cackle hunts for chaos, steering into the sharpest, most unbalanced positions the book allows. By this level the swindles are backed by real calculation — underestimate her at your own risk.',
    avatarEmoji: '🐆',
  },
};

// ─── Grinder — Ant -> Mole -> Otter -> Penguin -> Ox -> Gorilla ───────────
// Trade-happy, steers toward simplified endgames, never resigns early
// (SEED-098: "playing it trains exactly what FlawChess measures").

const GRINDER_PERSONAS: Record<`grinder-${Rung}`, Persona> = {
  'grinder-800': {
    id: personaId('Grinder', 800),
    style: 'Grinder',
    rung: 800,
    botElo: PERSONA_CALIBRATION['grinder-800'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['grinder-800'].label,
    blend: RUNG_BLEND[800],
    name: 'Pip the Ant',
    species: 'Ant',
    bio: 'Pip trades pieces the moment she gets the chance, happiest when the board is empty and simple. She is not fighting for the initiative — she is fighting for the endgame.',
    avatarEmoji: '🐜',
  },
  'grinder-1000': {
    id: personaId('Grinder', 1000),
    style: 'Grinder',
    rung: 1000,
    botElo: PERSONA_CALIBRATION['grinder-1000'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['grinder-1000'].label,
    blend: RUNG_BLEND[1000],
    name: 'Dig the Mole',
    species: 'Mole',
    bio: 'Dig burrows toward a simplified position, offering trades whenever the exchange is even. He rarely storms forward — he would rather grind you down one pawn at a time.',
    avatarEmoji: '🐹',
  },
  'grinder-1200': {
    id: personaId('Grinder', 1200),
    style: 'Grinder',
    rung: 1200,
    botElo: PERSONA_CALIBRATION['grinder-1200'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['grinder-1200'].label,
    blend: RUNG_BLEND[1200],
    name: 'Otto the Otter',
    species: 'Otter',
    bio: 'Otto swims calmly toward the endgame, trading down whenever the position allows it. He never resigns early, choosing to paddle on even in a difficult position.',
    avatarEmoji: '🦦',
  },
  'grinder-1400': {
    id: personaId('Grinder', 1400),
    style: 'Grinder',
    rung: 1400,
    botElo: PERSONA_CALIBRATION['grinder-1400'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['grinder-1400'].label,
    blend: RUNG_BLEND[1400],
    name: 'Nell the Penguin',
    species: 'Penguin',
    bio: 'Nell simply outlasts people. She trades down without fuss and settles into the endgame like it is the part she was waiting for, unbothered by how long it takes.',
    avatarEmoji: '🐧',
  },
  // 1600 -> Deep (Claude's discretion): Grinder's identity is fundamentally
  // calculation-driven (steering toward favorable trades and endgames), so
  // pairing it with heavier search fits better than the lighter Light preset.
  'grinder-1600': {
    id: personaId('Grinder', 1600),
    style: 'Grinder',
    rung: 1600,
    botElo: PERSONA_CALIBRATION['grinder-1600'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['grinder-1600'].label,
    blend: DEEP_BLEND,
    name: 'Tank the Ox',
    species: 'Ox',
    bio: 'Tank plows through complications by simplifying them away, trading pieces until only the essentials remain. He is stubborn in a lost position, playing on long past the point most bots would resign.',
    avatarEmoji: '🐂',
  },
  'grinder-1800': {
    id: personaId('Grinder', 1800),
    style: 'Grinder',
    rung: 1800,
    botElo: PERSONA_CALIBRATION['grinder-1800'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['grinder-1800'].label,
    blend: RUNG_BLEND[1800],
    name: 'Gus the Gorilla',
    species: 'Gorilla',
    bio: 'Gus calculates his way into favorable trades, steering the game toward the flat, grounded endgames he measures best in. He genuinely enjoys a long fight and will not give up a difficult position without one.',
    avatarEmoji: '🦍',
  },
};

// ─── Wall — Snail -> Hedgehog -> Turtle -> Badger -> Armadillo -> Hippo ───
// Fixed system openings, simplifying trades, welcomes an early draw a bit
// more readily than dead-equal (D-09).

const WALL_PERSONAS: Record<`wall-${Rung}`, Persona> = {
  'wall-800': {
    id: personaId('Wall', 800),
    style: 'Wall',
    rung: 800,
    botElo: PERSONA_CALIBRATION['wall-800'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['wall-800'].label,
    blend: RUNG_BLEND[800],
    name: 'Sheldon the Snail',
    species: 'Snail',
    bio: 'Sheldon retreats into his shell at the first sign of trouble, preferring a slow, solid setup over any early adventure. He is happy to trade down toward a draw well before things get complicated.',
    avatarEmoji: '🐌',
  },
  'wall-1000': {
    id: personaId('Wall', 1000),
    style: 'Wall',
    rung: 1000,
    botElo: PERSONA_CALIBRATION['wall-1000'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['wall-1000'].label,
    blend: RUNG_BLEND[1000],
    name: 'Spike the Hedgehog',
    species: 'Hedgehog',
    bio: 'Spike curls into a tight, prickly system and dares you to break through it. He welcomes an early draw more readily than most, content to hold rather than fight.',
    avatarEmoji: '🦔',
  },
  'wall-1200': {
    id: personaId('Wall', 1200),
    style: 'Wall',
    rung: 1200,
    botElo: PERSONA_CALIBRATION['wall-1200'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['wall-1200'].label,
    blend: RUNG_BLEND[1200],
    name: 'Shelly the Turtle',
    species: 'Turtle',
    bio: 'Shelly plays the same fixed system regardless of what you throw at her, trading pieces whenever the position allows it. She never storms forward — patience is the whole plan.',
    avatarEmoji: '🐢',
  },
  'wall-1400': {
    id: personaId('Wall', 1400),
    style: 'Wall',
    rung: 1400,
    botElo: PERSONA_CALIBRATION['wall-1400'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['wall-1400'].label,
    blend: RUNG_BLEND[1400],
    name: 'Bruno the Badger',
    species: 'Badger',
    bio: 'Bruno digs into his favorite system openings and holds his ground, trading down at every opportunity. He is a touch too eager to offer a draw, even from a perfectly fine position.',
    avatarEmoji: '🦡',
  },
  // 1600 -> Light (Claude's discretion): Wall's identity is carried mainly by
  // its system book + simplifying trades rather than deep calculation, so
  // the lighter preset is the better fit — Deep is reserved for the 1800
  // ceiling where "genuinely difficult wall to crack" needs real depth.
  'wall-1600': {
    id: personaId('Wall', 1600),
    style: 'Wall',
    rung: 1600,
    botElo: PERSONA_CALIBRATION['wall-1600'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['wall-1600'].label,
    blend: LIGHT_BLEND,
    name: 'Rocco the Armadillo',
    species: 'Armadillo',
    bio: 'Rocco calculates deep to keep everything under control, curling into the least chaotic line available whenever the position allows it. By this level his system openings and simplifying trades add up to a genuinely difficult wall to crack.',
    avatarEmoji: '🐢',
  },
  'wall-1800': {
    id: personaId('Wall', 1800),
    style: 'Wall',
    rung: 1800,
    botElo: PERSONA_CALIBRATION['wall-1800'].botElo,
    calibratedLabel: PERSONA_CALIBRATION['wall-1800'].label,
    blend: RUNG_BLEND[1800],
    name: 'Hilda the Hippo',
    species: 'Hippo',
    bio: 'Hilda calculates carefully to keep the position as flat and quiet as possible, smothering complications before they start. She is genuinely comfortable steering toward a solid, simplified draw, and by this level she is very hard to talk out of one.',
    avatarEmoji: '🦛',
  },
};

/**
 * The exhaustive 24-slot registry. `Record<PersonaId, Persona>` — TypeScript
 * enforces every one of the 24 template-literal ids is present; omitting a
 * slot is a compile error, mirroring `BOT_STYLE_BUNDLES`'s exhaustiveness
 * guarantee.
 */
export const PERSONA_REGISTRY: Record<PersonaId, Persona> = {
  ...ATTACKER_PERSONAS,
  ...TRICKSTER_PERSONAS,
  ...GRINDER_PERSONAS,
  ...WALL_PERSONAS,
};

/** Section display order for the Bots page grid (D-02/D-14): "Wall", never
 * "Solid Wall"/"Great Wall". */
export const STYLE_SECTION_ORDER: readonly Style[] = ['Attacker', 'Trickster', 'Grinder', 'Wall'];

/** Returns `style`'s 6 personas ascending by rung (800 -> 1800). */
export function personasForSection(style: Style): Persona[] {
  return RUNGS.map((rung) => PERSONA_REGISTRY[personaId(style, rung)]);
}

/**
 * Rung-major accessor (Phase 185, transposed grid): returns the 4 personas
 * AT `rung`, one per style, in `STYLE_SECTION_ORDER` order. Mirrors
 * `personasForSection`'s abstraction level so `PersonaGrid` can iterate
 * `RUNGS` (rows) outer x this (columns) inner without ever touching
 * `PERSONA_REGISTRY` directly (Pitfall 1).
 */
export function personasForRung(rung: Rung): Persona[] {
  return STYLE_SECTION_ORDER.map((style) => PERSONA_REGISTRY[personaId(style, rung)]);
}

/**
 * Plain guarded object-index lookup (T-183-02, RESEARCH.md): never throws,
 * never uses a dynamic `require`/`eval`. An unrecognized or `undefined` id
 * resolves to `undefined` — every downstream consumer (clock strip, draw
 * banner, result surfaces) null-coalesces to an unstyled fallback.
 */
export function personaForId(id: PersonaId | string | undefined): Persona | undefined {
  if (id === undefined) return undefined;
  return (PERSONA_REGISTRY as Record<string, Persona>)[id];
}

/**
 * quick-260722-ucc: extracts the persona's CALIBRATED ELO (the honest ~label
 * value a user sees, e.g. `~800` -> `800`) from `calibratedLabel` — NOT
 * `botElo`, which is the retargeted internal engine dial (e.g. `attacker-800`
 * has `botElo: 1100`). All 25 labels in `personaCalibration.ts` are a tilde
 * plus an integer, so a single digit-run match is sufficient; falls back to
 * `botElo` on the (currently unreachable) no-match case rather than NaN.
 */
export function personaCalibratedElo(persona: Persona): number {
  const match = persona.calibratedLabel.match(CALIBRATED_LABEL_INTEGER_PATTERN);
  if (match === null) return persona.botElo;
  return Number(match[0]);
}

/**
 * The ONE shared `settings.personaId -> Persona` lookup (Phase 183 Plan 05,
 * T-183-12) — every in-game/result-surface consumer (clock strip, draw
 * banner, result copy) calls this instead of re-implementing the
 * `settings.personaId ? PERSONA_REGISTRY[...] : undefined` ternary inline.
 * Returns `undefined` for a Custom-mode game (`personaId` unset) or an
 * unrecognized/removed id (`personaForId`'s existing guarded-lookup
 * contract) — every caller null-coalesces to the generic fallback.
 */
export function personaFor(settings: BotGameSettings): Persona | undefined {
  return settings.personaId ? personaForId(settings.personaId) : undefined;
}
