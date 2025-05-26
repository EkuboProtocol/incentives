import { describe, expect, it } from "vitest";
import { floatToRawValue } from "./floatToRawValue.js";
import { EVM_AIRDROP_CONTRACT_OPTIONS } from "./evmAirdropContract.js";

describe(EVM_AIRDROP_CONTRACT_OPTIONS.claimHashFunction, () => {
  it("0 claim", () => {
    expect(
      EVM_AIRDROP_CONTRACT_OPTIONS.claimHashFunction({
        address: 0n,
        id: 0,
        amount: 0n,
      }),
    ).toEqual(
      31859864274020425835881097038141327663329269283844144304447868555582374972449n,
    );
  });

  it("1,2,3 claim", () => {
    expect(
      EVM_AIRDROP_CONTRACT_OPTIONS.claimHashFunction({
        id: 1,
        address: 2n,
        amount: 3n,
      }),
    ).toEqual(
      49776295142305522338649292811956300178326541500117443588869412604416814650524n,
    );
  });

  it("3,1,2 claim", () => {
    expect(
      EVM_AIRDROP_CONTRACT_OPTIONS.claimHashFunction({
        id: 3,
        address: 1n,
        amount: 2n,
      }),
    ).toEqual(
      55647801268087614409780313831438174938825751625758071158119814313480165125404n,
    );
  });
});

describe(EVM_AIRDROP_CONTRACT_OPTIONS.siblingHashFunction, () => {
  it("0, 1", () => {
    expect(EVM_AIRDROP_CONTRACT_OPTIONS.siblingHashFunction(0n, 1n)).toEqual(
      75506153327051474587906755573858019282972751592871715030499431892688993766217n,
    );
    expect(EVM_AIRDROP_CONTRACT_OPTIONS.siblingHashFunction(1n, 0n)).toEqual(
      75506153327051474587906755573858019282972751592871715030499431892688993766217n,
    );
  });

  it("0, 0", () => {
    expect(EVM_AIRDROP_CONTRACT_OPTIONS.siblingHashFunction(0n, 0n)).toEqual(
      78338746147236970124700731725183845421594913511827187288591969170390706184117n,
    );
  });
});
