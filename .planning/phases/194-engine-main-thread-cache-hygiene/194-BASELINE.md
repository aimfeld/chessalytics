# Phase 194 Plan 01 — Main-Thread Cost Baseline (JANK-04, JANK-05)

Captured by `scripts/engine-mainthread-cost.mjs` per 194-VALIDATION.md's Wave 0
requirements. All four runs below use the IDENTICAL flag set, node budget pair, built-in
4-position set (italian / middlegame / sharp / endgame), and machine — only the code under
measurement changes between the pre-change and post-change sections.

## Pre-change baseline (JANK-04)

**Commands (run in this exact order, from repo root):**

```
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs --nodes 50 --candidate fast
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-mainthread-cost.mjs --nodes 400 --candidate fast
```

- **Host CPU:** AMD Ryzen 7 7840HS w/ Radeon 780M Graphics
- **`node --version`:** v24.14.0
- **`git rev-parse HEAD` (unmodified tree):** `c06c624947295b6e85322367be18b157f1fc408e`
  (`git show --stat` for this SHA touches zero files under `frontend/src/` — confirmed via
  `git show --stat <sha> | grep -c "frontend/src/"` returning `0`.)
- Both runs exited **0** (no provider-cache-miss abort; every `ranked output bit-identical`
  line reported `YES`).

### `--nodes 50` (verbatim stdout)

```

Main-thread cost — nodes=50 plies=8 concurrency=4 elo=1500 repeats=3  positions=4  candidate=fast

── italian
   real search wall                    15.7s  (nodes 50)
   MAIN-THREAD, current code           289 ms  = 1.84% of wall
   MAIN-THREAD, Phase 2 prototype      49 ms  = 0.31% of wall
   saved                               240 ms  (83% of main-thread cost)
   ranked output bit-identical         YES

── middlegame
   real search wall                    23.5s  (nodes 50)
   MAIN-THREAD, current code           276 ms  = 1.17% of wall
   MAIN-THREAD, Phase 2 prototype      57 ms  = 0.24% of wall
   saved                               219 ms  (79% of main-thread cost)
   ranked output bit-identical         YES

── sharp
   real search wall                    22.6s  (nodes 50)
   MAIN-THREAD, current code           288 ms  = 1.27% of wall
   MAIN-THREAD, Phase 2 prototype      89 ms  = 0.39% of wall
   saved                               200 ms  (69% of main-thread cost)
   ranked output bit-identical         YES

── endgame
   real search wall                    16.7s  (nodes 50)
   MAIN-THREAD, current code           151 ms  = 0.90% of wall
   MAIN-THREAD, Phase 2 prototype      20 ms  = 0.12% of wall
   saved                               131 ms  (87% of main-thread cost)
   ranked output bit-identical         YES

TOTAL main-thread across 4 positions:
  current code        1004 ms
  Phase 2 prototype   215 ms   (4.7x faster, saves 790 ms)

Reminder: this is UI-thread blocking time, NOT search latency. It lands in 5-8 ms chunks that block paint and input.
```

### `--nodes 400` (verbatim stdout)

```

Main-thread cost — nodes=400 plies=8 concurrency=4 elo=1500 repeats=3  positions=4  candidate=fast

── italian
   real search wall                    152.8s  (nodes 400)
   MAIN-THREAD, current code           2397 ms  = 1.57% of wall
   MAIN-THREAD, Phase 2 prototype      449 ms  = 0.29% of wall
   saved                               1949 ms  (81% of main-thread cost)
   ranked output bit-identical         YES

── middlegame
   real search wall                    208.7s  (nodes 400)
   MAIN-THREAD, current code           2156 ms  = 1.03% of wall
   MAIN-THREAD, Phase 2 prototype      678 ms  = 0.32% of wall
   saved                               1477 ms  (69% of main-thread cost)
   ranked output bit-identical         YES

── sharp
   real search wall                    207.1s  (nodes 400)
   MAIN-THREAD, current code           2444 ms  = 1.18% of wall
   MAIN-THREAD, Phase 2 prototype      548 ms  = 0.26% of wall
   saved                               1897 ms  (78% of main-thread cost)
   ranked output bit-identical         YES

── endgame
   real search wall                    111.4s  (nodes 400)
   MAIN-THREAD, current code           1139 ms  = 1.02% of wall
   MAIN-THREAD, Phase 2 prototype      213 ms  = 0.19% of wall
   saved                               926 ms  (81% of main-thread cost)
   ranked output bit-identical         YES

TOTAL main-thread across 4 positions:
  current code        8137 ms
  Phase 2 prototype   1888 ms   (4.3x faster, saves 6249 ms)

Reminder: this is UI-thread blocking time, NOT search latency. It lands in 5-8 ms chunks that block paint and input.
EXIT_CODE=0
```

