/**
 * wasmSimd.ts unit tests (Phase 213-01 D-13) — proves the probe returns a
 * plain boolean in every case (accepted, rejected, throwing, or absent) and
 * NEVER throws, since it runs synchronously at the top of every Maia
 * `ensureSpawned()` call, before any Worker is constructed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { supportsWasmSimd } from '../wasmSimd';

describe('supportsWasmSimd', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when WebAssembly.validate accepts the probe module', () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);
    expect(supportsWasmSimd()).toBe(true);
  });

  it('returns false when WebAssembly.validate rejects the probe module', () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    expect(supportsWasmSimd()).toBe(false);
  });

  it('returns false and never throws when WebAssembly.validate itself throws', () => {
    vi.spyOn(WebAssembly, 'validate').mockImplementation(() => {
      throw new Error('WebAssembly disabled');
    });

    expect(() => supportsWasmSimd()).not.toThrow();
    expect(supportsWasmSimd()).toBe(false);
  });

  it('returns false and never throws when WebAssembly.validate is absent (older engines)', () => {
    const original = WebAssembly.validate;
    // @ts-expect-error simulating an engine that predates WebAssembly.validate
    delete WebAssembly.validate;

    try {
      expect(() => supportsWasmSimd()).not.toThrow();
      expect(supportsWasmSimd()).toBe(false);
    } finally {
      WebAssembly.validate = original;
    }
  });
});
