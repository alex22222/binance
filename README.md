# Binance Agentic Stock Bot

Automated BSC tokenized-stock monitor and trader for Binance Agentic Wallet.

The bot:

- checks market status every 15 minutes while flat, and only runs the full entry scan during the regular session;
- from the expected 09:30 New York open, checks every 60 seconds until Binance reports `marketStatus: regular`, then starts the full scan in that same cycle;
- applies the published 2026-2028 U.S. cash-equity holiday and 13:00 early-close calendar before trusting Binance's live status;
- checks an open position every minute using executable sell quotes;
- holds at most one position;
- caps each order at 50 USDT;
- stops opening positions after 10 USDT of realized daily loss;
- resolves current BSC contracts from Binance on every entry cycle;
- blocks entries when market status, security audit, quote cost, wallet status, or Feishu setup fails;
- retries transient read-only failures but never retries a state-changing swap submission;
- writes an order intent before submission so a restart reconciles an ambiguous order instead of placing a duplicate;
- rejects quotes older than 10 seconds and entries whose refreshed output drifts by more than 0.3%;
- enforces a single running bot process and recovers stale process locks after a crash;
- persists an emergency-stop marker that survives process and computer restarts;
- appends a redacted JSONL audit trail for every startup, cycle, external call, decision, notification, order action, and state save;
- applies a conditional four-hour signal review instead of an unconditional time exit.

## Strategy

The X post used 15 minutes as a monitoring interval for an existing multi-position portfolio. This bot keeps that behavior for decisions but limits exposure to one highest-ranked position.

Entry gates:

- market and asset status are `TRADING`, and `marketStatus` is exactly `regular`;
- 15-minute return is at least `0.75 × ATR15`;
- at least 9 of the last 15 one-minute moves are positive;
- quoted round-trip cost is at most 0.7%;
- quoted fees/spread/price impact, 0.10 USDT estimated round-trip BSC gas, and a 0.1% execution buffer leave at least 0.3% net signal edge and net target profit;
- Binance token audit is supported, low-risk, has no hit risk items, and taxes are at most 5%; or
- Binance explicitly reports the audit unsupported, the contract came from the current official BSC RWA list, and `allowUnsupportedAuditForOfficialRwa` is enabled.

Network, HTTP, and API errors always fail closed. The RWA exception never applies to a contract supplied outside the official list.

The planned regular-session calendar uses `America/New_York`, so UTC and
Asia/Shanghai times follow U.S. daylight-saving changes automatically. Published
NYSE holidays and early closes are embedded through 2028 and cross-checked
against Nasdaq's 2026 U.S. equity calendar. Outside that published horizon,
new entries fail closed until the table is updated; open-position exit monitoring
continues. Binance `marketStatus: regular` remains a second mandatory gate for
unexpected closures, delayed opens, and trading halts.

Official sources:

- https://www.nyse.com/markets/hours-calendars
- https://www.nasdaq.com/market-activity/stock-market-holiday-schedule

The all-in entry estimate is:

```text
quoted round-trip cost
+ (estimatedRoundTripGasUsdt / maxTradeUsdt × 100%)
+ executionBufferPct
```

The bot rejects the candidate unless both the 15-minute gross edge proxy and
the dynamic `+2R` target retain at least `minNetEdgePct` after this estimate.
It repeats the same decision using refreshed buy and sell quotes immediately
before submitting an order.

`ATR15` is ATR(14), calculated only from closed 15-minute candles. The initial
risk unit `R` is:

```text
clamp(1.5 × ATR15, 1.0%, 3.5%)
```

Execution costs do not widen the price stop; they are used for entry admission
and the profit floor. While flat outside regular hours, the bot skips all
K-line, ATR, and two-way quote work. Exit checks remain active every 60 seconds
for an existing position, regardless of the market session, using an executable
sell quote:

- the initial stop is `-1R`;
- profit protection activates once the executable return reaches `+1R`;
- after activation, the trailing level follows the position peak at a distance
  of `1 × current ATR15`, but never below the entry all-in cost estimate plus
  the configured minimum net edge;
- the final take-profit reference is `+2R`;
- after four hours, the bot exits only when the entry signal is no longer valid
  and the executable return is below `+0.5R`;
- `-8%` remains an independent catastrophe protection line.

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

