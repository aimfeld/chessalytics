// @vitest-environment jsdom
/**
 * BoardControls unit tests — the opt-in fast-forward render guard
 * (Quick 260831-s4y, D-07).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BoardControls } from '../BoardControls';
import { TooltipProvider } from '@/components/ui/tooltip';

function requiredHandlers() {
  return {
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReset: vi.fn(),
    onFlip: vi.fn(),
    canGoBack: true,
    canGoForward: true,
  };
}

function renderControls(props: Partial<Parameters<typeof BoardControls>[0]> = {}) {
  return render(
    <TooltipProvider>
      <BoardControls {...requiredHandlers()} {...props} />
    </TooltipProvider>,
  );
}

describe('BoardControls', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders exactly the four base buttons when onFastForward is omitted (D-07 invariant)', () => {
    renderControls();
    expect(screen.queryByTestId('board-btn-fast-forward')).toBeNull();
    expect(screen.getByTestId('board-btn-reset')).toBeTruthy();
    expect(screen.getByTestId('board-btn-back')).toBeTruthy();
    expect(screen.getByTestId('board-btn-forward')).toBeTruthy();
    expect(screen.getByTestId('board-btn-flip')).toBeTruthy();
  });

  it('renders the fast-forward button, enabled, with its aria-label, and calls the handler once when clicked', () => {
    const onFastForward = vi.fn();
    renderControls({ onFastForward, canFastForward: true });
    const button = screen.getByTestId('board-btn-fast-forward') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-label')).toBe('Fast forward to next key moment');
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    expect(onFastForward).toHaveBeenCalledTimes(1);
  });

  it('renders the fast-forward button disabled when canFastForward is false or omitted', () => {
    const onFastForward = vi.fn();
    renderControls({ onFastForward, canFastForward: false });
    expect((screen.getByTestId('board-btn-fast-forward') as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    renderControls({ onFastForward });
    expect((screen.getByTestId('board-btn-fast-forward') as HTMLButtonElement).disabled).toBe(true);
  });
});
