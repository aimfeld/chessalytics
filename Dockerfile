FROM python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6 AS builder
COPY --from=ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 /uv /uvx /bin/

WORKDIR /app

# Install dependencies first (cacheable layer — copied before source code)
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-dev --no-install-project

# Copy source and install project.
# The opt-in dependency groups below pull the backend-only Maia-3 ONNX inference
# stack (onnxruntime + numpy) and the backend-only Web Push send stack (webpush +
# cryptography). Dockerfile.worker deliberately OMITS both so the remote-worker
# image stays lean (GEMS-06, PUSH-05). The uv cache mount above keeps the wheels
# cached across builds even when this source layer is invalidated.
COPY . /app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --group maia-inference --group push

FROM python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6 AS runtime
WORKDIR /app
COPY --from=builder /app /app
ENV PATH="/app/.venv/bin:$PATH"
# Strip pip from the runtime image. The app runs from the uv-managed venv and
# never invokes pip, but the base image's pip vendors msgpack/setuptools copies
# that Trivy flags as HIGH (GHSA-6v7p-g79w-8964, CVE-2025-47273) and that no
# base-image update fixes on our schedule. Removing pip removes the finding.
RUN rm -rf /usr/local/lib/python3.14/site-packages/pip* /usr/local/bin/pip*

# Stockfish (pinned official release sf_18) — supply-chain integrity via SHA-256
# See .planning/milestones/v1.15-phases/78-stockfish-eval-cutover-for-endgame-classification/78-CONTEXT.md D-06
# AVX2 binary verified on prod Hetzner VM (Phase 78 Plan 01 Task 1: ssh flawchess 'grep -c avx2 /proc/cpuinfo' → 4)
ARG STOCKFISH_TAG=sf_18
ARG STOCKFISH_ASSET=stockfish-ubuntu-x86-64-avx2
# SHA-256 from https://api.github.com/repos/official-stockfish/Stockfish/releases (sf_18 asset digest).
# Build fails if hash mismatches (T-78-01 mitigation).
ARG STOCKFISH_SHA256=536c0c2c0cf06450df0bfb5e876ef0d3119950703a8f143627f990c7b5417964
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && wget -q "https://github.com/official-stockfish/Stockfish/releases/download/${STOCKFISH_TAG}/${STOCKFISH_ASSET}.tar" -O /tmp/stockfish.tar \
    && echo "${STOCKFISH_SHA256}  /tmp/stockfish.tar" | sha256sum -c - \
    && tar -xf /tmp/stockfish.tar -C /tmp \
    && mv "/tmp/stockfish/${STOCKFISH_ASSET}" /usr/local/bin/stockfish \
    && chmod +x /usr/local/bin/stockfish \
    && rm -rf /tmp/stockfish.tar /tmp/stockfish \
    && apt-get purge -y wget \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
ENV STOCKFISH_PATH=/usr/local/bin/stockfish

COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
