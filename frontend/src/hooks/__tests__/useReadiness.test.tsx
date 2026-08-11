// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock apiClient at module level. Preserve other exports via importActual.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    apiClient: {
      get: vi.fn(),
    },
  };
});

import { apiClient } from '@/api/client';
import { useReadiness } from '../useReadiness';

// Mirrors the private constants declared in useReadiness.ts
// (READINESS_BACKOFF_LADDER_MS / READINESS_BACKOFF_BUDGET_MS, not exported —
// the hook keeps its scheduling constants module-private). The interval-
// sequence assertions below are what actually verifies these values are
// wired into the emitted schedule, not this mirrored declaration (D-05).
const BACKOFF_LADDER_MS = [15_000, 60_000, 300_000] as const;
const BACKOFF_BUDGET_MS = 30 * 60_000;

interface ReadinessPayload {
  tier1: boolean;
  tier2: boolean;
  pending_count: number;
  total_count: number;
}

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  return function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * Installs an apiClient.get mock that records Date.now() (faked by
 * vi.useFakeTimers()) on every invocation and resolves the caller-supplied
 * payload, so the emitted interval sequence is the array of deltas between
 * consecutive recorded timestamps. setPayload lets a test change what the
 * NEXT invocation resolves with, without needing a remount.
 */
function setupTimestampRecordingMock(initialPayload: ReadinessPayload) {
  const timestamps: number[] = [];
  let payload = initialPayload;
  vi.mocked(apiClient.get).mockImplementation(() => {
    timestamps.push(Date.now());
    return Promise.resolve({ data: payload });
  });
  return {
    timestamps,
    setPayload: (next: ReadinessPayload) => {
      payload = next;
    },
  };
}

function deltasOf(timestamps: number[]): number[] {
  return timestamps.slice(1).map((t, i) => t - (timestamps[i] ?? 0));
}

