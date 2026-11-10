import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
const START = Date.parse('2026-04-04T04:00:00Z') / 1000;
const collectorEnv = { SKIP_KLINES: '1', FROM: new Date(START * 1000).toISOString(), TO: new Date((START + 900) * 1000).toISOString() };
const marketFetch = market => `async input => {
  const url = new URL(input);
  if (url.pathname === '/events') return { ok: true, status: 200, json: async () => url.searchParams.getAll('slug').map(slug => ({ slug, markets: [${JSON.stringify(market)}] })) };
  if (url.pathname === '/trades') return { ok: true, status: 200, json: async () => [{ side: 'BUY', timestamp: ${START + 150}, outcome: 'Up', price: 0.8, size: 2 }] };
  throw Object.assign(new Error('Unexpected network: ' + input), { fatal: true });
}`;
const resolvedMarket = { closed: true, umaResolutionStatus: 'resolved', outcomes: '["Up","Down"]', outcomePrices: '["1","0"]', conditionId: 'fixture-condition' };

async function fixture(t, script) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'offline-15m-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ['src/polymarket-updown.mjs', 'scripts/' + script]) {
    await mkdir(join(directory, file, '..'), { recursive: true });
    await copyFile(new URL('../' + file, import.meta.url), join(directory, file));
  }
  return {
    directory,
    async save(file, contents) {
      await mkdir(join(directory, 'artifacts', file, '..'), { recursive: true });
      await writeFile(join(directory, 'artifacts', file), typeof contents === 'string' ? contents : JSON.stringify(contents));
    },
    run({ args = [], env = {}, fetchCode = 'async () => { throw Object.assign(new Error("Unexpected network"), { fatal: true }); }' } = {}) {
      const entry = join(directory, 'scripts', script);
      return spawnSync(process.execPath, [permissionFlag, '--allow-fs-read=' + directory, '--allow-fs-write=' + directory,
        '--input-type=module', '-e', `globalThis.fetch = ${fetchCode}; process.argv = ${JSON.stringify([process.execPath, entry, ...args])}; await import(${JSON.stringify(pathToFileURL(entry).href)});`], {
        cwd: directory, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 15_000,
      });
    },
  };
}

