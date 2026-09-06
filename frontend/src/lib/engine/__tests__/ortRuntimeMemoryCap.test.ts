// @vitest-environment node
/**
 * ortRuntimeMemoryCap.test.ts — proves the 1 GB wasm memory reservation cap
 * (quick 260906-p54, FLAWCHESS-9V) is present in BOTH vendored ORT glue
 * loaders and stays there.
 *
 * WebKit lets one page hold only three large wasm memory reservations before
 * `new WebAssembly.Memory(...)` throws `RangeError: Out of memory`. Both
 * `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.asyncify.mjs`
 * import a shared memory declared `min 256 / max 65536` pages (4 GiB) even at
 * `numThreads = 1`; this repo patches the imported `maximum` down to 16384
 * pages (1 GiB) — legal because a smaller `maximum` on an imported memory is
 * allowed as long as it stays `<=` the module's declared max.
 *
 * This patch lives in minified VENDOR code that `npm install` plus the
 * documented re-vendor `cp` command (see `public/maia/README.md`) silently
 * overwrites with stock 65536-page loaders. This gate exists so a re-vendor
 * that drops the patch fails CI loudly (FLAWCHESS-9V) instead of shipping a
 * silent regression back to the iOS OOM crash.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';

const MAX_ORT_WASM_MEMORY_PAGES = 16_384; // 16384 pages x 64 KiB = 1 GiB

const GLUE_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.asyncify.mjs',
] as const;

const MEMORY_LITERAL_PATTERN = /new WebAssembly\.Memory\(\{initial:256,maximum:(\d+),shared:!0\}\)/g;

describe('ORT wasm runtime memory cap (FLAWCHESS-9V)', () => {
  it.each(GLUE_FILES)('%s imports the shared memory at <= 1 GiB, exactly once', (fileName) => {
    const filePath = fileURLToPath(new NodeURL(`../../../../public/maia/${fileName}`, import.meta.url));
    const source = readFileSync(filePath, 'utf-8');

    const matches = [...source.matchAll(MEMORY_LITERAL_PATTERN)];

    // A re-vendor that introduces a second large reservation (or drops the
    // pattern entirely) must fail loudly here, not pass silently.
    expect(matches).toHaveLength(1);

    const capturedMaximum = matches[0]?.[1];
    expect(capturedMaximum).toBeDefined();
    // `<=`, not `===`, so a future re-vendor may lower the cap further
    // without editing this test.
    expect(Number(capturedMaximum)).toBeLessThanOrEqual(MAX_ORT_WASM_MEMORY_PAGES);
  });
});