## Post-change measurement (JANK-04)

Same commands, same flags, same 4-position set, same machine (AMD Ryzen 7 7840HS,
`node --version` v24.14.0) as the pre-change section above. Run AFTER JANK-01 shipped
(`maskAndSoftmaxUci` landed in `maiaEncoding.ts`/`maiaQueue.ts`, commits `96cb61b5`/`2e26fc3f`)
but BEFORE JANK-05's deletion of `--candidate fast` — `fastPolicyConversion` was first repointed
(Task 3 Step 1) to call the real shipped `maskAndSoftmaxUci` instead of its own script-local
copy of the vocab-index math, so the "Phase 2 prototype" column below IS the shipped
conversion, not a diverged copy. The "current code" column still runs the OLD
`maskAndSoftmax` + `sanToUci` reference path (kept alive only for this one measurement pass,
deleted afterward in Step 3).

**`git rev-parse HEAD` at capture time:** `2e26fc3f` (JANK-01/JANK-02 commits landed; the
prototype-repoint edit in Task 3 Step 1 is uncommitted at capture time, applied only to run
this measurement — the final Task 3 commit lands the repoint + the JANK-05 deletion together).

### `--nodes 50` (verbatim stdout)

```

Main-thread cost — nodes=50 plies=8 concurrency=4 elo=1500 repeats=3  positions=4  candidate=fast

── italian
   real search wall                    17.6s  (nodes 50)
   MAIN-THREAD, current code           306 ms  = 1.73% of wall
   MAIN-THREAD, Phase 2 prototype      48 ms  = 0.27% of wall
   saved                               257 ms  (84% of main-thread cost)
   ranked output bit-identical         YES

── middlegame
   real search wall                    33.1s  (nodes 50)
   MAIN-THREAD, current code           275 ms  = 0.83% of wall
   MAIN-THREAD, Phase 2 prototype      118 ms  = 0.36% of wall
   saved                               157 ms  (57% of main-thread cost)
   ranked output bit-identical         YES

── sharp
   real search wall                    25.4s  (nodes 50)
   MAIN-THREAD, current code           176 ms  = 0.69% of wall
   MAIN-THREAD, Phase 2 prototype      34 ms  = 0.13% of wall
   saved                               142 ms  (81% of main-thread cost)
   ranked output bit-identical         YES

── endgame
   real search wall                    15.9s  (nodes 50)
   MAIN-THREAD, current code           131 ms  = 0.83% of wall
   MAIN-THREAD, Phase 2 prototype      39 ms  = 0.25% of wall
   saved                               92 ms  (70% of main-thread cost)
   ranked output bit-identical         YES

TOTAL main-thread across 4 positions:
  current code        888 ms
  Phase 2 prototype   240 ms   (3.7x faster, saves 649 ms)

Reminder: this is UI-thread blocking time, NOT search latency. It lands in 5-8 ms chunks that block paint and input.
EXIT_CODE=0
```

### `--nodes 400` (verbatim stdout)

```

Main-thread cost — nodes=400 plies=8 concurrency=4 elo=1500 repeats=3  positions=4  candidate=fast

── italian
   real search wall                    169.2s  (nodes 400)
   MAIN-THREAD, current code           2245 ms  = 1.33% of wall
   MAIN-THREAD, Phase 2 prototype      225 ms  = 0.13% of wall
   saved                               2020 ms  (90% of main-thread cost)
   ranked output bit-identical         YES

── middlegame
   real search wall                    198.2s  (nodes 400)
   MAIN-THREAD, current code           2386 ms  = 1.20% of wall
   MAIN-THREAD, Phase 2 prototype      595 ms  = 0.30% of wall
   saved                               1792 ms  (75% of main-thread cost)
   ranked output bit-identical         YES

── sharp
   real search wall                    190.1s  (nodes 400)
   MAIN-THREAD, current code           2174 ms  = 1.14% of wall
   MAIN-THREAD, Phase 2 prototype      462 ms  = 0.24% of wall
   saved                               1713 ms  (79% of main-thread cost)
   ranked output bit-identical         YES

── endgame
   real search wall                    93.1s  (nodes 400)
   MAIN-THREAD, current code           944 ms  = 1.01% of wall
   MAIN-THREAD, Phase 2 prototype      185 ms  = 0.20% of wall
   saved                               759 ms  (80% of main-thread cost)
   ranked output bit-identical         YES

TOTAL main-thread across 4 positions:
  current code        7750 ms
  Phase 2 prototype   1466 ms   (5.3x faster, saves 6284 ms)

Reminder: this is UI-thread blocking time, NOT search latency. It lands in 5-8 ms chunks that block paint and input.
EXIT_CODE=0
```

