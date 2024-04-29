import client from "./client.js";
import { generateDrop } from "./generate-drop.js";

const power = Number(process.env.POWER ?? "1.000001");
const numTokens = BigInt(process.env.NUM_TOKENS ?? "2000000");

await client.connect();

await client.query(`BEGIN;`);
const { rows: claimData } = await client.query<{
  owner: string;
  numTokens: string;
}>({
  text: `
      WITH stats AS (SELECT SUM(POWER(l2.total_points::NUMERIC, $1::NUMERIC)) AS all_user_total
                     FROM leaderboard_materialized_view l2
                     WHERE l2.collector NOT IN
                           (0x3f60afe30844f556ac1c674678ac4447840b1c6c26854a2df6a8a3d2c015610)),

           percent_by_collector AS (SELECT l1.collector,
                                           l1.rank,
                                           (POWER(l1.total_points::NUMERIC, $1::NUMERIC) / s.all_user_total) AS percent
                                    FROM leaderboard_materialized_view l1,
                                         stats s
                                    WHERE l1.collector NOT IN
                                          (0x3f60afe30844f556ac1c674678ac4447840b1c6c26854a2df6a8a3d2c015610))
      SELECT pbc.collector                                               AS owner,
             FLOOR((pbc.percent * :num_tokens::NUMERIC) * 1e18::NUMERIC) AS amount
      FROM percent_by_collector pbc
      ORDER BY rank
  `,
  values: [power, numTokens],
});
await client.query(`COMMIT;`);

await generateDrop(
  claimData.map((c) => ({
    amount: BigInt(c.numTokens),
    claimee: BigInt(c.owner),
  })),
  new Date("2023-09-14T00:00:00Z"),
  new Date()
);
await client.end();
