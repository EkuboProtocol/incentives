import { describe, expect, it } from "vitest";
import { floatToRawValue } from "./floatToRawValue.js";

describe(floatToRawValue, () => {
  it("examples", () => {
    expect(floatToRawValue(0.0, 18)).toEqual(0n);
    expect(floatToRawValue(10.0, 18)).toEqual(10n ** 19n);
    expect(floatToRawValue(58382.0, 18)).toEqual(58382n * 10n ** 18n);
    expect(floatToRawValue(0.1, 18)).toEqual(10n ** 17n);
    expect(floatToRawValue(100_000.159, 18)).toEqual(
      100_000_159_000_000_000_000_000n,
    );
    expect(floatToRawValue(100_000.159_592_129, 18)).toEqual(
      100_000_159_592_129_000_000_000n,
    );
    expect(floatToRawValue(100_000.159238, 6)).toEqual(100_000_159_238n);
    expect(() => floatToRawValue(100_000.1592389, 6)).toThrow(
      "Value has too many decimals",
    );
  });
});
