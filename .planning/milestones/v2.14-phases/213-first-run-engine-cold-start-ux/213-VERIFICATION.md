---
phase: 213-first-run-engine-cold-start-ux
verified: 2026-08-29T13:05:00Z
status: passed
score: 39/39 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 19/19
  gaps_closed:
    - "G-213-35 (three parts, 213-08/213-09/213-10): the analysis-board gate's single bar now accounts for every byte actually transferred — one shared Stockfish fetch (213-08), the ORT runtime binary counted as a third gate asset with only the needed build ever requested (213-09), and store-notification coalescing plus a narrowed Analysis() subscription so the bar tracks the transfer in real time instead of crawling minutes behind it (213-10)."
    - "G-213-36 (213-11, later superseded by 213-12's mechanism): the DataCloneError that silently stalled every bot's first move after visiting /analysis first is gone — first fixed by retain-and-copy, then structurally eliminated by 213-12's CacheStorage migration (no ArrayBuffer is retained across spawns at all)."
    - "G-213-37 / D-20 (213-12): starting a bot game after the engine is already warm downloads nothing — all three engine assets (Maia model, ORT runtime, Stockfish wasm) resolve through one CacheStorage-backed byte-ownership layer, not bypassed by DevTools 'Disable cache'. The two per-path in-memory patches this superseded (213-11's retained ORT master, G-213-8's modelBuffer respawn handoff) are cleanly retired, confirmed by an independent grep for leftover fields."
    - "D-18 (213-11): the analysis gate now closes itself the instant the engine is genuinely ready (assets.ready, never last-byte); bots keeps its Start button and click-to-close."
  gaps_remaining: []
  regressions: []
---

# Phase 213: First-Run Engine Cold Start Verification Report (Re-Verification)

**Phase Goal:** A first-time visitor on a phone can start a bot game without the bot
silently burning its clock on a 45.7 MB model download. Whenever an engine is used —
Stockfish, Maia, or the combined FlawChess engine — the consumer first checks device
capability and asset availability and downloads what's missing behind a progress UI
showing overall progress and which asset is currently downloading. Bot play gates game
start on readiness via `confirmLive()`. The analysis board gets the same progress UI but
no gate. No warmup inference is added. Persona avatars ship at ~128px with lazy loading.

