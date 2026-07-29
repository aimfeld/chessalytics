<p align="center">
  <img src="frontend/public/icons/logo-128.png" alt="FlawChess logo" width="128" />
</p>

<h1 align="center">FlawChess</h1>

<p align="center">
  <em>Engines are flawless, humans play FlawChess</em>
</p>

<p align="center">
  Live at <a href="https://flawchess.com"><strong>flawchess.com</strong></a>
</p>

<p align="center">
  <a href="https://github.com/flawchess/flawchess/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/flawchess/flawchess/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/flawchess/flawchess/actions/workflows/github-code-scanning/codeql"><img alt="CodeQL" src="https://github.com/flawchess/flawchess/actions/workflows/github-code-scanning/codeql/badge.svg" /></a>
  <a href="https://docs.renovatebot.com"><img alt="Renovate" src="https://img.shields.io/badge/renovate-enabled-brightgreen?logo=renovatebot" /></a>
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue" />
  <img alt="Python" src="https://img.shields.io/badge/python-3.13-blue" />
  <img alt="React" src="https://img.shields.io/badge/react-19-blue" />
  <img alt="FastAPI" src="https://img.shields.io/badge/fastapi-0.115-green" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/postgresql-18-blue" />
</p>

## What is FlawChess?

A free, open-source chess analysis platform. Import your games from chess.com and lichess to find leaks in your openings, endgames, and time management. Its signature FlawChess Engine ranks moves by the practical score you'll actually achieve against a real opponent at your level, not the objective-best move a conventional engine would play.

![FlawChess Engine](frontend/public/screenshots/flawchess-engine.png)

## Features

- **FlawChess Engine**: an in-browser engine that ranks your moves by expected practical score: the best move you'll actually pull off against an opponent who defends like a real player at your level. Fuses Stockfish's objective evaluation with Maia's human move-prediction (expectimax inside an MCTS budget allocator), and surfaces the traps and swindles a conventional engine ignores.
- **Human-like bots**: 24 named opponents driven by the FlawChess Engine, spanning four playing styles (Attacker, Trickster, Grinder, Wall) across six approximate rating rungs from 800 to 1800, each a fully pinned personality with its own opening book, resign and draw-offer policy, and bio. Clocked play, and every finished game lands in your library as an analyzable game like any other.
- **Game & tactic analysis**: Stockfish over your entire game history, with every mistake tagged by the tactic behind it (fork, pin, skewer, and 20+ motifs), blunder-rate trends over time, and gem-move detection for the only good move most players at your rating would miss.
- **Personalized puzzle training**: a spaced-repetition drill built from your own blunders rather than a generic puzzle set. Each session mixes real blunders with quiet positions where several moves are fine, so you commit to "one critical move or several fine moves?" before playing; missed positions return next session, then after three days, then ten, until solved three times and retired.
- **Endgame analytics**: WDL by endgame type (rook, minor piece, pawn, queen, mixed), conversion rates when up material and recovery rates when down, Endgame ELO timeline per platform/time control, and LLM-narrated personalized feedback explaining what your stats mean.
- **Opening explorer & insights**: step through any position and see your WDL per candidate move; an automatic 16-half-move scan surfaces opening strengths and weaknesses with deep-links into the explorer; works for scouting opponents too.
- **Time management stats**: clock advantage/deficit at endgame entry, performance under matching time pressure vs opponents, flag rates per time control.
- **Opening comparison & tracking**: bookmark openings and compare WDL trends over time, filter by time control to see what works where.
- **System opening filter**: filter by your pieces only to analyze system openings like the London across all opponent variations.
- **Cross-platform import**: combine chess.com and lichess games, filter by color, time control, opponent type, and recency.
- **Mobile-friendly PWA**: installable on Android and iOS, optimized for touch.
- **Open source**: self-hostable, AGPL-3.0 licensed.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | FastAPI, Python 3.13, SQLAlchemy 2.x, Alembic |
| Frontend | React 19, TypeScript, Vite 5, Tailwind CSS |
| Database | PostgreSQL 18 |
| Chess | python-chess (Zobrist hashing), chess.js, react-chessboard |
| Auth | FastAPI-Users (JWT + Google OAuth) |
| Monitoring | Sentry |
| Hosting | Docker Compose, Caddy (auto-TLS), Hetzner Cloud CPX42 (8 vCPU, 16 GB RAM, 160 GB NVMe) |

## Engine Binaries (GPLv3 License Note)

