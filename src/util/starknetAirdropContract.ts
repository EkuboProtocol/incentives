import { pedersen_from_hex } from "pedersen-fast";
import { Claim } from "./airdrop.js";
import { GenerateAndInsertDropOptions } from "./generateAndInsertDrop.js";

const HASH_SELECTOR =
  0x01782c4dfd9b809591e597c7a90a503c5db310130ec93790567b00d95ac81da0n;

function claimHashFunction(claim: Claim): bigint {
  return BigInt(
    pedersen_from_hex(
      pedersen_from_hex(
        pedersen_from_hex(
          `0x${HASH_SELECTOR.toString(16)}`,
          `0x${claim.id.toString(16)}`,
        ),
        `0x${claim.address.toString(16)}`,
      ),
      `0x${claim.amount.toString(16)}`,
    ),
  );
}

// Updated hash function using pedersen_from_hex, assuming it's implemented correctly
function siblingHashFunction(left: bigint, right: bigint): bigint {
  if (left < right) {
    return BigInt(
      pedersen_from_hex(`0x${left.toString(16)}`, `0x${right.toString(16)}`),
    );
  } else {
    return BigInt(
      pedersen_from_hex(`0x${right.toString(16)}`, `0x${left.toString(16)}`),
    );
  }
}

export const STARKNET_AIRDROP_CONTRACT_OPTIONS: GenerateAndInsertDropOptions = {
  claimHashFunction,
  siblingHashFunction,
};
