import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';
import { formatClockLabel, isLowTime } from '@/lib/chessClock';
import { CLOCK_LOW_TIME_URGENT } from '@/lib/theme';
import type { Persona } from '@/lib/personas/personaRegistry';
import { placeholderAvatarFor, resolveAvatarSrc } from '@/lib/personas/personaAvatars';
import { MaterialDisplay } from '@/components/board/MaterialDisplay';

/** Avatar-circle size (px) for the persona portrait. Sized so the persona
 * card lands at ~60px tall (avatar + py-1.5), a deliberate +50% over the
 * compact ~40px text-only card — the portrait needs the room. */
const AVATAR_SIZE_PX = 48;

interface ClockDisplayProps {
  /** Side caption — the resolved player display name (lichess_username ->
   * chess_com_username -> "You", see lib/playerName.ts) for the human side,
   * or the persona's name / "FlawChess Bot" for the bot side (Phase 183,
   * D-06), per the UI-SPEC Copywriting Contract. */
  sideLabel: string;
  /** The bot's persona (Phase 183, D-06) — renders the avatar portrait with
   * the name and a "style · estimated ELO" line beside it for a persona
   * game; omitted (text-only compact card) for a Custom game or the human
   * side. */
  persona?: Persona;
  /** Remaining time in milliseconds. */
  remainingMs: number;
  /** The side to move — gets a subtle --secondary highlight (D-06/UI-SPEC). */
  isActive: boolean;
  /** True while the bot's move selection is in flight (D-06). */
  isThinking: boolean;
  /**
   * Quick 260809-jzz (D-02/D-05): the FEN currently on the board (the viewed
   * ply, not necessarily the live one) and which color this card represents.
   * Material renders only when BOTH are supplied.
   */
  fen?: string;
  side?: 'white' | 'black';
  testId?: string;
}

/** The persona's avatar portrait: real art when present, else the D-18
 * species-emoji placeholder on the per-style tint — same backstop pattern as
 * `PersonaCard`/`PersonaDetailSurface`. */
function PersonaAvatar({ persona }: { persona: Persona }): ReactElement {
  const avatar = placeholderAvatarFor(persona);
  const avatarSrc = resolveAvatarSrc(persona);

  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full text-2xl"
      style={{ backgroundColor: avatar.tint, width: AVATAR_SIZE_PX, height: AVATAR_SIZE_PX }}
    >
      {avatarSrc !== undefined ? (
        <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
      ) : (
        avatar.emoji
      )}
    </span>
  );
}

/**
 * A single side's clock card for the bot-game board (Phase 169 Plan 05).
 * Digits are formatted by chessClock.ts's formatClockLabel/isLowTime — this
 * component never reimplements clock math or formatting (D-07/UI-SPEC).
 *
 * Sized to sit close to the analysis board's PlayerBar strip (170 UAT test 7:
 * the original p-4 / text-xl card ate too much vertical space on mobile). The
 * card surface itself stays — the active-side fill and the low-time ring need
 * something to paint on. A persona game's bot card is the one exception: it
 * grows ~50% taller to fit the avatar portrait with the name + estimated
 * ELO stacked beside it.
 */
export function ClockDisplay({
  sideLabel,
  persona,
  remainingMs,
  isActive,
  isThinking,
  fen,
  side,
  testId,
}: ClockDisplayProps): ReactElement {
  const lowTime = isLowTime(remainingMs);

  const thinkingIndicator = isThinking && (
    <>
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand-brown"
      />
      <span className="sr-only" aria-live="polite">
        Bot is thinking
      </span>
    </>
  );

  return (
    <div
      data-testid={testId}
      className={cn(
        'flex items-center justify-between gap-2 rounded-[var(--radius)] bg-card px-2 py-1.5',
        isActive && 'bg-secondary',
        lowTime && 'ring-2 ring-destructive/40',
      )}
    >
      {/* Quick 260809-jzz (D-05): name/persona + material share a left group so
          material sits right after the name instead of being spread to the
          middle by the outer justify-between. min-w-0 lets the name shrink;
          the material itself is shrink-0 so it never gets squeezed. */}
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {persona ? (
            <>
              <PersonaAvatar persona={persona} />
              <span className="flex flex-col">
                <span className="flex items-center gap-2">
                  {sideLabel}
                  {thinkingIndicator}
                </span>
                <span className="font-normal text-muted-foreground">
                  {`${persona.style} · ${persona.calibratedLabel}`}
                </span>
              </span>
            </>
          ) : (
            <>
              {sideLabel}
              {thinkingIndicator}
            </>
          )}
        </span>
        {fen !== undefined && side !== undefined && (
          <MaterialDisplay fen={fen} side={side} className="shrink-0" />
        )}
      </span>
      <span
        className="text-lg font-bold tabular-nums"
        style={lowTime ? { color: CLOCK_LOW_TIME_URGENT } : undefined}
      >
        {formatClockLabel(remainingMs)}
      </span>
    </div>
  );
}
