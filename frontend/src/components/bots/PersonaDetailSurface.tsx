/**
 * PersonaDetailSurface — the persona detail dialog opened from `PersonaGrid`
 * (Phase 183, PERS-02). Shows the persona's avatar, name, DISPLAY-ONLY tilde
 * ELO label + style name, full bio, and reused color/TC chip controls
 * (`SetupScreen`'s exact markup + `CHIP_*` classes) defaulting to the
 * persisted last-used values. Tapping Play resolves those two controls into
 * a fully-pinned `BotGameSettings` (botElo/blend/style/personaId all pinned
 * by the persona, never a separate strength picker — Pitfall 3) and calls
 * `onStart` exactly once, the SAME entry `SetupScreen`'s Start button calls.
 *
 * Mirrors `GameResultDialog.tsx`'s Dialog shell. Uses the DialogContent
 * default vertical centering on all breakpoints — the previous
 * `top-[30%] sm:top-1/2` mobile anchor pushed this (tall) dialog off the
 * top of small screens.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  CHIP_BASE_CLASS,
  CHIP_ACTIVE_CLASS,
  CHIP_INACTIVE_CLASS,
} from '@/components/bots/chipStyles';
import { placeholderAvatarFor, resolveAvatarSrc } from '@/lib/personas/personaAvatars';
import type { Persona } from '@/lib/personas/personaRegistry';
import {
  readPersonaSetupSettings,
  writePersonaSetupSettings,
  DEFAULT_PERSONA_SETUP_SETTINGS,
  type BotPersonaSetupSettings,
} from '@/lib/personas/botPersonaSetupSettings';
import {
  TIME_CONTROL_PRESETS,
  DEFAULT_TC_PRESET_LABEL,
  findPresetByLabel,
  type TimeControlPreset,
} from '@/lib/botTimeControlPresets';
import { BOT_STYLE_BUNDLES } from '@/lib/engine/botStyleBundles';
import { PersonaEloDisclosurePopover } from '@/components/bots/PersonaEloDisclosurePopover';
import type { BotGameSettings } from '@/hooks/useBotGame';
import type { MoverColor } from '@/lib/liveFlaw';
import { cn } from '@/lib/utils';

type ColorPreference = BotPersonaSetupSettings['colorPreference'];

const TC_BUCKET_ORDER: readonly TimeControlPreset['bucket'][] = ['blitz', 'rapid', 'classical'];

const TC_BUCKET_LABELS: Record<TimeControlPreset['bucket'], string> = {
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
};

const COLOR_OPTIONS: ReadonlyArray<{ key: ColorPreference; label: string }> = [
  { key: 'white', label: 'White' },
  { key: 'black', label: 'Black' },
  { key: 'random', label: 'Random' },
];

/** `data-testid` for a color chip, e.g. `persona-color-white`. */
function personaColorTestId(key: ColorPreference): string {
  return `persona-color-${key}`;
}

/** `data-testid` for a TC chip, e.g. `persona-tc-15-10` — `+`/`.` become `-`. */
function personaTcTestId(label: string): string {
  return `persona-tc-${label.replace(/[+.]/g, '-')}`;
}

/** One TC bucket row (Blitz/Rapid/Classical) — mirrors `SetupScreen.tsx`'s
 * `TcBucketGroup` markup + layout verbatim, under this surface's own
 * `persona-tc-*` testid convention. */
