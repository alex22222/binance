#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo deploy/install-systemd.sh" >&2
  exit 1
fi

project_dir="/opt/binance-agentic-stock-bot"
environment_file="/etc/binance-agentic-stock-bot.env"
unit_dir="/etc/systemd/system"

if [[ ! -f "$project_dir/package.json" ]]; then
  echo "Project must be synced to $project_dir before installing services" >&2
  exit 1
fi

if ! id binancebot >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/binance-agentic-stock-bot --shell /usr/sbin/nologin binancebot
fi

install -d -o binancebot -g binancebot -m 700 \
  /var/lib/binance-agentic-stock-bot \
  /var/lib/binance-agentic-stock-bot/.baw \
  /var/lib/binance-agentic-stock-bot/watch \
  "$project_dir/state"

if [[ ! -f "$environment_file" ]]; then
  install -m 600 "$project_dir/deploy/binance-agentic-stock-bot.env.example" "$environment_file"
  echo "Created $environment_file. Replace every placeholder before starting services." >&2
fi

install -m 644 "$project_dir/deploy/binance-agentic-stock-bot.service" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-dashboard.service" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-watch.service" "$unit_dir/"
systemctl daemon-reload

echo "Installed service definitions without starting them."
echo "Run: node scripts/preflight-linux.mjs"
