# Production Runbook

Operational reference for the FlawChess production server. The root `CLAUDE.md` keeps only the guardrails; the values and commands live here.

> **Deploy only via `bin/deploy.sh`** (or the `/deploy` skill, which wraps the whole PR → CI → deploy → verify flow). Never deploy by direct SSH.

## Server

The production server is reachable via `ssh flawchess` (configured in the user's SSH config). Deploy user is `deploy`, app lives at `/opt/flawchess`.

```bash
# SSH into server
ssh flawchess

# Check services
ssh flawchess "cd /opt/flawchess && docker compose ps"

# View backend logs
ssh flawchess "cd /opt/flawchess && docker compose logs --tail=50 backend"

# Restart backend only
ssh flawchess "cd /opt/flawchess && docker compose restart backend"

# Full restart (data persists in named volumes)
ssh flawchess "cd /opt/flawchess && docker compose down && docker compose up -d"
```

- Domain: flawchess.com (Caddy handles auto-TLS)
- Stack: PostgreSQL 18 + FastAPI/Uvicorn + Caddy 2.11.4
- Hetzner Cloud CPX42, 8 vCPUs, 16 GB RAM + 4 GB swap (`/swapfile`), 160 GB NVMe

## Current prod config

Source of truth, not historical. The repeated 2026 OOM-kills traced to import memory pressure (not Stockfish); the incident-by-incident history lives in git (see `reports/import-stress-test/` and the `docker-compose.yml` db-service comments). The values that matter now:

- **Postgres tuning lives in `docker-compose.yml` db `command:`** — the single source of truth, not migrations, not `postgresql.auto.conf`: `shared_buffers=2GB`, `effective_cache_size=8GB`, `work_mem=16MB`, `maintenance_work_mem=512MB`, `max_connections=30`, `max_wal_size=8GB`, `wal_compression=on`. **Do not raise `shared_buffers` above 2GB** — it amplifies checkpoint flush size and revisits the OOM history.
- **`shm_size: "256m"`** on the db service (a Docker option, NOT a Postgres flag): Docker's 64 MB `/dev/shm` default exhausts under parallel-query DSM segments and surfaces as a misleading `asyncpg.DiskFullError`. A bare `docker compose restart db` does NOT apply a changed `shm_size` — recreate the container (`docker compose up -d db` or `bin/deploy.sh`).
- **SQLAlchemy pool** `10 + 10` overflow; backend/db containers have `mem_limit`/`memswap_limit` set (no swap → contained OOM-restart).
- **`STOCKFISH_POOL_SIZE=6`** in prod (stable; ~368 MB/worker → fits the 4g backend container). Raising to 8 is gated on a 24h soak of API latency + container RSS.

## Infrastructure notes

- Hetzner Cloud Firewall: inbound TCP 22/80/443 + ICMP from any.
- Alembic migrations run automatically on backend container startup via `deploy/entrypoint.sh`.
- `.env` on the server at `/opt/flawchess/.env` — never commit production secrets.
- Docker BuildKit cache capped at 3 GB by a daily cron (`/etc/cron.d/docker-builder-prune`, 3am UTC) — each deploy rebuilds images on the server, so the cache fills the disk without it. Inspect with `docker system df` (containerd image store, not `/var/lib/docker/buildkit`).
- VAPID key rotation (Web Push, only on suspected key compromise): follow `docs/push-vapid-rotation-runbook.md`.
- Remote Stockfish worker setup: see `REMOTE_WORKER.md`.
- `deploy/Caddyfile` carries an inline Cloudflare IP range list (`trusted_proxies` / `client_ip_headers`, SEED-161 group 1) so Caddy resolves the real visitor IP from `Cf-Connecting-Ip` instead of forwarding the Cloudflare anycast peer address. Refresh it by running `bin/check_cloudflare_ips.sh` and pasting any drift back between the `# BEGIN cloudflare-ranges` / `# END cloudflare-ranges` markers. A stale list does not error, it silently degrades client-IP attribution for requests arriving via a range missing from the list.
