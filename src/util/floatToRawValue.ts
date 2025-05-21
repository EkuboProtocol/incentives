export function floatToRawValue(value: number, decimals: number): bigint {
  const x = value.toString(10);
  const [w, f] = x.split(".");

  if (!f) {
    return BigInt(x) * 10n ** BigInt(decimals);
  }

  if (f.length > decimals) {
    throw new Error(`Value has too many decimals`);
  }

  return BigInt(w + f.padEnd(decimals, "0"));
}
