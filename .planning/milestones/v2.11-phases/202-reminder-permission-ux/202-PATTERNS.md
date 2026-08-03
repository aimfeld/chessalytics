# Phase 202: Reminder Permission UX - Pattern Map

**Mapped:** 2026-08-02
**Files analyzed:** 8
**Analogs found:** 6 / 8 (2 have no direct analog — genuinely new browser-API surface)

## Confirmed: existing test files (RESEARCH.md open question resolved)

Both already exist — this phase EXTENDS them, does not create them:
- `frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx`
- `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx`

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|-----------------|---------------|
| `frontend/src/lib/push.ts` (NEW) | utility (browser-API wrapper) | request-response (imperative async, wraps native Web APIs) | `frontend/src/hooks/useInstallPrompt.ts` (closest — feature detection + browser API orchestration) | role-match (no `lib/` module wraps an imperative multi-step browser API today; this is genuinely new shape) |
| `frontend/src/components/train/TrainReminderButton.tsx` (NEW) | component | request-response (click → async → local state swap) | `frontend/src/components/train/TrainScheduleSettings.tsx`'s `ScheduleCardShell` + indicator state (`idle`/`saved`/`error`) | role-match (closest state-machine shape: idle → pending → confirmed/error) |
| `frontend/src/components/train/TrainScoreScreen.tsx` (MODIFIED) | component | request-response | itself (existing file, button row area lines ~145-152) | exact (editing in place) |
| `frontend/src/components/train/TrainScheduleSettings.tsx` (MODIFIED) | component | CRUD (debounced draft → PUT) | itself (existing file, draft/debounce/indicator machinery lines 1-260) | exact (editing in place) |
| `frontend/src/hooks/useTrainSettings.ts` (MODIFIED) | hook | CRUD | itself (existing file, full content read) | exact (editing in place) |
| `frontend/src/types/train.ts` (MODIFIED) | type/schema mirror | transform (backend Pydantic → TS interface) | itself (existing file, `TrainSettingsResponse`/`TrainSettingsUpdate` lines ~129-141) | exact (editing in place) |
| `frontend/src/api/client.ts` (MODIFIED — new `pushApi` group) | service (HTTP client group) | request-response | `trainApi` group in same file (lines ~264-279) | exact |
| `frontend/src/lib/__tests__/push.test.ts` (NEW) | test | unit | `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` (`vi.stubGlobal` pattern) | role-match (closest browser-global-stubbing precedent in repo) |

## Pattern Assignments

### `frontend/src/lib/push.ts` (utility, request-response)

**Analog:** `frontend/src/hooks/useInstallPrompt.ts` (feature-detection style) + inline mechanics already fully specified in RESEARCH.md Pattern 1 (verified against `app/schemas/push.py` field names).

**Feature-detection pattern** (`useInstallPrompt.ts` lines 47-49):
```typescript
const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches;
const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
```
Apply the same style for `isPushSupported()`:
```typescript
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}
```

**Core async routine** — use RESEARCH.md's fully-specified `ensureDeviceSubscribed()` verbatim (it is grounded against verified backend schema field names, not invented this pass):
```typescript
export type DeviceSubscribeResult =
  | { status: 'subscribed'; subscription: PushSubscriptionJSON }
  | { status: 'denied' }
  | { status: 'unsupported' }
  | { status: 'error'; error: unknown };

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export async function ensureDeviceSubscribed(
  vapidPublicKey: string,
): Promise<DeviceSubscribeResult> {
  if (!isPushSupported()) return { status: 'unsupported' };
  if (Notification.permission === 'denied') return { status: 'denied' };
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission(); // ONLY call site — PERM-01
    if (result !== 'granted') return { status: 'denied' };
  }
  try {
    const registration = await navigator.serviceWorker.ready; // not getRegistration() — see main.tsx contrast below
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));
    await pushApi.subscribe(subscription.toJSON() as PushSubscriptionJSON);
    return { status: 'subscribed', subscription: subscription.toJSON() as PushSubscriptionJSON };
  } catch (error) {
    return { status: 'error', error }; // D-13 — no Sentry.captureException here if called via TanStack mutation
  }
}
```

