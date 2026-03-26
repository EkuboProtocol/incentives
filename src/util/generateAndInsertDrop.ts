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

export async function generateAndInsertClaimsDrop(
  sql: Sql<{ bigint: bigint; numeric: bigint }>,
  claims: Claim[],
  rewardPeriodIds: (string | bigint)[],
  options: GenerateAndInsertDropOptions,
): Promise<number> {
  const claimsWithHashes: { claim: Claim; hash: bigint }[] = claims.map(
    (claim) => ({
      claim,
      hash: options.claimHashFunction(claim),
    }),
  );

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

  if (claimsWithProofs.length > 0) {
    await sql`
      INSERT INTO incentives.generated_drop_proof
      ${sql(
        claimsWithProofs.map(({ claim: { id, address, amount }, proof }) => ({
          drop_id: dropId,
          id: id,
          address: address.toString(),
          amount: amount.toString(),
          proof: sql.array(proof.map((p) => sql.typed(BigInt(p), 1700))),
        })),
      )}
    `;
  }

  return dropId;
}

export async function generateAndInsertDrop(
  sql: Sql<{ bigint: bigint; numeric: bigint }>,
  allocations: Allocation[],
  rewardPeriodIds: (string | bigint)[],
  options: GenerateAndInsertDropOptions,
): Promise<number> {
  return generateAndInsertClaimsDrop(
    sql,
    allocations.map((allocation, ix): Claim => ({ id: ix, ...allocation })),
    rewardPeriodIds,
    options,
  );
}
