import { SkipBack, ChevronLeft, ChevronRight, Repeat2, FastForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

interface BoardControlsProps {
  onBack: () => void;
  onForward: () => void;
  onReset: () => void;
  onFlip: () => void;
  canGoBack: boolean;
  /** Enable state for the Reset button. Defaults to `canGoBack` when omitted. */
  canReset?: boolean;
  canGoForward: boolean;
  /**
   * Fast-forward handler (Quick 260831-s4y). The button renders ONLY when this
   * is supplied — Openings, Bots, Train and the App.tsx mobile board bar all
   * render BoardControls without it and deliberately keep four buttons (D-07).
   */
  onFastForward?: () => void;
  /** Enable state for the fast-forward button. Ignored when onFastForward is omitted. */
  canFastForward?: boolean;
  /** Optional slot for an info icon rendered at the end of the bar */
  infoSlot?: React.ReactNode;
  /** Render buttons in a vertical column (used on mobile beside the board) */
  vertical?: boolean;
  /**
   * Flat surface (Quick 260628-dgv): drop the rounded charcoal pill so the buttons
   * sit directly on the parent bar, reading like the main nav buttons. Used by the
   * mobile /analysis board-controls footer; desktop/Openings keep the pill.
   */
  flat?: boolean;
  /** Button size. 'sm' = h-8 w-8 (desktop), 'md' = h-9 w-9 (mobile slim row), 'lg' = h-11 w-11 (mobile vertical column), 'xl' = each button fills an equal share of the bar at a 48px tap target (bot play, matching that page's other action buttons). Defaults to 'lg' when vertical, 'sm' otherwise. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Explicit Tailwind size classes for the buttons. Overrides `size` when provided — use when width and height need to be decoupled (e.g. `h-9 w-11`). */
  buttonClassName?: string;
  /** Additional CSS classes for the root container */
  className?: string;
}

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg' | 'xl', string> = {
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-11 w-11',
  xl: 'flex-1 h-12',
};

export function BoardControls({
  onBack,
  onForward,
  onReset,
  onFlip,
  canGoBack,
  canReset,
  canGoForward,
  onFastForward,
  canFastForward,
  infoSlot,
  vertical = false,
  size,
  buttonClassName,
  className,
  flat = false,
}: BoardControlsProps) {
  const resolvedSize = size ?? (vertical ? 'lg' : 'sm');
  // flat (mobile /analysis footer) reads like the main nav bar: each control fills an
  // equal share of the width (flex-1) with a tall 48px tap target, unless the caller
  // pins an explicit size/buttonClassName (Quick 260628-cjp — larger tap targets).
  const navStyle = flat && !buttonClassName && !size;
  const buttonSizeClass =
    buttonClassName ?? (navStyle ? 'flex-1 h-12' : SIZE_CLASSES[resolvedSize]);
  // flat drops the charcoal pill so the bar reads like the main nav (Quick 260628-dgv).
  const surfaceClass = flat ? '' : 'rounded-lg charcoal-texture';
  // Match the main nav icon size (h-5) on the flat mobile bar and the 48px 'xl'
  // bar; keep h-4 on the smaller desktop/vertical pills.
  const iconSize = navStyle || resolvedSize === 'xl' ? 'h-5 w-5' : 'h-4 w-4';
  return (
    <div className={`flex items-center justify-evenly ${surfaceClass} ${vertical ? 'flex-col' : ''} ${className ?? ''}`}>
      <Tooltip content="Reset to start">
        <Button
          variant="ghost"
          size="icon"
          className={`${buttonSizeClass} hover:bg-accent`}
          onClick={onReset}
          disabled={!(canReset ?? canGoBack)}
          aria-label="Reset to start"
          data-testid="board-btn-reset"
        >
          <SkipBack className={iconSize} />
        </Button>
      </Tooltip>
      <Tooltip content="Previous move">
        <Button
          variant="ghost"
          size="icon"
          className={`${buttonSizeClass} hover:bg-accent`}
          onClick={onBack}
          disabled={!canGoBack}
          aria-label="Previous move"
          data-testid="board-btn-back"
        >
          <ChevronLeft className={iconSize} />
        </Button>
      </Tooltip>
      <Tooltip content="Next move">
        <Button
          variant="ghost"
          size="icon"
          className={`${buttonSizeClass} hover:bg-accent`}
          onClick={onForward}
          disabled={!canGoForward}
          aria-label="Next move"
          data-testid="board-btn-forward"
        >
          <ChevronRight className={iconSize} />
        </Button>
      </Tooltip>
      {onFastForward && (
        <Tooltip content="Fast forward to next key moment">
          <Button
            variant="ghost"
            size="icon"
            className={`${buttonSizeClass} hover:bg-accent`}
            onClick={onFastForward}
            disabled={!canFastForward}
            aria-label="Fast forward to next key moment"
            data-testid="board-btn-fast-forward"
          >
            <FastForward className={iconSize} />
          </Button>
        </Tooltip>
      )}
      <Tooltip content="Flip board">
        <Button
          variant="ghost"
          size="icon"
          className={`${buttonSizeClass} hover:bg-accent`}
          onClick={onFlip}
          aria-label="Flip board"
          data-testid="board-btn-flip"
        >
          <Repeat2 className={iconSize} />
        </Button>
      </Tooltip>
      {infoSlot}
    </div>
  );
}
