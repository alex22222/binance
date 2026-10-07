// Confirms that src/btc-observe.mjs, which the radar runs live, builds the same
// daily rows and triggers as this study's data.mjs from the same raw history.
import { readFileSync } from "node:fs";
import { OBSERVED_RULES, observationRows, ruleEvents } from "../../src/btc-observe.mjs";
import { dayIndex, days, fng, funding, price, rows } from "./data.mjs";

const fred = (id) => readFileSync(new URL(`./data/${id}.csv`, import.meta.url), "utf8").trim().split("\n").slice(1)
  .map((line) => line.split(","))
  .filter(([, value]) => value && value !== ".")
  .map(([date, value]) => ({ date, value: Number(value) }));

const live = observationRows({
  closes: days.map((date, index) => ({ date, close: price[index] })),
  fearGreed: [...fng.entries()].map(([date, value]) => ({ date, value })),
  funding,
  dollar: fred("DTWEXBGS"),
  realYield: fred("DFII10")
});

const START = dayIndex.get("2018-02-08");
const fields = ["trend", "r28", "funding7", "fng", "macro"];
let worst = 0;
let mismatches = 0;
for (let index = START; index < rows.length; index += 1) {
  for (const key of [...fields, "ma:20", "ma:200"]) {
    const [a, b] = key.startsWith("ma:")
      ? [live[index].ma[key.slice(3)], rows[index].ma[key.slice(3)]]
      : [live[index][key], rows[index][key]];
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    const difference = Math.abs(a - b);
    if (!(difference <= 1e-12 * Math.max(1, Math.abs(b)))) mismatches += 1;
    if (Number.isFinite(difference)) worst = Math.max(worst, difference);
  }
}
console.log(`rows ${days[START]}..${days.at(-1)}: ${rows.length - START} days, mismatched values ${mismatches}, largest difference ${worst}`);
for (const rule of OBSERVED_RULES) {
  const study = ruleEvents(rows, rule, { from: START });
  const radar = ruleEvents(live, rule, { from: START });
  const same = study.length === radar.length && study.every((index, k) => index === radar[k]);
  console.log(`${rule.id.padEnd(17)} triggers ${String(study.length).padStart(3)} study / ${String(radar.length).padStart(3)} live ${same ? "identical" : "DIFFERENT"}; last ${days[study.at(-1)] ?? "-"}`);
}
