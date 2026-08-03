# Phase 203: PWA Install Re-prompting & Train-Anchored Install Offer - Pattern Map

**Mapped:** 2026-08-02
**Files analyzed:** 12 (7 modified, 5 mechanical-repeat backend + migration)
**Analogs found:** 12 / 12 — every file this phase touches already exists and has a same-file or
sibling-file precedent to copy. No greenfield architecture in this phase; all analogs read-verified
this session at the cited line numbers.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `frontend/src/hooks/useInstallPrompt.ts` | hook | event-driven (browser install lifecycle + localStorage) | itself (in-place rewrite) | exact — self-analog, defect fix not a new pattern |
| `frontend/src/components/install/InstallPromptBanner.tsx` | component | request-response (route-gated render) | itself + `App.tsx`'s route-matching helper | exact |
| `frontend/src/components/train/TrainReminderButton.tsx` | component | CRUD (settings PUT) + event-driven (capability probes) | itself (five-state extension of existing four-branch component) | exact |
| `frontend/src/components/train/TrainScheduleSettings.tsx` | component | CRUD (debounced settings PUT) | itself (`ReminderControls` extraction pattern) | exact |
| New: QR handoff block component (mount-site prop, e.g. `TrainInstallQr.tsx`) | component | transform (URL → SVG, no I/O) | `ReminderControls` in `TrainScheduleSettings.tsx:201-251` (small presentational sub-component extracted to respect LOC limits) | role-match |
| `?src=handoff` sessionStorage capture/consume (hook or `ProtectedLayout` mount effect, TBD) | utility/hook | event-driven (one-shot OAuth-redirect survival) | `frontend/src/pages/OAuthCallbackPage.tsx:34-43` (`pending_toast`) + `frontend/src/api/googleAuth.ts:4,36-42` (`promote_intent`) | exact — two live precedents for the exact same mechanism |
| Re-surface banner (OFFER-05, new component, likely `TrainReminderResurfaceBanner.tsx`) | component | CRUD (subscribe) + event-driven (standalone launch trigger) | `TrainReminderButton.tsx` (capability-gated CTA + `ERROR_COPY` reuse) + `ScheduleCardShell`'s `Card` wrapper | role-match |
| `app/models/train_settings.py` (+ `reminder_intent_at` column) | model | CRUD | itself — `reminder_last_sent_on` (structural sibling, nullable timestamp) at lines 100-113 | exact |
| `alembic/versions/<new>_phase_203_reminder_intent.py` | migration | batch (schema DDL) | `alembic/versions/20260801_225358_ca8c8fbc2080_phase_201_train_reminder_columns.py` | exact |
| `app/schemas/train.py` (`TrainSettingsResponse` + `TrainSettingsUpdate`) | model (Pydantic schema) | request-response (validation) | itself, lines 198-246 (`reminder_enabled`/`reminder_hour` added identically in Phase 201) | exact |
| `app/repositories/train_repository.py` (`TrainSettingsRow`, `get_or_create_settings`, `upsert_settings`) | repository | CRUD | itself, lines 124-431 | exact |
| `app/routers/train.py` (`GET`/`PUT /train/settings`) | router | request-response | itself, lines 237-300 | exact |

## Pattern Assignments

### `frontend/src/hooks/useInstallPrompt.ts` (hook, event-driven)

**Analog:** itself — full 60-line file read, this is a defect-fix rewrite not a new pattern.

