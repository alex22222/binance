import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SERIES,
  directionOf,
  hourlySlug,
  isEtWeekend,
  roundStart,
  settlePnl,
  simulateMarketBuy,
  takerFee,
  winnerOf,
} from '../src/polymarket-updown.mjs';

const utc = (...args) => Date.UTC(...args) / 1000;
const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

test('ET weekend starts Saturday 00:00 and ends Sunday 23:59 New York time', () => {
  assert.equal(isEtWeekend(utc(2026, 9, 10, 3, 59, 59)), false); // Fri 23:59:59 EDT
  assert.equal(isEtWeekend(utc(2026, 9, 10, 4, 0, 0)), true); // Sat 00:00 EDT
  assert.equal(isEtWeekend(utc(2026, 9, 12, 3, 59, 59)), true); // Sun 23:59:59 EDT
  assert.equal(isEtWeekend(utc(2026, 9, 12, 4, 0, 0)), false); // Mon 00:00 EDT
  assert.equal(isEtWeekend(utc(2026, 10, 7, 5, 0, 0)), true); // Sat 00:00 EST after DST ends
});

test('hourly slugs follow Polymarket ET naming', () => {
  assert.equal(hourlySlug(utc(2026, 9, 10, 15)), 'bitcoin-up-or-down-october-10-2026-11am-et');
  assert.equal(hourlySlug(utc(2026, 9, 10, 4)), 'bitcoin-up-or-down-october-10-2026-12am-et');
  assert.equal(hourlySlug(utc(2026, 9, 10, 16)), 'bitcoin-up-or-down-october-10-2026-12pm-et');
});

test('round starts align to the series length', () => {
  const now = utc(2026, 9, 10, 15, 7, 57);
  assert.equal(roundStart(now, SERIES['5m'].sec), utc(2026, 9, 10, 15, 5));
  assert.equal(roundStart(now, SERIES['15m'].sec), utc(2026, 9, 10, 15, 0));
  assert.equal(roundStart(now, SERIES['4h'].sec), utc(2026, 9, 10, 12, 0));
  assert.equal(SERIES['5m'].slug(utc(2026, 9, 10, 15, 5)), 'btc-updown-5m-1791644700');
});

test('direction and settlement follow the price to beat, ties settle Up', () => {
  assert.equal(directionOf(83001, 83000), 'Up');
  assert.equal(directionOf(82999, 83000), 'Down');
  assert.equal(directionOf(83000, 83000), null);
  assert.equal(directionOf(NaN, 83000), null);
  assert.equal(winnerOf(83000, 83000), 'Up');
  assert.equal(winnerOf(82999.99, 83000), 'Down');
});

test('taker fee matches the published crypto fee table', () => {
  assert.equal(+takerFee(100, 0.5).toFixed(4), 1.75);
  assert.equal(+takerFee(100, 0.3).toFixed(4), 1.47);
  assert.equal(+takerFee(100, 0.9).toFixed(4), 0.63);
});

test('market buy walks asks from the cheapest level and respects the price cap', () => {
  const asks = [
    { price: '0.62', size: '10' },
    { price: '0.60', size: '10' },
    { price: '0.99', size: '1000' },
  ];
  const fill = simulateMarketBuy(asks, 10, 0.95);
  assert.equal(fill.bestAsk, 0.6);
  assert.equal(fill.worstPrice, 0.62);
  assert.equal(fill.filled, true);
  assert.ok(Math.abs(fill.notional - 10) < 1e-9);
  assert.ok(Math.abs(fill.shares - (10 + 4 / 0.62)) < 1e-9);
  assert.ok(Math.abs(fill.fee - (takerFee(10, 0.6) + takerFee(4 / 0.62, 0.62))) < 1e-9);

  const thin = simulateMarketBuy(asks, 50, 0.95);
  assert.equal(thin.filled, false);
  assert.ok(Math.abs(thin.notional - 12.2) < 1e-9);

  assert.equal(simulateMarketBuy([], 10).avgPrice, null);
});

test('settlement pays one dollar per winning share net of cost and fee', () => {
  const bet = { side: 'Up', shares: 16, notional: 10, fee: 0.25 };
  assert.deepEqual(settlePnl(bet, 'Up'), { payout: 16, pnl: 5.75 });
  assert.deepEqual(settlePnl(bet, 'Down'), { payout: 0, pnl: -10.25 });
});

async function researchFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'updown-research-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'src'));
  await mkdir(join(directory, 'elsewhere'));
  for (const file of ['src/polymarket-updown.mjs', 'scripts/analyze-15m-4h-combo.mjs',
    'scripts/analyze-weekend-updown-combos.mjs', 'scripts/run-weekend-updown-paper.mjs']) {
    await copyFile(new URL('../' + file, import.meta.url), join(directory, file));
  }
  return directory;
}

function researchCli(directory, name, args = [], env = {}, workingDirectory = join(directory, 'elsewhere')) {
  return spawnSync(process.execPath, [permissionFlag, '--allow-fs-read=' + directory,
    join(directory, 'scripts', name), ...args], {
    cwd: workingDirectory, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 10_000,
  });
}

