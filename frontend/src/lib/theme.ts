/**
 * Centralized theme constants.
 * Board square colors, primary accent colors, WDL colors, semantic zone colors, etc.
 * — single source of truth so branding changes only need one edit.
 */

// Board square colors (warm wood tones)
export const BOARD_DARK_SQUARE = '#B68965';
export const BOARD_LIGHT_SQUARE = '#F0DAB7';

export const darkSquareStyle = { backgroundColor: BOARD_DARK_SQUARE } as const;
export const lightSquareStyle = { backgroundColor: BOARD_LIGHT_SQUARE } as const;

// Move from/to square highlight (translucent yellow) — shared by the Openings
// ChessBoard last-move highlight and the Library eval-chart MiniBoard scrub.
export const MOVE_HIGHLIGHT_SQUARE = 'rgba(255, 255, 0, 0.35)';

// Analysis-board last-move overlay, colored by the played move's severity
// (Quick 260627-r9g item 5): red blunder, orange mistake, yellow inaccuracy
// (the shared MOVE_HIGHLIGHT_SQUARE), green for a clean move. Same hues as the
// SEV_* palette at the 0.35 alpha of the legacy yellow so all four read evenly.
export const MOVE_HIGHLIGHT_BLUNDER = 'oklch(0.58 0.19 25 / 0.35)';
export const MOVE_HIGHLIGHT_MISTAKE = 'oklch(0.70 0.16 55 / 0.35)';
export const MOVE_HIGHLIGHT_GOOD = 'oklch(0.55 0.16 145 / 0.35)';
// Gem/great last-move square highlight — the badge accent hues (MAIA_ACCENT
// violet / GREAT_ACCENT blue) at the same 0.35 alpha as the severity/good
// highlights above, so a scrubbed gem/great move's squares read in its own
// badge color instead of the generic "clean move" green.
export const MOVE_HIGHLIGHT_GEM = 'oklch(0.58 0.20 290 / 0.35)';
export const MOVE_HIGHLIGHT_GREAT = 'oklch(0.58 0.18 220 / 0.35)';
// Engine-line last-move square highlight (Train reveal stepping, 190.1 UAT):
// the engine-pointer blue (BEST_MOVE_ARROW's hue) at the same 0.35 alpha as
// the other MOVE_HIGHLIGHT_* overlays, so a stepped engine move's squares
// read as "engine line", not as a played-move verdict color.
export const MOVE_HIGHLIGHT_BEST = 'rgba(37, 99, 235, 0.35)';

// WDL colors — used in all win/draw/loss visualizations
// Richer base colors; the glass overlay softens them visually when applied
export const WDL_WIN = 'oklch(0.50 0.14 145)';
export const WDL_DRAW = 'oklch(0.60 0.02 260)';
export const WDL_LOSS = 'oklch(0.50 0.15 25)';

// Celebration confetti palette — a mixed, festive set for the bot-win confetti
// burst (Quick 260723-tqn). MUST be plain hex: canvas-confetti parses colors by
// stripping every non-hex char from the string, so oklch()/named colors are
// silently mangled into muddy browns (its hexToRgb only understands hex). Kept
// here so the celebration palette lives with the other colors, not hardcoded at
// the call site. Bright green + gold + amber + blue + pink + violet so the burst
// reads as a rainbow celebration rather than a single flat hue.
export const CONFETTI_COLORS = [
  '#22C55E', // green (win)
  '#FFD700', // gold
  '#FF9E1B', // amber
  '#3B9EFF', // blue
  '#FF5DA2', // pink
  '#A970FF', // violet
];

// Solid WDL accent borders (e.g. game card left edges).
// Matched to the strength/weakness card severity palette in arrowColor.ts.
export const WDL_BORDER_WIN = '#036C22';
export const WDL_BORDER_DRAW = '#6B7280';
export const WDL_BORDER_LOSS = '#9E2020';

// Severity colors (B/M/I — flaw stats panel and library game cards, Phase 107)
export const SEV_BLUNDER = 'oklch(0.58 0.19 25)';
export const SEV_MISTAKE = 'oklch(0.70 0.16 55)';
export const SEV_INACCURACY = 'oklch(0.82 0.13 95)';

// Severity pill composites — the same oklch hues at 14% (background) and 30%
// (border) alpha. Shared by the severity count badges (SeverityBadge) and the
// severity filter toggles (FlawFilterControl) so both read as one colored pill.
export const SEV_BLUNDER_BG = 'oklch(0.58 0.19 25 / 0.14)';
export const SEV_MISTAKE_BG = 'oklch(0.70 0.16 55 / 0.14)';
export const SEV_INACCURACY_BG = 'oklch(0.82 0.13 95 / 0.14)';
export const SEV_BLUNDER_BORDER = 'oklch(0.58 0.19 25 / 0.30)';
export const SEV_MISTAKE_BORDER = 'oklch(0.70 0.16 55 / 0.30)';
export const SEV_INACCURACY_BORDER = 'oklch(0.82 0.13 95 / 0.30)';

// Eval chart area fill and line colors (Phase 109 — EvalChart.tsx).
// White-ahead region (above midline) = lighter grey; black-ahead region
// (below midline) = dark grey, mirroring the white/black pieces.
export const EVAL_CHART_AREA_WHITE_AHEAD = 'oklch(0.78 0 0)';
export const EVAL_CHART_AREA_BLACK_AHEAD = 'oklch(0.32 0 0)';