**Current file in full** (`frontend/src/hooks/useInstallPrompt.ts:1-60`):
```typescript
import { useState, useEffect } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const ANDROID_DISMISS_KEY = 'install-prompt-dismissed';
const IOS_DISMISS_KEY = 'ios-install-banner-dismissed';

export function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isAndroidDismissed, setIsAndroidDismissed] = useState(
    () => localStorage.getItem(ANDROID_DISMISS_KEY) === 'true'
  );
  const [isIOSDismissed, setIsIOSDismissed] = useState(
    () => localStorage.getItem(IOS_DISMISS_KEY) === 'true'
  );

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const triggerInstall = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'accepted') {
      setPromptEvent(null);          // <- the ONLY correct null site (INSTALL-04 target)
    }
  };

  const dismissAndroid = () => {          // <- BUG SITE 1 (INSTALL-01/04)
    setIsAndroidDismissed(true);
    localStorage.setItem(ANDROID_DISMISS_KEY, 'true');   // bare boolean, no timestamp
    setPromptEvent(null);                                 // must NOT null here
  };

  const dismissIOS = () => {
    setIsIOSDismissed(true);
    localStorage.setItem(IOS_DISMISS_KEY, 'true');
  };

  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches; // <- BUG SITE 2 (INSTALL-05, missing navigator.standalone OR)
  const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  return {
    showAndroidPrompt: !!promptEvent && !isAndroidDismissed && !isStandalone && isMobile, // fail-safe: `!!promptEvent` already load-bearing
    showIOSBanner: isIOS && !isStandalone && !isIOSDismissed,
    triggerInstall,
    dismissAndroid,
    dismissIOS,
  };
}
```

**Fix shape for the three bug sites** (D-04/D-05, INSTALL-04, INSTALL-05 — values are LOCKED, not illustrative):
```typescript
const INSTALL_COOLDOWN_DAYS = 14; // D-04, named constant, never a literal
const INSTALL_MAX_ATTEMPTS = 3;   // D-04

// dismissAndroid must NOT call setPromptEvent(null) — move only cooldown state:
const dismissAndroid = () => {
  const now = Date.now();
  localStorage.setItem(ANDROID_DISMISS_AT_KEY, String(now));
  localStorage.setItem(ANDROID_ATTEMPT_COUNT_KEY, String(attemptCount + 1));
  setIsAndroidDismissed(true); // local re-render only; promptEvent survives
};

// isStandalone must OR navigator.standalone (requires a type augmentation, see Pitfall 3):
const isStandalone =
  (typeof navigator !== 'undefined' && navigator.standalone === true) ||
  (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches);
```

**Type augmentation needed** (RESEARCH.md Pitfall 3 — `navigator.standalone` is not in `lib.dom.d.ts`):
```typescript
declare global {
  interface Navigator {
    readonly standalone?: boolean;
  }
}
```

**Fail-safe property already present and must be preserved**: `showAndroidPrompt: !!promptEvent && ...`
(line 54) — the `!!promptEvent` term is why a non-re-firing Chrome silently shows nothing rather than a
dead button. Any rewrite of this return line must keep that term first.

---

### `frontend/src/components/install/InstallPromptBanner.tsx` (component, request-response)

**Analog:** itself, full 72-line file read.

**Current mount/consume pattern** (`InstallPromptBanner.tsx:1-10`):
```typescript
import { useInstallPrompt } from '@/hooks/useInstallPrompt';

export function InstallPromptBanner() {
  const { showAndroidPrompt, showIOSBanner, triggerInstall, dismissAndroid, dismissIOS } = useInstallPrompt();
  // ...renders <Drawer open={showAndroidPrompt} ...> and the iOS fixed banner
}
```

**D-07 Train-route suppression + D-11 `?src=handoff` override** — reuse the exact route-matching predicate
already established at `App.tsx:127` (`pathname.startsWith('/train')`), consumed via `useLocation()`
already imported at `App.tsx:2`:
```typescript
// App.tsx:126-128 (VERIFIED) — the existing predicate to reuse verbatim:
if (to === '/library') return pathname.startsWith('/library');
if (to === '/train') return pathname.startsWith('/train');
if (to === '/bots') return pathname.startsWith('/bots');
```
Add the check either at `InstallPromptBanner`'s two mount sites (`App.tsx:613`, `App.tsx:638`) or inside
`useInstallPrompt`/`InstallPromptBanner` itself — `useLocation()` is already in scope at both mount call
sites' parent component (multiple `const location = useLocation()` at `App.tsx:140,287,355,453,528`).

**Existing shipped copy/testids to reuse, not duplicate** (`InstallPromptBanner.tsx:15-69`):
- Android drawer: `data-testid="install-prompt-android"` (16), `btn-install` (28), `btn-install-dismiss` (36)
- iOS banner: `data-testid="banner-ios-install"` (49), `Share` icon + "tap **Share** then **Add to Home
  Screen**" body (52-55), `btn-ios-install-dismiss` (63) — this exact `Share` icon + copy is what D-14
  reuses as the lead-in for the iOS-tabbed Train slot's instructions, per UI-SPEC §6.