async function advanceAndFlush(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useReadiness', () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns safe default values (tier1=false, tier2=false) before first fetch resolves', async () => {
    // Never resolve the fetch — simulates loading state
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useReadiness(), { wrapper: makeWrapper() });

    // Before fetch resolves: defaults must prevent content flash
    expect(result.current.tier1).toBe(false);
    expect(result.current.tier2).toBe(false);
    expect(result.current.pendingCount).toBe(0);
    expect(result.current.totalCount).toBe(0);
  });

  it('polls at 3s interval while tier1 is false', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { tier1: false, tier2: false, pending_count: 5, total_count: 10 },
    });

    renderHook(() => useReadiness(), { wrapper: makeWrapper() });

    // Flush the initial fetch (microtasks only — don't run refetch timers yet)
    await act(async () => {
      await Promise.resolve();
    });

    const callCountAfterFirst = vi.mocked(apiClient.get).mock.calls.length;
    expect(callCountAfterFirst).toBeGreaterThanOrEqual(1);

    // Advance 3s to trigger first poll, then flush its promise
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Advance 3s to trigger second poll, then flush
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('emits a flat 3s cadence while tier1 is false', async () => {
    const mock = setupTimestampRecordingMock({
      tier1: false,
      tier2: false,
      pending_count: 0,
      total_count: 0,
    });

    renderHook(() => useReadiness(), { wrapper: makeWrapper() });
    await act(async () => {
      await Promise.resolve();
    });

    await advanceAndFlush(3_000);
    await advanceAndFlush(3_000);
    await advanceAndFlush(3_000);

    expect(deltasOf(mock.timestamps)).toEqual([3_000, 3_000, 3_000]);
  });

  it('emits the backoff interval sequence once tier1 is true', async () => {
    // This is the SURGE-01 artifact — it must fail if the backoff never
    // engages (D-05, D-07). MUTATION PROOF: see SUMMARY.md.
    const mock = setupTimestampRecordingMock({
      tier1: false,
      tier2: false,
      pending_count: 0,
      total_count: 0,
    });

    renderHook(() => useReadiness(), { wrapper: makeWrapper() });
    await act(async () => {
      await Promise.resolve();
    });

    // Two polls while tier1 is still false.
    await advanceAndFlush(3_000);
    await advanceAndFlush(3_000);

    // Switch to the backoff phase. The already-scheduled 3s timer fires once
    // more before the new data is observed — that call is the first response
    // to carry tier1=true, and only the NEXT scheduling decision reflects it.
    mock.setPayload({ tier1: true, tier2: false, pending_count: 0, total_count: 0 });
    await advanceAndFlush(3_000);
    await advanceAndFlush(15_000);
    await advanceAndFlush(60_000);
    await advanceAndFlush(300_000);
    await advanceAndFlush(300_000);

    expect(deltasOf(mock.timestamps)).toEqual([
      3_000, 3_000, 3_000, ...BACKOFF_LADDER_MS, BACKOFF_LADDER_MS[2],
    ]);
  });

  it('stops polling after the backoff budget', async () => {
    const mock = setupTimestampRecordingMock({
      tier1: true,
      tier2: false,
      pending_count: 0,
      total_count: 0,
    });

    renderHook(() => useReadiness(), { wrapper: makeWrapper() });
    await act(async () => {
      await Promise.resolve();
    });

    // Walk the ladder well past the 30-minute budget.
    const gaps = [15_000, 60_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000];
    for (const gap of gaps) {
      await advanceAndFlush(gap);
    }

    const callCountAfterLadder = mock.timestamps.length;
    const firstTimestamp = mock.timestamps[0] ?? 0;
    const lastTimestamp = mock.timestamps[mock.timestamps.length - 1] ?? 0;
    expect(lastTimestamp - firstTimestamp).toBeLessThanOrEqual(BACKOFF_BUDGET_MS);

    // Another hour of fake time must not produce any further call.
    await advanceAndFlush(3_600_000);
    expect(mock.timestamps.length).toBe(callCountAfterLadder);
  });

  it('resets the ladder when a new import starts', async () => {
    const mock = setupTimestampRecordingMock({
      tier1: true,
      tier2: false,
      pending_count: 0,
      total_count: 0,
    });

    renderHook(() => useReadiness(), { wrapper: makeWrapper() });
    await act(async () => {
      await Promise.resolve();
    });

    // Advance through the ladder up to (and including) reaching the 300s step.
    await advanceAndFlush(15_000);
    await advanceAndFlush(60_000);

    // A new import starts: tier1 flips back to false.
    mock.setPayload({ tier1: false, tier2: false, pending_count: 0, total_count: 0 });
    // The already-scheduled 300s timer fires once more before the reset is observed.
    await advanceAndFlush(300_000);
    // Ladder reset: the following cadence is the flat 3s poll.
    await advanceAndFlush(3_000);

    // A second import starts: tier1 flips true again — the ladder must restart at 15000.
    mock.setPayload({ tier1: true, tier2: false, pending_count: 0, total_count: 0 });
    await advanceAndFlush(3_000);
    await advanceAndFlush(15_000);

    expect(deltasOf(mock.timestamps)).toEqual([15_000, 60_000, 300_000, 3_000, 3_000, 15_000]);
  });

  it('emits exactly one request for a zero-games user', async () => {
    const mock = setupTimestampRecordingMock({
      tier1: true,
      tier2: true,
      pending_count: 0,
      total_count: 0,
    });

    renderHook(() => useReadiness(), { wrapper: makeWrapper() });
    await act(async () => {
      await Promise.resolve();
    });

    await advanceAndFlush(3_600_000);

    expect(mock.timestamps.length).toBe(1);
  });

  it('keeps polling while only tier2 is outstanding so gated surfaces still unlock', async () => {
    const mock = setupTimestampRecordingMock({
      tier1: true,
      tier2: false,
      pending_count: 5,
      total_count: 10,
    });

    const { result } = renderHook(() => useReadiness(), { wrapper: makeWrapper() });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.tier2).toBe(false);

    // Advance past the first ladder step while tier2 is still false.
    await advanceAndFlush(15_000);
    expect(result.current.tier2).toBe(false);

    // tier2 flips true on the backend side (evals drained + percentiles ready).
    mock.setPayload({ tier1: true, tier2: true, pending_count: 0, total_count: 10 });

    // Advance to the next scheduled ladder tick so the poll observes tier2=true —
    // no remount, no navigation, purely the same poll noticing the transition.
    await advanceAndFlush(60_000);
    // The state-update triggered by the fetch that lands exactly on the last
    // requested tick can commit one React render after the flush above —
    // drain any remaining pending timer/microtask work before asserting.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(result.current.tier2).toBe(true);
  });

  it('stops polling once tier2 is true', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { tier1: true, tier2: true, pending_count: 0, total_count: 10 },
    });

    renderHook(() => useReadiness(), { wrapper: makeWrapper() });

    // Flush the initial fetch
    await act(async () => {
      await Promise.resolve();
    });

    const callCountAfterFirst = vi.mocked(apiClient.get).mock.calls.length;
    expect(callCountAfterFirst).toBe(1);

    // Advance 30s — should NOT trigger more polls since tier2 is true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(apiClient.get).mock.calls.length).toBe(1);
  });

  it('maps response fields: pending_count → pendingCount, total_count → totalCount', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { tier1: true, tier2: false, pending_count: 7, total_count: 15 },
    });

    const { result } = renderHook(() => useReadiness(), { wrapper: makeWrapper() });

    // Flush microtasks + timers so TanStack Query updates the hook state
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.tier1).toBe(true);
    expect(result.current.tier2).toBe(false);
    expect(result.current.pendingCount).toBe(7);
    expect(result.current.totalCount).toBe(15);
  });
});
