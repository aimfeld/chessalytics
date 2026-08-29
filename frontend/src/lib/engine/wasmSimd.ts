/**
 * wasmSimd — a cheap, synchronous WASM-SIMD capability probe (D-13).
 *
 * Today a device that can never run Maia (no WASM SIMD support) downloads all
 * 45.7 MB of the model on mobile data before onnxruntime-web's `create()`
 * throws. This probe runs BEFORE any fetch starts (see `maiaWorkerHost.ts`'s
 * `ensureSpawned()`), so an incapable device never pays that cost finding out.
 *
 * Byte array sourced verbatim from GoogleChromeLabs/wasm-feature-detect@1.8.0
 * (`src/detectors/simd/module.ts`) — a minimal WASM module using a SIMD
 * instruction (`v128.const` / `i32x4.splat`-family opcode), valid only on an
 * engine with SIMD support. Hand-rolled here rather than depending on the
 * `wasm-feature-detect` npm package per 213-RESEARCH.md's Package Legitimacy
 * Audit / "Don't Hand-Roll" recommendation — this one detector is simple
 * enough, and cited, to inline.
 */

const SIMD_PROBE_MODULE_BYTES = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

/**
 * Returns `true` when this engine's `WebAssembly.validate` accepts the SIMD
 * probe module, `false` when it rejects it OR when validation itself throws
 * (e.g. `WebAssembly` absent entirely) — never throws. Synchronous:
 * `WebAssembly.validate` itself is synchronous, so this returns a boolean,
 * not a Promise.
 */
export function supportsWasmSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE_MODULE_BYTES);
  } catch {
    return false;
  }
}
