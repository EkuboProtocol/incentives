import { Allocation } from "./util/airdrop.js";
import { generateAndInsertDrop } from "./util/generateAndInsertDrop.js";
import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import { EVM_AIRDROP_CONTRACT_OPTIONS } from "./util/evmAirdropContract.js";
import { STARKNET_AIRDROP_CONTRACT_OPTIONS } from "./util/starknetAirdropContract.js";

const AIRDROP_CONTRACT_OPTIONS_BY_NETWORK_TYPE = {
  STARKNET: STARKNET_AIRDROP_CONTRACT_OPTIONS,
  EVM: EVM_AIRDROP_CONTRACT_OPTIONS,
};

const airdropContractOptions =
  AIRDROP_CONTRACT_OPTIONS_BY_NETWORK_TYPE[process.env.NETWORK_TYPE];

if (!airdropContractOptions) {
  throw new Error(
    `NETWORK_TYPE must be one of ${Object.keys(
      AIRDROP_CONTRACT_OPTIONS_BY_NETWORK_TYPE
    ).join(", ")}`
  );
}

const client = await initializeIncentivesClient();

try {
  await client.query("BEGIN;");
  await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;");

  const { rows: pendingDrops } = await client.query<{
    slug: string;
    minimum_allocation: string;
    period_ids: string[];
  }>({
    text: `
      WITH campaign_info AS (
        SELECT
          id,
          slug,
          minimum_allocation,
          start_time,
          distribution_cadence,
          floor(extract(epoch FROM CURRENT_TIMESTAMP - start_time) / extract(epoch FROM distribution_cadence)) AS num_distributions
        FROM
          incentives.campaigns
      ),
      cadences AS (
        SELECT
          id AS campaign_id,
          cadence_id,
          (start_time + distribution_cadence * cadence_id) AS start_time,
          (start_time + distribution_cadence * (cadence_id + 1)) AS end_time
        FROM
          campaign_info,
          generate_series(0, num_distributions - 1) AS cadence_id
      ),
      cadence_periods AS (
        SELECT
          c.campaign_id,
          c.cadence_id,
          array_agg(crp.id ORDER BY crp.start_time) AS period_ids,
          min(crp.start_time) first_start_time,
          max(crp.end_time) last_end_time
        FROM
          incentives.campaign_reward_periods crp
          JOIN cadences c ON crp.campaign_id = c.campaign_id
            AND crp.start_time BETWEEN c.start_time AND c.end_time
            AND crp.end_time BETWEEN c.start_time AND c.end_time
        WHERE
          crp.rewards_last_computed_at IS NOT NULL
          AND crp.id NOT IN (
            SELECT
              campaign_reward_period_id
            FROM
              incentives.generated_drop_reward_periods)
          GROUP BY
            c.campaign_id,
            cadence_id
      )
      SELECT
        ci.slug,
        ci.minimum_allocation,
        cp.period_ids
      FROM
        cadence_periods cp
        JOIN cadences c ON cp.campaign_id = c.campaign_id
          AND cp.cadence_id = c.cadence_id
        JOIN campaign_info ci ON c.campaign_id = ci.id;
      `,
  });

  for (const { slug, period_ids, minimum_allocation } of pendingDrops) {
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

    const filteredStats = rewardsRaw.reduce<{ amount: bigint; count: number }>(
      (memo, { total }) => {
        const filtered = BigInt(total) < minimumAllocation;
        if (filtered) {
          return {
            count: memo.count + 1,
            amount: memo.amount + BigInt(total),
          };
        } else {
          return memo;
        }
      },
      { amount: 0n, count: 0 }
    );

    const amounts: Allocation[] = rewardsRaw
      .map(({ owner, total }) => ({
        owner: BigInt(owner),
        total: BigInt(total),
      }))
      .filter(({ total }) => total >= minimumAllocation)
      .sort(({ total: a }, { total: b }) => Number(b - a))
      .map(({ total, owner }) => ({ address: owner, amount: total }));

    if (amounts.length === 0) {
      console.log(
        `No allocations met the threshold for the following periods: ${period_ids.join(
          ", "
        )}`
      );
      continue;
    }

    const sum = amounts.reduce((memo, { amount }) => memo + amount, 0n);

    const dropId = await generateAndInsertDrop(
      client,
      amounts,
      period_ids,
      airdropContractOptions
    );

    console.log("Campaign: ", slug);
    console.log("Periods: ", period_ids.join(", "));
    console.log("Created drop ID: ", dropId);
    console.log("Raw total: ", sum);
    console.log("Minimum allocation: ", Number(minimumAllocation) / 1e18);
    console.log("Filtered out: ", filteredStats);
    console.log("Formatted amount: ", Number(sum) / 1e18);
  }

  await client.query("COMMIT;");
} finally {
  await client.end();
}
