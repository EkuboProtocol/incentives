import { Allocation } from "./util/airdrop.js";
import { generateAndInsertDrop } from "./util/generateAndInsertDrop.js";
import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import { EVM_AIRDROP_CONTRACT_OPTIONS } from "./util/evmAirdropContract.js";

const client = await initializeIncentivesClient();

try {
  await client.query("BEGIN;");
  await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;");

  const { rows: pendingDrops } = await client.query<{
    slug: string;
    minimum_allocation: string;
    cadence_id: number;
    period_ids: string[];
    has_been_computed: boolean[];
  }>({
    text: `
        SELECT
          c.slug,
          c.minimum_allocation,
          (
            (
              FLOOR(
                EXTRACT(
                  epoch
                  FROM
                    (crp.end_time - c.start_time)
                ) / EXTRACT(
                  epoch
                  FROM
                    c.distribution_cadence
                )
              ) + 1
            )::INT
          ) AS cadence_id,
          ARRAY_AGG(
            crp.id
            ORDER BY
              crp.start_time
          ) AS period_ids,
          ARRAY_AGG(
            crp.rewards_last_computed_at IS NOT NULL
            ORDER BY
              crp.start_time
          ) AS has_been_computed
        FROM
          incentives.campaign_reward_periods crp
          JOIN incentives.campaigns c ON crp.campaign_id = c.id
        WHERE
          crp.end_time <= NOW()
          -- only cadences whose boundary has fully lapsed
          AND (
            c.start_time + (
              (
                FLOOR(
                  EXTRACT(
                    epoch
                    FROM
                      (crp.end_time - c.start_time)
                  ) / EXTRACT(
                    epoch
                    FROM
                      c.distribution_cadence
                  )
                ) + 1
              ) * c.distribution_cadence
            )
          ) <= NOW()
          AND crp.id NOT IN (
            SELECT
              campaign_reward_period_id
            FROM
              incentives.generated_drop_reward_periods
          )
        GROUP BY
          c.slug,
          c.minimum_allocation,
          cadence_id
        ORDER BY
          c.slug,
          cadence_id;
      `,
  });

  for (const {
    slug,
    period_ids,
    minimum_allocation,
    has_been_computed,
  } of pendingDrops) {
    if (!has_been_computed.every((is_computed) => is_computed)) {
      console.log(
        `Some reward periods have not been computed for cadence: ${period_ids
          .filter((_, ix) => !has_been_computed[ix])
          .join(", ")}`
      );
      continue;
    }

    const { rows: rewardsRaw } = await client.query<{
      owner: string;
      total: string;
    }>({
      text: `
          WITH reward_periods AS (SELECT id, end_time
                                  FROM incentives.campaign_reward_periods crp
                                  WHERE crp.id IN (${period_ids.join(", ")})),

              rewards_by_token AS (SELECT salt               AS token_id,
                                          SUM(reward_amount) AS total
                                    FROM incentives.computed_rewards cr
                                    WHERE cr.campaign_reward_period_id IN (SELECT id FROM reward_periods)
                                    GROUP BY salt),

              last_reward_period_end_time AS (SELECT MAX(end_time) AS last_end_time
                                              FROM reward_periods),

              ranked_transfers AS (SELECT token_id,
                                          to_address,
                                          ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY event_id DESC) AS row_no
                                    FROM position_transfers pt
                                          JOIN event_keys ek ON pt.event_id = ek.id
                                          JOIN blocks b ON ek.block_number = b.number,
                                        last_reward_period_end_time
                                    WHERE to_address != 0
                                      AND b.time < last_reward_period_end_time.last_end_time),

              token_owners AS (SELECT token_id,
                                      to_address AS owner
                                FROM ranked_transfers
                                WHERE row_no = 1)

          SELECT owner,
                FLOOR(SUM(rbt.total)) AS total
          FROM rewards_by_token rbt
                JOIN token_owners t_o ON t_o.token_id = rbt.token_id
          GROUP BY t_o.owner
          ORDER BY 2 DESC
        `,
    });

    const minimumAllocation = BigInt(minimum_allocation);

    const amounts: Allocation[] = rewardsRaw
      .map(({ owner, total }) => ({
        owner: BigInt(owner),
        total: BigInt(total),
      }))
      .filter(({ total }) => total >= minimumAllocation)
      .sort(({ total: a }, { total: b }) => Number(b - a))
      .map(({ total, owner }) => ({ address: owner, amount: total }));

    const sum = amounts.reduce((memo, { amount }) => memo + amount, 0n);

    const dropId = await generateAndInsertDrop(
      client,
      amounts,
      period_ids,
      EVM_AIRDROP_CONTRACT_OPTIONS
    );

    console.log("Campaign: ", slug);
    console.log("Periods: ", period_ids.join(", "));
    console.log("Created drop ID: ", dropId);
    console.log("Raw total: ", sum);
    console.log("Minimum allocation: ", minimumAllocation);
    console.log("Formatted amount: ", Number(sum) / 1e18);
  }

  await client.query("COMMIT;");
} finally {
  await client.end();
}