// EvalBar semantic re-exports (Phase 137 — EvalBar.tsx).
// The analysis board's vertical centipawn bar shares the same palette as the
// eval chart: white-ahead fill on top, black-ahead fill on bottom.
export const EVAL_BAR_WHITE = EVAL_CHART_AREA_WHITE_AHEAD;
export const EVAL_BAR_BLACK = EVAL_CHART_AREA_BLACK_AHEAD;

// Analysis eval-bar source accents (Phase 151.1 UAT). The two bars flanking the
// analysis board are color-coded by their source so the pair is legible at a
// glance: Stockfish (blue) on the right, Maia human-model (red) on the left. The
// accent tints the bar's advantage fill + frame, the source's card-header caption,
// and the small "SF"/"Maia" cap rendered above each bar.
export const STOCKFISH_ACCENT = 'oklch(0.58 0.16 255)'; // blue
// Violet (not red): red/orange/yellow read as move-quality severity, teal/crimson are
// the missed/allowed tactic arrows, and blue is Stockfish — violet sits in the one open
// hue gap and reads as a distinct "human" identity (151.1 UAT).
export const MAIA_ACCENT = 'oklch(0.58 0.20 290)'; // violet
// Gem-tier pill background (Phase 175, FILT-01) — same hue as MAIA_ACCENT at the
// same 14% alpha as the SEV_*_BG severity-pill composites, for the "has gem"
// Library filter toggle (FlawFilterControl) to read as one colored pill family
// with the severity/tag toggles it sits alongside.
export const MAIA_ACCENT_BG = 'oklch(0.58 0.20 290 / 0.14)';
// Great-move corner-marker identity color (Phase 175, SEED-108 D-01/D-02). The
// "great" tier sits one step below gem in the maia_prob band (0.20, 0.50] —
// a distinct blue hue (not gem's violet 290, not Stockfish's 255, not the
// desaturated Book blue 250) so all four board-marker identities read apart
// even though three share the "cool" family. Hue 220 + a higher chroma than
// Book's 0.04 keeps it legible as an alert-tier badge, not a muted context
// marker.
export const GREAT_ACCENT = 'oklch(0.58 0.18 220)'; // blue
// Great-tier pill background — same hue as GREAT_ACCENT, same 14% alpha
// convention as MAIA_ACCENT_BG/SEV_*_BG, for the "has great" Library filter toggle.
export const GREAT_ACCENT_BG = 'oklch(0.58 0.18 220 / 0.14)';
// FlawChess Engine source accent (Phase 155, D-05; 156 UAT: brown → gold). Tints
// the FlawChessEngineLines card frame + header caption + "FC" eval-bar fill/cap —
// the third source alongside Stockfish (blue) and Maia (violet). Gold/amber (not the
// app's brand brown) gives the house engine a warm identity that's clearly distinct
// from Stockfish's cold blue and doesn't collide with the brand-brown primary UI.
// Rendered as colored text/elements on the dark card, so a bright gold is legible.
export const FLAWCHESS_ENGINE_ACCENT = 'oklch(0.78 0.14 80)'; // gold/amber
// FlawChess Engine practical-score badge shades (155 UAT; 156 UAT: brown → gold).
// Three gold shades keyed by practical rank (best / 2nd / 3rd), the gold analog of the
// blue Stockfish best/2nd badges — all filled with WHITE text, so they stay dark enough
// (matching the prior brown shades' white-text contrast ~6.9/5.4/4.2) to carry it. Rank 1
// is darkest and most saturated so the top line reads strongest.
export const FLAWCHESS_ENGINE_BADGE_SHADES = [
  'oklch(0.47 0.13 80)', // best
  'oklch(0.53 0.12 80)', // second
  'oklch(0.59 0.10 80)', // third
] as const;
// Book/opening-theory corner-marker identity color (Phase 172, SEED-106 D-08).
// Chroma 0.04 is deliberately the LOWEST of any corner-marker hue (gem 0.20,
// Stockfish 0.16, FlawChess 0.14, severities 0.13-0.19), so the book badge
// visually recedes behind every alert/insight badge — it marks context
// ("this ply is opening theory"), not a signal worth alarm. Hue 250 sits in
// the cool-blue family without colliding with Stockfish's 255. Reserved
// EXCLUSIVELY for the book/opening-theory marker family (BookIcon +
// boardMarkers's book branch) — never reuse as a general-purpose muted blue.
export const BOOK_MARKER_COLOR = 'oklch(0.60 0.04 250)';
export const EVAL_CHART_LINE = 'oklch(0.82 0 0)';
// Muted grey for the rotated "Midgame" / "Endgame" text labels centered on the
// phase boundaries — legible over both the light and dark eval-bar regions.
export const EVAL_CHART_PHASE_LABEL = 'oklch(0.65 0 0)';
// White outline drawn around eval-chart flaw markers whose tags match an active
// flaw-tag filter (mirrors the TagChip active-filter ring, on the chart).
export const EVAL_MARKER_FILTER_OUTLINE = 'oklch(1 0 0)';
// Eval-chart scrub cursor: the vertical crosshair line and the active-ply dot.
// Matches --foreground in forced dark mode, i.e. the same near-white as the
// scrub slider's `bg-foreground` thumb, so cursor and knob read as one control.
export const EVAL_CHART_CURSOR = 'oklch(0.985 0 0)';