The launcher also reads `binance-agentic-wallet-instance-id` from macOS Keychain. Keep this stable so the CLI client identity does not depend on a changing network-interface address. Create it once before signing in:

```bash
security add-generic-password -U -a "$(id -un)" \
  -s binance-agentic-wallet-instance-id \
  -w "$(uuidgen)"
```

Changing this value invalidates the local CLI identity and requires signing in again.

Use the Keychain wrapper for every manual or automated CLI invocation:

```bash
scripts/baw-from-keychain.mjs wallet status --json
```

The local installation also links this wrapper as
`/Users/henry/.local/bin/baw`. Do not invoke the raw
`/Users/henry/.npm-global/bin/baw` executable directly: it bypasses the stable
instance ID. The macOS launcher configures the local proxy; the shared Node
runtime no longer injects a proxy so an Ubuntu server connects directly.

BAW CLI 1.7.0 does not persist a rotated session cookie after an established
wallet request. It also clears the existing session when the encrypted client
identity is opened with a different `BINANCE_INSTANCE_ID`. Apply the local
compatibility patch once after installing or upgrading the CLI:

```bash
npm run patch:baw-session
```

The launcher runs `npm run check:baw-session` semantics before starting. If a
CLI upgrade removes the patch, the bot fails closed instead of silently using a
stale session. The patch preserves the normal pending-session behavior during
QR sign-in, persists only rotations of an already established session, and
refuses an instance-ID mismatch without deleting the valid Keychain session. A
timestamped backup is written beside the CLI entry file before modification.

Send one notification test without accessing the wallet:

```bash
scripts/run-from-keychain.sh --test-feishu
```

Run one deterministic mock round trip with Feishu notification:

```bash
scripts/run-from-keychain.sh --mock-trade
```

The mock uses a 50 USDT buy at a synthetic price of 100 and a take-profit sell at 110. It resolves the symbol from the current official BSC RWA list but does not access the wallet or broadcast a transaction. The detailed result is saved under `state/mock-trades/`; the complete action sequence is appended to `state/action-trace.jsonl`.

View a mock result:

```bash
jq . state/mock-trades/<run-id>.json
```

View only that run's action timeline:

```bash
jq 'select(.runId=="<run-id>")' state/action-trace.jsonl
```

Feishu delivery retries transient network failures, HTTP 429, and HTTP 5xx responses up to three times. Permission, recipient, and other application errors fail immediately.

Generate and open the local strategy and Mock dashboard:

```bash
npm run dashboard:open
```

The self-contained HTML is written to `artifacts/strategy-mock-dashboard.html`. Run the command again after a new Mock to refresh the strategy snapshot and timeline.

Start the local live position and safety-control dashboard:

```bash
npm run dashboard:live
```

Open `http://127.0.0.1:4173`. It refreshes every three seconds and shows the bot heartbeat, current position, executable-quote PnL, pending order, risk budget, latest 15-minute signals, and recent action trace. A live candidate appears as a five-minute, one-time approval request containing the exact side, symbol, full contract addresses, amount, quote, costs, risk parameters, and audit status. The server binds only to `127.0.0.1`.

Approving or rejecting from the dashboard writes a new immutable decision under `state/approval-decisions/`; it never edits `state/bot-state.json`. The bot consumes that exact decision on its next cycle. Before an approved swap is submitted it rechecks the wallet, emergency stop, position state, trend/exit trigger, executable quote, quote drift, cost coverage, and token audit. An expired, mismatched, reused, or materially changed approval fails closed without broadcasting.

For authenticated access, configure both values before starting the dashboard:

```bash
export DASHBOARD_USERNAME='operator'
export DASHBOARD_PASSWORD='use-a-long-random-password'
```

An HTTPS reverse proxy must be used for public access. Set
`DASHBOARD_PUBLIC_ORIGIN` to the exact public origin, such as
`https://stocks.example.com`; state-changing requests from any other Origin are
rejected. Bot notifications sent to Feishu append this HTTPS address as the
mobile Dashboard link. Loopback and non-HTTPS addresses are never sent as phone
links.

## Ubuntu server deployment