---

### `frontend/src/components/train/TrainReminderButton.tsx` (component, CRUD + event-driven)

**Analog:** itself, full 133-line file read — the five-state resolver (OFFER-01) extends this exact
component; do not create a parallel component.

**Current single-state guard cascade to replace with a named resolver** (`TrainReminderButton.tsx:67-78`):
```typescript
// No skeleton, no spinner, no placeholder — a clean structural absence
// until every gate clears.
if (
  !capability.isResolved ||
  !capability.available ||
  capability.permission === 'denied' ||
  deniedNow ||
  deviceSubscribed === null ||
  deviceSubscribed ||
  data === undefined ||
  vapidPublicKey === null
) {
  return null;
}
```
Per RESEARCH.md Architecture Pattern 3, extract a pure `resolveReminderSlotState({ available, isStandalone,
isIOS, subscribed }): 'desktop-unsubscribed' | 'android-unsubscribed' | 'ios-tabbed' |
'standalone-unsubscribed' | 'subscribed' | 'hidden'` computed once near the top, switched on in the render
body — mirrors `TrainScheduleSettings.tsx`'s existing `ReminderControls` extraction (below) for the same
CLAUDE.md nesting/LOC reason.

**Confirmed span — D-09's exact QR-attachment point, D-14's exact iOS-branch fill point**
(`TrainReminderButton.tsx:51-61`):
```typescript
if (state === 'confirmed' && data !== undefined) {
  return (
    <span
      data-testid="train-reminder-confirmed"
      className="flex flex-1 min-w-0 items-center justify-center gap-1 text-sm text-muted-foreground"
    >
      <Check className="size-4" aria-hidden="true" />
      Reminders on — {formatReminderHour(data.reminder_hour)} on your training days
    </span>
  );
}
```

**`handleClick`'s full-replace PUT shape — the pattern D-15's iOS-tap write and the re-surface banner's
subscribe must extend, never re-invent** (`TrainReminderButton.tsx:80-119`, save call at 93-99):
```typescript
save(
  {
    weekdayMask: data.weekday_mask,
    puzzlesPerSession: data.puzzles_per_session,
    reminderEnabled: true,
    reminderHour: data.reminder_hour,
    // reminder_intent_at will join this object once TrainSettingsUpdate carries it (D-02)
  },
  {
    onSuccess: () => setState('confirmed'),
    onError: () => setState('error'),
  },
);
```

**`ERROR_COPY` in-place-replace pattern to reuse verbatim in the re-surface banner** (`TrainReminderButton.tsx:26`):
```typescript
const ERROR_COPY = "Couldn't turn on reminders. Try again.";
// ...
{state === 'error' ? ERROR_COPY : 'Remind me'}
```

---

### `frontend/src/components/train/TrainScheduleSettings.tsx` (component, CRUD, HANDOFF-04's QR home)

**Analog:** itself — `ReminderControls` extraction pattern (lines 183-251) is the exact shape the QR block
and the D-15 synchronous-write exception should follow.

**Sub-component extraction pattern to copy for the new QR block** (`TrainScheduleSettings.tsx:201-251`):
```typescript
interface ReminderControlsProps {
  draft: Draft | null;
  disabled: boolean;
  subscribing: boolean;
  blocked: boolean;
  onToggle: (checked: boolean) => void;
  onHourChange: (hour: number) => void;
}

/**
 * The PERM-03/PERM-04 master toggle + hour picker, extracted (like
 * `ScheduleCardShell` above) to keep `TrainScheduleSettings`'s own function
 * body inside CLAUDE.md's nesting/LOC limits. Purely presentational — all
 * async orchestration (D-09's toggle-ON exception) lives in the parent.
 */
function ReminderControls({ draft, disabled, subscribing, blocked, onToggle, onHourChange }: ReminderControlsProps): ReactElement {
  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Remind me to train</p>
        <Switch data-testid="filter-reminder-enabled" ... />
      </div>
      {/* ... */}
    </div>
  );
}
```