async function analysisCache(directory) {
  for (const [file, contents] of [
    ['weekend-favorite-timing/15m.jsonl', JSON.stringify({ start: 1775304000, winner: 'Up', buys: [] })],
    ['weekend-favorite-timing/1h.jsonl', JSON.stringify({ start: 1775304000, winner: 'Up', buys: [] })],
    ['btc5m-early-entry/5m.jsonl', JSON.stringify({ start: 1775304000, day: 'weekend', winner: 'Up', buys: [] })],
    ['4h-research/candidate-bets.json', '[]'],
  ]) {
    await mkdir(join(directory, file, '..'), { recursive: true });
    await writeFile(join(directory, file), contents + '\n');
  }
}

test('combination CLIs find project-relative caches from another working directory', async t => {
  const directory = await researchFixture(t);
  await analysisCache(join(directory, 'artifacts'));
  for (const name of ['analyze-15m-4h-combo.mjs', 'analyze-weekend-updown-combos.mjs']) {
    const result = researchCli(directory, name);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /15m/);
  }
});

test('combination CLIs accept an explicit cache directory without using a developer home', async t => {
  const directory = await researchFixture(t), cache = join(directory, 'custom-cache');
  await analysisCache(cache);
  for (const name of ['analyze-15m-4h-combo.mjs', 'analyze-weekend-updown-combos.mjs']) {
    const result = researchCli(directory, name, [], { RESEARCH_ARTIFACTS_DIR: cache });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('Paper status excludes legacy provisional and unknown settlements from official performance', async t => {
  const directory = await researchFixture(t), ledgerDirectory = join(directory, 'state/weekend-updown-paper');
  await mkdir(ledgerDirectory, { recursive: true });
  const bet = id => ({ type: 'bet', id, series: '1h', side: 'Up', shares: 16, notional: 10, fee: 0.25, avgPrice: 0.625 });
  const records = [bet('official'), bet('legacy'), bet('new'), bet('unknown'), bet('string-flag'),
    { type: 'settle', id: 'official', official: true, winner: 'Down', payout: 0, pnl: -10.25 },
    { type: 'settle', id: 'legacy', official: false, winner: 'Up', payout: 16, pnl: 5.75 },
    { type: 'provisional_settle', id: 'new', official: false, winner: 'Up', payout: 16, pnl: 5.75 },
    { type: 'settle', id: 'unknown', winner: 'Up', payout: 16, pnl: 5.75 },
    { type: 'settle', id: 'string-flag', official: 'true', winner: 'Up', payout: 16, pnl: 5.75 }];
  const contents = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  const file = join(ledgerDirectory, 'ledger.jsonl');
  await writeFile(file, contents);
  const result = researchCli(directory, 'run-weekend-updown-paper.mjs', ['--status'], {}, directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /total \| 5 \| 4 \| 0\.0% \| 0\.625 \| \$0\.25 \| \$-10\.25 \| -102\.5%/);
  assert.match(result.stdout, /OFFICIAL SETTLEMENT ONLY/);
  assert.match(result.stdout, /PROVISIONAL PRICE ESTIMATES ONLY/);
  assert.match(result.stdout, /total \| 2 \| \$11\.50/);
  assert.equal(await readFile(file, 'utf8'), contents, 'status must not migrate or rewrite the ledger');
});

const paperBet = { type: 'bet', id: '1h:1000', series: '1h', slug: 'fixture-round', start: 1000,
  end: 4600, side: 'Up', shares: 16, notional: 10, fee: 0.25, avgPrice: 0.625 };

test('Paper module imports without starting feeds, reading ledgers or creating directories', async t => {
  const directory = await researchFixture(t);
  const result = spawnSync(process.execPath, [permissionFlag, '--allow-fs-read=' + directory,
    '--input-type=module', '-e', 'globalThis.fetch=()=>{throw Error("unexpected network")};globalThis.WebSocket=class{constructor(){throw Error("unexpected feed")}};await import("../scripts/run-weekend-updown-paper.mjs");console.log("imported-only");'], {
    cwd: join(directory, 'elsewhere'), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'imported-only');
});

test('official lookup requires a closed binary market and one unambiguous Up/Down result', async () => {
  const { officialWinner } = await import('../scripts/run-weekend-updown-paper.mjs');
  const market = { closed: true, outcomes: '["Up","Down"]', outcomePrices: '["1","0"]' };
  const lookup = change => officialWinner('fixture', async () => [{ markets: [{ ...market, ...change }] }]);
  assert.equal(await lookup({}), 'Up');
  assert.equal(await lookup({ outcomes: '["Down","Up"]' }), 'Down');
  for (const change of [{ closed: false }, { closed: 'true' }, { closed: undefined },
    { outcomePrices: '["0.99","0.01"]' }, { outcomePrices: '["1","1"]' },
    { outcomes: '["Up","Other"]' }, { outcomes: '["Up","Up"]' }, { outcomePrices: '[]' }]) {
    assert.equal(await lookup(change), null);
  }
});

test('price estimates remain pending, are not repeated, then reconcile with a late official outcome', async () => {
  const { settlementPass, summarize } = await import('../scripts/run-weekend-updown-paper.mjs');
  const records = [structuredClone(paperBet)];
  let estimateCalls = 0, officialCalls = 0, official = null;
  const options = { records, now: paperBet.end + 10801, logResult: () => {},
    resolveOfficial: async () => { officialCalls++; return official; },
    resolveProvisional: async () => { estimateCalls++; return 'Up'; }, write: async r => records.push(r) };
  await settlementPass(options);
  assert.equal(records.length, 2);
  assert.equal(records[1].type, 'provisional_settle');
  assert.equal(records[1].official, false);
  assert.equal(summarize(records).rows.total.open, 1);
  assert.equal(summarize(records).rows.total.settled, 0);
  assert.equal(summarize(records).provisionalRows.total.pnl, 5.75);
  await settlementPass(options);
  assert.equal(records.length, 2);
  assert.equal(estimateCalls, 1);
  official = 'Down';
  await settlementPass(options);
  assert.equal(records.length, 3);
  assert.equal(records[2].type, 'settle');
  assert.equal(records[2].official, true);
  assert.equal(summarize(records).rows.total.pnl, -10.25);
  assert.equal(summarize(records).rows.total.settled, 1);
  assert.deepEqual(summarize(records).provisionalRows, {});
  await settlementPass(options);
  assert.equal(records.length, 3);
  assert.equal(officialCalls, 3, 'already official rounds need no further settlement fetch');
  assert.equal(records[1].pnl, 5.75, 'retain the original incorrect estimate as evidence');
});

test('legacy unofficial settle records do not prevent later official reconciliation', async () => {
  const { settlementPass, summarize } = await import('../scripts/run-weekend-updown-paper.mjs');
  const legacy = { type: 'settle', id: paperBet.id, official: false, winner: 'Up', pnl: 5.75, payout: 16 };
  const records = [structuredClone(paperBet), legacy];
  await settlementPass({ records, now: paperBet.end + 10801, resolveOfficial: async () => 'Down',
    resolveProvisional: async () => { throw Error('must not consult estimate'); },
    write: async r => records.push(r), logResult: () => {} });
  assert.equal(records.length, 3);
  assert.equal(records[1], legacy);
  assert.equal(summarize(records).rows.total.wins, 0);
  assert.equal(summarize(records).rows.total.pnl, -10.25);
  assert.deepEqual(summarize(records).provisionalRows, {});
});

test('official performance cannot be overwritten by a later estimate or include unknown flags', async () => {
  const { summarize } = await import('../scripts/run-weekend-updown-paper.mjs');
  const confirmed = { type: 'settle', id: paperBet.id, official: true, winner: 'Down', payout: 0, pnl: -10.25 };
  const estimated = { ...confirmed, official: false, winner: 'Up', payout: 16, pnl: 5.75 };
  const result = summarize([paperBet, confirmed, confirmed, estimated]);
  assert.equal(result.rows.total.settled, 1);
  assert.equal(result.rows.total.pnl, -10.25);
  assert.deepEqual(result.provisionalRows, {});
  for (const official of [undefined, null, 'true', 1]) {
    const pending = summarize([paperBet, { ...confirmed, official }]);
    assert.equal(pending.rows.total.open, 1);
    assert.equal(pending.rows.total.settled, 0);
  }
});

test('unresolved or failed source lookups remain unknown, and no-official status never reports zero profit', async () => {
  const { settlementPass, summarize, formatSummary } = await import('../scripts/run-weekend-updown-paper.mjs');
  const records = [structuredClone(paperBet)];
  const options = { records, now: paperBet.end + 10801,
    resolveOfficial: async () => { throw Error('source unavailable'); }, resolveProvisional: async () => null,
    write: async r => records.push(r), logResult: () => {} };
  await settlementPass(options);
  assert.equal(records.length, 1);
  assert.match(formatSummary(summarize(records)), /total \| 1 \| 1 \| — \| — \| — \| — \| —/);
  let called = false;
  await settlementPass({ ...options, now: paperBet.end + 20, resolveProvisional: async () => { called = true; return 'Up'; } });
  assert.equal(called, false, 'no estimate before the three-hour grace period');
});

test('Paper status supports a separate research ledger directory and leaves it unchanged', async t => {
  const directory = await researchFixture(t), ledgerDirectory = join(directory, 'paper-data');
  await mkdir(ledgerDirectory);
  const contents = JSON.stringify(paperBet) + '\n';
  await writeFile(join(ledgerDirectory, 'ledger.jsonl'), contents);
  const result = researchCli(directory, 'run-weekend-updown-paper.mjs', ['--status'], { RESEARCH_PAPER_DIR: ledgerDirectory });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /total \| 1 \| 1/);
  assert.equal(await readFile(join(ledgerDirectory, 'ledger.jsonl'), 'utf8'), contents);
});