### Shipped-code-only confirmation run (`--nodes 50`, no extra flags, after JANK-05 deletion)

After Step 3 deleted `fastPolicyConversion`/`assertParity`/`--candidate` and renamed the
single remaining measured path to `shippedPolicyConversion` (calling `maskAndSoftmaxUci`
directly), this run confirms the reduced script still runs clean end-to-end:

```
Main-thread cost — nodes=50 plies=8 concurrency=4 elo=1500 repeats=3  positions=4

── italian
   real search wall                    12.3s  (nodes 50)
   MAIN-THREAD                         27 ms  = 0.22% of wall

── middlegame
   real search wall                    26.0s  (nodes 50)
   MAIN-THREAD                         92 ms  = 0.35% of wall

── sharp
   real search wall                    22.9s  (nodes 50)
   MAIN-THREAD                         32 ms  = 0.14% of wall

── endgame
   real search wall                    12.2s  (nodes 50)
   MAIN-THREAD                         17 ms  = 0.14% of wall

TOTAL main-thread across 4 positions: 168 ms

Reminder: this is UI-thread blocking time, NOT search latency. It lands in 5-8 ms chunks that block paint and input.
EXIT=0
```

This is the go-forward baseline for future phases: a single-path script (no `--candidate`
flag) measuring only the shipped `maskAndSoftmaxUci` conversion.

### Comparison table (old two-step path vs the shipped `maskAndSoftmaxUci`, TOTAL across 4 positions)

| Node budget | Old path (`maskAndSoftmax`+`sanToUci`) | Shipped (`maskAndSoftmaxUci`) | Speedup | Saved |
|---|---|---|---|---|
| `--nodes 50`  | 888 ms  | 240 ms  | 3.7x | 649 ms |
| `--nodes 400` | 7750 ms | 1466 ms | 5.3x | 6284 ms |

The post-change MAIN-THREAD blocking time (shipped column) is lower than the pre-change
figure at both node budgets: pre-change TOTAL current-code was 1004 ms (`--nodes 50`) / 8137 ms
(`--nodes 400`); post-change shipped TOTAL is 240 ms / 1466 ms — a ~4.2x and ~5.6x reduction
respectively (run-to-run wall-clock variance on this machine explains why the two "current
code" totals above, 888/7750, differ slightly from the pre-change 1004/8137 — both column
pairs within the same run are the load-bearing, same-run comparison).

## Bit-identity evidence (JANK-04)

Verbatim `ranked output bit-identical` lines from the post-change runs above — this is now
the AUTHORITATIVE bit-identity proof (unlike the pre-change section's prototype-vs-current
check, this run compares the OLD reference path against the ACTUAL SHIPPED `maskAndSoftmaxUci`
function, since Task 3 Step 1 repointed `fastPolicyConversion` to call it directly):

**`--nodes 50`** (4/4 positions):
```
── italian:      ranked output bit-identical         YES
── middlegame:   ranked output bit-identical         YES
── sharp:        ranked output bit-identical         YES
── endgame:      ranked output bit-identical         YES
```

**`--nodes 400`** (4/4 positions):
```
── italian:      ranked output bit-identical         YES
── middlegame:   ranked output bit-identical         YES
── sharp:        ranked output bit-identical         YES
── endgame:      ranked output bit-identical         YES
```

Both runs exited 0 (no provider-cache-miss abort, no identity mismatch). Every one of the 8
position×node-budget combinations reports the shipped `maskAndSoftmaxUci`'s ranked-line output
(root move + practicalScore per candidate) as bit-identical to the old `maskAndSoftmax` +
`sanToUci` two-step path. With this evidence captured, Task 3 Step 3 deletes
`fastPolicyConversion`/`assertParity`/`--candidate` and re-points the script's single
remaining measured path (renamed from `currentPolicyConversion`) to call `maskAndSoftmaxUci`
directly.
