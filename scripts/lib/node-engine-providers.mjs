#!/usr/bin/env node
/**
 * node-engine-providers.mjs — shared Maia ONNX session + Stockfish UCI process
 * bring-up (Phase 168, CAL-02 no-duplication discipline).
 *
 * Extracted VERBATIM out of `scripts/gem-elo-calibration.mjs` (Phase 165) so
 * BOTH that harness and the new calibration harness (Phase 168) import the
 * exact same bring-up code — never a second hand-rolled copy of the Maia
 * session loader or the Stockfish WASM-over-UCI spawn trick. This is a
 * behavior-preserving mechanical refactor: gem-elo-calibration.mjs re-imports
 * these symbols and runs unchanged.
 *
 * Pitfall 5 (168-RESEARCH.md): the vendored Stockfish's Emscripten glue
 * locates its `.wasm` binary at `path.join(__dirname, basename(__filename,
 * ext) + '.wasm')` — i.e. same directory, SAME basename minus extension. The
 * `.cjs`/`.wasm` temp-file copy-then-rename logic below MUST stay byte-for-
 * byte identical to the original, or the spawned process silently hangs
 * waiting for `uciok`.
 *
 * Usage: node --import ./scripts/lib/frontend-alias-hook.mjs <script.mjs>
 * (resolveFrontendModule needs no `@/` alias itself — it resolves bare
 * package specifiers straight out of frontend/node_modules via createRequire.)
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ─── Path resolution (this file lives in scripts/lib/, one level deeper than
// scripts/gem-elo-calibration.mjs — REPO_ROOT/FRONTEND_DIR are re-derived
// relative to THIS file's own location, not inherited from the caller) ────────

// fileURLToPath (not URL.pathname): URL.pathname yields '/C:/...' on Windows,
// which path.resolve then mangles — the Stage B sweep runs on a Windows laptop.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
export const FRONTEND_DIR = path.resolve(REPO_ROOT, 'frontend');

/** Wall-clock timeout (ms) for the Stockfish `uci`/`isready` init handshake. */
export const STOCKFISH_INIT_TIMEOUT_MS = 30_000;

// ─── Resolve frontend-vendored runtime deps (onnxruntime-web, chess.js) ────────
// scripts/*.mjs is NOT under frontend/src, so bare package specifiers don't
// resolve from the repo root (no root node_modules). Mirror
// scripts/inspect_maia_onnx.mjs's createRequire-from-frontend recipe.

export async function resolveFrontendModule(packageName) {
  const requireFromFrontend = createRequire(path.join(FRONTEND_DIR, 'package.json'));
  const resolved = requireFromFrontend.resolve(packageName);
  return import(pathToFileURL(resolved).href);
}

// ─── Maia (onnxruntime) — loaded ONCE, reused across all positions ────────────

/**
 * `backend: 'wasm'` (default) is onnxruntime-web, app-faithful but leaks the
 * wasm arena (~"memory access out of bounds" after ~1,250 sweep positions —
 * ort-web internal, SEED-113 already disposes everything we own; both the
 * frontend maiaWorkerHost and the sweep supervisor mitigate by respawn).
 *
 * `backend: 'native'` is onnxruntime-node from scripts/package.json: no wasm
 * heap (the OOB crash class disappears) and ~2x faster single-threaded.
 * PINNED 1.21.1 — ort >= 1.22 SEGFAULTS loading this model (same pin as
 * pyproject's onnxruntime==1.20.1, scripts/maia_parity_spike.py Pitfall 2).
 * Pinned single-threaded: sweep workers are process-sharded, so intra-op
 * threads would only oversubscribe the box; measured backend parity is
 * |d expectedScore| <= ~1e-3 (same order as native's own thread-count
 * nondeterminism, an order below E-08's accepted @100-vs-@400 budget error).
 * NEVER mix backends within one study dataset without recording which rows
 * used which (the Stage B ledger stores `ort_backend` per row).
 */
export async function createMaiaSession({ backend = 'wasm' } = {}) {
  const modelPath = path.resolve(FRONTEND_DIR, 'public/maia/maia3_simplified.onnx');
  if (backend === 'native') {
    const requireFromScripts = createRequire(path.join(__dirname, '..', 'package.json'));
    let ort;
    try {
      ort = requireFromScripts('onnxruntime-node');
    } catch {
      throw new Error("backend 'native' needs onnxruntime-node: run `npm install` in scripts/ first");
    }
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
    return { ort, session };
  }
  const ort = (await resolveFrontendModule('onnxruntime-web')).default;
  ort.env.wasm.numThreads = 1; // matches the browser worker's no-COOP/COEP posture
  const modelBytes = fs.readFileSync(modelPath);
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
  return { ort, session };
}

// ─── Stockfish (vendored WASM over UCI) — spawned ONCE, reused across positions ─