Ubuntu uses systemd instead of the macOS Keychain/launchd launcher. The checked-in
deployment templates provide separate services for the bot and Dashboard. They
explicitly remove inherited proxy variables, keep the Dashboard on
`127.0.0.1:4173`, and expose it through Caddy HTTPS. Feishu remains an outbound
notification channel; the Dashboard reads pending approvals directly from bot
state.

See [`deploy/README.md`](deploy/README.md) for the server layout and cutover
procedure. The service templates default to:

- `BOT_LIVE=0`;
- Dashboard HTTP Basic Auth from `/etc/binance-agentic-stock-bot.env`;
- BAW session storage under `/var/lib/binance-agentic-stock-bot/.baw`.

The installer disables and removes the legacy `binance-agentic-watch` service.
The parser remains in `watch/` for local diagnostics, but is not part of the
production approval path.

## Reliability controls

Wallet session expiry fails closed. The bot records `EXPIRED`, suppresses repeated alerts for the same outage, preserves positions and pending orders, and resumes monitoring automatically after the operator signs in again. It never attempts to automate QR login.

Once per hour, the bot also reads `wallet settings`. If the maximum session has less than 24 hours remaining, it records `EXPIRING` and sends one Feishu reminder for that expiry timestamp. A settings-read network failure is traced but does not override a successful wallet-status check or block the current cycle.

The maximum sign-in duration is configured in the Binance App; the CLI cannot
change it. Binance also enforces a separate 24-hour inactivity sign-out that is
currently fixed and not user-configurable. A seven-day maximum therefore still
requires the wallet session to remain active and does not override that
24-hour rule.

Transient network failures on public APIs, wallet status, balances, quotes, and order-status reads retry up to three times with bounded backoff. `market-order swap` is attempted exactly once. A timeout during submission remains `AMBIGUOUS` until the next startup reconciles it against Binance order history; zero or multiple matches become `REVIEW_REQUIRED` and block new orders.

Trigger the durable emergency stop from the dashboard or terminal:

```bash
npm run emergency-stop -- "operator"
```

This writes `state/EMERGENCY_STOP` and signals only the PID recorded in `state/bot.lock`. While the marker exists, startup and pre-submission checks fail closed.

Explicitly archive the marker without starting the bot:

```bash
npm run emergency-resume
```

After reviewing the reason and wallet/order state, restart the Shadow service manually:

```bash
launchctl kickstart gui/$(id -u)/com.henry.binance-agentic-stock-bot
```

Install the included crash-recovery LaunchAgent:

```bash
install -m 600 com.henry.binance-agentic-stock-bot.plist.example \
  ~/Library/LaunchAgents/com.henry.binance-agentic-stock-bot.plist
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.henry.binance-agentic-stock-bot.plist
```

The template is fixed to `BOT_LIVE=0`. Abnormal exits restart automatically; emergency-stop and other clean exits do not.

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

Each 15-minute universe scan also appends replayable market records to
`state/market-data/YYYY-MM-DD.jsonl` using the Asia/Shanghai date. A
`market_scan` record contains the full fetched 1-minute and 15-minute OHLCV
windows, market status, derived trend/ATR features, configured thresholds, and
gate results for one symbol. Symbols that clear the market/trend gate receive a
second `quote_evaluation` record with the executable round-trip quote, cost
estimate, initial risk, and cost-coverage decision. `runId`, `cycleId`, and
`scanId` join the records without relying on line order.

Inspect one day or select a single scan:

```bash
jq -c 'select(.recordType=="market_scan")' state/market-data/YYYY-MM-DD.jsonl
jq -c 'select(.scanId=="<scan-id>")' state/market-data/YYYY-MM-DD.jsonl
```

## Live gate

Live trading requires all three gates:

1. `"mode": "live"` in `config.json`
2. `BOT_LIVE=1` in the process environment
3. `"requireTradeApproval": true` with a 30–900 second `approvalTtlSeconds`

```bash
BOT_LIVE=1 npm start
```

The environment gate prevents an accidental live start after editing the config. The approval gate is mandatory and cannot be disabled by configuration.

When an official RWA target has no available BSC security-audit result, the local approval card shows an additional per-order acknowledgement. It is recorded with that order decision and cannot be pre-accepted or persisted for later trades.

`com.henry.binance-agentic-stock-bot.plist.example` is a launchd template. It intentionally has `BOT_LIVE=0`; copying or loading it does not enable live trading.
