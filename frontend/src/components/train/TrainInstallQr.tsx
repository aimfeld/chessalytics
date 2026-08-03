/**
 * TrainInstallQr — the desktop→phone QR handoff block (HANDOFF-01..04,
 * D-09/D-10/D-13, 203-UI-SPEC.md § Interaction Contract 4). Shared by two
 * mount points: `TrainReminderButton`'s desktop confirmed-state upsell
 * (`testId="qr-handoff-score"`) and `TrainScheduleSettings`'s permanent home
 * (`testId="qr-handoff-settings"`).
 *
 * The mount-site `testId` is a REQUIRED PROP, never hardcoded inside this
 * component — that is what keeps the two mount points independently
 * queryable instead of colliding on one selector.
 *
 * The payload (`HANDOFF_QR_PATH`) is a plain URL with no token, session id,
 * user id or email of any kind (HANDOFF-01) — a signed one-time credential
 * was explicitly rejected for v1, because a scannable credential rendered on
 * a monitor is account takeover by screen-share, shoulder-surf, or
 * photograph.
 *
 * `qrcode.react`'s `QRCodeSVG` is lazy-loaded via `React.lazy` + `Suspense`
 * (fallback `null` — the structural-absence rule forbids a skeleton) so its
 * bundle stays off the mobile critical path. UAT item 5 (post-review fix,
 * 203-REVIEW.md): this component now ONLY ever mounts on desktop
 * (`!isMobile && !isStandalone`) at BOTH call sites — the score screen's
 * confirmed-state upsell already gated on that (`showDesktopQr` in
 * `TrainReminderButton`), but `TrainScheduleSettings`'s permanent Settings
 * home used to mount it unconditionally, which meant a phone visiting its
 * own Settings page rendered a QR asking the user to scan their own screen
 * with the same phone. Both call sites now gate before mounting this
 * component; the mobile-reachable equivalent is a live "Install FlawChess"
 * button (or nothing, if there is no live `beforeinstallprompt`), never this
 * component. The chunk is still fetched on demand either way, never eagerly.
 *
 * No dismiss control anywhere (D-13, a deliberate deviation from
 * HANDOFF-03's literal "dismissible" wording) — do not add one.
 */
import { lazy, Suspense, type ReactElement } from 'react';

const QRCodeSVG = lazy(() =>
  import('qrcode.react').then((module) => ({ default: module.QRCodeSVG })),
);

/** HANDOFF-01: no credential, no token — a plain path appended to the
 * current origin at render time. */
export const HANDOFF_QR_PATH = '/train?src=handoff';

/** D-10: 128x128, matching `qrcode.react`'s own default render size. */
export const QR_SIZE_PX = 128;

export interface TrainInstallQrProps {
  /** The mount-site test id — REQUIRED, never hardcoded inside this
   * component (see module docstring). */
  testId: string;
}

export function TrainInstallQr({ testId }: TrainInstallQrProps): ReactElement {
  const payload = `${window.location.origin}${HANDOFF_QR_PATH}`;

  return (
    <div className="w-full" data-testid={testId}>
      {/*
        The ONE new non-token colour surface in this phase — fixed
        (#FFFFFF background / #000000 modules) precisely because it must
        NOT follow the app theme. A theme-tinted or inverted QR is a
        scan-reliability risk (203-UI-SPEC.md § Color, QR contrast
        contract). Do not replace bg-white with a theme.ts token.
      */}
      <div className="inline-block rounded-md bg-white p-2">
        <Suspense fallback={null}>
          <QRCodeSVG value={payload} size={QR_SIZE_PX} />
        </Suspense>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Scan with your phone to open FlawChess there
      </p>
    </div>
  );
}
