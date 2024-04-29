import { Allocation } from "./airdrop.js";
import client from "./client.js";
import { generateDrop } from "./generate-drop.js";

const endDate = process.env.END_DATE
  ? new Date(`${process.env.END_DATE}T00:00:00Z`)
  : new Date(`${new Date().toISOString().split("T")[0]}T00:00:00Z`);

const startDate = process.env.START_DATE
  ? new Date(`${process.env.START_DATE}T00:00:00Z`)
  : new Date(new Date(endDate).getTime() - 86_400_000 * 14);

if (endDate.getTime() <= startDate.getTime())
  throw new Error("END_DATE must be greater than START_DATE");

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
        drop_id INT REFERENCES generated_drop (id) ON DELETE CASCADE
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

const amounts: Allocation[] = rewardsRaw
  .map(({ owner, total }) => ({
    owner: BigInt(owner),
    total: BigInt(Math.floor(Number(total) * 1e18)),
  }))
  // amounts less than 1 STRK are not included
  .filter(({ total }) => total >= 10n ** 18n)
  .sort(({ total: a }, { total: b }) => Number(b - a))
  .map(({ total, owner }) => ({ claimee: owner, amount: total }));

const dropId = await generateDrop(amounts, startDate, endDate);

console.log("Created drop ID", dropId);

await client.end();
