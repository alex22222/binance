export function normalizeTokenAmount(value) {
  const input = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(input)) throw new TypeError("Token amount must be a non-negative decimal");
  const [integerPart, fractionPart = ""] = input.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "");
  const fraction = fractionPart.replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

export function exactTokenBalance(balances) {
  if (!Array.isArray(balances)) throw new TypeError("Token balances must be an array");
  if (balances[0]?.balance == null) return "0";
  return normalizeTokenAmount(balances[0].balance);
}

export function isPositiveTokenAmount(value) {
  return normalizeTokenAmount(value) !== "0";
}

export function sameTokenAmount(left, right) {
  try {
    return normalizeTokenAmount(left) === normalizeTokenAmount(right);
  } catch {
    return false;
  }
}
