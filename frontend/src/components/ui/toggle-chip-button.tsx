/**
 * ToggleChipButton — the hand-rolled multi-select chip button pattern used by
 * `FilterPanel`'s "Time control" and "Platform" sections (grid layout, plain
 * `<button>`s — deliberately NOT the Radix `ToggleGroup` primitive used for
 * single-select rows like "Played as"). Extracted (191-06 UAT) so the exact
 * class strings live in exactly one place instead of being copy-pasted at
 * every multi-select-chip call site (FilterPanel's own two sections, plus
 * `TrainScheduleSettings`'s weekday picker).
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface ToggleChipButtonProps {
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
  testId?: string;
  disabled?: boolean;
  children: ReactNode;
}

export function ToggleChipButton({
  active,
  onClick,
  ariaLabel,
  testId,
  disabled,
  children,
}: ToggleChipButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={cn(
        'rounded border h-11 sm:h-7 text-sm transition-colors',
        active
          ? 'border-toggle-active bg-toggle-active text-toggle-active-foreground pointer-fine:hover:bg-toggle-active-hover'
          : 'border-border bg-inactive-bg text-muted-foreground pointer-fine:hover:bg-inactive-bg-hover pointer-fine:hover:text-foreground',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className="flex items-center justify-center gap-1">{children}</span>
    </button>
  );
}
