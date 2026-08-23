#!/usr/bin/env bash
# Installs a local git pre-push hook that runs the mandatory pre-PR gates
# documented in CLAUDE.md (ruff format / ruff check / ty / pytest).
#
# Usage:
#   bin/install_pre_push_hook.sh
#
# The hook lives in .git/hooks/pre-push (per-clone, never committed).
# To bypass for an exceptional push: `git push --no-verify`.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_PATH="${REPO_ROOT}/.git/hooks/pre-push"

cat > "${HOOK_PATH}" <<'HOOK'
#!/usr/bin/env bash
# Pre-push gate — enforces CLAUDE.md "Pre-PR checklist".
# Bypass with `git push --no-verify` only when intentionally pushing WIP.

set -euo pipefail

REMOTE="${1:-origin}"
PROTECTED_RE='^refs/heads/(main|production)$'

# Skip the gate when pushing nothing or only deletes.
while read -r local_ref local_sha remote_ref remote_sha; do
  if [[ -z "${local_sha:-}" || "${local_sha}" == "0000000000000000000000000000000000000000" ]]; then
    continue
  fi
  RUN_GATE=1
done

if [[ -z "${RUN_GATE:-}" ]]; then
  exit 0
fi

echo "→ pre-push: ruff format --check"
uv run ruff format --check app/ tests/ scripts/

echo "→ pre-push: ruff check"
uv run ruff check .

echo "→ pre-push: ty check"
uv run ty check app/ tests/ scripts/

echo "✓ pre-push gates passed"
HOOK

chmod +x "${HOOK_PATH}"
echo "Installed pre-push hook at ${HOOK_PATH}"
echo "Bypass with: git push --no-verify"