The files `frontend/public/engine/stockfish-18-lite-single.js` and `frontend/public/engine/stockfish-18-lite-single.wasm` are vendored from the `stockfish` npm package v18.0.8 ([nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js)) and are licensed under the [GNU General Public License v3 (GPL-3.0)](https://www.gnu.org/licenses/gpl-3.0.html). These binaries are loaded in a dedicated Web Worker process, which keeps the GPL non-infective for the FlawChess application code (Worker process boundary). All other FlawChess code is AGPL-3.0 licensed (see the LICENSE file).

- Package: `stockfish` v18.0.8
- Vendored files: `stockfish-18-lite-single.js`, `stockfish-18-lite-single.wasm`
- License: GPL-3.0
- Source: https://github.com/nmrugg/stockfish.js

## Sound Assets

The files under `frontend/public/sound/` (`Move.mp3`, `Capture.mp3`, `Check.mp3`, `Checkmate.mp3`, `Victory.mp3`, `Defeat.mp3`, `Draw.mp3`, `LowTime.mp3`, `GenericNotify.mp3`) are vendored from lichess's [lila](https://github.com/lichess-org/lila) `public/sound/sfx` directory, created by **Enigmahack**, and licensed under [GNU Affero General Public License v3 or later (AGPLv3+)](https://www.gnu.org/licenses/agpl-3.0.html) — fully compatible with FlawChess's own AGPL-3.0 license (see the LICENSE file). Note: lila's `public/sound/standard` set (a different, similarly-named directory) is explicitly a **non-free exception** per lila's own `COPYING.md` and is NOT used here — only the `sfx` directory's AGPLv3+ clips are vendored.

- Source: https://github.com/lichess-org/lila/tree/master/public/sound/sfx
- Author: Enigmahack
- License: AGPLv3+

## Getting Started

### Prerequisites

- Python 3.13 + [uv](https://docs.astral.sh/uv/)
- Node.js 20+
- Docker

### Setup

```bash
git clone https://github.com/flawchess/flawchess.git
cd flawchess
cp .env.example .env  # Edit with your settings
bin/run_local.sh
```

The script starts PostgreSQL (Docker), installs dependencies, runs migrations, seeds the openings reference table, installs the pinned Stockfish binary (via `bin/install_stockfish.sh` — same release and SHA-256 as the prod Docker image), and launches both backend and frontend. The API is at `http://localhost:8000` (docs at `/docs`), frontend at `http://localhost:5173`.

> **Note:** Google OAuth and Sentry are optional — the app works with email/password auth and without error monitoring. Leave those `.env` values empty to skip them.

> **Stockfish:** `bin/install_stockfish.sh` installs the pinned `sf_18` binary for your platform (Linux x86_64, macOS Apple Silicon, or macOS Intel) to `~/.local/stockfish/sf`, SHA-256 verified. The backend auto-discovers it (no `STOCKFISH_PATH` needed in dev); set `STOCKFISH_PATH` only to point at a binary in a non-standard location. Other platforms: install Stockfish manually and set `STOCKFISH_PATH`.

### Running Tests

```bash
uv run pytest          # Run all tests (serial)
uv run pytest -x       # Stop on first failure
uv run pytest -n auto  # Run in parallel across all CPU cores (much faster locally)
```

Each test run, and each `pytest-xdist` worker under `-n auto`, gets its own database cloned from a migrated template, so parallel and concurrent runs are fully isolated. `-n auto` is roughly 2x faster than serial on a multi-core machine. The template auto-refreshes whenever you add a migration, so there is no manual rebuild step. CI runs the suite serially for deterministic, bisectable logs; `-n auto` is a local convenience.

### Test Coverage

Backend uses `pytest-cov` (already in dev dependencies):

```bash
uv run pytest --cov=app --cov-report=term-missing   # Terminal report with missing lines
uv run pytest --cov=app --cov-report=html           # HTML report at htmlcov/index.html
```

Frontend uses Vitest's coverage (v8 provider):

```bash
cd frontend
npx vitest run --coverage                           # Terminal + HTML at coverage/index.html
```

### Linting & Type Checking

```bash
uv run ruff check .           # Backend lint
uv run ruff format .          # Backend format
uv run ty check app/ tests/   # Backend type check (zero errors required)
cd frontend && npm run lint   # Frontend lint
```

The CI pipeline runs these in order: ruff (lint) → [ty](https://github.com/astral-sh/ty) (type check) → pytest (tests). All three must pass.

## Remote Stockfish Worker

Want to help out? You can run a standalone Stockfish worker to support the FlawChess server and speed up game analysis. No Docker or full dev setup required. See [REMOTE_WORKER.md](REMOTE_WORKER.md) for setup instructions (Linux, macOS, and Windows).

## Backups & Recovery

The production VM is backed up by Hetzner's **automatic daily whole-server backup** feature with a 7-day rolling retention. Snapshots are managed by Hetzner and stored off the VM — a full disk loss can be recovered from the previous day's snapshot via the Hetzner Cloud Console.

- **Frequency:** daily, managed by Hetzner
- **Retention:** 7 days (rolling)
- **Scope:** full server image (PostgreSQL data volume included)
- **RPO:** up to 24 hours
- **PITR:** not enabled (point-in-time recovery would require WAL archiving in addition to the daily snapshot)

For deeper data-corruption scenarios that slip past 7 days (e.g. a silent bug that corrupts rows across weeks), a logical `pg_dump` retained separately would be a useful second layer but is not currently configured.

## Changelog & Releases

Release notes are published per milestone on the [GitHub Releases](https://github.com/flawchess/flawchess/releases) page. The full history across all milestones lives in [CHANGELOG.md](CHANGELOG.md), which follows a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) -inspired format.

## Contributing

Contributions are welcome. Please open an issue to discuss a feature or bug before submitting a pull request — this keeps effort aligned and avoids duplicate work.

Code style:
- Python: [Ruff](https://docs.astral.sh/ruff/) for linting and formatting, [ty](https://github.com/astral-sh/ty) for static type checking — `uv run ty check app/ tests/` must pass with zero errors
- TypeScript: ESLint (`npm run lint` in the `frontend/` directory)

## License

AGPL-3.0 — see [LICENSE](LICENSE). If you run a modified version of FlawChess as a network
service, the AGPL requires you to make your modified source available to its users (see
LICENSE §13).

## Links

- Live app: https://flawchess.com
- Contact: support@flawchess.com