// Tag families (flaw chip color-by-family, Phase 107).
// Phase 126 UAT: every flaw family now renders in a single neutral light grey
// (the same grey as the white-ahead eval-chart area) so only the new tactic-motif
// families (TAC_* below) carry distinct hue and stand out. The per-family constant
// names are kept (each family still has its own constant) — only the values changed
// to grey. This applies everywhere FAM_* is consumed: the tag chips, the Tags/eval
// tooltips, the you-vs-opponent Flaw Comparison grid, and the Flaws filter panel.
const FAM_NEUTRAL = EVAL_CHART_AREA_WHITE_AHEAD; // 'oklch(0.78 0 0)'
const FAM_NEUTRAL_BG = 'oklch(0.78 0 0 / 0.15)';
export const FAM_TEMPO = FAM_NEUTRAL;
export const FAM_TEMPO_BG = FAM_NEUTRAL_BG;
export const FAM_OPPORTUNITY = FAM_NEUTRAL;
export const FAM_OPPORTUNITY_BG = FAM_NEUTRAL_BG;
export const FAM_IMPACT = FAM_NEUTRAL;
export const FAM_IMPACT_BG = FAM_NEUTRAL_BG;
export const FAM_SEVERITY = FAM_NEUTRAL;
export const FAM_SEVERITY_BG = FAM_NEUTRAL_BG;
export const FAM_PHASE = FAM_NEUTRAL;
export const FAM_PHASE_BG = FAM_NEUTRAL_BG;
export const FAM_COMBO = FAM_NEUTRAL;
export const FAM_COMBO_BG = FAM_NEUTRAL_BG;

// Tactic motif family colors (Phase 126, updated Phase 129).
// Phase 126 UAT: every tactic family renders in a single blue (indigo) so all
// tactic families read as one consistent group. The per-family constant names
// exist only so consumers key by family name — the values all alias the shared
// TAC_BLUE. Do not introduce distinct hues; the single-blue convention is
// intentional. Phase 129: rekey to the 10-family taxonomy (plan 129-04 contract).
// Cross-stack contract: TAC_* names match the backend FAMILY_TO_MOTIF_INTS keys.
const TAC_BLUE = 'oklch(0.68 0.16 240)'; // indigo
const TAC_BLUE_BG = 'oklch(0.68 0.16 240 / 0.15)';
export const TAC_FORK = TAC_BLUE;
export const TAC_FORK_BG = TAC_BLUE_BG;
export const TAC_SKEWER = TAC_BLUE;
export const TAC_SKEWER_BG = TAC_BLUE_BG;
export const TAC_PIN = TAC_BLUE;
export const TAC_PIN_BG = TAC_BLUE_BG;
export const TAC_X_RAY = TAC_BLUE;
export const TAC_X_RAY_BG = TAC_BLUE_BG;
export const TAC_DOUBLE_CHECK = TAC_BLUE;
export const TAC_DOUBLE_CHECK_BG = TAC_BLUE_BG;
export const TAC_DISCOVERED_CHECK = TAC_BLUE;
export const TAC_DISCOVERED_CHECK_BG = TAC_BLUE_BG;
export const TAC_DISCOVERED_ATTACK = TAC_BLUE;
export const TAC_DISCOVERED_ATTACK_BG = TAC_BLUE_BG;
export const TAC_TRAPPED_PIECE = TAC_BLUE;
export const TAC_TRAPPED_PIECE_BG = TAC_BLUE_BG;
export const TAC_HANGING = TAC_BLUE;
export const TAC_HANGING_BG = TAC_BLUE_BG;
export const TAC_MATE = TAC_BLUE;
export const TAC_MATE_BG = TAC_BLUE_BG;
// Tier-3 "Advanced" families (Quick 260623-6pd). Same single-blue convention as above.
export const TAC_DEFLECTION = TAC_BLUE;
export const TAC_DEFLECTION_BG = TAC_BLUE_BG;
export const TAC_INTERMEZZO = TAC_BLUE;
export const TAC_INTERMEZZO_BG = TAC_BLUE_BG;
export const TAC_INTERFERENCE = TAC_BLUE;
export const TAC_INTERFERENCE_BG = TAC_BLUE_BG;
export const TAC_CLEARANCE = TAC_BLUE;
export const TAC_CLEARANCE_BG = TAC_BLUE_BG;
export const TAC_CAPTURING_DEFENDER = TAC_BLUE;
export const TAC_CAPTURING_DEFENDER_BG = TAC_BLUE_BG;
// Phase 133 (plan 133-02): attraction + sacrifice unsuppressed. Same single-blue convention.
export const TAC_ATTRACTION = TAC_BLUE;
export const TAC_ATTRACTION_BG = TAC_BLUE_BG;
export const TAC_SACRIFICE = TAC_BLUE;
export const TAC_SACRIFICE_BG = TAC_BLUE_BG;
// Move-type families (Quick 260623): en-passant + under-promotion. Same single-blue convention.
export const TAC_EN_PASSANT = TAC_BLUE;
export const TAC_EN_PASSANT_BG = TAC_BLUE_BG;
export const TAC_UNDER_PROMOTION = TAC_BLUE;
export const TAC_UNDER_PROMOTION_BG = TAC_BLUE_BG;
// Quick: promotion (28) surfaced (was D-09-hidden; perfect-precision residual, sibling of
// under-promotion). Same single-blue convention.
export const TAC_PROMOTION = TAC_BLUE;
export const TAC_PROMOTION_BG = TAC_BLUE_BG;

