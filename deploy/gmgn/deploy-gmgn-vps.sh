#!/usr/bin/env bash
# Deploy the GMGN monitor dashboard to the Vultr VPS under the unprivileged `gmgn` user.
#
# The GMGN module shares this Binance VPS but runs fully separated from the Binance bot.
# Code comes from the separate gmgn repository checkout (GMGN_ROOT, default ~/projects/gmgn).
#
# - Syncs the local gmgn working tree (not GitHub: the committed automation_gate.json has force_open=true).
# - Refuses to finish if the deployed gate is open.
# - Builds ~/.config/gmgn/config.json on the VPS from the VPS-side .env; the API key never leaves the VPS.
# - Runs the dashboard as gmgn-dashboard.service inside its own gmgn.slice, bound to 127.0.0.1:8765
#   (reach it via an SSH tunnel), fully separate from the Binance bot on the same host.
#
# Usage: bash deploy/gmgn/deploy-gmgn-vps.sh            (GMGN_ROOT=/path/to/gmgn to override)
set -euo pipefail

HOST="root@173.199.122.23"
KEY="$HOME/.ssh/polymtrade_vultr_ed25519"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
ROOT="${GMGN_ROOT:-$HOME/projects/gmgn}"
[ -f "$ROOT/gmgn_monitor/dashboard.py" ] || { echo "ABORT: GMGN_ROOT=$ROOT is not a gmgn checkout"; exit 1; }

echo "==> 1/5 sync working tree to /home/gmgn/app"
"${SSH[@]}" 'mkdir -p /home/gmgn/app'
rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" \
  --exclude '.git/' --exclude '.venv/' --exclude '__pycache__/' --exclude '*.pyc' \
  --exclude '.env*' --exclude '*.pem' --exclude '*.key' --exclude 'secrets.json' --exclude 'credentials.json' \
  --exclude '*.docx' --exclude '.DS_Store' --exclude '.pytest_cache/' --exclude '.ruff_cache/' --exclude '.mypy_cache/' \
  "$ROOT/" "$HOST:/home/gmgn/app/"
"${SSH[@]}" 'chown -R gmgn:gmgn /home/gmgn/app'

echo "==> 2/5 confirm automation gate is closed"
"${SSH[@]}" 'python3 -c "import json,sys; g=json.load(open(\"/home/gmgn/app/config/automation_gate.json\")); print(\"force_open =\", g.get(\"force_open\")); sys.exit(1 if g.get(\"force_open\") else 0)"' \
  || { echo "ABORT: force_open is true on the VPS"; exit 1; }

echo "==> 3/5 write ~/.config/gmgn/config.json from the VPS .env (key stays on the VPS)"
"${SSH[@]}" 'sudo -u gmgn -H python3 - <<"EOF"
import json, os, re
d = os.path.expanduser("~/.config/gmgn")
env = open(os.path.join(d, ".env"), encoding="utf-8").read()
key = re.search(r"^GMGN_API_KEY=(.+)$", env, re.M).group(1).strip()
path = os.path.join(d, "config.json")
cfg = json.load(open(path)) if os.path.exists(path) else {}
cfg["gmgn_api_key"] = key
fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f)
os.replace(path + ".tmp", path)
print("config.json written, fields:", sorted(cfg))
EOF'

echo "==> 4/5 run tests and doctor on the VPS"
"${SSH[@]}" 'cd /home/gmgn/app && sudo -u gmgn -H python3 -m unittest discover -s tests 2>&1 | tail -3 && sudo -u gmgn -H python3 -m gmgn_monitor.doctor 2>&1 | tail -5'

echo "==> 5/5 install and start the isolated GMGN module (gmgn.slice + gmgn-dashboard.service)"
# The GMGN module shares this host with the Binance bot (binance-agentic-*.service, Caddy).
# It never touches those units: own user, own slice with memory/CPU caps, read-only system,
# writable only under /home/gmgn, bound to loopback, not routed through Caddy.
"${SSH[@]}" 'cat > /etc/systemd/system/gmgn.slice <<"EOF"
[Unit]
Description=GMGN module (isolated from the Binance bot)

[Slice]
MemoryMax=300M
CPUQuota=50%
TasksMax=128
EOF
cat > /etc/systemd/system/gmgn-dashboard.service <<"EOF"
[Unit]
Description=GMGN monitor dashboard (manual trading, gate-controlled)
After=network-online.target
Wants=network-online.target

[Service]
Slice=gmgn.slice
User=gmgn
Group=gmgn
WorkingDirectory=/home/gmgn/app
Environment=PATH=/home/gmgn/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/gmgn
ExecStart=/usr/bin/python3 -m gmgn_monitor.dashboard --root /home/gmgn/app --host 127.0.0.1 --port 8765
Restart=on-failure
RestartSec=10
SyslogIdentifier=gmgn
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/gmgn
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now gmgn-dashboard && sleep 3 && systemctl --no-pager --lines=5 status gmgn-dashboard
echo "--- Binance units untouched:"; systemctl is-active binance-agentic-stock-bot binance-agentic-dashboard'

echo
echo "Done. Open the dashboard through an SSH tunnel:"
echo "  ssh -i $KEY -N -L 8765:127.0.0.1:8765 $HOST   # then visit http://127.0.0.1:8765"
echo "Manage the GMGN module on the VPS:"
echo "  systemctl status|restart|stop gmgn-dashboard    journalctl -t gmgn -f    systemd-cgtop gmgn.slice"
