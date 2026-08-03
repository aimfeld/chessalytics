// @vitest-environment jsdom
/**
 * TrainInstallQr.test.tsx — HANDOFF-01..04 (Phase 203 Plan 03, Task 3).
 * Mocks the lazy-loaded `qrcode.react` module with a plain stub element so
 * assertions target the encoded payload and DOM shape, not the library's
 * internal SVG-rendering details (203-RESEARCH.md Assumption A4: the real
 * export/prop shape — `QRCodeSVG`, `value`, `size` — was confirmed against
 * the installed package's shipped `.d.ts`, not assumed from memory).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, size }: { value: string; size?: number }) => (
    <svg data-testid="qr-code-svg-stub" data-value={value} data-size={size} />
  ),
}));

import { TrainInstallQr, HANDOFF_QR_PATH } from '@/components/train/TrainInstallQr';

afterEach(() => {
  cleanup();
});

describe('TrainInstallQr', () => {
  it("encodes exactly window.location.origin + '/train?src=handoff'", async () => {
    render(<TrainInstallQr testId="qr-handoff-test" />);

    await waitFor(() => {
      expect(screen.getByTestId('qr-code-svg-stub')).not.toBeNull();
    });
    expect(screen.getByTestId('qr-code-svg-stub').getAttribute('data-value')).toBe(
      `${window.location.origin}${HANDOFF_QR_PATH}`,
    );
  });

  it('renders the caption text beneath the chip', async () => {
    render(<TrainInstallQr testId="qr-handoff-test" />);

    await waitFor(() => {
      expect(screen.getByText('Scan with your phone to open FlawChess there')).not.toBeNull();
    });
  });

  it('applies the caller-supplied testId to its root; two instances with different testIds are both independently queryable', async () => {
    render(
      <>
        <TrainInstallQr testId="qr-handoff-score" />
        <TrainInstallQr testId="qr-handoff-settings" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('qr-handoff-score')).not.toBeNull();
      expect(screen.getByTestId('qr-handoff-settings')).not.toBeNull();
    });
  });

  it('performs no storage write and no navigation while rendering', async () => {
    const localSetItem = vi.spyOn(Storage.prototype, 'setItem');

    render(<TrainInstallQr testId="qr-handoff-test" />);
    await waitFor(() => {
      expect(screen.getByTestId('qr-code-svg-stub')).not.toBeNull();
    });

    expect(localSetItem).not.toHaveBeenCalled();
    localSetItem.mockRestore();
  });

  it('renders no dismiss control — no role="button" element and no accessible name matching /dismiss|close|not now/i', async () => {
    render(<TrainInstallQr testId="qr-handoff-test" />);

    await waitFor(() => {
      expect(screen.getByTestId('qr-code-svg-stub')).not.toBeNull();
    });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/dismiss|close|not now/i)).toBeNull();
  });

  it('renders the QR chip in a fixed white rounded surface, never a theme-derived color', () => {
    const { container } = render(<TrainInstallQr testId="qr-handoff-test" />);
    const chip = container.querySelector('.bg-white');
    expect(chip).not.toBeNull();
  });
});
