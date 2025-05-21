export interface Allocation {
  address: bigint;
  amount: bigint;
}

export interface Claim extends Allocation {
  id: number;
}

export type SiblingHashFunction = (left: bigint, right: bigint) => bigint;

export function constructMerkleTree(
  claimHashes: bigint[],
  hashFunction: SiblingHashFunction,
): {
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
