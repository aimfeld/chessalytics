/**
 * PersonaCard — a single tappable persona tile on the Bots page grid (Phase
 * 183, PERS-01/AVAT-01/AVAT-02). Shows the persona's avatar, name, and the
 * calibrated, tilde-prefixed strength label (Phase 184 CAL-05,
 * `persona.calibratedLabel`) — never a raw unqualified number, and never
 * `~${persona.rung}` (the pre-calibration provisional value; see
 * `personaRegistry.ts`'s calibration-provenance header note).
 *
 * Backstop: the avatar renders `resolveAvatarSrc(persona)`'s future real-art
 * portrait (D-17) when present, otherwise the D-18 placeholder (species
 * emoji on the per-style tint) — a persona whose real-art `avatarSrc` is
 * absent/pending NEVER fails to render an avatar; the emoji fallback is
 * always present. Every persona omits `avatarSrc` today (183-01-SUMMARY.md),
 * so every card currently renders the emoji branch.
 */

import type { ReactElement } from 'react';
import { Star } from 'lucide-react';
import type { Persona } from '@/lib/personas/personaRegistry';
import { placeholderAvatarFor, resolveAvatarSrc } from '@/lib/personas/personaAvatars';
import { STAR_FILLED, STAR_EMPTY } from '@/lib/theme';

export interface PersonaCardProps {
  persona: Persona;
  onSelect: (persona: Persona) => void;
  /** Phase 185: this persona's raw win count, fetched ONCE at `Bots.tsx` page
   * level (`useBotPersonaWins`) and prop-drilled down through `PersonaGrid` —
   * never fetched here (keeps this component's bare `render(<PersonaCard/>)`
   * tests working with no `QueryClientProvider`). `undefined` (loading/error/
   * not-yet-fetched) renders identically to `0` — a transient fetch failure
   * must never display a false "0 wins" negative, so both degrade to the same
   * all-outline zero-state. */
  winsForPersona?: number;
}

/** Fixed avatar-circle size (px) — shared by the width/height so the avatar
 * always renders in a perfect circle regardless of Tailwind's responsive
 * grid-column width above it. */
const AVATAR_SIZE_PX = 58;

/** Icon size (px) for each star glyph in the win-stars row (185-UI-SPEC.md). */
const STAR_SIZE_PX = 14;

/** Cap on the number of gold-filled stars — a raw win count above this still
 * renders exactly 3 filled stars, never a 4th star or a "+N" badge this
 * phase. Always exactly `MAX_DISPLAY_STARS` stars render (filled + outline). */
const MAX_DISPLAY_STARS = 3;

/**
 * PersonaStars — a row of exactly `MAX_DISPLAY_STARS` star glyphs: the first
 * `Math.min(wins, MAX_DISPLAY_STARS)` gold-filled (left to right), the
 * remainder grey-outline. `undefined`/`0` both render as all-outline (the
 * loading/error/zero states are deliberately merged — see `winsForPersona`'s
 * doc comment above).
 *
 * The 3 `Star` glyphs are individually `aria-hidden` — the wrapping `<span>`
 * carries the ONE `aria-label` a screen reader should announce for this row,
 * kept deliberately separate from the card button's own persona-identity
 * `aria-label` (185-UI-SPEC.md Accessibility section).
 */
function PersonaStars({ wins }: { wins: number | undefined }): ReactElement {
  const winCount = wins ?? 0;
  // Split into a filled-count and an empty-count that together always sum to
  // exactly MAX_DISPLAY_STARS. Without the Math.min cap, a raw winCount above
  // MAX_DISPLAY_STARS would make emptyCount negative (Array.from clamps a
  // negative length to 0), so the row would render MORE than
  // MAX_DISPLAY_STARS stars total — the cap is load-bearing for keeping every
  // card's row the same fixed height, not just a display nicety.
  const filledCount = Math.min(winCount, MAX_DISPLAY_STARS);
  const emptyCount = MAX_DISPLAY_STARS - filledCount;

  return (
    <span
      className="flex items-center justify-center gap-0.5"
      aria-label={`${winCount} win${winCount === 1 ? '' : 's'}`}
    >
      {Array.from({ length: filledCount }, (_, i) => (
        <Star
          key={`filled-${i}`}
          aria-hidden="true"
          size={STAR_SIZE_PX}
          fill={STAR_FILLED}
          color={STAR_FILLED}
        />
      ))}
      {Array.from({ length: emptyCount }, (_, i) => (
        <Star
          key={`empty-${i}`}
          aria-hidden="true"
          size={STAR_SIZE_PX}
          fill="none"
          color={STAR_EMPTY}
        />
      ))}
    </span>
  );
}

export function PersonaCard({ persona, onSelect, winsForPersona }: PersonaCardProps): ReactElement {
  const avatar = placeholderAvatarFor(persona);
  const avatarSrc = resolveAvatarSrc(persona);

  return (
    <button
      type="button"
      data-testid={`bots-persona-card-${persona.id}`}
      aria-label={`${persona.name}, ${persona.calibratedLabel} ELO`}
      onClick={() => onSelect(persona)}
      /* Mobile keeps only a hairline horizontal gutter: in the 4-column grid at
         a 360-390px viewport, the previous px-2 forced 2-9 of the persona names
         onto a third line ("Rocco the / Armadillo" became "Rocco / the /
         Armadillo"). The card is avatar-bound (58px wide) so the horizontal
         padding is invisible around the avatar anyway; only the name row was
         paying for it. Desktop (sm:) keeps the original 8px. */
      className="flex flex-col items-center gap-1 rounded border border-border bg-card px-0.5 py-2 text-center transition-colors sm:px-2 pointer-fine:hover:bg-inactive-bg-hover"
    >
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-full text-2xl"
        style={{
          backgroundColor: avatar.tint,
          width: AVATAR_SIZE_PX,
          height: AVATAR_SIZE_PX,
        }}
      >
        {avatarSrc !== undefined ? (
          <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
        ) : (
          avatar.emoji
        )}
      </span>
      <span className="text-sm font-medium text-foreground">{persona.name}</span>
      <span className="text-sm text-muted-foreground">{persona.calibratedLabel}</span>
      <PersonaStars wins={winsForPersona} />
    </button>
  );
}
