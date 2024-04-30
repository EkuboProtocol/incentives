import client from "./client.js";
import { generateDrop } from "./generate-drop.js";

const power = Number(process.env.POWER ?? "1.000001");
const numTokens = BigInt(process.env.NUM_TOKENS ?? 10n ** 25n / 3n);

await client.connect();

await client.query(`BEGIN;`);
const { rows: claimData } = await client.query<{
  claimee: string;
  amount: string;
}>({
  text: `
      WITH filtered_leaderboard AS (SELECT l.collector, l.rank, POWER(l.total_points::NUMERIC, $1::NUMERIC) AS points
                                    FROM leaderboard_materialized_view l
                                    WHERE l.collector NOT IN
                                          (0x3f60afe30844f556ac1c674678ac4447840b1c6c26854a2df6a8a3d2c015610)
                                      AND l.total_points > 1000),
          
           stats AS (SELECT SUM(points) AS total FROM filtered_leaderboard leaderboard),

           percent_by_collector AS (SELECT l.collector,
                                           l.rank,
                                           (l.points / s.total)::NUMERIC AS percent_of_total
                                    FROM filtered_leaderboard l,
                                         stats s)
      SELECT pbc.collector                             AS claimee,
             FLOOR(pbc.percent_of_total * $2::NUMERIC) AS amount
      FROM percent_by_collector pbc
      ORDER BY rank
  `,
  values: [power, numTokens],
});
await client.query(`COMMIT;`);

await generateDrop(
  claimData.map((c) => ({
    claimee: BigInt(c.claimee),
    amount: BigInt(c.amount),
  })),
  new Date("2023-09-14T00:00:00Z"),
  new Date()
);
await client.end();
