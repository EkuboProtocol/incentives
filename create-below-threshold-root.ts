import { Allocation } from "./airdrop.js";
import { generateDrop } from "./generate-drop.js";
import initializeClient from "./initializeClient.js";

const endDate = process.env.END_DATE
  ? new Date(`${process.env.END_DATE}T00:00:00Z`)
  : new Date(`${new Date().toISOString().split("T")[0]}T00:00:00Z`);

const startDate = process.env.START_DATE
  ? new Date(`${process.env.START_DATE}T00:00:00Z`)
  : new Date("2024-02-22T00:00:00Z");

const threshold = Number(process.env.THRESHOLD ?? 1);

if (endDate.getTime() <= startDate.getTime())
  throw new Error("END_DATE must be greater than START_DATE");

const client = await initializeClient();

await client.query("BEGIN;");
const { rows: rewardsRaw } = await client.query<{
  owner: string;
  total: string;
}>({
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
                            WHERE row_no = 1),

           binned AS (SELECT owner,
                             date_bin(INTERVAL '2 weeks', day, '2024-02-22T00:00:00Z') AS period_start,
                             SUM(incentives)                                           AS period_total
                      FROM strk_defi_spring_incentives
                               JOIN token_owners ON token_id = salt
                      WHERE day >= $1
                        AND day < $2
                      GROUP BY owner, period_start),
           grouped AS (SELECT owner, SUM(period_total) AS total
                       FROM binned
                       WHERE period_total < $3
                       GROUP BY owner)
      SELECT owner, total
      FROM grouped
      WHERE total > 0;
  `,
  values: [startDate, endDate, threshold],
});
await client.query("COMMIT;");

const amounts: Allocation[] = rewardsRaw
  .map(({ owner, total }) => ({
    owner: BigInt(owner),
    total: BigInt(Math.floor(Number(total) * 1e18)),
  }))
  .sort(({ total: a }, { total: b }) => Number(b - a))
  .map(({ total, owner }) => ({ claimee: owner, amount: total }));

const dropId = await generateDrop(client, amounts, startDate, endDate);

console.log("Created drop ID", dropId);

await client.end();
