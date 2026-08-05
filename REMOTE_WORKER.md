# Remote Stockfish Worker

Want to help out? You can run a small program on your computer that helps the FlawChess server analyze games faster. It runs Stockfish (the chess engine) in the background and quietly does analysis work whenever the server needs it.

You don't need to be a programmer to set this up, and you don't need a database or the full FlawChess developer setup. The main path below uses just the files, Stockfish, and one helper tool called `uv`. Prefer Docker? There's a container-based alternative at the end (["Advanced: Run in Docker"](#advanced-run-in-docker)).

## What you'll need first

- Ask the server owner for your `EVAL_OPERATOR_TOKEN`. This is a secret code that lets your computer connect. You'll paste it in later.

## Setup (Linux and macOS)

1. **Download the files.** Go to the [FlawChess repository](https://github.com/flawchess/flawchess) on GitHub, click the green **Code** button, and choose **Download ZIP**. Unzip it somewhere easy to find, like your Desktop. (No GitHub account needed.)

   *If you're comfortable with git, you can clone the repo instead:*
   ```
   git clone https://github.com/flawchess/flawchess.git
   ```

2. **Open a terminal** and go into the folder you just unzipped. For example:
   ```
   cd ~/Desktop/flawchess
   ```

3. **Install Stockfish.** Run this once:
   ```
   bin/install_stockfish.sh
   ```

4. **Install `uv`** (a tool that runs the worker). Follow the one-line install instructions at [the uv website](https://docs.astral.sh/uv/).

5. **Add your token.** In the flawchess folder, make a copy of the file `.env.example` and name the copy `.env`. Open `.env` in any text editor, find the line that starts with `EVAL_OPERATOR_TOKEN=`, and paste your token right after the `=`, like this:
   ```
   EVAL_OPERATOR_TOKEN=your-token-here
   ```

6. **Start the worker.** Back in the terminal, run:
   ```
   uv run python scripts/remote_eval_worker.py --workers 4
   ```
   `--workers 4` means it uses 4 CPU cores. 4 is a good default. If your computer is powerful and you want it to do more, don't set `--workers` above your machine's physical core count — each worker runs its own copy of Stockfish on one thread, and a position that runs out of time gets thrown away rather than just taking longer, so more workers than cores can make even a fast machine quietly submit gaps in its analysis.

7. **Leave it running** as long as you like. If it crashes or freezes up, it restarts itself automatically, no need to babysit it. To stop it, press `Ctrl-C` in the terminal — that always stops it cleanly and it will not restart on its own.

## Setup (Windows)

The worker runs on Windows too. No extra tools like WSL or Docker needed. The steps are the same as above, with two differences:

- **Instead of step 3** (`bin/install_stockfish.sh`), download the [Windows version of Stockfish](https://stockfishchess.org/download/) and unzip it somewhere on your computer.

- **After step 5**, also open your `.env` file and find the line starting with `STOCKFISH_PATH`. Remove the `#` at the start of the line (if there is one) and set it to where you put Stockfish. Use forward slashes `/` and leave off the `.exe` at the end:
   ```
   STOCKFISH_PATH="C:/path/to/stockfish-windows-x86-64-avx2"
   ```

Then start the worker exactly like step 6 above:
```
uv run python scripts/remote_eval_worker.py --workers 4
```

## Advanced: Run in Docker

If you already use Docker, you can run the worker in a container instead of installing `uv` and Stockfish yourself. This needs **Docker** and **Docker Compose** installed, plus the repository files (see step 1 above). It is an alternative to the steps above, not an addition: pick one.

1. **Add your token.** In the flawchess folder, create a file named `.env` (same as step 5 above) and add your token. You can also set how many CPU cores to use here:
   ```
   EVAL_OPERATOR_TOKEN=your-token-here
   REMOTE_WORKER_COUNT=4
   ```
   `REMOTE_WORKER_COUNT` is optional and defaults to `4` if you leave it out.

2. **Start the worker:**
   ```
   docker compose -f docker-compose.worker.yml up -d --build
   ```
   The first build downloads dependencies and Stockfish. On Apple Silicon Macs it compiles Stockfish from source, which takes a few minutes the first time; later builds are cached. On regular (Intel/AMD) machines it uses a prebuilt Stockfish and is fast.

3. **Watch it work:**
   ```
   docker compose -f docker-compose.worker.yml logs -f
   ```
   Press `Ctrl-C` to stop watching (the worker keeps running in the background).

4. **Stop the worker:**
   ```
   docker compose -f docker-compose.worker.yml down
   ```

The container restarts automatically if it crashes, freezes up, or your computer reboots, so it keeps helping until you run the stop command above. Running the stop command is always clean and will not trigger a restart.

## Updating the worker

Every so often the worker gets improvements and fixes. Updating is worth doing occasionally, and it takes two steps: get the latest files, then restart.

**Step 1 — Get the latest files.**

- *If you downloaded the ZIP:* download a fresh ZIP the same way as [step 1](#setup-linux-and-macos) and unzip it over your existing folder (or into a new folder). Your `.env` file is not in the download, so keep your old one or copy it across, your token does not change.
- *If you used git:* open a terminal in the flawchess folder and run:
  ```
  git pull
  ```
  Your `.env` file is not tracked by git, so your token stays untouched.

**Step 2 — Restart the worker.**

- *If you run it directly (Linux/macOS/Windows):* press `Ctrl-C` to stop it, then start it again with the same command as before:
  ```
  uv run python scripts/remote_eval_worker.py --workers 4
  ```
  `uv` automatically installs any new dependencies on start, so there is nothing else to do.

- *If you run it in Docker:* rebuild and restart in one command:
  ```
  docker compose -f docker-compose.worker.yml up -d --build
  ```
  The `--build` picks up the new code and any new dependencies. You do not need to stop it first.
