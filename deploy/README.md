# Ubuntu deployment

The production layout keeps every application port on loopback:

- bot: no listening port;
- dashboard: `127.0.0.1:4173`;
- Caddy: the only public listener, terminating HTTPS before HTTP Basic Auth reaches the dashboard.

The checked-in service files never enable live trading. Feishu is an outbound
notification channel; Dashboard approval state comes directly from the bot.

## Prepare a new server

Install Node.js, npm, Caddy, and the Binance Agentic Wallet CLI using their
official installation paths. The runtime expects:

```text
/usr/bin/node
/usr/bin/npm
/usr/local/bin/baw
```

Sync the repository to `/opt/binance-agentic-stock-bot`, then:

```bash
sudo /opt/binance-agentic-stock-bot/deploy/install-systemd.sh
sudoedit /etc/binance-agentic-stock-bot.env
sudo env BAW_CLI_PATH=/usr/local/bin/baw NPM_CLI_PATH=/usr/bin/npm \
  /usr/bin/node /opt/binance-agentic-stock-bot/scripts/patch-baw-session-persistence.mjs
sudo /usr/bin/node /opt/binance-agentic-stock-bot/scripts/preflight-linux.mjs \
  --environment-file=/etc/binance-agentic-stock-bot.env
```

Populate `config.json` separately. Do not copy the local macOS Keychain,
`state/`, wallet session files, or `config.json` blindly.
Keep application code and `config.json` root-owned; make `config.json`
group-readable by `binancebot` and keep runtime state owned by `binancebot`.

```bash
sudo chown root:binancebot /opt/binance-agentic-stock-bot/config.json
sudo chmod 640 /opt/binance-agentic-stock-bot/config.json
```

The BAW session is stored under
`/var/lib/binance-agentic-stock-bot/.baw`. Perform the server QR login as the
`binancebot` user with the same `BINANCE_INSTANCE_ID`; never copy the local
macOS Keychain or change the instance ID after login.

## Dashboard

Set a long random `DASHBOARD_PASSWORD`, an operator username, and the exact
HTTPS origin in `/etc/binance-agentic-stock-bot.env`. Copy `Caddyfile.example`
to `/etc/caddy/Caddyfile`, replace the domain, validate it, and reload Caddy.
Bot notifications append `DASHBOARD_PUBLIC_ORIGIN` as a mobile Dashboard link.
The same credentials work in the `/login` form used by Feishu and other mobile
webviews that do not display an HTTP Basic Auth prompt.
If the bot confirms a wallet disconnect, the Dashboard service may start the
official BAW QR sign-in flow and therefore shares the protected BAW session
directory with the bot.

HTTP Basic Auth is accepted only over the TLS reverse proxy. The Node dashboard
continues to bind to loopback and rejects state-changing requests from origins
other than loopback or `DASHBOARD_PUBLIC_ORIGIN`.

## Start in safe mode

```bash
sudo systemctl enable --now binance-agentic-dashboard
sudo systemctl enable --now binance-agentic-stock-bot
```

At this point:

- `BOT_LIVE=0` blocks a live config from starting.
- The bot sends Feishu notifications without polling them back into the
  Dashboard.

Inspect:

```bash
systemctl status binance-agentic-dashboard binance-agentic-stock-bot
journalctl -u binance-agentic-stock-bot -u binance-agentic-dashboard
```

## Strategy validation

The validation job is research-only. It downloads public one-minute token and
underlying-stock candles, runs the strategy library plus market-filtered A/B
variants with the same 50 USDT notional and conservative cost assumption, and
writes only under `state/strategy-validation/`. It does not use the wallet,
change the active strategy, approve an order, or submit a transaction.

Run the initial history load manually, then enable the daily post-close timer:

```bash
sudo systemctl start binance-agentic-strategy-validation
sudo systemctl enable --now binance-agentic-strategy-validation.timer
systemctl list-timers binance-agentic-strategy-validation.timer
```

The latest reports are `state/strategy-validation/latest.json` and
`state/shadow-outcomes/latest.json`. The timer runs after the U.S. regular
session, incrementally keeps already downloaded days, and then refreshes the
non-executing adaptive-momentum versus trend-pullback comparison from recorded
market scans.

## Explicit live cutover

Never run the local Mac and server with `BOT_LIVE=1` at the same time. Before
cutover, confirm there is no position, pending order, current approval, or
active emergency stop, preserve a state backup, and stop the local LaunchAgent.

Live trading requires a deliberate systemd drop-in:

```ini
[Service]
Environment=BOT_LIVE=1
```

The installer disables and removes the legacy `binance-agentic-watch` service.
Its state directory is intentionally preserved for audit and rollback.