**Contrast with existing SW code — do not copy this part:** `frontend/src/main.tsx:38` uses `navigator.serviceWorker.getRegistration()` (non-blocking, may return `undefined`) for its unrelated update-check loop. `push.ts` deliberately uses `navigator.serviceWorker.ready` instead (blocks until an active SW controls the page) — do not conflate the two patterns or duplicate/disturb `main.tsx`'s block.

---

### `frontend/src/components/train/TrainReminderButton.tsx` (component, request-response)

**Analog:** `TrainScheduleSettings.tsx`'s `ScheduleCardShell` + indicator state machine (`idle`/`saved`/`error`), lines 118-145, 152-172.

**State-machine shape to mirror** (`TrainScheduleSettings.tsx:152-172`):
```typescript
const [indicator, setIndicator] = useState<IndicatorState>('idle');
// ...
save(
  { ... },
  {
    onSuccess: () => {
      setIndicator('saved');
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = setTimeout(() => setIndicator('idle'), TRAIN_SETTINGS_SAVED_INDICATOR_MS);
      onSaved?.();
    },
    onError: () => {
      setIndicator('error');
    },
  },
);
```

**"Saved" indicator visual treatment to reuse verbatim for D-03's confirmation** (`TrainScheduleSettings.tsx:124-132`):
```typescript
{indicator === 'saved' && (
  <span
    data-testid="train-settings-saved"
    className="ml-auto flex items-center gap-1 text-sm font-normal text-muted-foreground"
  >
    <Check className="size-4" aria-hidden="true" />
    Saved
  </span>
)}
```
Adapt for D-03: swap "Saved" for `Reminders on — {HH}:00 on your training days`, same `<Check>` icon + `gap-1 text-sm text-muted-foreground` classes, but this replaces the button in place (not a header-corner indicator) — it is a `flex-1 min-w-0` sibling in the button row per UI-SPEC E1.

**Button import/base pattern** (`TrainScoreScreen.tsx:34-35, 145-152`):
```typescript
import { Button } from '@/components/ui/button';
import { TRAIN_CTA_BUTTON_CLASS } from '@/components/train/buttonStyles';
// ...
<Button
  variant="brand-outline"
  className={TRAIN_CTA_BUTTON_CLASS}
  onClick={onDone}
  data-testid="btn-train-score-done"
>
  Done
</Button>
```
`TrainReminderButton` follows this exact `Button` + `variant="brand-outline"` + `data-testid="btn-..."` shape (left slot, per D-04); `Done` in the modified `TrainScoreScreen.tsx` becomes `variant="default"` per the override.

---

### `frontend/src/components/train/TrainScoreScreen.tsx` (component, MODIFIED)

**Analog:** itself. Current button area (lines ~145-152) is a single `Button`. Row must become a two-child flex row per UI-SPEC E2 (`flex w-full items-center gap-2`, both children `flex-1`), citing the sibling precedent `TrainSolveScreen.tsx:876` (`className="flex w-full items-center gap-2"`) for the row wrapper shape — read that file if the exact row JSX is needed, not reproduced here since it's a different component.

**Docstring to update, not silently violate** (lines ~24-28, ~76-87): the SEED-122 "Done is deliberately `brand-outline` — it is an exit, not a call to action" rationale must be explicitly noted as overridden by D-04 in a comment at the same site, per CLAUDE.md's "comment bug fixes / non-obvious code" convention — this is a locked decision override, document it there.

---

### `frontend/src/components/train/TrainScheduleSettings.tsx` (component, MODIFIED)

**Analog:** itself — the entire `Draft`/`hasEditedRef`/`debouncedDraft`/`IndicatorState`/save-effect machine (lines 1-197) is the exact pattern to extend, not replace.

