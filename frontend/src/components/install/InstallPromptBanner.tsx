import { Share, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerClose,
} from '@/components/ui/drawer';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { isHandoffActive } from '@/lib/handoffMarker';

export function InstallPromptBanner() {
  const { showAndroidPrompt, showIOSBanner, triggerInstall, dismissAndroid, dismissIOS } = useInstallPrompt();
  const location = useLocation();

  // D-07/INSTALL-03: neither install surface renders on a Train route — this
  // is how "push before install" is satisfied structurally, by making it
  // geometrically impossible for the drawer to sit on top of, or steal a tap
  // from, the "Remind me" button, the score screen, or the Settings toggle,
  // rather than with a cross-component ordering arbiter. D-11: a scanned
  // handoff QR overrides this suppression for that one load — the marker is
  // an explicit "I came here to install" signal.
  const suppressedOnTrainRoute = location.pathname.startsWith('/train') && !isHandoffActive();
  if (suppressedOnTrainRoute) {
    return null;
  }

  return (
    <>
      {/* Android: bottom drawer install prompt */}
      <Drawer open={showAndroidPrompt} onOpenChange={(open) => { if (!open) dismissAndroid(); }} direction="bottom">
        <DrawerContent data-testid="install-prompt-android">
          <DrawerHeader>
            <DrawerTitle>Install FlawChess</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-6">
            <p className="text-sm text-muted-foreground mb-4">
              Get faster loads and instant access to your Train puzzles — right from your home screen.
            </p>
            <div className="flex gap-3">
              <Button
                onClick={triggerInstall}
                className="flex-1"
                data-testid="btn-install"
              >
                Install
              </Button>
              <DrawerClose asChild>
                <Button
                  variant="ghost"
                  className="flex-1"
                  data-testid="btn-install-dismiss"
                >
                  Not now
                </Button>
              </DrawerClose>
            </div>
          </div>
        </DrawerContent>
      </Drawer>

      {/* iOS: fixed bottom banner */}
      {showIOSBanner && (
        <div
          data-testid="banner-ios-install"
          className="fixed bottom-16 inset-x-0 z-30 sm:hidden flex items-center gap-3 bg-card border-t border-border px-4 py-3 pb-safe"
        >
          <Share className="h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-foreground flex-1">
            Install: tap <strong>Share</strong> then <strong>Add to Home Screen</strong>
          </p>
          <Tooltip content="Dismiss install banner">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 flex-shrink-0"
              onClick={dismissIOS}
              aria-label="Dismiss install banner"
              data-testid="btn-ios-install-dismiss"
            >
              <X className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      )}
    </>
  );
}