function PersonaTcBucketGroup({
  bucket,
  activeLabel,
  onSelect,
}: {
  bucket: TimeControlPreset['bucket'];
  activeLabel: string;
  onSelect: (label: string) => void;
}): ReactElement {
  const presets = TIME_CONTROL_PRESETS.filter((preset) => preset.bucket === bucket);

  return (
    <div className="mb-1 flex items-center gap-2">
      <p className="w-20 shrink-0 whitespace-nowrap text-sm text-muted-foreground">
        {TC_BUCKET_LABELS[bucket]}
      </p>
      <div
        className="grid flex-1 gap-1"
        style={{ gridTemplateColumns: `repeat(${presets.length}, minmax(0, 1fr))` }}
      >
        {presets.map((preset) => {
          const isActive = activeLabel === preset.label;
          return (
            <button
              key={preset.label}
              type="button"
              data-testid={personaTcTestId(preset.label)}
              aria-pressed={isActive}
              onClick={() => onSelect(preset.label)}
              className={cn(CHIP_BASE_CLASS, isActive ? CHIP_ACTIVE_CLASS : CHIP_INACTIVE_CLASS)}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** All data shaping kept out of the JSX so the component body stays
 * declarative, mirroring `SetupScreen.tsx`'s `useSetupScreenState`
 * precedent. Re-seeds from the persisted last-used values every time the
 * surface OPENS (not just on first mount) — a controlled dialog can stay
 * mounted across several open/close cycles for different personas. */
function usePersonaDetailState(
  ownerKey: string | null,
  open: boolean,
): {
  colorPreference: ColorPreference;
  tcLabel: string;
  setColorPreference: (pref: ColorPreference) => void;
  setTcLabel: (label: string) => void;
} {
  const [colorPreference, setColorPreference] = useState<ColorPreference>(
    DEFAULT_PERSONA_SETUP_SETTINGS.colorPreference,
  );
  const [tcLabel, setTcLabel] = useState<string>(DEFAULT_PERSONA_SETUP_SETTINGS.tcLabel);

  useEffect(() => {
    if (!open) return;
    const saved = readPersonaSetupSettings(ownerKey) ?? DEFAULT_PERSONA_SETUP_SETTINGS;
    setColorPreference(saved.colorPreference);
    setTcLabel(saved.tcLabel);
  }, [open, ownerKey]);

  return { colorPreference, tcLabel, setColorPreference, setTcLabel };
}

export interface PersonaDetailSurfaceProps {
  persona: Persona | null;
  ownerKey: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (settings: BotGameSettings) => void;
}

export function PersonaDetailSurface({
  persona,
  ownerKey,
  open,
  onOpenChange,
  onStart,
}: PersonaDetailSurfaceProps): ReactElement | null {
  const { colorPreference, tcLabel, setColorPreference, setTcLabel } = usePersonaDetailState(
    ownerKey,
    open,
  );

  // Hooks above run unconditionally on every render; this early return keeps
  // the JSX below persona-non-null without an outer conditional wrapper.
  if (persona === null) return null;

  const avatar = placeholderAvatarFor(persona);
  const avatarSrc = resolveAvatarSrc(persona);

  const handlePlay = (): void => {
    const preset = findPresetByLabel(tcLabel) ?? findPresetByLabel(DEFAULT_TC_PRESET_LABEL);
    const baseSeconds = preset?.baseSeconds ?? 600;
    const incrementSeconds = preset?.incrementSeconds ?? 0;

    // D-12 (mirrors SetupScreen.tsx's handleStart): an unresolved 'random'
    // preference must NEVER reach `useBotGame` — resolved to a concrete
    // color HERE, before `onStart` fires.
    const userColor: MoverColor =
      colorPreference === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : colorPreference;

    // Persist the UNRESOLVED preference, mirroring SetupScreen's own choice.
    writePersonaSetupSettings(ownerKey, { colorPreference, tcLabel });

    onStart({
      botElo: persona.botElo,
      blend: persona.blend,
      style: BOT_STYLE_BUNDLES[persona.style],
      userColor,
      baseSeconds,
      incrementSeconds,
      personaId: persona.id,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="persona-detail-surface">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-[90px] w-[90px] shrink-0 items-center justify-center overflow-hidden rounded-full text-5xl"
              style={{ backgroundColor: avatar.tint }}
            >
              {avatarSrc !== undefined ? (
                <img src={avatarSrc} alt="" loading="lazy" className="h-full w-full object-cover" />
              ) : (
                avatar.emoji
              )}
            </span>
            <div className="flex flex-col gap-1">
              <DialogTitle>{persona.name}</DialogTitle>
              {/* Display-only ELO/style text — never an EloSelector/
                  PlayStyleControl (Pitfall 3): this surface has no strength
                  picker. The calibrated label (Phase 184 CAL-05) pairs with a
                  D-08 disclosure popover as supplementary hover/tap detail,
                  never replacing the visible label. */}
              <div className="flex items-center gap-1">
                <p className="text-sm text-muted-foreground" data-testid="persona-detail-meta">
                  {`${persona.style} · ${persona.calibratedLabel}`}
                </p>
                <PersonaEloDisclosurePopover
                  isFloorRung={persona.rung === 800}
                  ariaLabel={`About ${persona.name}'s ELO measurement`}
                />
              </div>
            </div>
          </div>
        </DialogHeader>
        <p className="text-sm text-foreground" data-testid="persona-detail-bio">
          {persona.bio}
        </p>

        <div data-testid="persona-detail-color">
          <p className="mb-1 text-sm text-muted-foreground">Play as</p>
          <div className="grid grid-cols-3 gap-1">
            {COLOR_OPTIONS.map((option) => {
              const isActive = colorPreference === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  data-testid={personaColorTestId(option.key)}
                  aria-pressed={isActive}
                  onClick={() => setColorPreference(option.key)}
                  className={cn(CHIP_BASE_CLASS, isActive ? CHIP_ACTIVE_CLASS : CHIP_INACTIVE_CLASS)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div data-testid="persona-detail-tc">
          <p className="mb-1 text-sm text-muted-foreground">Time control</p>
          {TC_BUCKET_ORDER.map((bucket) => (
            <PersonaTcBucketGroup
              key={bucket}
              bucket={bucket}
              activeLabel={tcLabel}
              onSelect={setTcLabel}
            />
          ))}
        </div>

        <Button
          variant="default"
          data-testid="btn-persona-play"
          className="h-12 w-full"
          onClick={handlePlay}
        >
          Play
        </Button>
      </DialogContent>
    </Dialog>
  );
}
