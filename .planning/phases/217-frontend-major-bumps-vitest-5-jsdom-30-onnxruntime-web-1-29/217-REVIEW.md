---
phase: 217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29
reviewed: 2026-09-05T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - frontend/src/lib/engine/engineAssetCache.ts
  - frontend/src/lib/engine/engineAssetProgress.ts
  - frontend/src/lib/engine/maiaWorkerHost.ts
  - frontend/src/lib/engine/ortRuntimeSource.ts
  - frontend/public/maia/README.md
  - frontend/package.json
  - CHANGELOG.md
findings:
  critical: 0
  warning: 0
  info: 1
  total: 1
status: clean
---

# Phase 217: Code Review Report

**Reviewed:** 2026-09-05
**Depth:** standard
**Files Reviewed:** 7
**Status:** clean

## Summary

This phase's diff on `main` (`e3603b79a..6f19e0567`, restricted to the 7 files above) is a pure dependency-bump diff with no logic changes in any `.ts` file — every hunk in `engineAssetCache.ts`, `engineAssetProgress.ts`, `maiaWorkerHost.ts`, and `ortRuntimeSource.ts` is either (a) the `ENGINE_ASSET_CACHE_VERSION` bump from `1` to `2`, or (b) a doc-comment/byte-constant update reflecting the re-vendored onnxruntime-web 1.29.0 runtime binaries' new sizes. `package.json` bumps `onnxruntime-web` (exact pin, consistent with the vendoring precedent), `vitest`/`@vitest/coverage-v8`/`@vitest/ui` (4.x → 5.x), and `jsdom` (29.x → 30.x), and deletes the `overrides.undici` entry.

I independently verified every changed number rather than trusting the commit's own arithmetic:

- `sha256sum` on the six vendored files under `frontend/public/maia/` matches the README's table exactly (`ort.wasm.min.js`, `ort.webgpu.min.js`, `ort-wasm-simd-threaded.{mjs,wasm}`, `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`).
- `ls -la` on those same six files matches the recorded byte counts exactly, including the two large `.wasm` binaries (13,961,845 and 25,749,873) that feed `ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK` / `ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK` / `ORT_RUNTIME_BYTES_FALLBACK`.
- The `engineAssetCache.ts` comment's total-asset-size claim ("66.9 MB") reconciles exactly: `45,683,686 (model) + 13,961,845 (ort wasm-only) + 7,295,411 (stockfish) = 66,940,942` bytes ÷ 1,000,000 ≈ 66.9 MB (decimal-MB convention, consistent with the prior "66.5 MB" figure computed the same way against the old sizes).
- The `ortRuntimeSource.ts` doc comment's degraded-path total ("39.7 MB") reconciles: `25,749,873 + 13,961,845 = 39,711,718` bytes ≈ 39.7 MB.
- `maiaWorkerHost.ts`'s "14.0-25.7 MB" structured-clone range matches the two new fallback constants exactly.
- No stale references to the old byte literals (`13_479_978` / `24_254_953` / `13,479,978` / `24,254,953`) remain anywhere under `frontend/src/`.
- The three test files that assert on these constants (`engineAssetProgress.test.ts`, `ortRuntimeSource.test.ts`, `EngineReadyGate.test.tsx`) import the named exports rather than hardcoding byte literals, so the bump cannot silently desync test expectations from the new fallback values.
- The `overrides.undici` deletion in `package.json` is not a bare unexplained removal: it is backed by `217-RESEARCH.md`'s "Pattern 1" analysis (jsdom 30 declares `undici: ^8.9.0` natively, strictly newer than the deleted `^7.29.0` floor; `npm audit` showed zero live undici advisories at research time) and the phase's own plan-level verification step (`npm ls undici` / targeted `npm audit --json` filter). `npm ls undici` in the current tree confirms jsdom 30 resolves its own nested `undici@8.10.2` while `shadcn`/`@dotenvx` stay independently on `undici@7.29.1` — matching the documented intent exactly.
- `CHANGELOG.md`'s new bullet ("about 14 MB on the WASM path, 26 MB on the WebGPU path") rounds the verified byte counts correctly (13,961,845 → ~14 MB, 25,749,873 → ~26 MB).

No behavioral, security, or correctness defects found in the reviewed diff. All reviewed values are internally consistent and verified against the actual files on disk, not just against each other.

## Info

### IN-01: vitest 5 / jsdom 30 major bump has no CHANGELOG entry (dev-only, likely fine, flagging for consistency)

**File:** `CHANGELOG.md:24`
**Issue:** The single new "Internal" bullet under `[Unreleased]` covers only the onnxruntime-web 1.27.0→1.29.0 re-vendor (the user-visible re-download). It does not mention the `vitest`/`@vitest/coverage-v8`/`@vitest/ui` 4.x→5.x bump, the `jsdom` 29.x→30.x bump, or the `overrides.undici` deletion in `frontend/package.json`. These are dev/test-toolchain-only changes with zero shipped-bundle impact, so omitting them is defensible and consistent with `audit-ci.jsonc`'s `skip-dev: true` treatment of the same dependency tier. However, CLAUDE.md's precedent in this same file (e.g. Phase 216's "Internal: Renovate dependency PRs are live again... CI caches the uv and npm stores...") does document comparably internal, non-user-facing tooling changes as bullets. Since major-version bumps of a whole test framework are exactly the kind of change future readers scanning the changelog for "what changed and why did CI/tests need re-verification" would want to find.
**Fix:** Optional — if the project's convention is that dev-only version bumps with no shipped impact don't need a changelog line (as several other historical entries suggest), no action needed. If consistency with Phase 216's granularity is preferred, add a short internal bullet, e.g.: "Internal: `vitest`, `@vitest/coverage-v8`, `@vitest/ui` (4.x → 5.x) and `jsdom` (29.x → 30.x) bumped together; the `undici` override in `overrides` is deleted now that `jsdom` 30 resolves a patched version natively. (Phase 217)"

---

_Reviewed: 2026-09-05_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
