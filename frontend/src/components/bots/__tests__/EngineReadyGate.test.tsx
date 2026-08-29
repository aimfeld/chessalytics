// @vitest-environment jsdom
/**
 * EngineReadyGate.tsx — this is the Phase 213-01 tracer's own end-to-end
 * proof: it drives the REAL `engineAssetProgress.ts` store (never mocks
 * `useEngineAssets`) so the whole transport — store -> useEngineAssets ->
 * gate — is actually exercised, not just the component in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import { trackEvent } from '@/lib/analytics';
import { EngineReadyGate } from '../EngineReadyGate';
import {
  markEngineAssetFailed,
  markEngineAssetReady,
  markEngineAssetsUnsupported,
  ORT_RUNTIME_BYTES_FALLBACK,
  reportEngineAssetProgress,
  resetEngineAssetsForTests,
  STOCKFISH_WASM_BYTES_FALLBACK,
} from '@/lib/engine/engineAssetProgress';

/** Marks all three required assets ready — the Phase 213-09 gate condition (G-213-35). */
function markAllAssetsReady(): void {
  markEngineAssetReady('maia-model');
  markEngineAssetReady('stockfish-wasm');
  markEngineAssetReady('ort-runtime');
}

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ trackEvent: vi.fn() }));

const WAIT_FOR_TIMEOUT_MS = 3000;

/** This project registers no `@testing-library/jest-dom` matchers — read
 * `.disabled` off a cast element, following `TrainReminderTestCard.test.tsx`. */
function startButton(): HTMLButtonElement {
  return screen.getByTestId('btn-engine-start') as HTMLButtonElement;
}

beforeEach(() => {
  resetEngineAssetsForTests();
  localStorage.clear();
  vi.mocked(trackEvent).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
});

afterEach(() => {
  cleanup();
});