// Orientation-coded tactic colors (chips, arrows, depth badges, eval-chart tooltip;
// Games + Flaw card + analysis board). The two orientations carry opposite semantics, so
// they read apart at a glance independent of motif family. Both stay light enough to keep
// the chip text/border legible on the charcoal card. BG variants end in `/ 0.15)` so the
// shared HIGHLIGHT_BG helper (alpha 0.15 → 0.3 on hover) still applies.
// Quick 260628-ojq: swapped the orientation hues. Missed (a missed opportunity — a cooler,
// "you could have" signal) takes the teal (hue 200) that allowed used to wear. Allowed (you
// handed the opponent a tactic — a bad outcome) takes a crimson (hue 10): a vivid pink-red
// in the warm "this hurt you" family, set apart from the blunder's orange-red (hue 25) by
// being more saturated (chroma 0.22 vs 0.19), a touch lighter, and hue-shifted toward
// magenta. (Earlier tries — a lighter wine red, a cool purple/violet, then a dark burgundy —
// were dropped: wine/burgundy read too close to or muddier than the blunder, the purple too
// far from any "bad" cue.) The board's other hues are taken (red 25 blunder, orange 55
// mistake, yellow inaccuracy, green 145 clean move, blue 260 best-move arrow); teal (200) is
// the cool gap, crimson the warm one.
export const TAC_MISSED = 'oklch(0.70 0.15 200)'; // teal
export const TAC_MISSED_BG = 'oklch(0.70 0.15 200 / 0.15)';
export const TAC_MISSED_BORDER = 'oklch(0.70 0.15 200 / 0.30)';
// Allowed motifs render in a crimson — more saturated and pinker than the blunder red so the
// two read apart, while staying legible as chip text on the charcoal card. Used by the
// TacticMotifChip, the orientation arrows, and the eval chart tooltip so colors match across
// surfaces.
export const TAC_ALLOWED = 'oklch(0.60 0.22 10)'; // crimson
export const TAC_ALLOWED_BG = 'oklch(0.60 0.22 10 / 0.15)';
export const TAC_ALLOWED_BORDER = 'oklch(0.60 0.22 10 / 0.30)';

// Phase 135 UAT: the active tag in the Missed/Allowed switch (TacticLineExplorer)
// gets a solid white border so the selected line reads at a glance against its
// colored fill — replaces the old ghost-button toggle.
export const TAC_SWITCH_ACTIVE_BORDER = 'white';

// Lighter missed/allowed variants used only for the miniboard depth-number badges,
// which sit on top of the blue best-move and red severity arrows. The chip-tier
// lightness (0.70) reads muddy on the same-hue arrow, so the badge numbers are
// raised to ~0.84 for contrast against the arrow fill (the black outline does the
// rest). Hue/chroma match TAC_MISSED/TAC_ALLOWED so they stay the same colors.
// Quick 260628-ojq: match the swapped families — missed teal (hue 200), allowed
// crimson (hue 10).
export const TAC_MISSED_LABEL = 'oklch(0.84 0.13 200)'; // lighter teal
export const TAC_ALLOWED_LABEL = 'oklch(0.84 0.13 10)'; // lighter crimson

// D-05 active-filter ring — applied to TagChip when its tag matches an active
// useFlawFilterStore filter. Ring only: no fill, bold, or size change. The ring
// color is applied inline (per-family) so only the Tailwind ring-width + offset
// classes are constant here; callers combine this with a family color string.
export const ACTIVE_FILTER_RING_CLASS = 'ring-2 ring-offset-1';

// Phase histogram bar fills (PHASE_OPENING/MIDDLEGAME/ENDGAME) were used by
// FlawTagDistribution (deleted Phase 115 D-02). Removed to keep knip clean.

// Glass-effect overlay: white highlight fading to transparent
// Applied as backgroundImage on WDL bar segments for a polished look
export const GLASS_OVERLAY =
  'linear-gradient(to bottom, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0.05) 60%, rgba(0,0,0,0.05) 100%)';

// Semantic zone colors — matched to WDL red/green/amber/blue in brightness
// Note: ZONE_DANGER uses the same oklch values as WDL_LOSS and ZONE_SUCCESS
// the same as WDL_WIN; they are intentionally identical (zone colors track the
// WDL palette) but kept as separate exports for semantic clarity.
export const ZONE_DANGER = 'oklch(0.50 0.15 25)';       // red zone (same hue as WDL_LOSS)
export const ZONE_NEUTRAL = 'oklch(0.50 0.14 260)';     // blue zone (L/C match WDL)
export const ZONE_SUCCESS = 'oklch(0.50 0.14 145)';     // green zone (same hue as WDL_WIN)

