import client from "./client.js";
import { generateDrop } from "./generate-drop.js";

// one-third of total supply
const NUM_TOKENS = 10n ** 25n / 3n;

const BASE_POWER = 1.0001;
const TRANSLATOR_POWER = 1.001;
const MODERATOR_POWER = 1.01;

await client.connect();

await client.query(`BEGIN;`);
const { rows: claimData } = await client.query<{
  claimee: string;
  amount: string;
}>({
  text: `
      WITH filtered_leaderboard AS (SELECT l.collector,
                                           l.rank,
                                           (
                                               CASE
                                                   -- moderators
                                                   WHEN
                                                       l.collector IN (
                                                           0x02e03baacb2bb218b9f7860e9e3af6fbefa6a9c6efff767936961fe39a9dd91d
                                                       )
                                                       THEN POWER(l.total_points::NUMERIC, ${MODERATOR_POWER}::NUMERIC)
                                                   -- translators
                                                   WHEN l.collector IN (0)
                                                       THEN POWER(l.total_points::NUMERIC, ${TRANSLATOR_POWER}::NUMERIC)
                                                   ELSE
                                                       POWER(l.total_points::NUMERIC, ${BASE_POWER}::NUMERIC)
                                                   END
                                               ) AS points
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
             FLOOR(pbc.percent_of_total * $1::NUMERIC) AS amount
      FROM percent_by_collector pbc
      ORDER BY rank
  `,
  values: [NUM_TOKENS],
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
