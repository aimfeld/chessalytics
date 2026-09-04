#!/usr/bin/env bash
# Diffs the inline Cloudflare CIDR range list embedded in deploy/Caddyfile's
# global trust block (SEED-161 group 1 / F-01, see the block's own comment)
# against the live https://www.cloudflare.com/ips-v4 and /ips-v6 endpoints.
#
# Cloudflare periodically retires and publishes new anycast ranges. A stale
# list here silently degrades client-IP attribution: Caddy still resolves
# most visitors correctly, but any request that arrives via a range missing
# from our list falls back to the Cloudflare peer address instead of the
# real visitor, and nothing errors - the guest-creation limiter and
# worker_heartbeats.last_ip just quietly start misattributing again.
#
# Deliberately NOT wired into CI (D-11): a network call to cloudflare.com on
# every CI run is not worth it for a list that changes on the order of
# months, not days. Run this on demand (e.g. periodically, or when
# investigating a suspected client-IP regression) and paste any drift back
# between the `# BEGIN cloudflare-ranges` / `# END cloudflare-ranges`
# markers in deploy/Caddyfile.
#
# Usage: bin/check_cloudflare_ips.sh [path/to/Caddyfile]
#   Exit 0: the committed ranges match the live Cloudflare lists.
#   Exit 1: drift detected, markers missing, or a fetch failed.

set -euo pipefail

CADDYFILE="${1:-deploy/Caddyfile}"

if [ ! -f "$CADDYFILE" ]; then
  echo "Error: Caddyfile not found at '$CADDYFILE'." >&2
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -q "$1" -O "$2"; }
else
  echo "Error: need 'curl' or 'wget' in PATH." >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Fetching current Cloudflare IP ranges..."
download "https://www.cloudflare.com/ips-v4" "$tmp/ips-v4.txt"
download "https://www.cloudflare.com/ips-v6" "$tmp/ips-v6.txt"

# cloudflare.com/ips-v4 has no trailing newline, so a bare `cat f1 f2` glues
# its last range onto ips-v6's first range; force a separator between files.
{ cat "$tmp/ips-v4.txt"; echo; cat "$tmp/ips-v6.txt"; } | grep -v '^[[:space:]]*$' | sort -u > "$tmp/upstream.txt"

if ! grep -q '# BEGIN cloudflare-ranges' "$CADDYFILE" || ! grep -q '# END cloudflare-ranges' "$CADDYFILE"; then
  echo "Error: '# BEGIN cloudflare-ranges' / '# END cloudflare-ranges' markers not found in '$CADDYFILE'. Failing loudly rather than silently skipping the check, since a broken parse here is exactly the failure mode that would let the range list drift unnoticed." >&2
  exit 1
fi

# Extract CIDR-shaped tokens only (contain a '/'), so the surrounding
# `trusted_proxies static \` keyword tokens and line-continuation backslashes
# on the marker-adjacent lines are ignored automatically rather than assumed
# to be ranges.
sed -n '/# BEGIN cloudflare-ranges/,/# END cloudflare-ranges/p' "$CADDYFILE" \
  | grep -oE '[0-9a-fA-F:.]+/[0-9]+' \
  | sort -u > "$tmp/committed.txt"

if [ ! -s "$tmp/committed.txt" ]; then
  echo "Error: no CIDR ranges found between the markers in '$CADDYFILE'." >&2
  exit 1
fi

only_in_file=$(comm -23 "$tmp/committed.txt" "$tmp/upstream.txt")
only_upstream=$(comm -13 "$tmp/committed.txt" "$tmp/upstream.txt")

if [ -z "$only_in_file" ] && [ -z "$only_upstream" ]; then
  echo "Cloudflare ranges match: $CADDYFILE is up to date with cloudflare.com/ips-v4 + ips-v6."
  exit 0
fi

echo "Drift detected between '$CADDYFILE' and the live Cloudflare IP lists:" >&2
if [ -n "$only_in_file" ]; then
  echo "  Present only in $CADDYFILE (stale, no longer published by Cloudflare):" >&2
  echo "$only_in_file" | sed 's/^/    /' >&2
fi
if [ -n "$only_upstream" ]; then
  echo "  Present only upstream (missing from $CADDYFILE):" >&2
  echo "$only_upstream" | sed 's/^/    /' >&2
fi
exit 1