**Verified:** 2026-08-29T13:05:00Z
**Status:** passed
**Re-verification:** Yes — replaces the 2026-08-28T22:50:00Z VERIFICATION.md
(`human_needed`, 19/19), which correctly deferred one blocking-human check
(G-213-34's cold-cache Slow-4G Network-tab script). That check has since been run
four more times across gap-closure plans 213-08 through 213-12, surfacing three
further blocker-severity gaps (G-213-35's three parts, G-213-36, G-213-37/D-20), all
now closed and human-confirmed. This run re-verifies the 19 previously-verified
truths still hold under the intervening refactor, and gives full first-pass scrutiny
to every new must-have from plans 213-08..12.

## Goal Achievement

### Part A — Regression check: the 19 previously-verified truths (213-01..07)

All 19 truths from the prior VERIFICATION.md (readiness definition, cache-miss gate,
non-dismissible Dialog states, unconditional two-asset bundle, analysis-board gating,
terminal states, telemetry, avatar lazy-loading, etc.) were re-checked directly
against the current codebase rather than assumed from the prior report.

| # | Truth (condensed) | Status | Evidence (this session) |
|---|---|---|---|
| 1-6 | Unconditional bundle (G-213-19b): both `maia-model`/`stockfish-wasm` always required, no blend branch | ✓ VERIFIED | `ALL_ENGINE_ASSETS` now `['maia-model','stockfish-wasm','ort-runtime']` (213-09 added a 3rd id, additive — the two originals are still unconditional); `useBotGame.ts` bring-up effect and `retryEngineWarm()` re-read directly, still unconditional |
| 7-13 | Analysis board gated identically to Bots (G-213-34): 3 layouts, one aggregate bar, unsupported-hides-gate | ✓ VERIFIED | `Analysis.tsx` still mounts `engineGateNode` at 3 sites (`grep -c` = 3); D-18 (213-11) changed WHEN the analysis gate closes (auto vs click) but not WHETHER it gates — confirmed by direct read of the `surface === 'analysis'` auto-close effect plus the unchanged `unsupported` suppression predicate |
| 14-19 | D-01 readiness, D-04 no-timer gate, D-09 non-dismissible Dialog, D-14/D-15 terminal states, D-06/D-12 comment hygiene, D-16 Umami surface | ✓ VERIFIED | `EngineReadyGate.tsx` structure re-read in full: `showCloseButton={false}`, `onOpenChange={() => {}}`, `failed`/`unsupported` branches present, `trackEvent()` calls now carry both `surface` and (213-11) `trigger` |
| P1 | No adaptive/speculative prefetch (D-08) | ✓ VERIFIED | `grep -rE "saveData|effectiveType|navigator\.connection" frontend/src/` — zero hits |

**Persona avatars (D-18/213-02, unaffected by this gap chain):** `loading="lazy"`
confirmed present on all three render sites (`PersonaCard.tsx:131`,
`PersonaDetailSurface.tsx:213`, `ClockDisplay.tsx:55`).

### Part B — New must-haves: G-213-35 (213-08, 213-09, 213-10)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 20 | 213-08: Stockfish `.wasm` fetched exactly once per page load through one shared source module, every consumer routed through it | ✓ VERIFIED | `stockfishWorkerSource.ts` exists, `getEngineAsset` import present (post-213-12 migration); `workerPool.ts`'s `replaceDeadSlot()` depends on `ensureStockfishWorkerUrl()`'s page-session-memoised object URL (confirmed deliberately retained, per 213-12's own key-decisions, since it's a Worker-construction handle, not a byte cache) |
| 21 | 213-08: shared fetch failure degrades every consumer to direct construction; CR-01/CR-02 preserved | ✓ VERIFIED | Targeted test file passes (`stockfishWorkerSource.test.ts`, `workerPool.test.ts` — 129/129 in this session's run, see Behavioral Spot-Checks) |
| 22 | 213-09: exactly one ORT runtime binary transferred per page load; build chosen main-thread, before any Worker; f16-absent devices never request the 24.3 MB asyncify build | ✓ VERIFIED | `ortRuntimeSource.ts` still contains the adapter-probe-then-fetch shape (now via `getEngineAsset()` post-213-12); targeted test suite passes (26/26 `ortRuntimeSource.test.ts` in this session) |
| 23 | 213-09: `ort-runtime` registered as a 3rd gate asset, CR-02-safe, denominator sums all three, monotonic across estimate-to-exact | ✓ VERIFIED | `EngineAssetId` union is `'maia-model' \| 'stockfish-wasm' \| 'ort-runtime'`; `ALL_ENGINE_ASSETS` and `ENGINE_ASSET_FALLBACK_BYTES` both carry the 3rd id (direct read, `engineAssetProgress.ts:20,72,78,88,95`) |
| 24 | 213-09: both surfaces (bot play + analysis board) served by the SAME shared runtime fetch through `acquireMaiaWorker()` | ✓ VERIFIED | Both `Bots.tsx:574` and `Analysis.tsx` (3 mount sites) reach the same `EngineReadyGate`/`maiaWorkerHost` singleton; unchanged single-choke-point architecture confirmed by direct read |
| 25 | 213-10 (the criterion 213-09's Task 4 explicitly FAILED on): the gate's bar advances in step with the transfer — reaches 100% within ~1s of the last byte, never minutes later | ✓ VERIFIED | Mechanism re-confirmed present: `engineAssetProgress.ts`'s `refreshSnapshot()`/`notifyListeners()` split with `lastNotifiedPercentById` gating notification on rounded-percent change (lines 128-163, 250-259); `Analysis.tsx:1126` subscribes via `useEngineAssetStatus()` (a primitive), not the full byte object. Targeted test suite passes (39/39 `engineAssetProgress.test.ts`, 3/3 `useEngineAssets.test.ts` in this session). **Human-verified**: the user's own words after this landed — "Model download in analysis board was perfect" on both Chrome and Brave (recorded in `.continue-here.md`, corroborated by the 213-UAT.md G-213-36 entry's `reason` text) |
| 26 | 213-10: `Analysis()` re-renders only on status transitions, never on a byte-only tick; `EngineReadyGate` still gets full byte-level progress | ✓ VERIFIED | Render-count test present and passing (`Analysis.test.tsx`); `useEngineAssets()` (full object) is unchanged and still the hook `EngineReadyGate.tsx` uses internally |
| 27 | 213-10: notification coalescing never delays/drops CR-02 or the final 100%/G-213-19 readout | ✓ VERIFIED | `markEngineAssetPending`/`Ready`/`Failed`/`Unsupported`/`Retrying`/`resetForRefetch` all call `notifyListeners()` unconditionally per direct read of `engineAssetProgress.ts`; dedicated tests for each pass |

### Part C — New must-haves: G-213-36 (213-11, mechanism later superseded by 213-12)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 28 | A second worker spawn (/analysis -> /bots hop) receives a valid, non-detached buffer and initialises normally | ✓ VERIFIED | Confirmed by the CURRENT mechanism (213-12's CacheStorage layer, not 213-11's now-retired retain-and-copy): `getEngineAsset()` never retains an ArrayBuffer past the fetch window (`inflightByAssetId` deleted on settle, direct read `engineAssetCache.ts:214-238`) and every read — cache-hit or single-flight join — returns an independent `slice(0)`/fresh-`arrayBuffer()` instance, so no two callers can ever share (and one detach) the same buffer. Dedicated `maiaWorkerHost.test.ts` "G-213-36" describe block passes (confirmed by this session's targeted run) |
| 29 | D-18: analysis gate auto-closes on `assets.ready` (never `allBytesIn`); bots keeps Start; telemetry gains a `trigger: 'auto' \| 'user'` discriminator | ✓ VERIFIED | `EngineReadyGate.tsx`: `ENGINE_GATE_STARTED_TRIGGER_AUTO`/`_USER` constants, `handleStart` idempotent via `startedFiredRef`, auto-close effect keyed on `assets.ready` gated by `surface === 'analysis'`, `DialogFooter`/Start button gated by `surface === 'bots'` — all confirmed by direct read at the cited line numbers |
| 30 | `fetchWasmOnlyOrtRuntime()` and the `modelBuffer` transfer audited; conclusions recorded and later made moot | ✓ VERIFIED (superseded cleanly) | 213-12 retired the `modelBuffer` field entirely (`grep` for `modelBuffer`/`prefetchedBuffer` in `maiaWorkerHost.ts`/`maia-worker.js` finds only historical doc comments, zero live fields — confirmed this session) |

### Part D — New must-haves: G-213-37 / D-20 (213-12)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 31 | Starting a bot game after the engine is already warm downloads NOTHING — second Maia worker spawn reads the 45.7 MB model out of CacheStorage, holds under "Disable cache" | ✓ VERIFIED (human-confirmed) | `maia-worker.js`'s `fetchModelBuffer(onProgress, assetCacheName)` opens `caches.open(assetCacheName)` and matches `MODEL_PATH` before ever fetching (direct read, lines 227-232); `maiaWorkerHost.ts`'s `constructWorker()` sends `assetCacheName: ENGINE_ASSET_CACHE_NAME` in every init message. **Human-verified**: Task 4's checkpoint (`213-12-PLAN.md`) was run in Chrome + Brave with "Disable cache" ticked and approved by the user 2026-08-29 — confirmed independently via git: commit `197b1c37e` ("Task 4 checkpoint approved — G-213-37 and D-20 complete"), authored by the project owner, present at HEAD |
| 32 | All three assets resolve through ONE byte-ownership layer (`engineAssetCache.ts`); no fourth per-asset in-memory patch added | ✓ VERIFIED | `ortRuntimeSource.ts` and `stockfishWorkerSource.ts` both `import { getEngineAsset } from './engineAssetCache'` (direct read); no competing cache/retention mechanism found in either file (`OrtRuntimeMasterResult`/`fetchRuntimeBinary` — zero grep hits, confirmed retired) |
| 33 | Every worker spawn gets a fresh ArrayBuffer no other caller holds; no buffer retained in main-thread module scope between spawns | ✓ VERIFIED | `getEngineAsset()`'s `inflightByAssetId` map entry is deleted the instant its promise settles (`engineAssetCache.ts:214-217`, direct read); cache-hit path calls `match.arrayBuffer()` fresh on every call (a real `Cache.match()` constructs a new `Response` per call) |
| 34 | Bytes genuinely come from CacheStorage, not RAM — cleared cache produces a 2nd fetch, populated cache produces zero | ✓ VERIFIED | Dedicated "cache provenance" test pairs in `ortRuntimeSource.test.ts`/`stockfishWorkerSource.test.ts`, each proven load-bearing by a recorded revert (reverting to a memoised-result shape made the "cache cleared -> 2nd fetch" case fail as expected, restored). Confirmed passing in this session's targeted run |
| 35 | `caches` absence and `cache.put` quota failure both degrade gracefully, never block startup; zero-length cached entries treated as a miss; non-ok responses never cached | ✓ VERIFIED | Direct read of `engineAssetCache.ts`: `typeof caches === 'undefined'` returns `null` (line 91); `streamAndCache()` only calls `cache.put` when `!skipFurtherWrites`, catches and Sentry-reports a `put` rejection exactly once, then sets `skipFurtherWrites = true` (lines 166-179); `getEngineAsset()` treats `bytes.byteLength > 0` as the hit condition (line 226); `streamAndCache` throws before ever calling `cache.put` on a non-ok response (lines 139-142) |
| 36 | Cache invalidation is one version constant; the stale sweep never touches Workbox's PWA-shell caches | ✓ VERIFIED | `ENGINE_ASSET_CACHE_VERSION`/`ENGINE_ASSET_CACHE_NAME_PREFIX` constants confirmed (lines 41, 51); sweep filters strictly on `key.startsWith(ENGINE_ASSET_CACHE_NAME_PREFIX)` (line 104, direct read) — cannot match `html-shell`/`workbox-precache-*` |
| 37 | A cache hit reports full progress immediately — the bar never freezes at 0% on a zero-byte start or a wasm-pinned respawn | ✓ VERIFIED | `onProgress(bytes.byteLength, bytes.byteLength)` fires synchronously on a cache hit (line 227); `respawnPinnedToWasm()`'s `resetEngineAssetForRefetch('maia-model')` is now unconditional per 213-12's own recorded key-decision, so a cache-hit's immediate 100% report is never preceded by a stale reset |
| 38 | D-04 untouched — the gate predicate stays synchronous, never keyed on CacheStorage | ✓ VERIFIED | `engineGateRequired()` in `engineAssetProgress.ts` is untouched by 213-12's diff (confirmed by `grep` — no `caches`/`await` inside it); still a synchronous localStorage read |
| 39 | Prior invariants re-verified unmodified: G-213-19, G-213-19b, D-13, CR-02, FLAWCHESS-92 terminate-at-zero-leases | ✓ VERIFIED | `supportsWasmSimd()` gate still precedes `spawn()`/`getEngineAsset()` in `ensureSpawned()` (confirmed by direct read, D-13 test re-run in isolation per 213-12-SUMMARY, independently re-confirmed passing in this session's full-suite run); `releaseLease`/`resetModuleState` confirmed unchanged by this plan's diff |

**Score:** 39/39 truths verified (0 present-but-behavior-unverified, 0 overrides)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `frontend/src/lib/engine/engineAssetCache.ts` | Single CacheStorage byte-ownership layer | ✓ VERIFIED | `getEngineAsset`, `ENGINE_ASSET_CACHE_NAME`, `ENGINE_ASSET_CACHE_NAME_PREFIX`, `resetEngineAssetCacheForTests` all exported and used |
| `frontend/src/lib/engine/ortRuntimeSource.ts` | Migrated onto `getEngineAsset()`, retained-master mechanism deleted | ✓ VERIFIED | `getEngineAsset` imported; `OrtRuntimeMasterResult`/`fetchRuntimeBinary` — zero grep hits |
| `frontend/src/lib/engine/stockfishWorkerSource.ts` | Migrated onto `getEngineAsset()` | ✓ VERIFIED | `getEngineAsset` imported and called in `fetchAndPublishSharedWasm()` |
| `frontend/src/lib/engine/maiaWorkerHost.ts` | `assetCacheName` in `InitMessage`, `modelBuffer` field removed | ✓ VERIFIED | `assetCacheName?: string` present; `modelBuffer` only in historical doc comments |
| `frontend/public/maia/maia-worker.js` | Cache-first `fetchModelBuffer`, no `prefetchedBuffer` param | ✓ VERIFIED | `caches.open(assetCacheName)`/`cache.match` present; `prefetchedBuffer` — zero live references |
| `frontend/src/lib/engine/engineAssetProgress.ts` | 3rd `ort-runtime` asset id; coalesced notification split | ✓ VERIFIED | `EngineAssetId` union of 3; `refreshSnapshot`/`notifyListeners` split present |
| `frontend/src/hooks/useEngineAssets.ts` | `useEngineAssetStatus()` primitive hook | ✓ VERIFIED | Exported, used by `Analysis.tsx` |
| `frontend/src/pages/Analysis.tsx` | Narrowed subscription; gate mounted at 3 sites; D-18 auto-close consumer | ✓ VERIFIED | `useEngineAssetStatus()` at single call site; `engineGateNode` × 3 |
| `frontend/src/components/bots/EngineReadyGate.tsx` | D-18 per-surface close behavior, trigger discriminator | ✓ VERIFIED | `surface === 'bots'`/`'analysis'` branches, `ENGINE_GATE_STARTED_TRIGGER_*` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `getEngineAsset()` | `caches.open(ENGINE_ASSET_CACHE_NAME)` | `openEngineAssetCache()`, memoised once per page session | ✓ WIRED | Direct read, `engineAssetCache.ts:91-113` |
| `maiaWorkerHost.constructWorker()` | `maia-worker.js`'s `fetchModelBuffer` | `InitMessage.assetCacheName = ENGINE_ASSET_CACHE_NAME` | ✓ WIRED | `maiaWorkerHost.ts:408`, `maia-worker.js:517` (`msg.assetCacheName`) |
| Second `BotsGame` mount (`key={boot.nonce}`) | zero engine-asset network requests | teardown-at-zero-leases -> fresh spawn -> cache hit on all 3 assets | ✓ WIRED (human-confirmed) | Mechanism confirmed by code read; the actual zero-byte outcome is a real-browser DevTools measurement — approved 2026-08-29, commit `197b1c37e` |
| `Analysis.tsx` | `useEngineAssetStatus()` | single call site, `Object.is` bail on unchanged status | ✓ WIRED | `Analysis.tsx:1126` |
| `EngineReadyGate` (analysis) | `handleStart('auto')` | `useEffect` keyed on `assets.ready` | ✓ WIRED | `EngineReadyGate.tsx:296-301` |
| `requiredEngineAssets()` (3 ids) | Both gate mounts' aggregate bar | `useEngineAssets(requiredEngineAssets())` | ✓ WIRED | `EngineAssetId` union of 3; `Bots.tsx:574`, `Analysis.tsx` × 3 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `EngineReadyGate` progress bar (both surfaces) | byte-weighted percent over 3 assets | `useEngineAssets` over `engineAssetProgress` store, fed by `getEngineAsset()`'s real `onProgress` callback (cache-hit reports complete instantly; cache-miss streams real chunks) | Yes | ✓ FLOWING |
| `maia-worker.js`'s model source | `modelBuffer` | `caches.match(MODEL_PATH)` on hit, real `fetch()` streamed through the SAME progress path on miss | Yes | ✓ FLOWING |

### Behavioral Spot-Checks / Test Execution

All commands below were re-run directly by this verifier in this session (not taken from SUMMARY prose):

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Targeted 213-08..12 test files (9 files) | `npm test -- --run` on `engineAssetCache`, `maiaWorkerScript`, `maiaWorkerHost`, `ortRuntimeSource`, `stockfishWorkerSource`, `engineAssetProgress`, `useEngineAssets`, `EngineReadyGate`, `Analysis` | 9 files / 278 tests passed | ✓ PASS |
| Lint | `npm run lint` | clean | ✓ PASS |
| Dead code | `npm run knip` | clean | ✓ PASS |
| Build | `npm run build` | clean (`tsc -b` + `vite build`, PWA precache generated) | ✓ PASS |
| Full suite (run once) | `npm test -- --run` | 247/248 files clean, 1 file (`Train.guestGate.test.tsx`) failed 2/6 under the parallel run | ⚠️ then confirmed |
| `Train.guestGate.test.tsx` standalone | `npm test -- --run src/pages/__tests__/Train.guestGate.test.tsx` | 6/6 passed | ✓ PASS — confirms the documented pre-existing parallel-run-only flake (213-05-SUMMARY.md), not a regression |
| Debt markers | `grep -nE "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` on all 9 files touched by 213-09..12 | zero hits | ✓ PASS |
| `modelBuffer`/`prefetchedBuffer` leftover check | `grep -rn` on `maiaWorkerHost.ts`/`maia-worker.js` | only historical doc comments, zero live fields | ✓ PASS |

Full suite total: **248 test files / 3843 tests**, matching 213-12-SUMMARY.md's own reported count exactly.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| G-213-35 | 213-08, 213-09, 213-10 | Analysis-board gate bar tracks real network byte progress in step with the Network tab | ✓ SATISFIED | Truths #20-27; human-confirmed ("perfect" on both Chrome/Brave) |
| G-213-36 | 213-11 (mechanism superseded by 213-12) | Bot play works after the analysis board has already warmed the engine | ✓ SATISFIED | Truths #28-30; console-clean check (D) part of 213-12 Task 4's approved checkpoint |
| G-213-37 | 213-12 | Starting a bot game after the engine is warm downloads nothing | ✓ SATISFIED | Truths #31-39; approved via commit `197b1c37e` |
| D-18 | 213-11 | Analysis gate closes itself; bots keeps Start | ✓ SATISFIED | Truth #29 |
| D-20 | 213-12 | CacheStorage as the single byte-ownership layer for all engine assets | ✓ SATISFIED | Truths #32-38 |

**Frontmatter `requirements-completed` note:** 213-10's and 213-11's own SUMMARYs
deliberately left `requirements-completed` empty because each plan's OWN
`checkpoint:human-verify` Task was never individually run to completion (213-09's
Task 4 failed and was explicitly superseded by 213-10's Task 3; 213-11's Task 3 was
left open pending further UAT that surfaced G-213-37 instead). Their underlying
truths are nonetheless independently confirmed here: G-213-35's third part
(213-10) via the user's own "perfect" feedback recorded in `.continue-here.md` and
213-UAT.md's G-213-36 entry; G-213-36 (213-11) via 213-12's own re-verified test
block (mechanism moved, invariant re-proven) plus 213-12 Task 4's console-clean
check. This is a case of a later, broader checkpoint (213-12's Task 4, git-approved)
subsuming two earlier plans' individually-unclosed checkpoints — not a gap.

No orphaned requirements: every gap/decision ID referenced across 213-08..12's
`requirements:` frontmatter is claimed by exactly one plan and traced to code above.
`REQUIREMENTS.md` has no Phase 213 rows (phase tracks gap IDs via UAT/CONTEXT
instead, as stated in the verification brief).

### Anti-Patterns Found

None in any of the 9 files touched by 213-09 through 213-12
(`engineAssetCache.ts`, `ortRuntimeSource.ts`, `stockfishWorkerSource.ts`,
`maiaWorkerHost.ts`, `maia-worker.js`, `engineAssetProgress.ts`,
`useEngineAssets.ts`, `Analysis.tsx`, `EngineReadyGate.tsx`): zero
`TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` matches (confirmed directly, not
taken from any SUMMARY's own claim).

### Independent Code Review Findings — Carried Forward, Still Not a Verification Gap

The prior VERIFICATION.md's four independent-review findings (213-REVIEW.md round 2)
were re-checked directly against the current codebase, since three of the four
touch worker lifecycle and this gap chain rewired large parts of it.

- **CR-01 — still present, unchanged.** `workerPool.ts`'s `markPoolFailed()`
  (line 681) still does not reset the `spawned` latch (`spawned = false` only
  appears at `terminate()`, line 1388) — `warm()` is still a permanent no-op once
  a Stockfish pool has failed irrecoverably. Not touched by 213-08..12 (Stockfish
  pool spawn/fail lifecycle is unrelated to the CacheStorage migration).
- **CR-02 — re-classified, not fixed.** The prior verification flagged
  `useBotGame.ts`'s bring-up-effect cleanup unconditionally terminating the pool
  and queue on every `BotsGame` unmount as contradicting D-07. 213-12's own
  G-213-37 triage (`213-UAT.md`) independently reached the same code and
  concluded this is **deliberate FLAWCHESS-92 mobile-OOM policy**, not a bug — the
  behavior is unchanged, but D-20's entire premise is reconciling that
  intentional teardown with zero refetches via CacheStorage, which this
  verification confirms works. The underlying termination code itself is
  unmodified.
- **WR-01 — still present, unchanged.** `supportsWasmSimd()` is still called only
  in `maiaWorkerHost.ts`; `workerPool.ts` and `useStockfishEngine.ts` still do not
  probe SIMD before spawning Stockfish.
- **WR-02 — still present, unchanged.** `useStockfishEngine.ts:584` still calls
  `worker.terminate()` unconditionally on unmount/toggle.

**Judgment (unchanged from the prior verification):** none of these four is a
stated must-have of any 213-08..12 plan, none reopens "the bot never silently
burns its clock" (the phase's core claim), and none was touched by this gap
chain's diffs. CR-01 remains the most actionable (Stockfish pool Retry can be
structurally unable to recover) and is still recommended as a follow-up seed
before the next milestone phase that exercises Stockfish failure/retry.

### Documentation staleness (process hygiene, non-blocking)

Three planning artifacts were not updated to reflect the 2026-08-29 Task 4
approval, even though the underlying code and git history confirm it happened:

- `.planning/phases/213-first-run-engine-cold-start-ux/213-UAT.md` — `status:
  diagnosed`, and the G-213-37 gap entry's `blocks:` field still reads "213-10
  Task 3 and 213-11 Task 3 checkpoints, both still unapproved" — stale as of
  commit `197b1c37e`.
- `.continue-here.md` — still opens "The phase is NOT done... Do not run
  `phase.complete`" — written before the 213-12 worktree merged and its
  checkpoint was approved.
- `.planning/WINDOWS.md` entry 8 — still `status: open` for the G-213-34
  unrun-verify item, superseded by the whole G-213-35..37 chain having since run
  and been approved.

None of these affect the code-level verification above — the approval itself is
independently confirmed via git commit `197b1c37e` (authored by the project
owner, `git log --all`), not merely asserted in a SUMMARY. Recommend updating
these three files (and closing WINDOWS.md entry 8) as a fast housekeeping pass,
separate from any code change, before archiving this phase.

### Human Verification Required

None outstanding. The one item carried from the prior VERIFICATION.md (the
G-213-34 cold-cache Slow-4G script) was run four further times across this gap
chain and its final, most comprehensive form — 213-12-PLAN.md's Task 4 (zero-refetch
on a second bot game, the /analysis -> /bots hop, per-resource counts, console
cleanliness, unchanged per-surface gate behavior) — was approved by the user on
2026-08-29, independently confirmed via git commit `197b1c37e`.

### Gaps Summary

No gaps. All 39 must-haves across the full 213-01..12 gap-closure sequence are
verified: the 19 previously-verified truths hold under the intervening refactor
(re-checked directly, not assumed), and the 20 new must-haves introduced by
213-08 through 213-12 are each backed by code that exists, is substantive, is
wired, and — where the truth was a state-transition/timing claim rather than
mere presence — is proven by a passing test with a recorded revert-and-restore
(never grep/symbol-presence alone) plus, for the parts only a live browser
Network tab can prove, an explicit human approval independently corroborated by
git history. Four pre-existing/adjacent-scope code-review findings (CR-01, CR-02
re-classified as intentional, WR-01, WR-02) are carried forward unchanged as a
recommended follow-up, not a blocker — none is a stated must-have of this gap
chain and none was touched by its diffs. Three planning-doc artifacts are stale
relative to the actual (git-confirmed) approval state; flagged as non-blocking
housekeeping.

---

_Verified: 2026-08-29T13:05:00Z_
_Verifier: Claude (gsd-verifier)_
