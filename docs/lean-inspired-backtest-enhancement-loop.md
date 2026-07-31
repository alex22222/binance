# LEAN-inspired backtest enhancement loop

## Goal

Incrementally strengthen the existing Node.js strategy validation system with
deterministic event replay, shared pure strategy decisions, evidence-aware
execution modeling, and consistent performance reporting.

This is an additive refactor. It must not replace or change the production
trading path.

## Protected production invariants

- Do not change BAW invocation, wallet authentication, or session handling.
- Do not change approval creation, expiry, matching, or confirmation rules.
- Do not change emergency-stop behavior.
- Do not change quote freshness or quote-drift checks.
- Do not change live swap submission or pending-order reconciliation.
- Do not weaken audit, market-session, position-count, daily-loss, or symbol
  isolation gates.
- Do not disable or delay open-position exit monitoring.
- Research-only execution models must never call the wallet or submit orders.

## Verification loop

For every stage:

1. Add or update behavior-focused tests before changing implementation.
2. Make one focused, minimal implementation change.
3. Run the focused tests.
4. Run the full `npm test` suite.
5. Run `git diff --check`.
6. Review the target-file diff for protected-invariant changes.
7. Record the result and next step below.

## Baseline

- Date: 2026-07-31
- Worktree: contains pre-existing, unrelated uncommitted changes; preserve them.
- Full test suite: 160 passed, 0 failed.
- `git diff --check`: passed.
- Test command: `npm test`

## Stages

### Stage 0 - Baseline and invariants

- [x] Record protected production invariants.
- [x] Record the dirty-worktree baseline.
- [x] Run the full test suite.
- [x] Confirm the existing diff has no whitespace errors.

### Stage 1 - Shared pure strategy decisions

- [x] Add parity tests for live and replay candle analysis.
- [x] Reuse the production ATR and momentum functions in replay.
- [x] Reuse the production dynamic exit decision in replay where semantics
      match, without changing production callers.
- [x] Preserve existing historical output on deterministic fixtures.

### Stage 2 - Deterministic event replay

- [x] Add an explicit monotonic time frontier.
- [x] Prove future candles cannot change earlier decisions.
- [x] Separate signal, order intent, execution event, and portfolio update.
- [x] Preserve current one-minute execution-delay semantics.

### Stage 3 - Evidence-aware execution

- [x] Define explicit `QUOTE_REPLAY` and `CANDLE_PROXY` evidence levels.
- [x] Model quote age, quote drift, costs, gas, and terminal failure without
      invoking the wallet.
- [x] Never mix evidence levels in one unlabeled performance result.

### Stage 4 - Performance and quality gate

- [x] Report profit factor, drawdown, average win/loss, MAE/MFE, R multiples,
      turnover, execution rate, cost, and evidence coverage consistently.
- [x] Keep historical and forward windows separate.
- [x] Run the full test suite and final protected-path diff review.
- [x] Document remaining limitations and safe follow-up work.

## Open

- None.

## Done

- Stage 0 baseline and safety boundaries.
- Stage 1 iteration 1: moved raw/normalized candle momentum and ATR analysis to
  `src/strategy-signals.mjs`. Production continues importing the same public
  names from `src/strategy.mjs`; replay now uses the shared implementation.
  Focused tests and the full suite pass (163 passed, 0 failed), and
  `git diff --check` passes.
- Stage 1 iteration 2: moved dynamic exit decisions to
  `src/strategy-exit.mjs`. Production continues importing the same public name
  from `src/strategy.mjs`; ordinary replay strategies now use the shared exit
  decision and map only report labels. The research-only three-control variant
  retains its additional early-failure rule. A deterministic two-trade fixture
  preserves entry times, exit times, and take-profit reasons. The full suite
  passes (166 passed, 0 failed), and `git diff --check` passes.
- Stage 2: added monotonic minute-close replay frames and an optional detailed
  event ledger. Strategy results now always expose event counts and retain full
  events only when `includeReplayEvents` is true. Signal, order intent, fill,
  position-open, exit signal, and position-close events are distinct. A future
  candle mutation test proves events before the frontier are unchanged. The
  existing one-minute signal-to-entry behavior and deterministic trade times
  remain unchanged. The full suite passes (171 passed, 0 failed), and
  `git diff --check` passes.
- Stage 3: added pure research-only `CANDLE_PROXY` and strict `QUOTE_REPLAY`
  execution. Quote replay validates execution time lookup, quote freshness,
  amount equality, optional expected-output drift, recorded gas, and terminal
  on-chain failure. Missing, stale, future, drifted, or amount-mismatched quotes
  are rejected without candle fallback. Focused execution and replay tests
  pass.
- Stage 4 reporting: moved performance aggregation to one pure report module.
  Strategy and per-symbol results now share profit factor, drawdown, average
  win/loss, payoff ratio, executed turnover, gas and total cost, MAE/MFE, and R
  summaries. Every strategy also reports order execution rate and explicit
  evidence coverage. Historical and forward reports carry separate
  `HISTORICAL` and `FORWARD` labels.
- Final quality gate: the full suite passes (179 passed, 0 failed), the
  validation runner passes `node --check`, and `git diff --check` passes. A
  protected-path scan found no wallet, approval, swap, emergency-stop, or
  process-execution calls in the replay and reporting modules. `src/bot.mjs`
  and configuration files retain only the unrelated dirty-worktree changes
  present at the baseline; this loop did not write them. Production imports
  retain the same `analyzeCandles`, `calculateAtrPct`, and
  `dynamicExitDecision` public names.

## Remaining limitations

- `CANDLE_PROXY` is still a minute-bar proxy. It cannot prove intrabar fill
  order, book depth, spread, price impact, partial fills, or route availability.
- `QUOTE_REPLAY` requires archived side-, amount-, and execution-time-specific
  quotes. Quote drift is measurable only when `expectedOutputAmount` is
  archived with the quote; the report states this requirement explicitly.
- MAE/MFE uses minute closes after the fixed model cost and before gas. Final
  realized PnL includes recorded entry and exit gas.
- The replay does not model a shared cash ledger, margin, dividends, corporate
  actions, taxes, or chain reorgs.
- Research results remain non-executing. A safe follow-up is to archive
  read-only amount-specific quotes and compare them in Shadow before considering
  any production decision change.

## Blocked / escalated

- None.
