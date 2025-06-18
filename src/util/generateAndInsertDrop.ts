import {
  Allocation,
  Claim,
  constructMerkleTree,
  generateProof,
  SiblingHashFunction,
} from "./airdrop.js";
import { Client } from "pg";

export interface GenerateAndInsertDropOptions {
  claimHashFunction(claim: Claim): bigint;
  siblingHashFunction: SiblingHashFunction;
}

export async function generateAndInsertDrop(
  client: Client,
  allocations: Allocation[],
  rewardPeriodIds: (string | bigint)[],
  options: GenerateAndInsertDropOptions
): Promise<number> {
  const claimsWithHashes: { claim: Claim; hash: bigint }[] = allocations
    .map((allocation, ix): Claim => ({ id: ix, ...allocation }))
    .map((claim) => ({
      claim,
      hash: options.claimHashFunction(claim),
    }));

  // Example usage:
  const { root, layers } = constructMerkleTree(
    claimsWithHashes.map(({ hash }) => hash),
    options.siblingHashFunction
  );

  const claimsWithProofs = claimsWithHashes.map(({ hash, claim }) => ({
    claim,
    proof: generateProof(hash, layers),
  }));

  const {
    rows: [{ id: dropId }],
  } = await client.query({
    text: `
      INSERT INTO incentives.generated_drop (root)
      VALUES ($1)
      RETURNING id;
    `,
    values: [root],
  });

  await client.query({
    text: `
      INSERT INTO incentives.generated_drop_reward_periods (drop_id, campaign_reward_period_id)
      VALUES ${rewardPeriodIds.map((rp) => `($1, ${rp})`).join(",\n")};
    `,
    values: [dropId],
  });

  const insertText = `
        INSERT INTO incentives.generated_drop_proof (drop_id, id, address, amount, proof)
        VALUES
        ${claimsWithProofs
          .map(
            ({ claim: { id, address, amount }, proof }) =>
              `(${dropId}, ${id}, ${address}, ${amount}, '{${proof
                .map((p) => p.toString())
                .join(",")}}')`
          )
          .join(",\n")};
    `;

  await client.query(insertText);

  return dropId;
}
