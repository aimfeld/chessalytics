import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { BOT_ACTION_BUTTON_CLASS } from '@/components/bots/chipStyles';

interface BotDrawOfferBannerProps {
  /** True while the bot has a live outgoing draw offer (Phase 183, D-07 —
   * `useBotGame`'s `botDrawOffer`). Nothing renders while false. */
  offerLive: boolean;
  /** The offering persona's name, or `null` for a Custom game (falls back to
   * the generic "The bot offers a draw" copy). */
  personaName: string | null;
  onAccept: () => void;
  onDecline: () => void;
}

/**
 * A non-blocking inline banner near the board/clocks announcing the bot's
 * outgoing draw offer (Phase 183, D-07). Renders nothing while no offer is
 * live. Play continues underneath it — this is deliberately NOT a Dialog:
 * the user can keep looking at the board, and the hook auto-expires the
 * offer on the user's next committed move (no extra page logic needed here).
 */
export function BotDrawOfferBanner({
  offerLive,
  personaName,
  onAccept,
  onDecline,
}: BotDrawOfferBannerProps): ReactElement | null {
  if (!offerLive) return null;

  const message = personaName ? `${personaName} offers a draw` : 'The bot offers a draw';

  return (
    <div
      data-testid="bot-draw-offer-banner"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] bg-secondary px-4 py-2"
    >
      <span className="text-sm font-medium text-foreground">{message}</span>
      <div className="flex items-center gap-2">
        <Button
          variant="default"
          className={BOT_ACTION_BUTTON_CLASS}
          onClick={onAccept}
          data-testid="btn-accept-bot-draw"
        >
          Accept
        </Button>
        <Button
          variant="brand-outline"
          className={BOT_ACTION_BUTTON_CLASS}
          onClick={onDecline}
          data-testid="btn-decline-bot-draw"
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
