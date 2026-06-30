#!/bin/bash
# lowpoly-trust-cert.sh — make the studio TLS cert trustable on YOUR client.
#
# Why: the 3D Lowpoly viewer iframe (and its screenshot WebSocket) loads from a
# separate https origin (e.g. https://<ip>:9565). It uses the studio's
# self-signed cert (forgeax-studio/.tls/cert.pem). Browsers refuse self-signed
# certs in sub-iframes (no "proceed" prompt), so the viewer's wss:// fails even
# when the panel looks "open". Importing this cert as a TRUSTED ROOT on the
# client makes every origin/port that uses it (18920 / 9565 / 9567 …) trusted —
# the interactive panel's WS connects and screenshots work.
#
# The headless renderer (scripts/headless-renderer.mjs, launched by run.sh)
# already bypasses this for the AGENT; this script is for YOUR own browser view.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT="$ROOT/.tls/cert.pem"
OUT="$ROOT/forgeax-studio-ca.crt"

if [ ! -f "$CERT" ]; then
  echo "ERROR: $CERT not found. Start the stack once (bash scripts/run.sh) to generate TLS, or create .tls/{cert,key}.pem." >&2
  exit 1
fi

cp "$CERT" "$OUT"
echo "==============================================================="
echo " ForgeaX Studio TLS cert exported for client trust import"
echo "==============================================================="
echo " file:        $OUT"
echo -n " sha256:      "; openssl x509 -in "$CERT" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//'
echo -n " covers:      "; openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tail -1 | sed 's/^ *//'
echo
echo " 1) Copy it to your CLIENT machine (the one running the browser):"
echo "      scp <user>@<server>:$OUT ."
echo
echo " 2) Import as a TRUSTED ROOT / Authority:"
echo "    • Chrome/Edge  → Settings ▸ Privacy & security ▸ Security ▸"
echo "                     Manage certificates ▸ Authorities ▸ Import ▸ pick the .crt"
echo "                     ▸ check 'Trust this certificate for identifying websites'"
echo "    • Firefox      → Settings ▸ Privacy & Security ▸ Certificates ▸"
echo "                     View Certificates ▸ Authorities ▸ Import ▸ trust for websites"
echo "    • macOS        → open the .crt → Keychain Access ▸ login ▸ double-click ▸"
echo "                     Trust ▸ 'When using this certificate: Always Trust'"
echo "    • Windows      → double-click .crt ▸ Install ▸ Local Machine ▸"
echo "                     'Trusted Root Certification Authorities'"
echo "    • Linux (CA)   → sudo cp $OUT /usr/local/share/ca-certificates/ && sudo update-ca-certificates"
echo
echo " 3) Fully restart the browser, then reload Studio. The :9565 viewer panel"
echo "    (and its screenshot WebSocket) will connect — no more capture timeouts"
echo "    from your own open panel."
echo "==============================================================="
