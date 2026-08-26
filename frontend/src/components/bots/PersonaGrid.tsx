/**
 * PersonaGrid — the Bots page's default setup view (Phase 183, PERS-01/
 * PERS-04). Renders all 24 personas as a transposed grid (Phase 185): one
 * header row of the 4 style names (`STYLE_SECTION_ORDER`) in their accent
 * colors, then 6 rung rows ascending 800 (top) -> 1800 (bottom)
 * (`RUNGS`/`personasForRung`), 4 `PersonaCard`s per row in style order, no
 * row labels — plus one clearly-visible Custom entry that routes to the
 * unchanged `SetupScreen` (D-01) rather than duplicating any of its
 * controls here.
 */

import type { ReactElement } from 'react';
import { PersonaCard } from '@/components/bots/PersonaCard';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardBody } from '@/components/ui/card';
import { InfoPopover } from '@/components/ui/info-popover';
import { currentStrengthCopy } from '@/lib/currentStrengthCopy';
import {
  STYLE_SECTION_ORDER,
  RUNGS,
  personasForRung,
  type Persona,
} from '@/lib/personas/personaRegistry';
import type { Style } from '@/lib/engine/styleOpeningLines';
import { ATTACKER_ACCENT, TRICKSTER_ACCENT, GRINDER_ACCENT, WALL_ACCENT } from '@/lib/theme';
import type { CurrentStrength } from '@/types/users';

/** Per-style section-heading accent (D-14: the heading text is the style's
 * own display name — "Wall", never "Solid Wall"/"Great Wall"). Mirrors
 * `personaAvatars.ts`'s `PERSONA_STYLE_TINT` exhaustiveness convention. */
const STYLE_ACCENT: Record<Style, string> = {
  Attacker: ATTACKER_ACCENT,
  Trickster: TRICKSTER_ACCENT,
  Grinder: GRINDER_ACCENT,
  Wall: WALL_ACCENT,
};

export interface PersonaGridProps {
  onSelectPersona: (persona: Persona) => void;
  onSelectCustom: () => void;
  /** Quick 260811-u11 (SEED-147): the player's current-strength estimate,
   * resolved by `Bots.tsx` from its single `useUserProfile()` call. `null`
   * for guests / users with neither a qualifying recent-games rung nor an
   * anchor — the reference line is then omitted entirely rather than
   * showing a placeholder. */
  currentStrength: CurrentStrength | null;
  /** Phase 185: per-persona-id raw win counts, fetched ONCE by `Bots.tsx`
   * (`useBotPersonaWins`) and prop-drilled here — this component never calls
   * `useQuery` itself (Pattern 3, single-fetch-then-prop-drill), which would
   * break its existing no-`QueryClientProvider` render tests. `undefined`
   * while loading/erroring; each card degrades to its own all-outline
   * zero-state rather than blocking this whole grid. */
  winsByPersona?: Record<string, number>;
}

/**
 * Intro card explaining what makes these opponents different from a dialed-down
 * engine, with the player's own strength reference as a separated second row.
 *
 * The CARD itself renders unconditionally (guests included — they get no rating
 * row, and are exactly who needs the explanation most); only the rating row
 * inside it is gated on `currentStrength`, which also gates its separator so a
 * guest never sees a rule with nothing under it.
 *
 * Copy accuracy constraint: 16 of the 24 personas run at `HUMAN_BLEND` (rungs
 * 800-1400), where `selectBotMove` makes exactly ONE Maia policy call and never
 * searches. So this copy must never claim the bots "calculate" or "think" — it
 * describes human move PREDICTION, which is what all 24 have in common. The
 * style sentence stays directional for the same reason: `varianceBonus` and
 * `contempt` only bite on the Light/Deep rungs, while the prior reweighting and
 * opening books tilt every rung.
 */
