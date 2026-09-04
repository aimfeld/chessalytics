import type { ReactElement, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Switch } from '@/components/ui/switch';

/**
 * Engine-card header: a Switch + accented icon/label row. Shared by
 * `AnalysisTabs.tsx`'s `FlawChessCard` and `AnalysisDesktopCards.tsx`'s
 * `StockfishCard` (215-06 WR-03) — previously two private copies that had
 * already diverged (one hard-coded the `Cpu` icon, the other kept the
 * original `icon` prop), each citing `Analysis.tsx`'s own module-level
 * `EngineToggleHeader` as their "source of truth" even though that helper
 * no longer exists there. Both sibling component files import from here
 * instead.
 */
export function EngineToggleHeader({
  checked,
  onCheckedChange,
  accent,
  testId,
  ariaLabel,
  icon: Icon,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  accent: string;
  testId: string;
  ariaLabel: string;
  icon: LucideIcon;
  children: ReactNode;
}): ReactElement {
  return (
    <>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
        data-testid={testId}
        style={checked ? { backgroundColor: accent } : undefined}
      />
      <span className="flex items-center gap-1.5 text-sm font-medium" style={{ color: accent }}>
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {children}
      </span>
    </>
  );
}
