import {
  Allocation,
  Claim,
  computeClaimHash,
  constructMerkleTree,
  generateProof,
} from "./airdrop.js";
import { Client } from "pg";

export async function generateDrop(
  client: Client,
  allocations: Allocation[],
  startDate: Date,
  endDate: Date,
): Promise<number> {
  const claimsWithHashes: { claim: Claim; hash: bigint }[] = allocations
    .map((c, ix): Claim => ({ id: ix, ...c }))
    .map((claim, ix) => ({ claim, hash: computeClaimHash(claim) }));

  // Example usage:
  const { root, layers } = constructMerkleTree(
    claimsWithHashes.map(({ hash }) => hash),
  );

  const claimsWithProofs = claimsWithHashes.map(({ hash, claim }) => ({
    claim,
    proof: generateProof(hash, layers),
  }));

  await client.query("BEGIN;");
  const {
    rows: [{ id: dropId }],
  } = await client.query({
    text: `
      INSERT INTO generated_drop (root, start_date, end_date)
      VALUES ($1, $2, $3)
      RETURNING id;
    `,
    values: [root, startDate, endDate],
  });

  const insertText = `
    INSERT INTO generated_drop_proof (drop_id, id, claimee, amount, proof)
    VALUES
    ${claimsWithProofs
      .map(
        ({ claim: { id, claimee, amount }, proof }) =>
          `(${dropId}, ${id}, ${claimee}, ${amount}, '{${proof
            .map((p) => p.toString())
            .join(",")}}')`,
      )
      .join(",\n")};
  `;

  await client.query(insertText);

  await client.query("COMMIT;");

  return dropId;
}
