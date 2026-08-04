import { useState } from 'react';
import type { ReactElement } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import { BOT_ACTION_BUTTON_CLASS } from '@/components/bots/chipStyles';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface GameControlsProps {
  /** Whether a draw offer is currently allowed (D-01 gate — e.g. not already pending). */
  canOfferDraw: boolean;
  /** D-04 post-decline cooldown throttle — disables the button with a tooltip. */
  drawCooldownActive: boolean;
  muted: boolean;
  onResignConfirmed: () => void;
  onOfferDraw: () => void;
  onToggleMute: () => void;
}

/**
 * Resign / offer-draw / mute control row for the bot-game board (Phase 169
 * Plan 05). Resign is a two-step D-04 confirmation via the existing `Dialog`
 * primitive (the trigger stays brand-outline; only the actual confirm action
 * is destructive-colored, per CLAUDE.md's primary/secondary button rule).
 */
export function GameControls({
  canOfferDraw,
  drawCooldownActive,
  muted,
  onResignConfirmed,
  onOfferDraw,
  onToggleMute,
}: GameControlsProps): ReactElement {
  const [resignDialogOpen, setResignDialogOpen] = useState(false);
  const drawOfferDisabled = !canOfferDraw || drawCooldownActive;

  const handleConfirmResign = (): void => {
    setResignDialogOpen(false);
    onResignConfirmed();
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="brand-outline"
        className={cn(BOT_ACTION_BUTTON_CLASS, 'flex-1')}
        onClick={() => setResignDialogOpen(true)}
        data-testid="board-btn-resign"
      >
        Resign
      </Button>
      <Dialog open={resignDialogOpen} onOpenChange={setResignDialogOpen}>
        <DialogContent data-testid="resign-confirm-dialog">
          <DialogHeader>
            <DialogTitle>Resign this game?</DialogTitle>
            <DialogDescription>You&apos;ll lose this game against the bot.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className={BOT_ACTION_BUTTON_CLASS}
              onClick={() => setResignDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className={BOT_ACTION_BUTTON_CLASS}
              onClick={handleConfirmResign}
              data-testid="board-btn-resign-confirm"
            >
              Resign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* WR-04: the tooltip content is Radix-rendered regardless of hover
       * intent, so it must only ever MOUNT while the cooldown is actually
       * the reason the button is disabled — an unconditional wrapper opens
       * "Wait a few more moves..." on hover of a perfectly clickable button.
       * `drawCooldownActive` (not the combined `drawOfferDisabled`) is the
       * correct gate: an enabled button never wraps in a tooltip at all. */}
      {/* Resign and Offer draw split the row evenly (`flex-1` each); the mute
          toggle keeps its fixed square footprint. In the cooldown branch the
          Tooltip's `<span>` is the actual flex child, so it carries `flex-1`
          and the button inside stretches to `w-full`. */}
      {drawCooldownActive ? (
        <Tooltip content="Wait a few more moves before offering again">
          <span className="flex-1">
            <Button
              variant="brand-outline"
              className={cn(BOT_ACTION_BUTTON_CLASS, 'w-full')}
              disabled={drawOfferDisabled}
              onClick={onOfferDraw}
              data-testid="board-btn-offer-draw"
            >
              Offer draw
            </Button>
          </span>
        </Tooltip>
      ) : (
        <Button
          variant="brand-outline"
          className={cn(BOT_ACTION_BUTTON_CLASS, 'flex-1')}
          disabled={drawOfferDisabled}
          onClick={onOfferDraw}
          data-testid="board-btn-offer-draw"
        >
          Offer draw
        </Button>
      )}

      <Button
        variant="ghost"
        size="icon"
        className="size-12"
        onClick={onToggleMute}
        aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
        data-testid="board-btn-mute"
      >
        {muted ? <VolumeX /> : <Volume2 />}
      </Button>
    </div>
  );
}
