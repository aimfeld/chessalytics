/**
 * maiaWorkerErrors.ts unit tests (quick 260729-sod, FIX 2).
 *
 * Load-bearing case: the real FLAWCHESS-92 prod string matches BOTH the OOM
 * and the load patterns — classification order must put OOM first, since
 * memory exhaustion is the true root cause (see FINDINGS.md §1).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Sentry from '@sentry/react';
import { classifyMaiaWorkerError, captureMaiaWorkerError } from './maiaWorkerErrors';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('classifyMaiaWorkerError', () => {
  it('classifies the real FLAWCHESS-92 OOM string as oom, not load', () => {
    const raw = 'no available backend found. ERR: [wasm] RangeError: Out of memory';
    expect(classifyMaiaWorkerError(raw)).toBe('oom');
  });

  it('classifies a bare "Load failed" as load', () => {
    expect(classifyMaiaWorkerError('Load failed')).toBe('load');
  });

  it('classifies a module-script import failure as load', () => {
    expect(classifyMaiaWorkerError('TypeError: Importing a module script failed.')).toBe('load');
  });

  it('classifies an arbitrary ONNX runtime message as inference', () => {
    expect(classifyMaiaWorkerError('Non-zero status code returned while running Clip node')).toBe('inference');
  });

  it('classifies a memory-access-out-of-bounds message as oom', () => {
    expect(classifyMaiaWorkerError('memory access out of bounds')).toBe('oom');
  });
});

describe('captureMaiaWorkerError', () => {
  it('puts the raw text in context, not in the error message, and tags maia_failure', () => {
    const raw = 'no available backend found. ERR: [wasm] RangeError: Out of memory';
    captureMaiaWorkerError(raw, { source: 'maia-queue-worker', backend: null });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, opts] = vi.mocked(Sentry.captureException).mock.calls[0]!;
    expect((err as Error).message).not.toContain(raw);
    expect(opts).toEqual(
      expect.objectContaining({
        tags: expect.objectContaining({
          source: 'maia-queue-worker',
          backend: 'unknown',
          maia_failure: 'oom',
        }),
        contexts: expect.objectContaining({ maia: { rawMessage: raw } }),
      }),
    );
  });

  it('does not vary the error message with the worker text (stable grouping)', () => {
    captureMaiaWorkerError('Load failed', { source: 'maia-worker', backend: 'webgpu' });
    captureMaiaWorkerError('Load failed: network hiccup', { source: 'maia-worker', backend: 'webgpu' });

    const calls = vi.mocked(Sentry.captureException).mock.calls;
    const [err1] = calls[0]!;
    const [err2] = calls[1]!;
    expect((err1 as Error).message).toBe((err2 as Error).message);
  });
});