// Endgame gauge zone colors — fixed per-bucket thresholds.
// Blue marks the "typical skill-cohort range" for each bucket; red below,
// green above. The Diff column + bullet chart in the same section still
// carry the opponent-relative verdict against the user's actual opponents.
// The two signals can disagree when the opponent pool is unusual (e.g.
// filtered by opponent strength) — that disagreement is informative,
// not a bug.
const GAUGE_DANGER = ZONE_DANGER;                       // red zone — internal use only
const GAUGE_SUCCESS = ZONE_SUCCESS;                     // green zone — internal use only
export const GAUGE_NEUTRAL = 'oklch(0.55 0.18 260)';        // blue skill-cohort / neutral zone (matches MY_SCORE_COLOR / Recovery line)

export interface GaugeZone {
  from: number;  // 0..1
  to: number;    // 0..1
  color: string; // CSS color
}

// Fallback used only when a caller omits the `zones` prop on EndgameGauge.
// All current callers pass explicit bucket-specific zones.
export const DEFAULT_GAUGE_ZONES: GaugeZone[] = [
  { from: 0, to: 0.4, color: GAUGE_DANGER },
  { from: 0.4, to: 0.6, color: GAUGE_NEUTRAL },
  { from: 0.6, to: 1.0, color: GAUGE_SUCCESS },
];

// Gauge bands are 3-tuples [weak, neutral, strong] across every endgame gauge;
// numeric bounds come from the codegen'd registry (`@/generated/endgameZones`)
// so colors live here as a positional triple the FE pairs with those bounds.
export const GAUGE_ZONE_COLORS = [GAUGE_DANGER, GAUGE_NEUTRAL, GAUGE_SUCCESS] as const;

// Pair numeric `{from, to}` bands from the Python-owned zone registry with
// the FE-owned `GAUGE_ZONE_COLORS` triple. Caller must pass exactly 3 bands.
export function colorizeGaugeZones(bands: readonly { from: number; to: number }[]): GaugeZone[] {
  return bands.map((b, i) => ({ ...b, color: GAUGE_ZONE_COLORS[i] ?? GAUGE_NEUTRAL }));
}

// Minimum games required for reliable stats — rows/charts below this threshold are dimmed
export const MIN_GAMES_FOR_RELIABLE_STATS = 10;

// Inactivity-gap break-label font (px). 14 = the CLAUDE.md text-sm floor; SC-4 enlarges the
// prior compact fontSize-11 annotation into a deliberately prominent marker.
export const BREAK_LABEL_FONT_SIZE = 14;

// Inactivity-gap Palmtree glyph size (px). Deliberately larger than the label text so the
// icon reads as the primary break marker while the compact "1.1y" text stays at text-sm.
export const BREAK_LABEL_GLYPH_SIZE = 22;

// Opacity applied to stats/charts with unreliable data (below MIN_GAMES_FOR_RELIABLE_STATS)
export const UNRELIABLE_OPACITY = 0.5;

// Time Pressure chart line colors (Phase 55)
// Blue for user's score line — same hue as recovery line in EndgameConvRecovChart
const MY_SCORE_COLOR = 'oklch(0.55 0.18 260)';     // internal alias for SCORE_TIMELINE_LINE_ENDGAME

// Phase 62 — Impersonation pill.
// Orange (hue ~40) — distinct from amber Guest badge (hue ~80) and WDL_LOSS (hue ~25).
// Semantic: "elevated state, admin attention"; must read legibly on dark surface.
export const IMPERSONATION_PILL_BG = 'oklch(0.50 0.18 40)';
export const IMPERSONATION_PILL_FG = 'oklch(0.95 0.02 40)';
export const IMPERSONATION_PILL_BORDER = 'oklch(0.60 0.18 40)';

// Endgame ELO Timeline chart combo palette (Phase 57 ELO-05; rebuilt Phase
// 87.5). 8 combos = 2 platforms x 4 time controls. Two constants per combo
// (bright Endgame ELO stroke + dark Actual ELO stroke) instead of an opacity
// modifier, so both tones preserve their hue reading on the dark charcoal surface.
// Hues chosen to clear WCAG AA 3:1 non-text contrast against oklch(0.145 0 0);
// adjacent combos separated by >=40 deg hue to stay visually distinct.
// Values locked in 57-UI-SPEC.md §ELO_COMBO_COLORS.

import type { EloComboKey } from '@/types/endgames';

export const ELO_COMBO_COLORS: Record<EloComboKey, { bright: string; dark: string }> = {
  chess_com_bullet:    { bright: 'oklch(0.62 0.22 30)',  dark: 'oklch(0.42 0.18 30)'  },
  chess_com_blitz:     { bright: 'oklch(0.65 0.20 260)', dark: 'oklch(0.45 0.16 260)' },
  chess_com_rapid:     { bright: 'oklch(0.70 0.18 80)',  dark: 'oklch(0.50 0.14 80)'  },
  chess_com_classical: { bright: 'oklch(0.60 0.22 310)', dark: 'oklch(0.40 0.18 310)' },
  lichess_bullet:      { bright: 'oklch(0.62 0.20 0)',   dark: 'oklch(0.42 0.16 0)'   },
  lichess_blitz:       { bright: 'oklch(0.62 0.18 220)', dark: 'oklch(0.42 0.14 220)' },
  lichess_rapid:       { bright: 'oklch(0.65 0.18 140)', dark: 'oklch(0.45 0.14 140)' },
  lichess_classical:   { bright: 'oklch(0.60 0.18 340)', dark: 'oklch(0.40 0.14 340)' },
};

