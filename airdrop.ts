import { pedersen_from_hex } from "pedersen-fast";

export interface Claim {
  id: number;
  claimee: bigint;
  amount: bigint;
}

export type Allocation = Omit<Claim, "id">;

const HASH_SELECTOR =
  0x01782c4dfd9b809591e597c7a90a503c5db310130ec93790567b00d95ac81da0n;

export function computeClaimHash(claim: Claim): bigint {
  return BigInt(
    pedersen_from_hex(
      pedersen_from_hex(
        pedersen_from_hex(
          `0x${HASH_SELECTOR.toString(16)}`,
          `0x${claim.id.toString(16)}`,
        ),
        `0x${claim.claimee.toString(16)}`,
      ),
      `0x${claim.amount.toString(16)}`,
    ),
  );
}

// Updated hash function using pedersen_from_hex, assuming it's implemented correctly
function hashFunction(left: bigint, right: bigint): bigint {
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

export function constructMerkleTree(claimHashes: bigint[]): {
  root: bigint;
  layers: bigint[][];
} {
  const layers = [claimHashes];
  let lastLayer = layers[layers.length - 1];
  while (lastLayer.length > 1) {
    const nextLayer: bigint[] = [];
    for (let i = 0; i < lastLayer.length; i += 2) {
      const left = lastLayer[i];
      const right = lastLayer.length > i + 1 ? lastLayer[i + 1] : lastLayer[i]; // Duplicate if odd number of elements
      nextLayer.push(hashFunction(left, right));
    }
    layers.push(nextLayer);
    lastLayer = nextLayer;
  }
  return {
    root: layers[layers.length - 1][0],
    // remove the last one because it's just the root
    layers: layers.slice(0, layers.length - 1),
  };
}

export function generateProof(claimHash: bigint, layers: bigint[][]): bigint[] {
  let index = layers[0].indexOf(claimHash);
  if (index === -1) {
    throw new Error("Claim hash not found in the tree");
  }

  const proof: bigint[] = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    // if even, the sibling is on the right, and vice versa
    const siblingIndex = index % 2 ? index - 1 : index + 1;
    if (siblingIndex < layer.length) {
      proof.push(layer[siblingIndex]);
    } else {
      // it is instead hashed with itself
      proof.push(layer[index]);
    }
    index = Math.floor(index / 2);
  }
  return proof;
}
