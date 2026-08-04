import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { BotGameSnapshot } from '@/lib/botGameSnapshot';
import { BOT_ACTION_BUTTON_CLASS } from '@/components/bots/chipStyles';

// ─── Named constants (CLAUDE.md no-magic-numbers) ──────────────────────────

/** The project's estimated-duration TC-bucket rule (CLAUDE.md, mirrored from
 * `app/services/normalization.py::parse_time_control`): estimated seconds =
 * base + increment * MOVES_PER_GAME_ESTIMATE, bucketed bullet/blitz/rapid/
 * classical. Used here ONLY for the gate's human label — never for the wire
 * format (that's `toBackendTcStr`, deliberately NOT imported here). */
const BULLET_MAX_SECONDS = 180;
const BLITZ_MAX_SECONDS = 600;
const RAPID_MAX_SECONDS = 1800;
const MOVES_PER_GAME_ESTIMATE = 40;

const SECONDS_PER_MINUTE = 60;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = MS_PER_SECOND * 60;
const MS_PER_HOUR = MS_PER_MINUTE * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

interface ResumeGateProps {
  snapshot: BotGameSnapshot;
  /** Read off the already-restored hook's `liveGamePly` — never re-parsed
   * from `snapshot.pgn` here (that would be a second, parallel replay path). */
  plyCount: number;
  onResume: () => void;
  onDiscard: () => void;
}

/**
 * A HUMAN label ("Blitz 5+3"), minutes-based. Do NOT use `toBackendTcStr`
 * here: that is the base-seconds WIRE format ("300+3") and must never leak
 * into UI copy. Bucketed via the project's estimated-duration rule.
 */
function formatTcLabel(baseSeconds: number, incrementSeconds: number): string {
  const estimatedSeconds = baseSeconds + incrementSeconds * MOVES_PER_GAME_ESTIMATE;

  let bucketLabel: string;
  if (estimatedSeconds < BULLET_MAX_SECONDS) bucketLabel = 'Bullet';
  else if (estimatedSeconds < BLITZ_MAX_SECONDS) bucketLabel = 'Blitz';
  else if (estimatedSeconds <= RAPID_MAX_SECONDS) bucketLabel = 'Rapid';
  else bucketLabel = 'Classical';

  const baseMinutes = baseSeconds / SECONDS_PER_MINUTE;
  return `${bucketLabel} ${baseMinutes}+${incrementSeconds}`;
}

/**
 * "just now" / "N minutes ago" / "N hours ago" / "N days ago", with correct
 * singular/plural. D-06: a snapshot never expires — the age is shown so a
 * stale game is obvious and the USER decides. No TTL, no auto-drop.
 */
function formatRelativeAge(savedAt: number, now: number): string {
  const elapsedMs = Math.max(0, now - savedAt);

  if (elapsedMs < MS_PER_MINUTE) return 'just now';

  if (elapsedMs < MS_PER_HOUR) {
    const minutes = Math.floor(elapsedMs / MS_PER_MINUTE);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  if (elapsedMs < MS_PER_DAY) {
    const hours = Math.floor(elapsedMs / MS_PER_HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(elapsedMs / MS_PER_DAY);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The "Resume game?" overlay (Phase 170 D-04). Renders as a non-dismissible
 * `Dialog` (no close affordance, `onOpenChange` ignores close attempts) over
 * the already-restored board, so the user recognizes the game and explicitly
 * chooses Resume or Discard — nothing starts until they do. Discard opens a
 * confirmation first (D-05, mirroring `GameControls`' resign-confirm
 * verbatim): discarding an in-progress game is irreversible and leaves no
 * server trace anywhere (SC2).
 */
export function ResumeGate({
  snapshot,
  plyCount,
  onResume,
  onDiscard,
}: ResumeGateProps): ReactElement {
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // react-hooks/purity: Date.now() is impure — read it once via a lazy
  // initializer rather than directly during render. The gate is a
  // short-lived overlay, so a single mount-time snapshot of "now" is
  // sufficient (no live-ticking age display is required by D-06).
  const [now] = useState(() => Date.now());

  const tcLabel = formatTcLabel(snapshot.settings.baseSeconds, snapshot.settings.incrementSeconds);
  const age = formatRelativeAge(snapshot.savedAt, now);
  const identityLine = `${tcLabel} vs FlawChess Bot (${snapshot.settings.botElo}) · ${plyCount} moves · ${age}`;

  const handleConfirmDiscard = (): void => {
    setDiscardConfirmOpen(false);
    onDiscard();
  };

  return (
    <>
      <Dialog open onOpenChange={() => {}}>
        <DialogContent data-testid="resume-gate" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Resume game?</DialogTitle>
            <DialogDescription className="text-sm">{identityLine}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="brand-outline"
              className={BOT_ACTION_BUTTON_CLASS}
              onClick={() => setDiscardConfirmOpen(true)}
              data-testid="btn-discard"
            >
              Discard
            </Button>
            <Button
              variant="default"
              className={BOT_ACTION_BUTTON_CLASS}
              onClick={onResume}
              data-testid="btn-resume"
            >
              Resume
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
        <DialogContent data-testid="discard-confirm-dialog">
          <DialogHeader>
            <DialogTitle>Discard this game?</DialogTitle>
            <DialogDescription>
              This game will be lost — unfinished games are never saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className={BOT_ACTION_BUTTON_CLASS}
              onClick={() => setDiscardConfirmOpen(false)}
              data-testid="btn-discard-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className={BOT_ACTION_BUTTON_CLASS}
              onClick={handleConfirmDiscard}
              data-testid="btn-discard-confirm"
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
