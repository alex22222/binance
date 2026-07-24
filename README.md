# Binance Agentic Stock Bot

Automated BSC tokenized-stock monitor and trader for Binance Agentic Wallet.

The bot:

- scans the configured universe every 15 minutes for entries;
- monitors an open position every minute for stop loss or take profit;
- holds at most one position;
- caps each order at 50 USDT;
- stops opening positions after 10 USDT of realized daily loss;
- resolves current BSC contracts from Binance on every entry cycle;
- blocks entries when market status, security audit, quote cost, wallet status, or Feishu setup fails;
- appends a redacted JSONL audit trail for every startup, cycle, external call, decision, notification, order action, and state save;
- has no fixed maximum holding time.

## Strategy

The X post used 15 minutes as a monitoring interval for an existing multi-position portfolio. This bot keeps that behavior for decisions but limits exposure to one highest-ranked position.

Entry gates:

- market and asset status are `TRADING`;
- 15-minute return is at least 0.8%;
- at least 10 of the last 15 one-minute moves are positive;
- quoted round-trip cost is at most 0.7%;
- Binance token audit is supported, low-risk, has no hit risk items, and taxes are at most 5%; or
- Binance explicitly reports the audit unsupported, the contract came from the current official BSC RWA list, and `allowUnsupportedAuditForOfficialRwa` is enabled.

Network, HTTP, and API errors always fail closed. The RWA exception never applies to a contract supplied outside the official list.

Exit gates use an executable sell quote:

- stop loss at -8%;
- take profit at +10%.

After an exit, the same symbol has a 30-minute cooldown and must pass all entry gates again.

## Setup

```bash
cp config.example.json config.json
npm test
```

Use either a custom bot webhook:

```bash
export FEISHU_WEBHOOK_URL='https://open.feishu.cn/open-apis/bot/v2/hook/...'
```

Or a custom app:

```bash
export FEISHU_APP_ID='...'
export FEISHU_APP_SECRET='...'
export FEISHU_RECEIVE_ID='...'
```

IDs beginning with `oc_` are sent as `chat_id`; IDs beginning with `ou_` are sent as `open_id`. For other IDs, set `FEISHU_RECEIVE_ID_TYPE` explicitly.

Do not commit `config.json`, state files, or the webhook URL.

To store custom-app credentials in macOS Keychain without putting them in shell history, double-click:

```text
scripts/configure-feishu-keychain.command
```

The unattended launcher reads those Keychain entries through `scripts/run-from-keychain.sh`.

Send one notification test without accessing the wallet:

```bash
scripts/run-from-keychain.sh --test-feishu
```

## Shadow verification

`config.example.json` defaults to `shadow`. Run one decision cycle:

```bash
npm run once
```

Run continuously:

```bash
npm start
```

Every run receives a unique run ID and every cycle receives a unique cycle ID. The append-only trace is written to `state/action-trace.jsonl` by default. Credentials, tokens, authorization headers, API keys, and webhook URLs are redacted.

## Live gate

Live trading requires both:

1. `"mode": "live"` in `config.json`
2. `BOT_LIVE=1` in the process environment

```bash
BOT_LIVE=1 npm start
```

The second gate prevents an accidental live start after editing the config.

`com.henry.binance-agentic-stock-bot.plist.example` is a launchd template. It intentionally has `BOT_LIVE=0`; copying or loading it does not enable live trading.