**Draft interface to extend** (implied by the `Draft` shape used at line ~150 and `useTrainSettings.ts`'s `TrainSettingsDraft`):
```typescript
export interface TrainSettingsDraft {
  weekdayMask: number;
  puzzlesPerSession: number;
  reminderEnabled: boolean;   // NEW
  reminderHour: number;       // NEW
}
```

**Seed effect to extend** (lines 156-160):
```typescript
useEffect(() => {
  if (data !== undefined && draft === null) {
    setDraft({ weekdayMask: data.weekday_mask, puzzlesPerSession: data.puzzles_per_session });
  }
}, [data, draft]);
```
Add `reminderEnabled: data.reminder_enabled, reminderHour: data.reminder_hour` to the seed object.

**Debounced save-effect no-op guard to extend** (lines 172-194) — add two more equality comparisons (`reminderEnabled`, `reminderHour`) to the early-return guard and to the `save()` payload, EXCEPT per D-09/Pattern 3 in RESEARCH.md: toggle-ON must NOT write `reminderEnabled: true` into `draft` synchronously — only toggle-OFF and hour changes ride this exact debounce path unmodified.

**Toggle-ON async exception — the one deviation from the extend-in-place pattern** (per RESEARCH.md Pattern 3, grounded in D-09):
```typescript
onCheckedChange={(checked) => {
  if (!checked) {
    hasEditedRef.current = true;
    setDraft((prev) => (prev ? { ...prev, reminderEnabled: false } : prev));
    return; // rides the existing debounce
  }
  void ensureDeviceSubscribed(vapidKey).then((result) => {
    if (result.status === 'subscribed') {
      hasEditedRef.current = true;
      setDraft((prev) => (prev ? { ...prev, reminderEnabled: true } : prev));
    } else {
      setToggleError(result.status); // springs back off, D-06/D-13
    }
  });
}}
```

**Placement:** third sibling block inside the existing `flex flex-col gap-4` wrapper (line ~215), after "Puzzles per session" — see the `<div className="w-full">` blocks at lines ~228-259 for the exact wrapper shape (`<p className="mb-1 text-sm text-muted-foreground">Label</p>` followed by the control).

**Radix `Switch`/`Select` import precedent to add** — `TrainScheduleSettings.tsx` currently imports `ToggleGroup`/`ToggleChipButton` (lines 29-30); add `Switch` from `@/components/ui/switch` and `Select` primitives from `@/components/ui/select` alongside these, following the same relative-import convention (`@/components/ui/*`).

**Existing `Switch` call-site pattern to copy** — not read this pass in full; `frontend/src/pages/Analysis.tsx:327` and `frontend/src/components/analysis/MaiaHumanPanel.tsx:148` are cited in RESEARCH.md/UI-SPEC as the two existing `Switch` call sites (both use the default neutral `bg-primary` checked-track — do NOT override with a brand color per UI-SPEC's Color section). Read one of these two files at implementation time for the exact `Switch` prop/`onCheckedChange` signature if not already inferable from `components/ui/switch.tsx`.

---

### `frontend/src/hooks/useTrainSettings.ts` (hook, MODIFIED)

**Analog:** itself — full file read, reproduced above. Exact extension points:

**`TrainSettingsDraft` interface** (lines 25-28) — add `reminderEnabled: boolean; reminderHour: number;` (see above).

**Mutation body** (lines 38-46) — this is the **single call site** RESEARCH.md's "full-replace PUT" gotcha refers to:
```typescript
const mutation = useMutation({
  mutationFn: ({ weekdayMask, puzzlesPerSession }: TrainSettingsDraft) => {
    const body: TrainSettingsUpdate = {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekday_mask: weekdayMask,
      puzzles_per_session: puzzlesPerSession,
    };
    return trainApi.updateSettings(body);
  },
  onSuccess: (data) => {
    queryClient.setQueryData(TRAIN_SETTINGS_QUERY_KEY, data);
    void queryClient.invalidateQueries({ queryKey: TRAIN_PROGRESS_QUERY_KEY });
  },
});
```
Must destructure and send `reminderEnabled`/`reminderHour` too, mapped to snake_case in `body`, or every existing PUT (weekday chips, puzzle count) 422s the moment the two new required backend fields land — this is the single point of failure named in RESEARCH.md.

---

### `frontend/src/types/train.ts` (types, MODIFIED)

**Analog:** itself, lines 129-141 (verified against `app/schemas/train.py:208-230`):
```typescript
export interface TrainSettingsResponse {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
}

export interface TrainSettingsUpdate {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
}
```
Add `reminder_enabled: boolean; reminder_hour: number;` to BOTH interfaces (field-for-field mirror convention per this file's own docstring, lines 1-9 — "field-for-field, literal unions instead of bare string").

---

### `frontend/src/api/client.ts` (service, MODIFIED — new `pushApi` group)

**Analog:** `trainApi` group in the same file, lines 264-279:
```typescript
export const trainApi = {
  composeOrResumeSession: () =>
    apiClient.post<TrainSessionResponse>('/train/sessions').then(r => r.data),
  solvePuzzle: (sessionId: number, data: SolveRequest) =>
    apiClient.post<SolveResponse>(`/train/sessions/${sessionId}/solve`, data).then(r => r.data),
  getSettings: () =>
    apiClient.get<TrainSettingsResponse>('/train/settings').then(r => r.data),
  updateSettings: (data: TrainSettingsUpdate) =>
    apiClient.put<TrainSettingsResponse>('/train/settings', data).then(r => r.data),
};
```
New `pushApi` group, same file, same style — place near `trainApi` (imports of new `@/types/push` types go in the existing `import type { ... } from '@/types/...'` block near the top, lines 1-30):
```typescript
export const pushApi = {
  getVapidPublicKey: () =>
    apiClient.get<VapidPublicKeyResponse>('/push/vapid-public-key').then(r => r.data),
  subscribe: (data: PushSubscribeRequest) =>
    apiClient.post<PushSubscribeResponse>('/push/subscribe', data).then(r => r.data),
  unsubscribe: (endpoint: string) =>
    apiClient.post('/push/unsubscribe', { endpoint }),
};
```
Auth: `apiClient`'s Bearer-token interceptor (lines 59-63, not re-read this pass — already verified in RESEARCH.md) covers this group automatically, no new auth wiring needed.

---

### `frontend/src/lib/__tests__/push.test.ts` (test, NEW)

**Analog:** `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` — the only existing precedent in the repo for stubbing a browser global via `vi.stubGlobal`.

**Verbatim stub/cleanup pattern to follow** (`useTrainGradingEngine.test.ts:26-34, 68-79`):
```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.stubGlobal(
    'Worker',
    vi.fn(function (this: unknown) {
      return mockWorker;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
```
Adapt the same `beforeEach`/`afterEach` shape for `Notification`:
```typescript
vi.stubGlobal('Notification', {
  permission: 'default',
  requestPermission: vi.fn().mockResolvedValue('granted'),
});
```
and stub `navigator.serviceWorker` via `Object.defineProperty(navigator, 'serviceWorker', { value: {...}, configurable: true })` since `serviceWorker` is a read-only getter on `navigator` in jsdom (cannot `vi.stubGlobal` it directly — must use `Object.defineProperty`, per UI-SPEC discretion item 5). No existing file in the repo does this; `frontend/src/__tests__/pushServiceWorker.test.ts` tests the SW file itself via `node:vm`, a structurally different mechanism — do not copy that file's pattern for this test.

**File-level pragma** (`useTrainGradingEngine.test.ts:1`):
```typescript
// @vitest-environment jsdom
```
Apply the same pragma to `push.test.ts` and to any extended assertions in `TrainScoreScreen.test.tsx`/`TrainScheduleSettings.test.tsx` if not already present (check both existing files for this pragma before assuming it's missing).

---

## Shared Patterns

### Debounced auto-save indicator (`idle`/`saved`/`error`)
**Source:** `frontend/src/components/train/TrainScheduleSettings.tsx:118-145` (`ScheduleCardShell`) and `:152-172` (save effect)
**Apply to:** `TrainScheduleSettings.tsx`'s new toggle/hour-picker block (D-09's non-toggle-ON paths) and `TrainReminderButton.tsx`'s D-03/D-13 confirmation/error swap (adapted, not identical — see button component's excerpt above for the divergence).

### Sentry — no duplicate capture
**Source:** `frontend/src/lib/queryClient.ts` `MutationCache.onError` (not re-read this pass, already verified/cited in CONTEXT.md D-13 and RESEARCH.md)
**Apply to:** every TanStack-mutation-based call site in this phase (`pushApi.subscribe`/`unsubscribe` when routed through a `useMutation`). Any call inside `ensureDeviceSubscribed()` that is NOT wrapped in a `useMutation` (i.e. called as a bare `async` function from a plain `onClick`) does not get free Sentry coverage — confirm at implementation time whether `lib/push.ts`'s `ensureDeviceSubscribed()` is invoked via a thin `useMutation` wrapper (RESEARCH.md's `usePushSubscribe.ts` recommendation) specifically to inherit this global capture, rather than calling `pushApi.subscribe` as a bare promise inside the lib function.

### Feature detection / platform-branching style
**Source:** `frontend/src/hooks/useInstallPrompt.ts:47-49`
**Apply to:** `lib/push.ts`'s `isPushSupported()` — same inline boolean-expression style, no helper-class abstraction.

### `Button` variant convention (CLAUDE.md, not a file excerpt)
**Apply to:** `TrainReminderButton` (`variant="brand-outline"`) and `TrainScoreScreen`'s `Done` (`variant="default"`, overriding its own prior SEED-122 rationale per D-04). Never hand-roll colors with `className`/`bg-*` (CLAUDE.md Frontend § UI & Components).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `frontend/src/lib/push.ts` (the `ensureDeviceSubscribed`/`urlBase64ToUint8Array` core, as opposed to the feature-detect shell) | utility | request-response | No existing `lib/` module orchestrates a multi-step imperative native browser API (permission → SW-ready → subscribe → POST) anywhere in the codebase; `main.tsx`'s SW code is a different, simpler shape (single `getRegistration()` call, no permission/subscribe chain). RESEARCH.md's Pattern 1 (grounded in `web.dev`'s canonical implementation + verified backend schema field names) is the source of truth here instead of a codebase analog. |
| `frontend/src/types/push.ts` (NEW — `PushSubscriptionKeys`, `PushSubscribeRequest`, `VapidPublicKeyResponse`, `PushSubscribeResponse`) | type/schema mirror | transform | No existing frontend type file mirrors `app/schemas/push.py` yet (Phase 201 shipped the backend only). Mirror `frontend/src/types/train.ts`'s own docstring convention ("field-for-field, literal unions instead of bare string") and field names from `app/schemas/push.py:12-49` (verified in RESEARCH.md) rather than an existing frontend analog. |

## Metadata

**Analog search scope:** `frontend/src/components/train/`, `frontend/src/hooks/`, `frontend/src/hooks/__tests__/`, `frontend/src/api/client.ts`, `frontend/src/types/train.ts`, `frontend/src/lib/`, `frontend/src/main.tsx`
**Files scanned/read this pass:** `TrainScoreScreen.tsx` (grep + targeted lines), `TrainScheduleSettings.tsx` (full 1-260), `useTrainSettings.ts` (full), `useInstallPrompt.ts` (full), `useTrainGradingEngine.test.ts` (lines 1-90), `client.ts` (targeted: imports + `trainApi` block), `types/train.ts` (targeted: header + `TrainSettingsResponse`/`Update`)
**Pattern extraction date:** 2026-08-02
