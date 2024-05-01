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
                                                                       0x02e03baacb2bb218b9f7860e9e3af6fbefa6a9c6efff767936961fe39a9dd91d,
                                                                       0x04cbf563b6bc061f9ceb67bb70105626a96c9fecb6eec047dbf4266b1502652b,
                                                                       0x0370C485054aEFE955c599499bc3BF0404D8D0aB0720d1C120f2C75332a94aD7
                                                           )
                                                       THEN POWER(l.total_points::NUMERIC, ${MODERATOR_POWER}::NUMERIC)
                                                   -- translators
                                                   WHEN l.collector IN (
                                                                        0x02e03baacb2bb218b9f7860e9e3af6fbefa6a9c6efff767936961fe39a9dd91d,
                                                                        0x01C8d2Bb17cdDf22728553c9700ADfBBD42D1999194b409B1188b17191Cc2Efd,
                                                                        0x060d202502c5fF01890Cc70f491aFE85098E962038261Cd3296c80132f4766f6,
                                                                        0x06e87c5bd4e828fa58d12739c6d390f486f02ff73def7ab6c7aee65a25987e63,
                                                                        0x01a4b773Fd67D167f3f769eb24cFCc86409C106036Efebdd38a9005DE734CD0B,
                                                                        0x02Ddb811e7F5CA6891A2bd5e2D09C0a3277C63FA048a3F4c169159E2454890da,
                                                                        0x029d00828f83f93cee2373f4f6747cc64bab7003f21cd428aacc74e2e2543253
                                                       )
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