// Neutral fill color for score/eval bullets on Openings cards (260507-t4r).
// Tufte/Few bullet-chart convention: the bar carries position only; the colored
// zone bands behind it carry the qualitative verdict. High contrast against the
// 0.35-opacity zone fills; zero chroma so it reads as genuinely neutral.
// Endgame consumers keep the zone-colored bar via the `barColor` prop default.
export const BULLET_BAR_NEUTRAL = 'oklch(0.85 0 0)';

// Categorical "neutral" board arrow color (Move Explorer). Used for arrows
// whose move falls in the in-between score band, has too few games, or has
// low statistical confidence. Rendered at ARROW_LOW_EMPHASIS_OPACITY (0.30)
// in ChessBoard.tsx so it visually reads as a transparent grey on both the
// warm-wood light squares and the darker square — high contrast against
// DARK_GREEN/DARK_RED in the same overlay.
//
// Hex (not oklch) because the Move Explorer + ChessBoard rely on string
// equality `arrow.color === DARK_BLUE` to choose the low-emphasis opacity
// branch, so DARK_BLUE in arrowColor.ts re-exports this exact string.
export const ARROW_NEUTRAL = '#6B7280';  // Tailwind gray-500 / matches WDL_BORDER_DRAW

// Engine best-move arrow on the Library miniboards (Game + Flaw cards). Blue with
// built-in alpha so it reads as a translucent "engine suggestion" pointer — visually
// secondary to the red flaw-move arrow it sits beside on the Flaw card, and a calm
// overlay on the scrubbed Game-card board. rgba (not oklch) so the alpha is explicit.
export const BEST_MOVE_ARROW = 'rgba(37, 99, 235, 0.8)';  // Tailwind blue-600 @ 80%

// FlawChess Engine board arrow (Phase 156) — the practical-play move rendered on the
// analysis board (game + free). Bright gold/amber (matching FLAWCHESS_ENGINE_ACCENT's
// hue) so it pops against both the dark and light board squares and reads as the FC
// engine's identity color, distinct from the blue Stockfish arrow (156 UAT). rgba (not
// oklch) like the other arrow tokens: oklch() does not reliably paint in the SVG `fill`
// presentation attribute, which left the arrow invisible. sRGB of oklch(0.80 0.15 80).
export const FLAWCHESS_ENGINE_ARROW = 'rgb(213, 152, 0)';  // deep gold/amber (156 UAT: darker + fully opaque)

// Second-best engine move: arrow + eval badge (151.1 UAT). A light blue so 1st vs 2nd
// read as a blue hierarchy (best = solid blue, second = light blue) rather than the
// old blue-vs-grey. SECOND_BEST_BADGE_TEXT is a dark ink for the eval number, since
// near-white text is unreadable on the light-blue badge fill.
export const SECOND_BEST_ARROW = 'rgba(147, 197, 253, 0.85)';  // Tailwind blue-300 @ 85%
export const SECOND_BEST_BADGE_TEXT = 'oklch(0.25 0.03 255)';  // dark blue ink

// Tactic Line Explorer payoff-ply arrows (Phase 135). Lighter alpha than BEST_MOVE_ARROW
// so payoff arrows visually recede behind the punchline arrow (same blue, less prominent).
export const PAYOFF_MOVE_ARROW = 'rgba(59, 130, 246, 0.5)';  // Tailwind blue-500 @ 50%

// Next-move arrow on the analysis board: while on the main line, a translucent white
// pointer for the move actually played next in the game. Rendered on top of the other
// arrows (see BoardArrow.onTop) so it stays visible, and a bit thinner than the standard
// engine arrows so it reads as a subtle "you played this next" hint.
export const NEXT_MOVE_ARROW = 'rgba(255, 255, 255, 0.9)';

// Endgame ELO Timeline volume bars (Phase 57.1; rebuilt Phase 87.5).
// Muted gray with alpha so the
// bars read as "context, not data" on the charcoal-texture card surface.
// L=0.55 / chroma=0 keeps the bar visually distinct from all 8 ELO_COMBO_COLORS
// hues; alpha=0.25 lets the texture noise show through, reinforcing the
// passive-context reading. Locked per 57.1-RESEARCH.md Pitfall 3.
export const ENDGAME_VOLUME_BAR_COLOR = 'oklch(0.55 0 0 / 0.25)';

// Phase 68 — Endgame vs Non-Endgame Score timeline.
// Two line strokes (endgame + non-endgame) with a colored shaded band between
// them indicating which side leads. Low alpha on the fills (0.18) so the
// grid, axis labels, and the two primary lines remain dominant while still
// conveying the sign of the gap at a glance.
// - LINE_ENDGAME reuses MY_SCORE_COLOR (brand blue) — keeps "user's endgame"
//   visually anchored to the same hue used on the Time Pressure chart.
// - LINE_NON_ENDGAME uses a light blue (UAT 2026-05-17) so the two lines
//   share the blue family but stay visually distinct via lightness + dash
//   pattern (endgame = dashed brand blue, non-endgame = dotted light blue).
// - FILL_ABOVE (green) and FILL_BELOW (red) reuse WDL win/loss hues at 0.28
//   alpha — bumped from 0.18 (UAT 2026-05-17) so the signed band reads more
//   clearly against the chart background. Sign convention: above ==
//   endgame > non_endgame (green), below == endgame < non_endgame (red).
export const SCORE_TIMELINE_LINE_ENDGAME = MY_SCORE_COLOR;
export const SCORE_TIMELINE_LINE_NON_ENDGAME = 'oklch(0.78 0.09 230)';
export const SCORE_TIMELINE_FILL_ABOVE = 'oklch(0.50 0.14 145 / 0.28)';
export const SCORE_TIMELINE_FILL_BELOW = 'oklch(0.50 0.15 25 / 0.28)';

