export function summarizeWalletBalances(balances, checkedAt = new Date().toISOString()) {
  if (!Array.isArray(balances)) throw new TypeError("Wallet balances must be an array");
  const totalUsd = balances.reduce((total, balance) => {
    const value = Number(balance?.value);
    if (Number.isFinite(value)) return total + value;
    const quantity = Number(balance?.balance);
    const price = Number(balance?.price);
    return Number.isFinite(quantity) && Number.isFinite(price) ? total + quantity * price : total;
  }, 0);
  return {
    totalUsd,
    assetCount: balances.length,
    checkedAt
  };
}
