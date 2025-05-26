import { Claim } from "./airdrop.js";
import { GenerateAndInsertDropOptions } from "./generateAndInsertDrop.js";
import { encodeAbiParameters, keccak256, toHex } from "viem";

function claimHashFunction(claim: Claim): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [
          { name: "index", type: "uint256" },
          { name: "account", type: "address" },
          { name: "amount", type: "uint128" },
        ],
        [BigInt(claim.id), toHex(claim.address, { size: 20 }), claim.amount],
      ),
    ),
  );
}

// Updated hash function using pedersen_from_hex, assuming it's implemented correctly
function siblingHashFunction(a: bigint, b: bigint): bigint {
  if (a < b) {
    return BigInt(
      keccak256(
        encodeAbiParameters(
          [
            { name: "left", type: "bytes32" },
            { name: "right", type: "bytes32" },
          ],
          [toHex(a, { size: 32 }), toHex(b, { size: 32 })],
        ),
      ),
    );
  } else {
    return BigInt(
      keccak256(
        encodeAbiParameters(
          [
            { name: "left", type: "bytes32" },
            { name: "right", type: "bytes32" },
          ],
          [toHex(b, { size: 32 }), toHex(a, { size: 32 })],
        ),
      ),
    );
  }
}

export const EVM_AIRDROP_CONTRACT_OPTIONS: GenerateAndInsertDropOptions = {
  claimHashFunction,
  siblingHashFunction,
};
