import {
  Allocation,
  Claim,
  constructMerkleTree,
  generateProof,
  SiblingHashFunction,
} from "./airdrop.js";
import { Sql } from "postgres";

export interface GenerateAndInsertDropOptions {
  claimHashFunction(claim: Claim): bigint;
  siblingHashFunction: SiblingHashFunction;
}

export async function generateAndInsertDrop(
  sql: Sql<{ bigint: bigint }>,
  allocations: Allocation[],
  rewardPeriodIds: (string | bigint)[],
  options: GenerateAndInsertDropOptions,
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
    options.siblingHashFunction,
  );

  const claimsWithProofs = claimsWithHashes.map(({ hash, claim }) => ({
    claim,
    proof: generateProof(hash, layers),
  }));

  const [{ id: dropId }] = await sql<{ id: number }[]>`
      INSERT INTO incentives.generated_drop (root)
      VALUES (${root.toString()})
      RETURNING id;
    `;

  if (rewardPeriodIds.length > 0) {
    await sql`
      INSERT INTO incentives.generated_drop_reward_periods 
      ${sql(rewardPeriodIds.map((rpid) => ({ drop_id: dropId, campaign_reward_period_id: rpid })))}
    `;
  }

  const proofRows = claimsWithProofs.map(
    ({ claim: { id, address, amount }, proof }) => [
      dropId,
      id,
      address.toString(),
      amount.toString(),
      sql.array(proof.map((p) => p.toString())),
    ],
  );

  if (proofRows.length > 0) {
    await sql`
      INSERT INTO incentives.generated_drop_proof
      ${sql(
        claimsWithProofs.map((pr) => ({
          drop_id: dropId,
          id: pr.claim.id,
          address: pr.claim.address.toString(),
          amount: pr.claim.amount.toString(),
          proof: sql.array(pr.proof.map((p) => p.toString())),
        })),
      )}
    `;
  }

  return dropId;
}