describe('EngineReadyGate', () => {
  it('renders the gate with Start disabled while the store is idle', () => {
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    expect(screen.getByTestId('engine-ready-gate')).toBeTruthy();
    expect(startButton().disabled).toBe(true);
  });

  // ─── G-213-34: per-surface copy ────────────────────────────────────────────

  it('the bots surface still renders today\'s title and one-time-download note', () => {
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    const gate = screen.getByTestId('engine-ready-gate');
    expect(gate.textContent).toContain('Getting the bot ready');
    expect(gate.textContent).toContain(
      'This is a one-time download. Later games start straight away.',
    );
  });

  it('the analysis surface renders its own title and note, naming the engine, not a bot or a game', () => {
    render(<EngineReadyGate surface="analysis" onStart={vi.fn()} onRetry={vi.fn()} />);

    const gate = screen.getByTestId('engine-ready-gate');
    expect(gate.textContent).toContain('Getting the engine ready');
    expect(gate.textContent).toContain(
      'This is a one-time download. Later visits start straight away.',
    );
    expect(gate.textContent).not.toContain('bot');
    expect(gate.textContent).not.toContain('game');
  });

  it('reflects real byte progress from the store — description names the asset and shows the percent, and the progress element reports it', async () => {
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    act(() => {
      reportEngineAssetProgress('maia-model', 22_841_843, 45_683_686);
    });

    // Phase 213-09 (G-213-35): the denominator is now the full 66.5 MB bundle
    // (maia + stockfish + ort-runtime's untouched fallback totals), not the
    // pre-213-09 53.0 MB pair — 22,841,843 / 66,459,075 -> 34%.
    await waitFor(
      () => {
        const gate = screen.getByTestId('engine-ready-gate');
        expect(gate.textContent).toContain('Maia model');
        expect(gate.textContent).toContain('34%');
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );

    const progress = screen.getByTestId('engine-ready-progress');
    expect(progress.getAttribute('aria-valuenow')).toBe('34');
  });

  it('shows the MB pair alongside the percent, and tells the user the download is one-time (G-213-4)', async () => {
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    act(() => {
      reportEngineAssetProgress('maia-model', 22_841_843, 45_683_686);
    });

    await waitFor(
      () => {
        // A bare percent gave no sense of scale — the readout must say how many
        // MB of how many, from the SAME byte-weighted aggregate as the bar.
        // Phase 213-09: the total is now the 66.5 MB unconditional triple.
        expect(screen.getByTestId('engine-ready-readout').textContent).toBe(
          'Maia model — 34% (22.8 / 66.5 MB)',
        );
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );

    expect(screen.getByTestId('engine-ready-gate').textContent).toContain('one-time download');
  });

  it('says the engine is starting once the last byte lands but the worker is not ready yet (G-213-19)', async () => {
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    // Every byte of ALL THREE assets is in, but no `ready` message has
    // arrived for any — the worker is still building the ONNX session and
    // running its warmup inference. On the wasm fallback (Brave) that gap is
    // several seconds long. Phase 213-09: all three assets are always
    // required, so all three must report full bytes before the aggregate
    // counts as "all bytes in".
    act(() => {
      reportEngineAssetProgress('maia-model', 45_683_686, 45_683_686);
      reportEngineAssetProgress('stockfish-wasm', STOCKFISH_WASM_BYTES_FALLBACK, STOCKFISH_WASM_BYTES_FALLBACK);
      reportEngineAssetProgress('ort-runtime', ORT_RUNTIME_BYTES_FALLBACK, ORT_RUNTIME_BYTES_FALLBACK);
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('engine-ready-readout').textContent).toBe(
          'Download complete. Starting the engine...',
        );
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );
    // Still gated: bytes on disk are not a runnable engine.
    expect(startButton().disabled).toBe(true);

    act(() => {
      markAllAssetsReady();
    });

    await waitFor(
      () => {
        expect(startButton().disabled).toBe(false);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );
  });

  it('does NOT claim the engine is starting while a second asset is still downloading (G-213-19)', async () => {
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    // Maia is fully in, Stockfish is not — the aggregate is not complete, so
    // the readout must still be a live byte count, not the preparing copy.
    act(() => {
      reportEngineAssetProgress('maia-model', 45_683_686, 45_683_686);
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('engine-ready-readout').textContent).toContain('MB');
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );
    expect(screen.getByTestId('engine-ready-readout').textContent).not.toContain(
      'Starting the engine',
    );
  });

  it('does NOT claim the engine is starting while bytes are still arriving but the percent has rounded to 100 (G-213-19)', async () => {
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    // Combined ~99.88% of the bundle's bytes: `percent` rounds to 100, but the
    // download is not finished. This is why the preparing copy is gated on
    // BYTES, not percent. Maia + Stockfish fully in, ort-runtime at
    // 13,400,000 / 13,479,978 (79,978 bytes short of the wasm-only fallback total).
    act(() => {
      reportEngineAssetProgress('maia-model', 45_683_686, 45_683_686);
      reportEngineAssetProgress('stockfish-wasm', STOCKFISH_WASM_BYTES_FALLBACK, STOCKFISH_WASM_BYTES_FALLBACK);
      reportEngineAssetProgress('ort-runtime', 13_400_000, ORT_RUNTIME_BYTES_FALLBACK);
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('engine-ready-progress').getAttribute('aria-valuenow')).toBe(
          '100',
        );
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );
    expect(screen.getByTestId('engine-ready-readout').textContent).toBe(
      'Maia model — 100% (66.4 / 66.5 MB)',
    );
  });

  it('enables Start once the store reports ready, and clicking it calls onStart exactly once (D-18: bots does NOT auto-call onStart on readiness alone)', async () => {
    const onStart = vi.fn();
    render(<EngineReadyGate surface="bots" onStart={onStart} onRetry={vi.fn()} />);

    // Phase 213-09: ALL THREE assets must be marked ready — a subset can no
    // longer enable Start.
    act(() => {
      markAllAssetsReady();
    });

    await waitFor(
      () => {
        expect(startButton().disabled).toBe(false);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );
    // D-18: reaching readiness alone must NOT close the bots gate — only a
    // click does. This is the surface-asymmetry the analysis auto-close
    // (tested below) must not leak into bot play.
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.click(startButton());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  // ─── Phase 213-09: every session gated on ALL THREE assets, single byte-weighted bar (D-11, G-213-35) ──

  it('every session is gated on ALL THREE assets, shows exactly ONE progress element, and the subtext switches asset as each one completes (D-11)', async () => {
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    // No asset done yet — Start stays disabled. requiredEngineAssets()
    // orders maia-model first, so it is the initial in-flight label.
    expect(startButton().disabled).toBe(true);
    await waitFor(() => {
      const gate = screen.getByTestId('engine-ready-gate');
      expect(gate.textContent).toContain('Maia model');
    });
    // D-11: exactly one aggregate progress element, never one per asset.
    expect(screen.queryAllByTestId('engine-ready-progress')).toHaveLength(1);

    act(() => {
      reportEngineAssetProgress('stockfish-wasm', 1000, STOCKFISH_WASM_BYTES_FALLBACK);
    });

    // Stockfish progress alone must not flip the subtext — maia-model is
    // still the undone asset named first.
    expect(screen.getByTestId('engine-ready-gate').textContent).toContain('Maia model');

    // Complete maia-model — the subtext must switch to the next undone
    // asset (stockfish-wasm), and the aggregate bar reflects the
    // byte-weighted total (D-11), never per-asset rows.
    act(() => {
      markEngineAssetReady('maia-model');
    });

    await waitFor(
      () => {
        const gate = screen.getByTestId('engine-ready-gate');
        expect(gate.textContent).toContain('Stockfish engine');
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );

    expect(screen.queryAllByTestId('engine-ready-progress')).toHaveLength(1);
    expect(startButton().disabled).toBe(true); // stockfish-wasm, ort-runtime still not done

    // Complete stockfish-wasm — the subtext switches to the THIRD asset
    // (ort-runtime, Phase 213-09/G-213-35), and Start is STILL disabled.
    act(() => {
      markEngineAssetReady('stockfish-wasm');
    });

    await waitFor(
      () => {
        const gate = screen.getByTestId('engine-ready-gate');
        expect(gate.textContent).toContain('Runtime engine');
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );

    expect(screen.queryAllByTestId('engine-ready-progress')).toHaveLength(1);
    expect(startButton().disabled).toBe(true); // ort-runtime still not done

    act(() => {
      markEngineAssetReady('ort-runtime');
    });

    await waitFor(
      () => {
        expect(startButton().disabled).toBe(false);
      },
      { timeout: WAIT_FOR_TIMEOUT_MS },
    );
  });

  // ─── Phase 213-04 D-14: two terminal states, correct retry affordance ─────

  it('the unsupported terminal state renders no button of any kind, and never the LoadError trailer copy', () => {
    act(() => {
      markEngineAssetsUnsupported();
    });
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    const gate = screen.getByTestId('engine-ready-gate');
    expect(within(gate).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('engine-gate-unsupported')).toBeTruthy();
    expect(gate.textContent).not.toContain('Please try again in a moment');
  });

  it('the failed terminal state renders a Retry button that clears the failed status and calls onRetry exactly once', () => {
    markEngineAssetFailed('maia-model');
    const onRetry = vi.fn();
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={onRetry} />);

    expect(screen.getByTestId('engine-gate-failed')).toBeTruthy();
    const retryButton = screen.getByTestId('btn-engine-retry');

    fireEvent.click(retryButton);

    expect(onRetry).toHaveBeenCalledTimes(1);
    // markEngineAssetsRetrying() cleared 'failed' back to 'idle' — the gate
    // re-renders in its downloading state (Start present, disabled, no
    // terminal testid left in the DOM).
    expect(screen.getByTestId('btn-engine-start')).toBeTruthy();
    expect(screen.queryByTestId('engine-gate-failed')).toBeNull();
  });

  // ─── Quick 260829-tku: the Maia out-of-memory terminal variant ────────────

  describe.each([['bots'], ['analysis']] as const)(
    'the out-of-memory terminal state (surface=%s)',
    (surface) => {
      it('renders the oom testid and free-memory copy, not the generic failed testid, with a working Retry and a single tagged Sentry capture', () => {
        markEngineAssetFailed('maia-model', 'oom');
        const onRetry = vi.fn();
        render(<EngineReadyGate surface={surface} onStart={vi.fn()} onRetry={onRetry} />);

        expect(screen.getByTestId('engine-gate-oom')).toBeTruthy();
        expect(screen.queryByTestId('engine-gate-failed')).toBeNull();
        const gate = screen.getByTestId('engine-ready-gate');
        expect(gate.textContent).toContain('Your device ran out of memory');
        expect(gate.textContent).toContain('Close your other browser tabs and apps');

        // Exactly one button, the existing Retry testid, behaving identically
        // to the generic failed state.
        expect(within(gate).queryAllByRole('button')).toHaveLength(1);
        const retryButton = screen.getByTestId('btn-engine-retry');
        fireEvent.click(retryButton);
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('engine-gate-oom')).toBeNull();

        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        expect(Sentry.captureException).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Engine cold start: device ran out of memory starting the engine',
          }),
          expect.objectContaining({
            tags: expect.objectContaining({ source: 'engine-ready-gate', engine_failure: 'oom' }),
          }),
        );
      });
    },
  );

  // ─── Quick 260829-tku Task 2: the new branch must not swallow the generic path ──

  it.each([
    ['a load-classified failure', 'load' as const],
    ['an unclassified failure', undefined],
  ])('%s still renders the pre-existing engine-gate-failed testid, title, body, and Retry', (_label, kind) => {
    markEngineAssetFailed('maia-model', kind);
    render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

    const failedPanel = screen.getByTestId('engine-gate-failed');
    expect(failedPanel.textContent).toContain('The engine did not start');
    expect(failedPanel.textContent).toContain('Something interrupted the download');
    expect(screen.queryByTestId('engine-gate-oom')).toBeNull();
    expect(screen.getByTestId('btn-engine-retry')).toBeTruthy();
  });

  // ─── Phase 213-04 D-16/D-17: Umami wait/abandonment + Sentry terminal capture ──

  describe('telemetry (D-16/D-17)', () => {
    it('fires engine-gate-shown exactly once on mount, carrying which surface mounted it (G-213-34)', () => {
      render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

      expect(trackEvent).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith('engine-gate-shown', { surface: 'bots' });
    });

    it('fires engine-gate-started exactly once on Start, with a bucketed wait_bucket prop and the surface, and never fires abandoned afterward', () => {
      vi.useFakeTimers();
      try {
        render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);
        vi.mocked(trackEvent).mockClear(); // drop the mount-time 'shown' call

        // Phase 213-09: ALL THREE assets must be marked ready to enable Start.
        act(() => {
          markAllAssetsReady();
        });
        vi.advanceTimersByTime(3_000); // lands in the '2-5s' bucket

        fireEvent.click(startButton());

        expect(trackEvent).toHaveBeenCalledTimes(1);
        expect(trackEvent).toHaveBeenCalledWith('engine-gate-started', {
          wait_bucket: '2-5s',
          surface: 'bots',
          trigger: 'user',
        });

        // Unmounting AFTER Start must not also fire abandoned.
        cleanup();
        expect(trackEvent).not.toHaveBeenCalledWith('engine-gate-abandoned', { surface: 'bots' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('D-18: fires engine-gate-started exactly once on the analysis auto-close, with trigger "auto" and the surface — and never fires abandoned afterward', () => {
      render(<EngineReadyGate surface="analysis" onStart={vi.fn()} onRetry={vi.fn()} />);
      vi.mocked(trackEvent).mockClear(); // drop the mount-time 'shown' call

      act(() => {
        markAllAssetsReady();
      });

      expect(trackEvent).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith('engine-gate-started', {
        wait_bucket: expect.any(String),
        surface: 'analysis',
        trigger: 'auto',
      });

      // Unmounting AFTER the auto-close must not also fire abandoned — the
      // run completed, it was not abandoned.
      cleanup();
      expect(trackEvent).not.toHaveBeenCalledWith('engine-gate-abandoned', { surface: 'analysis' });
    });

    it('fires engine-gate-abandoned exactly once on unmount when Start was never pressed, carrying the surface', () => {
      const { unmount } = render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);
      vi.mocked(trackEvent).mockClear();

      unmount();

      expect(trackEvent).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith('engine-gate-abandoned', { surface: 'bots' });
    });

    it('fires engine-gate-abandoned on pagehide, and does not double-fire on the subsequent unmount', () => {
      const { unmount } = render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);
      vi.mocked(trackEvent).mockClear();

      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(trackEvent).toHaveBeenCalledTimes(1);
      expect(trackEvent).toHaveBeenCalledWith('engine-gate-abandoned', { surface: 'bots' });

      unmount();
      expect(trackEvent).toHaveBeenCalledTimes(1); // still just the one call
    });

    it('never fires any Umami event when the gate never mounts (D-04 cache-hit path)', () => {
      // The gate simply never renders in the cache-hit case (Bots.tsx's own
      // conditional mount, not this component's concern) — asserting the
      // absence of calls here documents the contract this component upholds
      // by only ever firing from its own effects.
      expect(trackEvent).not.toHaveBeenCalled();
    });

    it('produces zero Sentry captures across a full idle -> downloading -> ready -> Start run', () => {
      const onStart = vi.fn();
      render(<EngineReadyGate surface="bots" onStart={onStart} onRetry={vi.fn()} />);

      act(() => {
        reportEngineAssetProgress('maia-model', 20_000_000, 45_683_686);
      });
      // Phase 213-09: ALL THREE assets must be marked ready to enable Start.
      act(() => {
        markAllAssetsReady();
      });
      fireEvent.click(startButton());

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('captures exactly one Sentry exception for the unsupported terminal state, with device context and no interpolated message', () => {
      act(() => {
        markEngineAssetsUnsupported();
      });
      render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Engine cold start: device cannot run the Maia model' }),
        expect.objectContaining({
          tags: expect.objectContaining({ source: 'engine-ready-gate', engine_failure: 'unsupported' }),
          contexts: expect.objectContaining({ engine_device: expect.any(Object) }),
        }),
      );
    });

    it('captures exactly one Sentry exception for the failed terminal state, distinct from the unsupported message', () => {
      markEngineAssetFailed('maia-model');
      render(<EngineReadyGate surface="bots" onStart={vi.fn()} onRetry={vi.fn()} />);

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Engine cold start: engine failed to start' }),
        expect.objectContaining({
          tags: expect.objectContaining({ source: 'engine-ready-gate', engine_failure: 'download' }),
        }),
      );
    });
  });

  // ─── Phase 213-09 (G-213-35): BOTH mounts, three-asset denominator ─────────
  //
  // `Bots.tsx` mounts `surface="bots"`, `Analysis.tsx` mounts
  // `surface="analysis"` — both read the SAME `engineAssetProgress.ts` store
  // via `requiredEngineAssets()`, so "both surfaces" becomes arithmetic here.
  // Every assertion below is run for BOTH surface values explicitly — never
  // one surface with the other assumed.

  describe.each([['bots'], ['analysis']] as const)('surface=%s', (surface) => {
    it('shows the three-asset denominator (66.5 MB) in its readout', async () => {
      render(<EngineReadyGate surface={surface} onStart={vi.fn()} onRetry={vi.fn()} />);

      act(() => {
        reportEngineAssetProgress('maia-model', 22_841_843, 45_683_686);
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('engine-ready-readout').textContent).toBe(
            'Maia model — 34% (22.8 / 66.5 MB)',
          );
        },
        { timeout: WAIT_FOR_TIMEOUT_MS },
      );
    });

    it('keeps its own per-surface title and note (G-213-34) while sharing the three-asset denominator', () => {
      render(<EngineReadyGate surface={surface} onStart={vi.fn()} onRetry={vi.fn()} />);

      const gate = screen.getByTestId('engine-ready-gate');
      const expectedTitle = surface === 'bots' ? 'Getting the bot ready' : 'Getting the engine ready';
      expect(gate.textContent).toContain(expectedTitle);
    });

    it('reaches readiness only once ALL THREE assets are done — not sooner (D-18: enables Start on bots, auto-closes via onStart on analysis)', async () => {
      const onStart = vi.fn();
      render(<EngineReadyGate surface={surface} onStart={onStart} onRetry={vi.fn()} />);

      act(() => {
        markEngineAssetReady('maia-model');
        markEngineAssetReady('stockfish-wasm');
      });
      if (surface === 'bots') {
        expect(startButton().disabled).toBe(true); // ort-runtime still not done
      } else {
        // D-18: analysis renders no Start button at all, in any state.
        expect(screen.queryByTestId('btn-engine-start')).toBeNull();
        expect(onStart).not.toHaveBeenCalled();
      }

      act(() => {
        markEngineAssetReady('ort-runtime');
      });

      if (surface === 'bots') {
        await waitFor(
          () => {
            expect(startButton().disabled).toBe(false);
          },
          { timeout: WAIT_FOR_TIMEOUT_MS },
        );
        // D-18: reaching readiness alone does not close bots — only a click does.
        expect(onStart).not.toHaveBeenCalled();
      } else {
        // D-18: reaching readiness closes analysis on its own — no click, no button.
        await waitFor(
          () => {
            expect(onStart).toHaveBeenCalledTimes(1);
          },
          { timeout: WAIT_FOR_TIMEOUT_MS },
        );
        expect(screen.queryByTestId('btn-engine-start')).toBeNull();
      }
    });

    it('renders exactly ONE non-dismissible gate and exactly ONE progress element', () => {
      render(<EngineReadyGate surface={surface} onStart={vi.fn()} onRetry={vi.fn()} />);

      expect(screen.queryAllByTestId('engine-ready-gate')).toHaveLength(1);
      expect(screen.queryAllByTestId('engine-ready-progress')).toHaveLength(1);
    });
  });

  // ─── Phase 213-11 (D-18): analysis auto-closes, bots keeps Start ──────────

  describe('D-18: analysis auto-close vs bots Start button', () => {
    it('analysis: never renders a Start button, in the downloading state either', () => {
      render(<EngineReadyGate surface="analysis" onStart={vi.fn()} onRetry={vi.fn()} />);
      expect(screen.queryByTestId('btn-engine-start')).toBeNull();
    });

    it('analysis: stays OPEN and shows the G-213-19 preparing readout while all bytes are in but the worker is not yet ready — the close waits for real readiness, not last byte', async () => {
      const onStart = vi.fn();
      render(<EngineReadyGate surface="analysis" onStart={onStart} onRetry={vi.fn()} />);

      // Every byte of ALL THREE assets is in, but no `ready` message has
      // arrived — mirrors the bots G-213-19 test above, keyed to the
      // auto-close's own gating condition (assets.ready, never allBytesIn).
      act(() => {
        reportEngineAssetProgress('maia-model', 45_683_686, 45_683_686);
        reportEngineAssetProgress('stockfish-wasm', STOCKFISH_WASM_BYTES_FALLBACK, STOCKFISH_WASM_BYTES_FALLBACK);
        reportEngineAssetProgress('ort-runtime', ORT_RUNTIME_BYTES_FALLBACK, ORT_RUNTIME_BYTES_FALLBACK);
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('engine-ready-readout').textContent).toBe(
            'Download complete. Starting the engine...',
          );
        },
        { timeout: WAIT_FOR_TIMEOUT_MS },
      );
      // Still open — bytes on disk are not a runnable engine, and the gate
      // must not close on last-byte-in.
      expect(screen.getByTestId('engine-ready-gate')).toBeTruthy();
      expect(onStart).not.toHaveBeenCalled();

      act(() => {
        markAllAssetsReady();
      });

      await waitFor(
        () => {
          expect(onStart).toHaveBeenCalledTimes(1);
        },
        { timeout: WAIT_FOR_TIMEOUT_MS },
      );
    });

    it('analysis: the failed terminal state does NOT auto-close — onStart is never called, and Retry still works exactly as on bots', () => {
      markEngineAssetFailed('maia-model');
      const onStart = vi.fn();
      const onRetry = vi.fn();
      render(<EngineReadyGate surface="analysis" onStart={onStart} onRetry={onRetry} />);

      expect(screen.getByTestId('engine-gate-failed')).toBeTruthy();
      expect(onStart).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('btn-engine-retry'));
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onStart).not.toHaveBeenCalled();
    });

    it('analysis: the unsupported terminal state does NOT auto-close — onStart is never called (defensive; Analysis.tsx additionally suppresses mounting the gate at all in this state)', () => {
      act(() => {
        markEngineAssetsUnsupported();
      });
      const onStart = vi.fn();
      render(<EngineReadyGate surface="analysis" onStart={onStart} onRetry={vi.fn()} />);

      expect(screen.getByTestId('engine-gate-unsupported')).toBeTruthy();
      expect(onStart).not.toHaveBeenCalled();
    });

    it('bots: the failed and unsupported terminal states also do not auto-call onStart (no auto-close behavior exists on this surface at all)', () => {
      markEngineAssetFailed('maia-model');
      const onStartFailed = vi.fn();
      render(<EngineReadyGate surface="bots" onStart={onStartFailed} onRetry={vi.fn()} />);
      expect(onStartFailed).not.toHaveBeenCalled();
      cleanup();

      resetEngineAssetsForTests();
      act(() => {
        markEngineAssetsUnsupported();
      });
      const onStartUnsupported = vi.fn();
      render(<EngineReadyGate surface="bots" onStart={onStartUnsupported} onRetry={vi.fn()} />);
      expect(onStartUnsupported).not.toHaveBeenCalled();
    });
  });
});
