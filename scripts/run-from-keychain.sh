#!/bin/zsh

set -e

export PATH="/Users/henry/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export HTTP_PROXY="http://127.0.0.1:7890"
export HTTPS_PROXY="http://127.0.0.1:7890"
export ALL_PROXY="socks5://127.0.0.1:7890"
export NO_PROXY="127.0.0.1"

export BINANCE_INSTANCE_ID="$(security find-generic-password -a henry -s binance-agentic-wallet-instance-id -w)"
export FEISHU_APP_ID="$(security find-generic-password -a henry -s binance-stock-bot-feishu-app-id -w)"
export FEISHU_APP_SECRET="$(security find-generic-password -a henry -s binance-stock-bot-feishu-app-secret -w)"
export FEISHU_RECEIVE_ID="$(security find-generic-password -a henry -s binance-stock-bot-feishu-receive-id -w)"

cd /Users/henry/projects/binance
/usr/local/bin/node scripts/patch-baw-session-persistence.mjs --check
exec /usr/local/bin/npm start -- "$@"
