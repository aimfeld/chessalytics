#!/usr/bin/env bash
#
# Capture the flawchess.com mail record inventory from a single nameserver.
#
# Used by docs/cloudflare-cdn-cutover-runbook.md sections 2 and 9. The point of the
# script is that the pre-flight and post-cutover captures are produced by identical
# code, so `diff`ing them reports only real changes. If you edit the query block
# here, mirror it into both runbook sections (or delete them in favour of this
# script) — a divergence turns the diff into noise and hides a genuine regression.
#
# The site records (apex A/AAAA, www, DS, NS) are deliberately NOT captured here.
# Those are supposed to change at cutover; the runbook keeps them in a separate
# rollback file.
#
# Usage:
#   bin/show_dns_records.sh dns1.swizzonic.ch preflight
#   bin/show_dns_records.sh julissa.ns.cloudflare.com postflight
#   diff cloudflare-cutover-mail-preflight-*.txt cloudflare-cutover-mail-postflight-*.txt
#
set -euo pipefail

if [ $# -ne 2 ]; then
    echo "usage: $0 <nameserver> <preflight|postflight>" >&2
    exit 64
fi

NS=$1
ROLE=$2

case "$ROLE" in
    preflight | postflight) ;;
    *)
        echo "$0: role must be 'preflight' or 'postflight', got '$ROLE'" >&2
        exit 64
        ;;
esac

OUT="cloudflare-cutover-mail-$ROLE-$(date +%Y%m%d).txt"

{
    echo "=== apex MX ==="
    dig @"$NS" +short MX flawchess.com
    echo "=== apex TXT (SPF) ==="
    dig @"$NS" +short TXT flawchess.com
    echo "=== mail client autoconfiguration CNAMEs ==="
    for n in autoconfig autodiscover mail webmail smtp imap pop; do
        printf '%s: ' "$n"
        dig @"$NS" +short CNAME $n.flawchess.com
    done
    echo "=== mail client autoconfiguration SRV ==="
    for s in _autodiscover._tcp _submission._tcp _submissions._tcp \
        _imaps._tcp _imap._tcp _pop3s._tcp; do
        printf '%s: ' "$s"
        dig @"$NS" +short SRV $s.flawchess.com
    done
    echo "=== send.flawchess.com MX (Resend bounce) ==="
    dig @"$NS" +short MX send.flawchess.com
    echo "=== send.flawchess.com TXT (Resend SPF) ==="
    dig @"$NS" +short TXT send.flawchess.com
    echo "=== resend._domainkey.flawchess.com TXT (Resend DKIM, apex-level) ==="
    dig @"$NS" +short TXT resend._domainkey.flawchess.com
    echo "=== _dmarc.flawchess.com TXT ==="
    dig @"$NS" +short TXT _dmarc.flawchess.com
} | tee "$OUT"
