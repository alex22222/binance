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
  "$project_dir/state"

if [[ ! -f "$environment_file" ]]; then
  install -m 600 "$project_dir/deploy/binance-agentic-stock-bot.env.example" "$environment_file"
  echo "Created $environment_file. Replace every placeholder before starting services." >&2
fi

install -m 644 "$project_dir/deploy/binance-agentic-stock-bot.service" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-dashboard.service" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-strategy-validation.service" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-strategy-validation.timer" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-shadow-outcomes.service" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-shadow-outcomes.timer" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-trade-review.service" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-trade-review.timer" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-premarket-brief.service" "$unit_dir/"
install -m 644 "$project_dir/deploy/binance-agentic-premarket-brief.timer" "$unit_dir/"
systemctl disable --now binance-agentic-watch.service >/dev/null 2>&1 || true
rm -f "$unit_dir/binance-agentic-watch.service"
systemctl daemon-reload

echo "Installed service definitions without starting them."
echo "Removed the legacy Feishu watch service; Feishu remains notification-only."
echo "Run: node scripts/preflight-linux.mjs"