/** Thin line-buffered UCI stdin/stdout wrapper around the spawned Stockfish child process. */
export class StockfishUciEngine {
  /**
   * `tempFilePaths` (WR-04): the `.cjs`/`.wasm` temp copies `spawnStockfish`
   * made for this process — retained here (not just at spawn time) so
   * `terminate()` can delete them; nothing else keeps a reference.
   */
  constructor(child, tempFilePaths = []) {
    this.child = child;
    this.buffer = '';
    this.lineListeners = new Set();
    this.tempFilePaths = tempFilePaths;
    this.quitting = false; // set by terminate() so the exit handler below doesn't treat a clean quit as a crash
    // WR-03: reject-with-cleanup callbacks for every in-flight waitFor(), so an
    // unexpected process death fails the pending caller immediately instead of
    // surfacing as an unhandled 'error' event or a full timeoutMs wait.
    this.pendingWaiters = new Set();

    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        for (const listener of this.lineListeners) listener(line);
      }
    });
    this.child.on('error', (err) => {
      this.#failPendingWaiters(new Error(`Stockfish process error: ${err.message}`));
    });
    this.child.on('exit', (code, signal) => {
      if (this.quitting) return; // expected — terminate() already told us to ignore this
      this.#failPendingWaiters(new Error(`Stockfish process exited unexpectedly (code=${code}, signal=${signal})`));
    });
    this.child.stdin.on('error', (err) => {
      this.#failPendingWaiters(new Error(`Stockfish stdin error (process likely exited): ${err.message}`));
    });
  }

  #failPendingWaiters(err) {
    for (const rejectWithCleanup of [...this.pendingWaiters]) rejectWithCleanup(err);
  }

  send(command) {
    this.child.stdin.write(`${command}\n`);
  }

  onLine(listener) {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        off();
        this.pendingWaiters.delete(rejectWithCleanup);
      };
      const rejectWithCleanup = (err) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        rejectWithCleanup(new Error(`Stockfish response timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.onLine((line) => {
        if (predicate(line)) {
          cleanup();
          resolve(line);
        }
      });
      this.pendingWaiters.add(rejectWithCleanup);
    });
  }

  async init() {
    this.send('uci');
    await this.waitFor((line) => line === 'uciok', STOCKFISH_INIT_TIMEOUT_MS);
    this.send('isready');
    await this.waitFor((line) => line === 'readyok', STOCKFISH_INIT_TIMEOUT_MS);
  }

  /**
   * WR-01: after a position's `go` search times out (waitFor rejected), the
   * engine is still searching. Sending the next `position`/`go` on top of a live
   * search corrupts subsequent grades. Stop the search and block on `readyok` so
   * the engine is quiescent before the next position — lets the run skip one bad
   * position and continue instead of aborting the whole multi-hour sweep.
   */
  async stopAndSync() {
    this.send('stop');
    this.send('isready');
    await this.waitFor((line) => line === 'readyok', STOCKFISH_INIT_TIMEOUT_MS);
  }

  /** Kills the process AND deletes its temp `.cjs`/`.wasm` copies (WR-04) — always safe to call more than once. */
  terminate() {
    this.quitting = true; // WR-03: tells the 'exit' handler this shutdown is expected, not a crash
    this.send('quit');
    this.child.kill();
    for (const filePath of this.tempFilePaths) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

export async function spawnStockfish() {
  const engineDir = path.resolve(FRONTEND_DIR, 'public/engine');
  const srcJsPath = path.join(engineDir, 'stockfish-18-lite-single.js');
  const srcWasmPath = path.join(engineDir, 'stockfish-18-lite-single.wasm');

  // Copy to a non-ESM .cjs so it auto-starts a UCI CLI on stdin/stdout under Node
  // (memory note project_headless_stockfish_wasm_verification). The Emscripten
  // glue locates its .wasm binary at `path.join(__dirname, basename(__filename,
  // ext) + '.wasm')` — i.e. same directory, SAME basename minus extension — so
  // the .wasm copy must be renamed to match the .cjs basename exactly, not just
  // co-located under its original name.
  const runId = `node-engine-providers-stockfish-${process.pid}-${Date.now()}`;
  const cjsPath = path.join(os.tmpdir(), `${runId}.cjs`);
  const wasmPath = path.join(os.tmpdir(), `${runId}.wasm`);
  fs.copyFileSync(srcJsPath, cjsPath);
  fs.copyFileSync(srcWasmPath, wasmPath);

  const child = spawn('node', [cjsPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const engine = new StockfishUciEngine(child, [cjsPath, wasmPath]);
  try {
    await engine.init();
  } catch (err) {
    // CR-02: the child process (and its temp file copies) must not leak if the
    // UCI handshake itself fails/times out — terminate() kills the process AND
    // unlinks the temp files even though init() never completed.
    engine.terminate();
    throw err;
  }
  return engine;
}