// "Moves by Rating" chart (Phase 151 Plan 05 — SURF-01/02/03, spike 006 port).
// The "you are here" ELO reference line uses a dedicated warm brown (matches
// spike 006's --brand marker). Line/label COLOR used to encode played/best
// identity (MOVES_BY_RATING_PLAYED_LINE/BEST_LINE/OTHER_LINES) — that
// identity-palette was replaced in Phase 151.1 (D-03) by the MOVE_QUALITY_*
// palette below: color now encodes the Stockfish-graded quality bucket, and
// played/best emphasis is carried by stroke WIDTH alone (decoupled, D-01/D-07).
export const MOVES_BY_RATING_REFERENCE_LINE = 'white'; // white "you are here" marker (151.1 UAT)

// Move-quality 5-bucket palette (Phase 151.1 D-03 — Stockfish-graded Maia
// moves on the Moves-by-Rating chart). Color now encodes QUALITY (was
// identity, MOVES_BY_RATING_* above): dark-green = the grading search's own
// best-scoring candidate, light-green = a clean non-best move ("good"), and
// the 3 severity tiers reuse SEV_INACCURACY/SEV_MISTAKE/SEV_BLUNDER verbatim
// (never re-derive their oklch values — see liveFlaw.ts/flawThresholds.ts,
// the single-sourced grading pipeline this phase's classifyMoveQuality
// reuses). Both new greens share WDL_WIN's hue (145) but sit at distinct
// lightness from each other and from WDL_WIN itself (which stays reserved
// for its own win/draw/loss semantic, not quality). MOVE_QUALITY_PENDING is
// the neutral "graded not yet arrived" line color (D-05 progressive/
// streaming grading — lines render immediately in this muted gray before the
// first shallow Stockfish eval commits a real quality color).
export const MOVE_QUALITY_BEST = 'oklch(0.40 0.17 145)'; // dark green
export const MOVE_QUALITY_GOOD = 'oklch(0.72 0.13 145)'; // light green
export const MOVE_QUALITY_INACCURACY = SEV_INACCURACY;
export const MOVE_QUALITY_MISTAKE = SEV_MISTAKE;
export const MOVE_QUALITY_BLUNDER = SEV_BLUNDER;
export const MOVE_QUALITY_PENDING = 'oklch(0.65 0.02 260)'; // muted neutral gray

// Bot-game clock low-time urgent color (Phase 169 D-07 — ClockDisplay.tsx).
// Below LOW_TIME_THRESHOLD_MS (chessClock.ts), the active clock's digits
// switch to this destructive red and gain a ring-2 urgent treatment, matching
// the shadcn `--destructive` CSS-variable token value so the urgent state
// reads consistently with the app's other destructive surfaces (resign
// confirm button, etc.) without hard-coding a duplicate literal.
export const CLOCK_LOW_TIME_URGENT = 'oklch(0.577 0.245 27.325)';

// Bot persona per-style accent colors (Phase 183, PERS-03/AVAT-01). One accent
// per style — Attacker/Trickster/Grinder/Wall — used for the Bots page grid's
// section headers and the D-18 placeholder-avatar background tint. Distinct
// from every existing WDL/MAIA/severity/tactic hue above: Attacker (15) sits
// between the crimson TAC_ALLOWED (10) and the blunder red (25) but at a
// higher chroma so it reads as its own "aggressive" identity rather than a
// severity color; Trickster (320) is a playful magenta, clearly apart from
// MAIA_ACCENT's violet (290); Grinder (165) is an earthy teal-green between
// WDL_WIN (145) and TAC_MISSED (200); Wall (235) is a steady blue-gray,
// distinct from Stockfish (255) and GREAT_ACCENT (220). `_BG` variants follow
// the established 14% alpha convention (MAIA_ACCENT_BG et al.) for section
// header washes and placeholder-avatar tints.
export const ATTACKER_ACCENT = 'oklch(0.60 0.20 15)'; // fiery red-orange
export const ATTACKER_ACCENT_BG = 'oklch(0.60 0.20 15 / 0.14)';
export const TRICKSTER_ACCENT = 'oklch(0.60 0.20 320)'; // playful magenta
export const TRICKSTER_ACCENT_BG = 'oklch(0.60 0.20 320 / 0.14)';
export const GRINDER_ACCENT = 'oklch(0.55 0.14 165)'; // earthy teal-green
export const GRINDER_ACCENT_BG = 'oklch(0.55 0.14 165 / 0.14)';
export const WALL_ACCENT = 'oklch(0.55 0.12 235)'; // steady blue-gray
export const WALL_ACCENT_BG = 'oklch(0.55 0.12 235 / 0.14)';

