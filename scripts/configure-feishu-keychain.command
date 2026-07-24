#!/bin/zsh

set -e

keychain_account="henry"

echo "飞书凭据只会写入 macOS 钥匙串，不会写入项目文件。"
read "feishu_app_id?飞书 App ID: "
read -s "feishu_app_secret?飞书 App Secret: "
echo
read "feishu_receive_id?飞书接收 ID（oc_ 或 ou_）: "

security add-generic-password -U -a "$keychain_account" -s "binance-stock-bot-feishu-app-id" -w "$feishu_app_id" >/dev/null
security add-generic-password -U -a "$keychain_account" -s "binance-stock-bot-feishu-app-secret" -w "$feishu_app_secret" >/dev/null
security add-generic-password -U -a "$keychain_account" -s "binance-stock-bot-feishu-receive-id" -w "$feishu_receive_id" >/dev/null

unset feishu_app_id feishu_app_secret feishu_receive_id

echo
echo "飞书凭据已保存到 macOS 钥匙串。"
echo "按任意键关闭。"
read -k 1