function HumanLikeOpponentsCard({
  currentStrength,
}: {
  currentStrength: CurrentStrength | null;
}): ReactElement {
  return (
    <Card as="section" data-testid="bots-intro-card">
      <CardHeader size="compact">Human-like Opponents</CardHeader>
      <CardBody className="space-y-3 text-sm text-muted-foreground">
        {/* The info trigger sits inline at the END of the sentence it expands,
            not up in the header — it explains this claim, and the rating row
            below uses the same trailing-trigger shape. `align-middle` keeps the
            16px glyph on the text baseline when the sentence wraps. */}
        <p>
          Not weakened engines: these bots are driven by the FlawChess Engine and play similar to
          human players.{' '}
          <span className="inline-flex align-middle">
            <InfoPopover ariaLabel="About the bot opponents" testId="bots-intro-info">
              <div className="max-w-xs space-y-2">
                <p>
                  A normal engine turned down plays perfectly, then throws in a random blunder.
                  These bots instead predict what a human at that rating would actually play, so
                  their mistakes look like the ones you meet online.
                </p>
                <p>
                  Each style tilts that further: Attackers press, Tricksters play for
                  complications, Grinders trade down and never resign, Walls keep it quiet.
                </p>
              </div>
            </InfoPopover>
          </span>
        </p>

        {/* Strength reference for picking an opponent: the persona cards all
            carry a `~ELO` label, but without the player's own number those
            labels have nothing to be "similar" to. A null `rung` (anchor
            fallback) does NOT suppress this row — only currentStrength ===
            null does. The rule lives on this row (not as a standalone sibling)
            so it disappears with the row it separates. */}
        {currentStrength !== null && (
          <div
            className="flex items-center gap-1 border-t border-border/40 pt-3"
            data-testid="bots-player-rating"
          >
            <p>
              Your estimated blitz rating:{' '}
              <span className="font-semibold text-foreground">{`~${Math.round(currentStrength.rating)}`}</span>
            </p>
            <InfoPopover
              ariaLabel="About your estimated blitz rating"
              testId="bots-player-rating-info"
            >
              <p>{currentStrengthCopy(currentStrength)}</p>
            </InfoPopover>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function PersonaGrid({
  onSelectPersona,
  onSelectCustom,
  currentStrength,
  winsByPersona,
}: PersonaGridProps): ReactElement {
  return (
    // Bottom-nav clearance (mirrors SetupScreen.tsx's root pb-20 sm:pb-4
    // pattern — this is now the Bots page's default setup-phase root).
    <div
      data-testid="bots-persona-grid"
      className="mx-auto flex max-w-2xl flex-col gap-6 p-4 pb-20 sm:pb-4"
    >
      <HumanLikeOpponentsCard currentStrength={currentStrength} />

      {/* Single grid-cols-4 container for the header row + all 6 rung body
          rows, so columns align exactly and row/column gaps stay uniform
          (8px, per UI-SPEC) — separate from the outer flex column's gap-6.
          Header cells auto-flow into row 1; RUNGS.flatMap(personasForRung)
          fills the remaining rows rung-major (800 top -> 1800 bottom), no
          row labels (locked decision). */}
      <div className="grid grid-cols-4 gap-2">
        {STYLE_SECTION_ORDER.map((style) => (
          <div
            key={style}
            data-testid={`bots-persona-header-${style.toLowerCase()}`}
            className="text-center text-sm font-semibold tracking-wide"
            style={{ color: STYLE_ACCENT[style] }}
          >
            {style}
          </div>
        ))}
        {RUNGS.flatMap((rung) => personasForRung(rung)).map((persona) => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            onSelect={onSelectPersona}
            winsForPersona={winsByPersona?.[persona.id]}
          />
        ))}
      </div>

      <Button
        variant="brand-outline"
        data-testid="bots-persona-custom"
        onClick={onSelectCustom}
        className="h-12 w-full"
      >
        Custom
      </Button>
    </div>
  );
}