test('weekly review includes the Beijing start and excludes the next week boundary', async t => {
  const f = await fixture(t, 'analyze-15m-week.mjs');
  const start = Date.parse('2026-10-19T00:00:00+08:00') / 1000;
  const trades = [start - 900, start, start + 7 * 86400 - 900, start + 7 * 86400].map(s => ({
    slug: 'btc-updown-15m-' + s, side: 'BUY', outcome: 'Up', price: 0.8, size: 1.25, timestamp: s + 150,
  }));
  await f.save('15m-conditions/klines/fixture.json', []);
  await f.save('15m-conditions/wallet-trades.json', trades);
  await f.save('15m-conditions/outcomes.json', Object.fromEntries(trades.map(r => [r.slug, 'Up'])));
  const result = f.run({ args: ['2026-10-19'] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /买入 2 笔，已结算 2/);
  assert.match(result.stdout, /10-25 23:45/);
  assert.doesNotMatch(result.stdout, /^  (10-18 23:45|10-26 00:00)/m);
});

test('cross-asset BTC-volatility filter excludes a missing BTC candle window', async t => {
  const f = await fixture(t, 'backtest-eth-15m-counter-1h.mjs');
  const starts = [START, START + 7 * 86400, START + 14 * 86400, Date.parse('2026-07-04T04:00:00Z') / 1000];
  const rounds = starts.map(start => ({ start, winner: 'Up', buys: [[100, 1, 0.8, 2], [150, 1, 0.8, 2]] }));
  const hours = starts.map(start => ({ start, winner: 'Down', buys: [[100, 0, 0.8, 2]] }));
  const candles = dates => dates.flatMap(s => Array.from({ length: 60 }, (_, i) => [s + 60 - (59 - i) * 60, 100, 100, 100, 100]));
  for (const dir of ['eth-updown', 'weekend-favorite-timing']) {
    await f.save(dir + '/15m.jsonl', rounds.map(JSON.stringify).join('\n'));
    await f.save(dir + '/1h.jsonl', hours.map(JSON.stringify).join('\n'));
  }
  await f.save('eth-updown/klines/fixture.json', candles(starts));
  await f.save('15m-conditions/klines/fixture.json', candles([starts[0], starts[2], starts[3]]));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const filtered = result.stdout.split('\nR1·按 BTC 波动（与实盘同一数据）\n')[1].split('\n=== BTC')[0];
  assert.match(filtered, /周末 4–6 月（训练）\s+n 2\b/);
  assert.match(result.stdout, /^ETH R1·按 BTC 波动（与实盘同一数据）\s+4(?:天|个样本日)/m);
});

test('collector retries incomplete cache, replaces rounds and preserves other dates', async t => {
  const f = await fixture(t, 'fetch-eth-updown-rounds.mjs');
  const prior = { start: START - 86400, winner: 'Down', buys: [] };
  for (const name of ['1h', '15m']) await f.save('eth-updown/' + name + '.jsonl', [prior, { start: START, missing: true }, { start: START, winner: null, buys: [] }].map(JSON.stringify).join('\n') + '\n');
  const result = f.run({ env: collectorEnv, fetchCode: marketFetch(resolvedMarket) });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['1h', '15m']) {
    const rows = (await readFile(join(f.directory, 'artifacts/eth-updown/' + name + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.find(r => r.start === START && r.winner === 'Up')?.buys.length, 1);
    assert.equal(rows.length, 2, 'retry must replace, not append a duplicate round');
    assert.deepEqual(rows.find(r => r.start === prior.start), prior);
  }
  const rerun = f.run({ env: collectorEnv });
  assert.equal(rerun.status, 0, rerun.stderr);
});

test('collector exits nonzero on fetch failure and retains the existing cache', async t => {
  const f = await fixture(t, 'fetch-eth-updown-rounds.mjs');
  const before = JSON.stringify({ start: START - 86400, winner: 'Down', buys: [] }) + '\n';
  await f.save('eth-updown/1h.jsonl', before);
  const result = f.run({ env: collectorEnv, fetchCode: 'async () => ({ ok: false, status: 410 })' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /^done$/m);
  assert.match(result.stderr, /HTTP 410/);
  assert.equal(await readFile(join(f.directory, 'artifacts/eth-updown/1h.jsonl'), 'utf8'), before);
});

test('collector settles only a closed binary market and follows outcome labels', async t => {
  for (const [label, changes, winner] of [
    ['reversed labels', { outcomes: '["Down","Up"]' }, 'Down'],
    ['normal Down', { outcomePrices: '["0","1"]' }, 'Down'],
    ['still open', { closed: false }, null],
    ['missing resolution', { umaResolutionStatus: undefined }, null],
    ['proposed only', { umaResolutionStatus: 'proposed' }, null],
    ['disputed', { umaResolutionStatus: 'disputed' }, null],
    ['missing identity', { conditionId: '' }, null],
    ['two winners', { outcomePrices: '["1","1"]' }, null],
    ['nonbinary payout', { outcomePrices: '["1","0.4"]' }, null],
    ['unknown labels', { outcomes: '["Yes","No"]' }, null],
    ['missing price', { outcomePrices: '["1",null]' }, null],
    ['malformed labels', { outcomes: 'not-json' }, null],
  ]) await t.test(label, async t => {
    const f = await fixture(t, 'fetch-eth-updown-rounds.mjs');
    if (label === 'reversed labels') for (const name of ['1h', '15m']) await f.save('eth-updown/' + name + '.jsonl', JSON.stringify({ start: START, winner: 'Up', buys: [] }) + '\n');
    const result = f.run({ env: collectorEnv, fetchCode: marketFetch({ ...resolvedMarket, ...changes }) });
    const rows = (await readFile(join(f.directory, 'artifacts/eth-updown/1h.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].winner, winner);
    assert.equal(rows[0].settlement?.closed, changes.closed ?? true);
    assert.equal(rows[0].settlement?.conditionId, changes.conditionId ?? resolvedMarket.conditionId);
    assert.equal(result.status, winner ? 0 : 1, result.stderr);
    if (!winner) assert.doesNotMatch(result.stdout, /^done$/m);
  });
});

test('month simulation retains observed dates before counter and R1 filtering', async t => {
  const f = await fixture(t, 'simulate-15m-r1-month.mjs');
  const hist = Array.from({ length: 60 }, (_, i) => ({
    start: (i < 30 ? START : Date.parse('2026-07-04T04:00:00Z') / 1000) + (i % 30) * 86400,
    counter: i % 3 !== 0, vol60: i % 3 === 1 ? 3 : 6, price: 0.8, win: true,
  }));
  await f.save('15m-conditions/bets.json', { hist: hist.toReversed(), live: hist.slice(0, 3) });
  const result = f.run();
  assert.match(result.stdout, /不过滤）.*历史 40 注 \/ 60 个(?:交易|样本)日/);
  assert.match(result.stdout, /现策略）.*历史 20 注 \/ 60 个(?:交易|样本)日/);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /历史连续30天/);
});

test('all-filtered dates remain zero-bet days; insufficient windows are not invented', async t => {
  const f = await fixture(t, 'simulate-15m-r1-month.mjs');
  const hist = [0, 1].map(i => ({ start: START + i * 86400, counter: true, vol60: 8, price: 0.8, win: true }));
  await f.save('15m-conditions/bets.json', { hist, live: hist });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /现策略）.*历史 0 注 \/ 2 个样本日/);
  assert.match(result.stdout, /按样本日重抽样（1万次）\s+每月注数\s+0\s+平均 \+\$0\.0/);
  assert.match(result.stdout, /滚动窗口）.*样本不足/);
  assert.doesNotMatch(result.stdout, /NaN|Infinity/);
});
