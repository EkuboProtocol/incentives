import {
  Allocation,
  Claim,
  constructMerkleTree,
  generateProof,
  SiblingHashFunction,
} from "./airdrop.js";
import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

export interface GenerateAndInsertDropOptions {
  claimHashFunction(claim: Claim): bigint;
  siblingHashFunction: SiblingHashFunction;
}

export async function generateAndInsertDrop(
  sql: SqlClient,
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
      VALUES (${root})
      RETURNING id;
    `;

  if (rewardPeriodIds.length > 0) {
    await sql`
      INSERT INTO incentives.generated_drop_reward_periods (drop_id, campaign_reward_period_id)
      VALUES ${sql(rewardPeriodIds.map((rp) => [dropId, rp]))};
    `;
  }

  const proofRows = claimsWithProofs.map(
    ({ claim: { id, address, amount }, proof }) => [
      dropId,
      id,
      address,
      amount,
      sql.array(proof.map((p) => p.toString())),
    ],
  );

  if (proofRows.length > 0) {
    await sql`
      INSERT INTO incentives.generated_drop_proof (drop_id, id, address, amount, proof)
      VALUES ${sql(proofRows)};
    `;
  }

  return dropId;
}
