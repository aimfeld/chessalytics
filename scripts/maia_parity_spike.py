#!/usr/bin/env python3
"""maia_parity_spike.py — the Phase 174 D-02 parity gate (GEMS-04).

Proves the Python Maia-3 port (app/services/maia_encoding.py + onnxruntime CPU)
agrees with the client (onnxruntime-web WASM + frontend/src/lib/maiaEncoding.ts) on
every fixture ply, per D-01:

  (1) TIER-STABILITY (the load-bearing check): tier(python_maia_prob) ==
      expected_tier for every entry, using the SAME edges as gemMove.ts
      (gem <= 0.20, great (0.20, 0.50], else neither). Tier agreement is what
      actually protects stored gem/great classification from diverging from the
      live board.
  (2) EPSILON: abs(python_maia_prob - expected_maia_prob) <= PARITY_EPSILON.

The expected values in tests/fixtures/maia_parity/corpus.json come from an
INDEPENDENT client-equivalent path (see the corpus provenance block), so this is a
genuine cross-check, not a self-comparison.

Exit code: 0 iff every entry passes BOTH checks; non-zero otherwise (printing which
plies failed which check). This script is COMMITTED (not throwaway) as a standing
regression guard against future onnxruntime/model bumps — per Pitfall 2, any bump
of the pinned onnxruntime version must re-run this gate before merging. History:
>=1.22 segfaulted the vendored model in July 2026 at the 1.20.1 pin; Phase 218
re-measured 1.29.0 clean in September 2026 and raised the pin (see PARITY_EPSILON
block below for the dated series).

D-02 fail path: if this gate CANNOT pass legitimately, the phase PAUSES for re-scope.
Do NOT loosen PARITY_EPSILON to force a pass, do NOT switch to Maia-on-workers without
an explicit human decision.

Usage:
  uv sync --group maia-inference && uv run python scripts/maia_parity_spike.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np

# Make the repo root importable when run as `python scripts/maia_parity_spike.py`.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from app.services.maia_encoding import (  # noqa: E402
    NUM_SQUARES,
    PLANES_PER_SQUARE,
    encode_board,
    elo_to_input,
    mask_and_softmax,
)

# ─── Parity tolerance (D-01) ───────────────────────────────────────────────────

# Empirically derived from the measured max per-ply drift across the fixture corpus
# between the Python port (onnxruntime CPU) and the client-equivalent reference
# (onnxruntime-web WASM + the TS encoding).
#
#   Measured max per-ply drift (2026-07-16, 11-entry corpus): 0.003844
#     (on Rxd1 @2600 — the busiest middlegame position; simpler positions drift
#      ~0.0000-0.0003. The drift is genuine CPU-vs-WASM float accumulation, never a
#      tier flip: every ply lands in the same gem/great/neither tier on both paths.)
#   PARITY_EPSILON = 0.010 gives ~2.6x headroom over the measured max drift while
#   staying well below the tightest tier-edge margin in the corpus (0.033, Nf3
#   @1500) — so a real tier flip (which needs a >=0.033 shift at the closest entry)
#   can never hide inside the epsilon band. This TIGHTENS the ~0.02 research
#   placeholder (CONTEXT.md D-01) to the actual CPU-vs-WASM float drift this model
#   exhibits, with room for benign cross-environment re-capture noise.
#
#   Re-measured (2026-09-05, onnxruntime 1.29.0, same 11-entry corpus, isolated
#   `uv run --no-project` environment — see Phase 218): max per-ply drift 0.004237
#   on Qxd5 @1000 (vs 0.003844 above) — PASS against the 1.20.1 baseline, no
#   segfault observed, every ply still tier-matches. Evidence:
#     .planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/
#       218-evidence-onnxruntime-1.29.0-python.txt (candidate)
#       218-evidence-onnxruntime-1.20.1-control.txt (same-environment control)
#   The Node side (onnxruntime-node 1.29.0, verify_value_head.mjs, native
#   backend) also PASSED with no crash — see
#   218-evidence-onnxruntime-node-1.29.0.txt in the same directory.
PARITY_EPSILON: float = 0.010

# The gem/great tier edges (frontend/src/lib/gemMove.ts GEM_MAIA_MAX_PROB=0.20 +
# the Great ceiling in CONTEXT.md). Kept as named constants (no magic numbers).
GEM_MAX_PROB: float = 0.20
GREAT_MAX_PROB: float = 0.50

# Vendored model — the backend loads the SAME bytes the client uses (T-174-02).
_MODEL_PATH = _REPO_ROOT / "frontend" / "public" / "maia" / "maia3_simplified.onnx"
_MODEL_SHA256 = "405bf76c15727dad8728b352c06a8f3c1b80fb2760e8d666b32485c63d75b856"

_CORPUS_PATH = _REPO_ROOT / "tests" / "fixtures" / "maia_parity" / "corpus.json"


def classify_tier(maia_prob: float) -> str:
    """Map a policy probability to its gem/great/neither tier (gemMove.ts edges)."""
    if maia_prob <= GEM_MAX_PROB:
        return "gem"
    if maia_prob <= GREAT_MAX_PROB:
        return "great"
    return "neither"


def _verify_model_bytes() -> None:
    if not _MODEL_PATH.exists():
        raise SystemExit(f"maia_parity_spike: model not found at {_MODEL_PATH}")
    digest = hashlib.sha256(_MODEL_PATH.read_bytes()).hexdigest()
    if digest != _MODEL_SHA256:
        raise SystemExit(
            "maia_parity_spike: vendored model SHA-256 mismatch — backend/client byte "
            f"desync (expected {_MODEL_SHA256}, got {digest}). Parity is meaningless "
            "against different bytes."
        )


def run_python_maia_prob(session, entry: dict) -> float:
    """Run the Python port + ONNX session for one fixture entry, returning the policy
    probability of played_uci."""
    fen = entry["fen"]
    elo = float(entry["pinned_elo"])
    tokens = np.array(encode_board(fen), dtype=np.float32).reshape(
        1, NUM_SQUARES, PLANES_PER_SQUARE
    )
    elo_in = np.array([elo_to_input(elo)], dtype=np.float32)
    feeds = {"tokens": tokens, "elo_self": elo_in, "elo_oppo": elo_in}
    outputs = session.run(["logits_move"], feeds)
    policy = np.asarray(outputs[0]).reshape(-1).astype(np.float32)
    # mask_and_softmax is numpy-free — hand it a plain list of floats.
    probs = mask_and_softmax(policy.tolist(), fen)
    played_uci = entry["played_uci"]
    if played_uci not in probs:
        raise SystemExit(
            f"maia_parity_spike: played_uci {played_uci} not legal/found for fen {fen}"
        )
    return probs[played_uci]


def main() -> int:
    try:
        import onnxruntime  # deferred — lives in the isolated maia-inference group
    except ImportError:
        print(
            "maia_parity_spike: onnxruntime not installed. Sync the group first:\n"
            "  uv sync --group maia-inference && uv run python scripts/maia_parity_spike.py",
            file=sys.stderr,
        )
        return 2

    _verify_model_bytes()
    corpus = json.loads(_CORPUS_PATH.read_text())
    entries = corpus["entries"]

    session = onnxruntime.InferenceSession(str(_MODEL_PATH), providers=["CPUExecutionProvider"])

    failures: list[str] = []
    max_drift = 0.0
    print(f"maia_parity_spike: {len(entries)} fixture plies, PARITY_EPSILON={PARITY_EPSILON}\n")
    print(f"{'played':>7} {'elo':>5} {'expected':>9} {'python':>9} {'drift':>8}  tier(exp/py)")
    for entry in entries:
        py_prob = run_python_maia_prob(session, entry)
        exp_prob = float(entry["expected_maia_prob"])
        drift = abs(py_prob - exp_prob)
        max_drift = max(max_drift, drift)
        exp_tier = entry["expected_tier"]
        py_tier = classify_tier(py_prob)

        tier_ok = py_tier == exp_tier
        eps_ok = drift <= PARITY_EPSILON
        flag = "OK " if (tier_ok and eps_ok) else "FAIL"
        print(
            f"{entry['played_san']:>7} {entry['pinned_elo']:>5} {exp_prob:>9.6f} "
            f"{py_prob:>9.6f} {drift:>8.6f}  {exp_tier}/{py_tier} {flag}"
        )
        if not tier_ok:
            failures.append(
                f"TIER: {entry['played_san']} @{entry['pinned_elo']} "
                f"expected {exp_tier}, python got {py_tier} (prob={py_prob:.6f})"
            )
        if not eps_ok:
            failures.append(
                f"EPSILON: {entry['played_san']} @{entry['pinned_elo']} "
                f"drift {drift:.6f} > PARITY_EPSILON {PARITY_EPSILON}"
            )

    print(f"\nmeasured max per-ply drift: {max_drift:.6f}")
    print(f"PARITY_EPSILON:             {PARITY_EPSILON:.6f}")

    if failures:
        print(f"\nPARITY GATE FAILED ({len(failures)} check(s)):", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(
            "\nD-02: the phase PAUSES for re-scope. Do NOT loosen PARITY_EPSILON to "
            "force a pass; do NOT switch to Maia-on-workers without a human decision.",
            file=sys.stderr,
        )
        return 1

    print("\nPARITY GATE PASSED — every ply tier-matches and is within PARITY_EPSILON.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
