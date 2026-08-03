// @vitest-environment jsdom
/**
 * InstallPromptBanner.test.tsx — Phase 203 Plan 02 (INSTALL-03/06, D-07/D-11).
 * Wave-0 gap: this component had zero automated coverage before this phase.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InstallPromptBanner } from '@/components/install/InstallPromptBanner';
import { HANDOFF_MARKER_KEY } from '@/lib/handoffMarker';

vi.mock('@/hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => mockUseInstallPrompt(),
}));

const mockUseInstallPrompt = vi.fn();

const LIVE_OFFER_STATE = {
  showAndroidPrompt: true,
  showIOSBanner: false,
  canInstall: true,
  isIOS: false,
  isStandalone: false,
  isMobile: true,
  triggerInstall: vi.fn(),
  dismissAndroid: vi.fn(),
  dismissIOS: vi.fn(),
};

function renderAt(path: string): void {
  mockUseInstallPrompt.mockReturnValue(LIVE_OFFER_STATE);
  render(
    <MemoryRouter initialEntries={[path]}>
      <InstallPromptBanner />
    </MemoryRouter>,
  );
}

describe('InstallPromptBanner', () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the Android drawer on /openings with a live offer', () => {
    renderAt('/openings');
    expect(screen.getByTestId('install-prompt-android')).not.toBeNull();
  });

  it('renders nothing on /train (D-07 route suppression)', () => {
    renderAt('/train');
    expect(screen.queryByTestId('install-prompt-android')).toBeNull();
  });

  it('renders nothing on /train/anything — proves prefix match, not exact path', () => {
    renderAt('/train/anything');
    expect(screen.queryByTestId('install-prompt-android')).toBeNull();
  });

  it('renders the drawer on /train when the handoff marker is active (D-11 override)', () => {
    sessionStorage.setItem(HANDOFF_MARKER_KEY, '1');
    renderAt('/train');
    expect(screen.getByTestId('install-prompt-android')).not.toBeNull();
  });

  it('the drawer body makes no notification/reminder/alert/push promise (INSTALL-06)', () => {
    renderAt('/openings');
    const drawer = screen.getByTestId('install-prompt-android');
    expect(drawer.textContent ?? '').not.toMatch(/notification|remind|alert|push/i);
  });
});
