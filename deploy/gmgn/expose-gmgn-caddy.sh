#!/usr/bin/env bash
# Publish the VPS GMGN dashboard at https://spaceflag.site/gmgn/ behind the Binance dashboard login.
#
# One account for both dashboards: before proxying /gmgn/* to the GMGN dashboard (127.0.0.1:8765),
# Caddy forward-auths the request against the Binance dashboard's authenticated GET /health
# (127.0.0.1:4173). A valid `dashboard_session` cookie (or the Binance basic-auth credentials)
# is let through; an unauthenticated browser is redirected to the Binance /login page.
# Writes under /gmgn/ must also come from Origin https://spaceflag.site or www (cross-site guard).
#
# The Binance routes keep working exactly as before: the site block's bare
# `reverse_proxy 127.0.0.1:4173` is wrapped into `handle { ... }` next to the /gmgn/ route.
# The edit sits between markers, is validated with `caddy validate`, and is rolled back on failure.
#
# Prerequisite: deploy/gmgn/deploy-gmgn-vps.sh has run (gmgn-dashboard.service listening on 127.0.0.1:8765).
# Usage: bash deploy/gmgn/expose-gmgn-caddy.sh
set -euo pipefail

HOST="root@173.199.122.23"
KEY="$HOME/.ssh/polymtrade_vultr_ed25519"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")

echo "==> 1/3 preflight on the VPS"
"${SSH[@]}" 'set -e
systemctl is-active --quiet gmgn-dashboard || { echo "ABORT: gmgn-dashboard is not running; run deploy/gmgn/deploy-gmgn-vps.sh first"; exit 1; }
code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/health)
[ "$code" = "401" ] || { echo "ABORT: Binance /health returned $code without login (expected 401: auth must be enabled)"; exit 1; }
echo "gmgn-dashboard active; Binance /health requires login (401) - OK"'

echo "==> 2/3 route /gmgn/ through the Binance login, validate, reload (rollback on failure)"
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
CF=/etc/caddy/Caddyfile
BAK="$CF.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$CF" "$BAK"
python3 - "$CF" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
start, end = "\t# >>> gmgn module >>>", "\t# <<< gmgn module <<<"
block = f"""{start}
\t# Managed by binance deploy/gmgn/expose-gmgn-caddy.sh: /gmgn/ shares the Binance dashboard login.
\tredir /gmgn /gmgn/ 308
\thandle_path /gmgn/* {{
\t\t@cross_site_write {{
\t\t\tmethod POST PUT PATCH DELETE
\t\t\tnot header_regexp Origin ^https://(www\\.)?spaceflag\\.site$
\t\t}}
\t\trespond @cross_site_write "forbidden" 403
\t\tforward_auth 127.0.0.1:4173 {{
\t\t\turi /health
\t\t\t@unauthorized status 401 403
\t\t\thandle_response @unauthorized {{
\t\t\t\tredir * /login 303
\t\t\t}}
\t\t}}
\t\treverse_proxy 127.0.0.1:8765
\t}}
\thandle {{
\t\treverse_proxy 127.0.0.1:4173
\t}}
{end}"""
if start in text:
    text = re.sub(re.escape(start) + r".*?" + re.escape(end), lambda _: block, text, flags=re.S)
else:
    site = re.search(r"^spaceflag\.site[^\n]*\{\n(.*?)^\}", text, re.S | re.M)
    if not site:
        sys.exit("spaceflag.site site block not found")
    body = site.group(1)
    line = "\treverse_proxy 127.0.0.1:4173\n"
    if body.count(line) != 1:
        sys.exit("expected exactly one bare 'reverse_proxy 127.0.0.1:4173' in the spaceflag.site block")
    new_body = body.replace(line, block + "\n", 1)
    text = text[:site.start(1)] + new_body + text[site.end(1):]
open(path, "w", encoding="utf-8").write(text)
PY
if caddy validate --config "$CF" --adapter caddyfile >/tmp/caddy_validate.log 2>&1; then
  systemctl reload caddy
  echo "caddy reloaded (backup: $BAK)"
else
  cp -p "$BAK" "$CF"
  echo "ABORT: caddy validate failed, Caddyfile restored from $BAK"; tail -5 /tmp/caddy_validate.log
  exit 1
fi
REMOTE

echo "==> 3/3 smoke test"
sleep 2
gmgn="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 https://spaceflag.site/gmgn/ || true)"
main="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 https://spaceflag.site/ || true)"
echo "https://spaceflag.site/gmgn/ without login -> $gmgn (expect 303 -> /login)"
echo "https://spaceflag.site/      without login -> $main (Binance dashboard, unchanged)"
echo "Log in at https://spaceflag.site/login with the Binance dashboard account, then open https://spaceflag.site/gmgn/"
