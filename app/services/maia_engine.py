"""maia_engine.py — process-wide Maia-3 ONNX inference lifecycle (Phase 174, GEMS-03).

Mirrors app/services/engine.py's module-level global-singleton start/stop shape
(start_engine/stop_engine), with ONE structural addition: a D-03a import guard.
Stockfish is a hard dependency, so engine.py never guards its import; onnxruntime
+ numpy live in the ISOLATED `maia-inference` uv group (GEMS-06), so lean/worker
images boot WITHOUT them. `start_maia()` therefore does a deferred `import
onnxruntime` inside a try/except ImportError that logs and returns a no-op —
the backend never crashes because Maia is absent (D-03a). The module itself
imports cleanly without onnxruntime/numpy (both imports are deferred), so it is
safe to import from app.main and the default no-group test suite.

The session is eager-loaded once at FastAPI lifespan startup (D-03) and reused
for every inference — a fixed-size singleton, never one session per request
(T-174-07). At load, the vendored model file's SHA-256 is cross-checked against
the value pinned in frontend/public/maia/README.md so a backend/client byte
desync (T-174-09) disables Maia (with a Sentry-captured error) rather than
serving inferences that would disagree with the live board (D-04). The single
vendored file is loaded by both the backend and the client, guaranteeing
byte-identical bytes.

score_move(fen, elo, played_uci) reuses the Plan-01 pure encoding
(maia_encoding.encode_board / elo_to_input / mask_and_softmax) and the
eager-loaded session, returning the policy probability of the played move — or
None when the session is unavailable (caller: "no Maia candidate").
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import TYPE_CHECKING

import sentry_sdk

from app.services.maia_encoding import (
    NUM_SQUARES,
    PLANES_PER_SQUARE,
    elo_to_input,
    encode_board,
    mask_and_softmax,
)

if TYPE_CHECKING:
    import onnxruntime

logger = logging.getLogger(__name__)

# Repo-root-relative path to the single vendored model (backend + client load the
# same bytes). app/services/maia_engine.py -> parent(services)/parent(app)/parent(root).
_REPO_ROOT: Path = Path(__file__).resolve().parent.parent.parent
_MODEL_PATH: Path = _REPO_ROOT / "frontend" / "public" / "maia" / "maia3_simplified.onnx"

# Pinned in frontend/public/maia/README.md (the client's integrity source). A
# mismatch means backend and client would run different model bytes, so parity
# (D-04) is void — we disable Maia rather than serve divergent inferences.
_MODEL_SHA256: str = "405bf76c15727dad8728b352c06a8f3c1b80fb2760e8d666b32485c63d75b856"

# Model output tensor + input feed names (confirmed contract, 151-MAIA-CONTRACT.md).
_LOGITS_OUTPUT: str = "logits_move"
_TOKENS_INPUT: str = "tokens"
_ELO_SELF_INPUT: str = "elo_self"
_ELO_OPPO_INPUT: str = "elo_oppo"

# Module-global singleton session (None until start_maia loads it; None again
# after stop_maia or when onnxruntime/the model is unavailable).
_session: onnxruntime.InferenceSession | None = None


def _model_bytes_ok() -> bool:
    """Cross-check the vendored model's SHA-256 against the pinned value. Missing
    file or digest mismatch -> log + Sentry-capture and return False so start_maia
    disables Maia gracefully (T-174-09)."""
    if not _MODEL_PATH.exists():
        logger.error("maia_engine: vendored model missing — Maia inference disabled")
        sentry_sdk.set_context("maia", {"model_path": str(_MODEL_PATH)})
        sentry_sdk.capture_message("maia_engine: vendored model file missing")
        return False
    digest = hashlib.sha256(_MODEL_PATH.read_bytes()).hexdigest()
    if digest != _MODEL_SHA256:
        # Variables via context (not the message) to preserve Sentry grouping.
        logger.error("maia_engine: model SHA-256 desync — Maia inference disabled")
        sentry_sdk.set_context("maia", {"expected_sha256": _MODEL_SHA256, "actual_sha256": digest})
        sentry_sdk.capture_message("maia_engine: vendored model SHA-256 desync")
        return False
    return True


async def start_maia() -> None:
    """Eager-load the one process-wide Maia ONNX session at lifespan startup.

    Idempotent: a second call is a no-op. D-03a: onnxruntime lives in the isolated
    maia-inference group and may be absent (lean/worker images) — catch ImportError,
    log, and return without raising so the backend still boots. Unexpected
    (non-ImportError) load failures are Sentry-captured and swallowed so Maia stays
    disabled rather than aborting startup.
    """
    global _session
    if _session is not None:
        return
    try:
        import onnxruntime  # deferred — group-isolated, may not be installed (D-03a)
    except ImportError:
        logger.info("maia_engine: onnxruntime not installed — Maia inference disabled")
        return
    if not _model_bytes_ok():
        return
    try:
        _session = onnxruntime.InferenceSession(
            str(_MODEL_PATH), providers=["CPUExecutionProvider"]
        )
    except Exception:
        # Bug guard: a corrupt model / onnxruntime init failure must not crash the
        # app — disable Maia and report. (D-03a philosophy extended to load errors.)
        logger.exception("maia_engine: ONNX session load failed — Maia inference disabled")
        sentry_sdk.capture_exception()
        _session = None
        return
    # Startup confirmation. Bug fix (phase 212 plan 08): this function previously
    # logged ONLY on its four failure paths and returned silently on success, so
    # the benchmark-lane runbook's "confirm the startup log reports Maia loaded"
    # check was impossible to perform — there was no such line. Absence of an
    # error line is not a positive signal, and it is a dangerous one to rely on
    # here: a Maia-absent backend produces PV normally but silently never stamps
    # best_moves_completed_at, and row counts alone cannot tell "Maia ran, zero
    # candidates" from "Maia absent" after the fact.
    logger.info("maia_engine: Maia ONNX session loaded — inference enabled (%s)", _MODEL_PATH)


def is_maia_available() -> bool:
    """True when the process-wide Maia session was successfully loaded at
    lifespan startup (start_maia). Cheap in-memory check — no I/O, no session.

    Used by eval_apply.py's completion-marker guardrail (Phase 176 BACK-01/D-01):
    a Maia-absent backend must never stamp best_moves_completed_at, or the
    affected games would be permanently excluded from the tier-4b backfill
    lottery with zero best-move rows. Formalizes what the test suite already
    does by reaching into _session directly.
    """
    return _session is not None


async def stop_maia() -> None:
    """Tear down the process-wide Maia session. Safe to call without a prior start
    (no-op). Idempotent."""
    global _session
    _session = None


def score_move(fen: str, elo: float, played_uci: str) -> float | None:
    """Return the Maia policy probability (0..1) of `played_uci` at `fen`, rated
    `elo`, using the Plan-01 encoding + the eager-loaded session.

    Returns None when the session is unavailable (caller: "no Maia candidate") or
    when `played_uci` is not among the position's legal moves. numpy is imported
    lazily (isolated group): a live session implies the group is synced, but the
    import is still guarded so a partial env degrades to None rather than raising.
    """
    if _session is None:
        return None
    try:
        import numpy as np  # deferred — isolated maia-inference group alongside onnxruntime
    except ImportError:
        return None

    tokens = np.array(encode_board(fen), dtype=np.float32).reshape(
        1, NUM_SQUARES, PLANES_PER_SQUARE
    )
    elo_in = np.array([elo_to_input(elo)], dtype=np.float32)
    feeds = {_TOKENS_INPUT: tokens, _ELO_SELF_INPUT: elo_in, _ELO_OPPO_INPUT: elo_in}
    outputs = _session.run([_LOGITS_OUTPUT], feeds)
    policy = np.asarray(outputs[0]).reshape(-1).astype(np.float32)
    probs = mask_and_softmax(policy.tolist(), fen)
    return probs.get(played_uci)
