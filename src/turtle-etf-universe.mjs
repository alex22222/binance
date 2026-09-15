// U.S.-listed, unlevered ETF candidates verified against Binance BSC on 2026-09-09.
// Selection is based on distinct exposures, not an optimized backtest ranking.
export const TURTLE_ETF_UNIVERSE = Object.freeze([
  { symbol: "SPY", exposure: "美国大盘", cluster: "US_EQUITY" },
  { symbol: "QQQ", exposure: "纳斯达克100", cluster: "US_EQUITY" },
  { symbol: "IWM", exposure: "美国小盘", cluster: "US_EQUITY" },
  { symbol: "EFA", exposure: "发达市场（美国及加拿大以外）", cluster: "INTERNATIONAL_EQUITY" },
  { symbol: "EEM", exposure: "新兴市场", cluster: "INTERNATIONAL_EQUITY" },
  { symbol: "TLT", exposure: "20年以上美国国债", cluster: "DURATION" },
  { symbol: "GLD", exposure: "黄金", cluster: "GOLD" },
  { symbol: "DBC", exposure: "综合商品期货", cluster: "COMMODITIES" }
]);

export function turtleEtfAssets(assets) {
  return TURTLE_ETF_UNIVERSE.map((item) => {
    const matches = assets.filter((asset) => asset.ticker === item.symbol && asset.chainId === "56");
    if (matches.length !== 1 || matches[0].assetType !== 3) {
      throw new Error(`Expected one Binance BSC ETF: ${item.symbol}`);
    }
    return { ...matches[0], ...item };
  });
}
