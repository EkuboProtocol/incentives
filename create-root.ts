import { pedersen_from_hex } from "pedersen-fast";
import pg from "pg";

const endDate = process.env.END_DATE
  ? new Date(`${process.env.END_DATE}T00:00:00Z`)
  : new Date(`${new Date().toISOString().split("T")[0]}T00:00:00Z`);

const startDate = process.env.START_DATE
  ? new Date(`${process.env.START_DATE}T00:00:00Z`)
  : new Date(new Date(endDate).getTime() - 86_400_000 * 14);

if (endDate.getTime() <= startDate.getTime())
  throw new Error("END_DATE must be greater than START_DATE");

const client = new pg.Client();
await client.connect();

await client.query(`
    CREATE TABLE IF NOT EXISTS generated_drop
    (
        id           SERIAL PRIMARY KEY,
        root         NUMERIC     NOT NULL,
        start_date   timestamptz NOT NULL,
        end_date     timestamptz NOT NULL,
        generated_at timestamptz DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS generated_drop_proof
    (
        drop_id INT REFERENCES generated_drop (id) ON DELETE CASCADE,
        id      INT       NOT NULL,
        claimee NUMERIC   NOT NULL,
        amount  NUMERIC   NOT NULL,
        proof   NUMERIC[] NOT NULL,
        PRIMARY KEY (drop_id, id, claimee)
    );

    -- meant to be manually populated
    CREATE TABLE IF NOT EXISTS deployed_airdrop_contracts
    (
        address NUMERIC NOT NULL PRIMARY KEY,
        token   NUMERIC NOT NULL,
        drop_id INT REFERENCES generated_drop (id) ON DELETE CASCADE,
        funded  BOOLEAN NOT NULL
    );
`);

await client.query("BEGIN;");
const { rows: rewardsRaw } = await client.query<{
  owner: string;
  total: string;
}>({
  values: [startDate, endDate],
  text: `
      WITH ranked_transfers AS (SELECT token_id,
                                       to_address,
                                       ROW_NUMBER() OVER (
                                           PARTITION BY token_id
                                           ORDER BY event_id DESC
                                           ) AS row_no
                                FROM position_transfers pt
                                         JOIN event_keys ek ON pt.event_id = ek.id
                                         JOIN blocks b ON ek.block_number = b.number
                                WHERE to_address != 0
                                  AND b.time < $2),

           token_owners AS (SELECT token_id,
                                   to_address AS owner
                            FROM ranked_transfers
                            WHERE row_no = 1)

      SELECT owner,
             SUM(incentives) AS total
      FROM strk_defi_spring_incentives
               JOIN token_owners ON token_id = salt
          AND day >= $1 AND day < $2
      GROUP BY owner
  `,
});
await client.query("COMMIT;");

interface Claim {
  id: number;
  claimee: bigint;
  amount: bigint;
}

const HASH_SELECTOR =
  0x01782c4dfd9b809591e597c7a90a503c5db310130ec93790567b00d95ac81da0n;

function computeClaimHash(claim: Claim): bigint {
  return BigInt(
    pedersen_from_hex(
      pedersen_from_hex(
        pedersen_from_hex(
          `0x${HASH_SELECTOR.toString(16)}`,
          `0x${claim.id.toString(16)}`
        ),
        `0x${claim.claimee.toString(16)}`
      ),
      `0x${claim.amount.toString(16)}`
    )
  );
}

// amounts less than 1 STRK are not going to be claimed
const claimsWithHashes: { claim: Claim; hash: bigint }[] = rewardsRaw
  .map(({ owner, total }) => ({
    owner: BigInt(owner),
    total: BigInt(Math.floor(Number(total) * 1e18)),
  }))
  .filter(({ total }) => total >= 10n ** 18n)
  .sort(({ total: a }, { total: b }) => Number(b - a))
  .map(({ total, owner }, ix) => ({ id: ix, claimee: owner, amount: total }))
  .map((claim) => ({ claim, hash: computeClaimHash(claim) }));

// Updated hash function using pedersen_from_hex, assuming it's implemented correctly
function hashFunction(left: bigint, right: bigint): bigint {
  if (left < right) {
    return BigInt(
      pedersen_from_hex(`0x${left.toString(16)}`, `0x${right.toString(16)}`)
    );
  } else {
    return BigInt(
      pedersen_from_hex(`0x${right.toString(16)}`, `0x${left.toString(16)}`)
    );
  }
}

function constructMerkleTree(claimHashes: bigint[]): {
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

function generateProof(claimHash: bigint, layers: bigint[][]): bigint[] {
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

// Example usage:
const { root, layers } = constructMerkleTree(
  claimsWithHashes.map(({ hash }) => hash)
);

const claimsWithProofs = claimsWithHashes.map(({ hash, claim }) => ({
  claim,
  proof: generateProof(hash, layers),
}));

await client.query("BEGIN;");
const {
  rows: [{ id: dropId }],
} = await client.query({
  text: `INSERT INTO generated_drop (root, start_date, end_date)
           VALUES ($1, $2, $3)
           RETURNING id;`,
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
            .join(",")}}')`
      )
      .join(",\n")};
`;

await client.query(insertText);

await client.query("COMMIT;");

await client.end();

console.log("Created drop ID", dropId);