**Composition point — where the new QR block is inserted** (`TrainScheduleSettings.tsx:452-461`):
```typescript
{showReminderBlock && (
  <ReminderControls
    draft={draft}
    disabled={disabled}
    subscribing={subscribing}
    blocked={blocked}
    onToggle={handleReminderToggle}
    onHourChange={handleReminderHourChange}
  />
)}
{/* HANDOFF-04 QR block is a sibling here, e.g.: */}
{/* <TrainInstallQr testIdSuffix="settings" /> */}
```
Existing label pattern the QR section's "Use FlawChess on your phone" caption must match
(`TrainScheduleSettings.tsx:399-400,421-422`):
```typescript
<div className="w-full">
  <p className="mb-1 text-sm text-muted-foreground">Train on</p>
  {/* ... */}
</div>
```

**D-09/D-15's synchronous-write-bypasses-debounce exception — the pattern the iOS `reminder_intent_at`
write must mirror, NOT the debounced draft path** (`TrainScheduleSettings.tsx:335-364`, toggle-ON branch):
```typescript
const handleReminderToggle = (checked: boolean): void => {
  setIndicator((prev) => (prev === 'reminder-error' ? 'idle' : prev));
  if (!checked) {
    hasEditedRef.current = true;
    setDraft((prev) => (prev ? { ...prev, reminderEnabled: false } : prev));
    return;
  }
  const { vapidPublicKey } = capability;
  if (vapidPublicKey === null) return;
  setSubscribing(true);
  void ensureDeviceSubscribed(vapidPublicKey)
    .catch((error: unknown): DeviceSubscribeResult => ({ status: 'error', error }))
    .then((result) => {
      setSubscribing(false);
      if (result.status === 'subscribed') {
        hasEditedRef.current = true;
        setDraft((prev) => (prev ? { ...prev, reminderEnabled: true } : prev));
        return;
      }
      // ...
    });
};
```
This is the SAME shape D-15 needs for the iOS tap: an explicit, awaited, synchronous `save()`/mutation
call fired immediately, never folded into the 600ms debounced draft (`TRAIN_SETTINGS_SAVE_DEBOUNCE_MS =
600` at line 59, `hasEditedRef` guard at 261) — see Pitfall 5 below.

---

### `?src=handoff` sessionStorage-across-OAuth-redirect (D-12)

**Two live analogs in this codebase — copy pattern (1), it is the closer shape:**

**(1) `pending_toast` — write side** (`frontend/src/pages/OAuthCallbackPage.tsx:34-43`):
```typescript
if (promoted === '1') {
  // Guest promoted via Google SSO — clear saved guest token
  localStorage.removeItem('guest_token');
  // Defer the toast message so it appears after the final redirect
  // (OAuthCallback → / → /openings or /import). Showing the toast here
  // can lose it during the rapid redirect chain after a full page load.
  sessionStorage.setItem(
    'pending_toast',
    'Account created with Google. Your data is saved.',
  );
}
navigate('/', { replace: true });
```

**(1) `pending_toast` — consume side**, `ProtectedLayout`'s mount effect, "the stable destination after
the redirect chain" (`frontend/src/App.tsx:557-562`, cited by RESEARCH.md; comment at line 556 explains
why this mount point is chosen):
```typescript
useEffect(() => {
  const msg = sessionStorage.getItem('pending_toast');
  if (msg) {
    sessionStorage.removeItem('pending_toast');
    toast.success(msg);
  }
}, []);
```

**(2) `promote_intent` — a slightly different point in the flow (captured BEFORE the redirect to Google,
not after) but the same one-shot-`sessionStorage`-flag idea** (`frontend/src/api/googleAuth.ts:4,36-42`):
```typescript
const PROMOTE_INTENT_KEY = 'promote_intent';
// ...
const promoteIntent = sessionStorage.getItem(PROMOTE_INTENT_KEY) === '1';
// ...
sessionStorage.removeItem(PROMOTE_INTENT_KEY);
```

