// Shared rules for Polymarket "Bitcoin Up or Down" rounds (the markets future.news lists):
// round schedule, ET weekend filter, slugs, taker fee and order-book fill simulation.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Research caches are independent of the shell working directory and developer home.
export function researchArtifactPath(...parts) {
  return resolve(process.env.RESEARCH_ARTIFACTS_DIR || fileURLToPath(new URL('../artifacts/', import.meta.url)), ...parts);
}

export const FEE_RATE = 0.07; // crypto_fees_v2: fee = shares * 0.07 * p * (1 - p), takers only

const etFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  hour12: true,
});

export function etParts(sec) {
  return Object.fromEntries(etFormat.formatToParts(new Date(sec * 1000)).map((p) => [p.type, p.value]));
}

export function isEtWeekend(sec) {
  const weekday = etParts(sec).weekday;
  return weekday === 'Sat' || weekday === 'Sun';
}

export function hourlySlug(sec) {
  const p = etParts(sec);
  return `bitcoin-up-or-down-${p.month.toLowerCase()}-${p.day}-${p.year}-${p.hour}${p.dayPeriod.toLowerCase()}-et`;
}

// priceVariant: Polymarket crypto-price API variant that returns the round's Chainlink
// "price to beat". The hourly round settles on the Binance BTCUSDT 1H candle instead.
export const SERIES = {
  '5m': { sec: 300, slug: (s) => `btc-updown-5m-${s}`, priceVariant: 'fiveminute' },
  '15m': { sec: 900, slug: (s) => `btc-updown-15m-${s}`, priceVariant: 'fifteen' },
  '1h': { sec: 3600, slug: hourlySlug, priceVariant: null },
  '4h': { sec: 14400, slug: (s) => `btc-updown-4h-${s}`, priceVariant: 'fourhour' },
};

export function roundStart(nowSec, seriesSec) {
  return nowSec - (nowSec % seriesSec);
}

// The side the price is on relative to the price to beat; null when exactly flat.
export function directionOf(current, priceToBeat) {
  if (!(current > 0) || !(priceToBeat > 0) || current === priceToBeat) return null;
  return current > priceToBeat ? 'Up' : 'Down';
}

// Rounds settle Up when the close is greater than or equal to the open.
export function winnerOf(close, open) {
  return close >= open ? 'Up' : 'Down';
}

export function takerFee(shares, price) {
  return FEE_RATE * shares * price * (1 - price);
}

// Fill-and-kill market buy of `stakeUsd` notional against `asks` ([{price, size}], any order),
// never paying more than `maxPrice`. Fee is charged per level on top of the notional.
export function simulateMarketBuy(asks, stakeUsd, maxPrice = 0.99) {
  const levels = asks
    .map((a) => ({ price: +a.price, size: +a.size }))
    .filter((a) => a.price > 0 && a.size > 0 && a.price <= maxPrice)
    .sort((a, b) => a.price - b.price);
  let remaining = stakeUsd;
  let shares = 0;
  let notional = 0;
  let fee = 0;
  let worstPrice = null;
  for (const level of levels) {
    if (remaining <= 1e-9) break;
    const take = Math.min(level.size, remaining / level.price);
    shares += take;
    notional += take * level.price;
    fee += takerFee(take, level.price);
    remaining -= take * level.price;
    worstPrice = level.price;
  }
  return {
    shares,
    notional,
    fee,
    avgPrice: shares ? notional / shares : null,
    bestAsk: levels[0]?.price ?? null,
    worstPrice,
    filled: notional >= stakeUsd - 1e-6,
  };
}

export function settlePnl({ side, shares, notional, fee }, winner) {
  const payout = side === winner ? shares : 0;
  return { payout, pnl: payout - notional - fee };
}