// Persona win-stars row (Phase 185, 185-UI-SPEC.md Color section). Declared as
// their own independent named constants — NOT an alias/import of
// FLAWCHESS_ENGINE_ACCENT — even though STAR_FILLED numerically matches it
// (same gold/amber hue), so the two can diverge independently in the future
// without an accidental cross-feature recolor.
export const STAR_FILLED = 'oklch(0.78 0.14 80)'; // gold/amber
export const STAR_EMPTY = 'oklch(0.45 0 0)'; // mid-grey outline

// Train verdict colors (Phase 190-05, D-10) — alias the existing WDL palette
// so "correct"/"incorrect" verdict rows read with the same green/red the
// rest of the app already uses for win/loss, rather than inventing a
// parallel pair of hues for the same semantic.
export const TRAIN_VERDICT_CORRECT = WDL_WIN;
export const TRAIN_VERDICT_INCORRECT = WDL_LOSS;

// Train score-screen rating bands (Phase 190-05, SOLV-07: green/yellow/red).
// Green/red alias the same WDL hues as the verdict colors above; yellow is a
// genuinely new amber value. Deliberately NOT SEV_INACCURACY, even though
// both are amber-family: SEV_INACCURACY belongs to the flaw-severity
// taxonomy elsewhere in the app and repurposing it here would couple two
// unrelated scales (a future retune of one would silently retune the
// other). The named threshold constants themselves (TRAIN_RATING_GREEN_MIN /
// TRAIN_RATING_YELLOW_MIN) are pure logic and live in lib/trainScore.ts, not
// here — this file only carries color, never a threshold value.
export const TRAIN_RATING_GREEN = WDL_WIN;
export const TRAIN_RATING_YELLOW = 'oklch(0.75 0.15 85)'; // amber
export const TRAIN_RATING_RED = WDL_LOSS;

// Train "Points: +N" flash badge foregrounds (SEED-119). The badge now
// covers 4 background tiers (ZONE_DANGER/SEV_MISTAKE/SEV_INACCURACY/
// ZONE_SUCCESS) instead of the old fixed white-text pill — 3 of those
// backgrounds are dark enough for near-white text, but SEV_INACCURACY sits
// at oklch lightness 0.82 (a light amber), which white text cannot clear
// for legible contrast. Two named foregrounds, not one, so each tier picks
// the correct-contrast text explicitly rather than a single compromise gray.
export const TRAIN_POINTS_FG_ON_DARK = 'oklch(0.98 0 0)'; // near-white, for the 3 dark tiers
export const TRAIN_POINTS_FG_ON_LIGHT = 'oklch(0.20 0 0)'; // near-black, for the light yellow tier

// Train reveal-board best-move arrow (Phase 190.1, D-02; recolored per 190.1
// UAT) — blue marks the engine's BEST move (matching what blue means
// everywhere else in the app: an engine/analysis pointer), never the user's
// played move. The played move is colored by its own move quality
// (MOVE_QUALITY_* above) in lib/trainArrows.ts. Aliases the existing blue
// BEST_MOVE_ARROW value (same aliasing style as TRAIN_VERDICT_CORRECT/
// TRAIN_RATING_GREEN above); the two never coexist on one board (that token
// is only used on Library miniboards).
export const TRAIN_BEST_MOVE_ARROW = BEST_MOVE_ARROW;

// Shield flame meter, 7 slots (Phase 193 D-01, 193-UI-SPEC.md `## Color`;
// amended at 193 UAT — the 3-band pip meter became a per-slot flame ramp).
// Indexed by SLOT, not by shield_level: slot i always renders the same
// color whether it is the highest lit flame or one of several. The ramp
// runs yellow (slot 1) -> orange (slot 4) -> red (slot 7), so the shield's
// heat reads at a glance without a legend. Empty slots use the neutral
// text-muted-foreground/50 Tailwind token (a grey outline flame), never an
// 8th named color.
// Train session-streak badge (193 UAT round 4). The streak count is the
// headline number of the Streak card but rendered as plain text it read as
// just another stat, so it now sits in a filled amber trophy pill. One FLAT
// amber, deliberately not a value from the flame ramp below: the pill must
// never read as an 8th flame or as a heat level on the same scale. The
// foreground is near-black because the amber sits at oklch lightness 0.78,
// which white text cannot clear for legible contrast (same reasoning as
// TRAIN_POINTS_FG_ON_LIGHT above, kept as its own constant so a retune of
// the points badge can't silently retune the streak badge).
export const TRAIN_STREAK_BADGE_BG = 'oklch(0.78 0.16 85)'; // amber
export const TRAIN_STREAK_BADGE_FG = 'oklch(0.20 0 0)'; // near-black

export const TRAIN_SHIELD_FLAME_COLORS = [
  'oklch(0.80 0.15 95)', // 1: yellow
  'oklch(0.78 0.16 85)', // 2: amber
  'oklch(0.75 0.17 72)', // 3: deep amber
  'oklch(0.72 0.18 60)', // 4: orange
  'oklch(0.69 0.19 50)', // 5: deep orange
  'oklch(0.66 0.20 40)', // 6: orange-red
  'oklch(0.62 0.21 29)', // 7: red
] as const;