**Recommendation for D-12** (per RESEARCH.md §5): capture `?src=handoff` on arrival at the marked URL
(before any redirect to Google is initiated — same timing as `promote_intent`'s capture), write to
`sessionStorage`, and consume at the same `ProtectedLayout` mount point that already reads `pending_toast`
— follow pattern (1)'s consume-side shape most closely since it is post-redirect, which is when the
`?src=handoff` param has already been stripped by the OAuth chain and only the `sessionStorage` copy
survives.

---

### Backend: `reminder_intent_at` round-trip (D-02/D-15) — mechanical repeat of Phase 201's `reminder_enabled`/`reminder_hour`

Five files, same shape each time. **Load-bearing asymmetry**: unlike `reminder_last_sent_on` (server-write-only,
appears in NEITHER `TrainSettingsResponse` NOR `TrainSettingsUpdate`), `reminder_intent_at` must be
client-writable (D-15) — it belongs in BOTH schemas, so its analog is `reminder_enabled`/`reminder_hour`
(which appear in both), not `reminder_last_sent_on`.

**1. Model** (`app/models/train_settings.py:44-113`, analog field at 111-113, sibling nullable-timestamp
field to follow is `reminder_last_sent_on` at 113 — but note it's a `Date`, and `reminder_intent_at` must
be a `DateTime(timezone=True)` per the codebase's nullable-instant convention):
```python
# EXISTING (client-writable pair — the shape to copy for reminder_intent_at):
reminder_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
reminder_hour: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="18")
# EXISTING (server-write-only sibling — nullable timestamp SHAPE to copy, but NOT the write-access pattern):
reminder_last_sent_on: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
```
Codebase convention for nullable *timestamps* (not dates) — confirmed at
`app/models/drill_session.py:87`, `app/models/eval_jobs.py:94,102`, `app/models/herring_pool.py:136` (all
grep-verified this session, consistent `DateTime(timezone=True)` — never a naive `DateTime`):
```python
reminder_intent_at: Mapped[datetime.datetime | None] = mapped_column(
    DateTime(timezone=True), nullable=True
)
```
Docstring pattern to mirror (lines 95-105 explain the server-write-only sibling; a parallel comment block
should explain the OPPOSITE for `reminder_intent_at` — CLIENT-writable, appears in both schemas).

**2. Migration** — copy `alembic/versions/20260801_225358_ca8c8fbc2080_phase_201_train_reminder_columns.py`
verbatim in shape (full file read):
```python
def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("train_settings", sa.Column("reminder_last_sent_on", sa.Date(), nullable=True))

def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("train_settings", "reminder_last_sent_on")
```
`reminder_intent_at` needs the same two-line shape with `sa.DateTime(timezone=True)` in place of
`sa.Date()`. No CHECK constraint (unbounded timestamp), no backfill — module docstring should state "No
backfill, no data migration: every existing row lands on NULL," matching lines 16-17 of the 201 migration.

**3. Schemas** (`app/schemas/train.py:198-246`, full class bodies read):
```python
class TrainSettingsResponse(BaseModel):
    """... reminder_last_sent_on is deliberately absent — it is the reminder job's
    own watermark (D-06), never readable or writable by a client."""
    timezone: str
    weekday_mask: int
    puzzles_per_session: int
    reminder_enabled: bool
    reminder_hour: int
    # reminder_intent_at: datetime.datetime | None  <- ADD HERE (client-writable, unlike reminder_last_sent_on)

class TrainSettingsUpdate(BaseModel):
    """A separate schema from TrainSettingsResponse ... so a PUT body can never
    smuggle a server-owned field."""
    timezone: str
    weekday_mask: int = Field(ge=0, le=127)
    puzzles_per_session: int = Field(ge=1, le=50)
    reminder_enabled: bool
    reminder_hour: int = Field(ge=REMINDER_HOUR_MIN, le=REMINDER_HOUR_MAX)
    # reminder_intent_at: datetime.datetime | None = None  <- ADD HERE, no bound validator needed (V5: no injection surface on a timestamp)
```

**4. Repository** (`app/repositories/train_repository.py:124-431`, full range read — `TrainSettingsRow`
dataclass at 124-150, `get_settings` at 223-245, `get_or_create_settings` at 248-300, `upsert_settings` at
303-431):
```python
@dataclass(frozen=True)
class TrainSettingsRow:
    # ... existing fields ...
    reminder_enabled: bool
    reminder_hour: int
    reminder_last_sent_on: datetime.date | None
    # reminder_intent_at: datetime.datetime | None  <- ADD as a new field

async def get_settings(session: AsyncSession, *, user_id: int) -> TrainSettingsRow | None:
    # ...
    return TrainSettingsRow(
        # ... existing kwargs ...
        reminder_enabled=row.reminder_enabled,
        reminder_hour=row.reminder_hour,
        reminder_last_sent_on=row.reminder_last_sent_on,
        # reminder_intent_at=row.reminder_intent_at,  <- ADD
    )
```
`upsert_settings` (303-431) takes `reminder_enabled: bool, reminder_hour: int` as explicit keyword
params (310-311) and includes both in the `pg_insert(...).values(...)` (380-381) AND the
`on_conflict_do_update(set_={...})` dict (389-390) — `reminder_intent_at` joins ALL THREE of these
(param list, `.values()`, `set_` dict) since, unlike `reminder_last_sent_on` (deliberately excluded from
`set_` per the module docstring at lines 353-357, 391-393), it IS client-writable and must be updatable
on every PUT.

**5. Router** (`app/routers/train.py:237-300`, full range read):
```python
@router.get("/settings", response_model=TrainSettingsResponse)
async def get_train_settings(...) -> TrainSettingsResponse:
    settings_row = await train_repository.get_or_create_settings(session, user_id=user.id)
    await session.commit()
    return TrainSettingsResponse(
        timezone=settings_row.timezone,
        weekday_mask=settings_row.weekday_mask,
        puzzles_per_session=settings_row.puzzles_per_session,
        reminder_enabled=settings_row.reminder_enabled,
        reminder_hour=settings_row.reminder_hour,
        # reminder_intent_at=settings_row.reminder_intent_at,  <- ADD
    )

@router.put("/settings", response_model=TrainSettingsResponse)
async def update_train_settings(body: TrainSettingsUpdate, ...) -> TrainSettingsResponse:
    settings_row = await train_repository.upsert_settings(
        session,
        user_id=user.id,
        timezone=body.timezone,
        weekday_mask=body.weekday_mask,
        puzzles_per_session=body.puzzles_per_session,
        reminder_enabled=body.reminder_enabled,
        reminder_hour=body.reminder_hour,
        # reminder_intent_at=body.reminder_intent_at,  <- ADD
        now_utc=now_utc,
    )
    await session.commit()
    return TrainSettingsResponse(... reminder_hour=settings_row.reminder_hour, ...)
        # reminder_intent_at=settings_row.reminder_intent_at,  <- ADD
```
No dynamic/generic field iteration anywhere in this router — every new field requires touching these two
explicit constructor calls (237-252, 255-300).

**6. Frontend types + hook** (`frontend/src/types/train.ts:128-150`, `frontend/src/hooks/useTrainSettings.ts:1-60`,
full files read) — same full-replace-PUT pattern:
```typescript
// types/train.ts
export interface TrainSettingsResponse {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
  reminder_enabled: boolean;
  reminder_hour: number;
  // reminder_intent_at: string | null;  <- ADD (ISO datetime string or null)
}

// useTrainSettings.ts — TrainSettingsDraft (lines 25-33) already carries the
// exact self-documenting warning this pattern needs repeated for reminder_intent_at:
export interface TrainSettingsDraft {
  weekdayMask: number;
  puzzlesPerSession: number;
  /** Phase 202 (PERM-01..04). This is a full-replace PUT body, so both new
   * fields must be threaded through the mutation together or every existing
   * weekday/puzzle-count save 422s. */
  reminderEnabled: boolean;
  reminderHour: number;
}
```

**Two existing PUT call sites that must both carry the new field once `reminder_intent_at` joins
`TrainSettingsUpdate`** (Pitfall 1): `frontend/src/components/train/TrainReminderButton.tsx:93-99` and
`frontend/src/components/train/TrainScheduleSettings.tsx:298-304` — plus the NEW third write path this
phase adds for the iOS tap (D-15), which must NOT ride the debounced draft (Pitfall 5, see
`TrainScheduleSettings.tsx:335-364` pattern above).

---

## Shared Patterns

### Push-capability single call site (do not duplicate)
**Source:** `frontend/src/lib/push.ts:42-44` (`isPushSupported`), line 137/145 (`ensureDeviceSubscribed`,
the ONLY caller of `Notification.requestPermission()`/`PushManager.subscribe()`, per its own module
docstring lines 1-13).
**Apply to:** the re-surface banner's subscribe CTA, the Android-tabbed confirmed-state install offer must
NOT call these directly — the re-surface banner reuses `ensureDeviceSubscribed()`, never a new call site.

### `usePushCapability` — live-derived, never cached
**Source:** `frontend/src/hooks/usePushCapability.ts` (61 lines, full read) — `{ isResolved, available,
vapidPublicKey, permission }` via `staleTime: Infinity` TanStack Query, `permission` read live every
render (line 59).
**Apply to:** the five-state resolver in `TrainReminderButton`; the re-surface banner's own subscribe gate.

### Structural absence, not disabled placeholder
**Source:** `TrainReminderButton.tsx:65-66` comment: "No skeleton, no spinner, no placeholder — a clean
structural absence until every gate clears."
**Apply to:** every new state in the five-state resolver, the Android-tabbed install offer (`!!promptEvent`
gate), the re-surface banner (mounts nothing until `getDeviceSubscription()` + `reminder_intent_at` both
resolve).

### Route-matching predicate for Train-route detection
**Source:** `frontend/src/App.tsx:127`: `if (to === '/train') return pathname.startsWith('/train');`
**Apply to:** D-07's drawer suppression check and D-11's `?src=handoff` override branch — reuse this exact
predicate shape (`pathname.startsWith('/train')`), do not write a second one.

### Full-replace PUT contract (Pitfall 1, load-bearing for this whole phase)
**Source:** `app/schemas/train.py:219` docstring: "A separate schema from `TrainSettingsResponse`... so a
PUT body can never smuggle a server-owned field" + `frontend/src/hooks/useTrainSettings.ts:28-30`'s
self-documenting warning.
**Apply to:** every file in the `reminder_intent_at` round-trip (backend 5 files + frontend types/hook) AND
every existing/new PUT call site (`TrainReminderButton.handleClick`, `TrainScheduleSettings`'s debounced
save, the new iOS-tap synchronous write, the re-surface banner's subscribe-triggered save if it also
writes settings).

### Sentry capture in service/router except blocks
**Source:** CLAUDE.md § Error Handling & Sentry — `sentry_sdk.capture_exception()` in every non-trivial
`except` in `app/services/`/`app/routers/`; frontend manual fetch/catch blocks call
`Sentry.captureException(error, { tags: { source: '...' } })`, but TanStack Query mutations (all of this
phase's writes) are already covered by the global `MutationCache.onError` in
`frontend/src/lib/queryClient.ts` — do NOT add a duplicate capture in the iOS-tap handler or the re-surface
banner's mutation.

## No Analog Found

None. Every file this phase touches (new or modified) has a same-file, sibling-file, or two-file precedent
already read-verified in this codebase. The two genuinely new components (QR handoff block, re-surface
banner) are role-matched to existing extracted sub-components (`ReminderControls`) and the existing
`TrainReminderButton` CTA/error-copy shape respectively — not built from scratch conceptually.

## Test Analogs

### Frontend

**`frontend/src/components/train/__tests__/TrainReminderButton.test.tsx` EXISTS** (contradicts
RESEARCH.md's "not checked this session" uncertainty — confirmed present and read this session, 90+ lines
read). This is the direct analog for OFFER-01..04's five-state test coverage — extend it, do not create a
parallel file. Its mocking pattern (`stubBrowserGlobals`, lines 58-83):
```typescript
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    trainApi: { ...actual.trainApi, getSettings: vi.fn(), updateSettings: vi.fn() },
    pushApi: { ...actual.pushApi, getVapidPublicKey: vi.fn(), subscribe: vi.fn() },
  };
});

function stubBrowserGlobals(options?: { permission?: NotificationPermission; ... }): void {
  vi.stubGlobal('Notification', {
    permission: options?.permission ?? 'default',
    requestPermission: options?.requestPermission ?? vi.fn().mockResolvedValue('granted'),
  });
  if (!options?.omitPushManager) vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { ready: Promise.resolve({ pushManager: { getSubscription: ..., subscribe: ... } }) },
    configurable: true,
  });
}
```
This is the `vi.stubGlobal`/`Object.defineProperty` convention (file header comment cites
`useTrainGradingEngine.test.ts`'s precedent) to reuse for `navigator.standalone`, `matchMedia`, and UA
string mocking in the new `useInstallPrompt.test.ts` / `InstallPromptBanner.test.tsx` (see Wave-0 gap
below) and for the five-state resolver's `isStandalone`/`isIOS` inputs in this same file's extension.

**`frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` EXISTS** — confirmed present;
this is the analog for HANDOFF-04's QR-in-Settings test coverage. `matchMedia`/`localStorage` are not
directly grepped in this file (no hits), meaning its existing mocks are likely scoped to the
`trainApi`/`pushApi` mock pattern above rather than raw browser globals — the new `resurface-banner`
localStorage dismiss-key test and any `isStandalone` assertion should follow `TrainReminderButton.test.tsx`'s
`stubBrowserGlobals` shape instead, since that is the file with the actual browser-global mocking precedent.

**Wave-0 gap, confirmed this session**: no `useInstallPrompt.test.ts` or `InstallPromptBanner.test.tsx`
exists anywhere in `frontend/src/hooks/__tests__/` or `frontend/src/components/install/` (directory listing
checked; only `__tests__/` under `components/train/` has install-adjacent coverage). This is genuinely
greenfield test coverage — INSTALL-01/04/05 and D-07/D-11 have zero existing automated tests to extend.
The executor must create these two files. The `matchMedia`-mocking convention is otherwise well-established
project-wide (RESEARCH.md cites ~30 files); `Object.defineProperty(window, 'matchMedia', {...})` is the
idiom, and `stubBrowserGlobals`-style helpers (above) are the closest in-repo template for the
`navigator.standalone`/UA-string mocks this hook specifically needs.

### Backend

**`tests/routers/test_train.py` — settings round-trip tests EXIST and are the direct analog for
`reminder_intent_at`** (confirmed via grep this session, full relevant range read at lines 1920-1994):
```python
@pytest.mark.asyncio
async def test_get_settings_creates_defaults_on_first_touch(test_engine) -> None:
    """First GET creates and returns the D-06/D-07/D-08 defaults in one call."""
    email = f"train-settings-default-{uuid.uuid4().hex[:8]}@example.com"
    _user_id, token = await _register_and_login(email)
    resp = await _get_settings(token)
    assert resp.status_code == 200
    assert resp.json() == {
        "timezone": "UTC",
        "weekday_mask": 127,
        "puzzles_per_session": 6,
        "reminder_enabled": False,
        "reminder_hour": 18,
        # "reminder_intent_at": None,  <- ADD to this literal dict once the field lands
    }

@pytest.mark.asyncio
async def test_put_settings_persists_and_round_trips(test_engine) -> None:
    """A PUT persists and a subsequent GET returns exactly what was stored."""
    email = f"train-settings-put-{uuid.uuid4().hex[:8]}@example.com"
    _user_id, token = await _register_and_login(email)
    put_resp = await _put_settings(
        token, timezone="America/New_York", weekday_mask=0b0010101,
        puzzles_per_session=8, reminder_enabled=True, reminder_hour=7,
    )
    assert put_resp.status_code == 200
    assert put_resp.json() == {
        "timezone": "America/New_York", "weekday_mask": 0b0010101,
        "puzzles_per_session": 8, "reminder_enabled": True, "reminder_hour": 7,
        # "reminder_intent_at": "...",  <- ADD
    }
```
The `_put_settings`/`_get_settings` test helpers (referenced at line ~644-658, `reminder_enabled: bool =
False, reminder_hour: int = 18` default kwargs) also need a `reminder_intent_at` parameter added to their
signatures for a new `test_put_settings_writes_reminder_intent_at` (or similar) test. Every existing literal
`resp.json() == {...}` assertion across this file (both GET and PUT tests) will need the new key added or
the tests fail on an unexpected extra field — this is the backend mirror of Pitfall 1's frontend full-replace
hazard.
