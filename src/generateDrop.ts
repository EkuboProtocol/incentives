import { Allocation } from "./util/airdrop.js";
import { generateAndInsertDrop } from "./util/generateAndInsertDrop.js";
import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import { EVM_AIRDROP_CONTRACT_OPTIONS } from "./util/evmAirdropContract.js";

const client = await initializeIncentivesClient();

const MIN_DROP_SIZE = Number(process.env.MIN_DROP_SIZE ?? 0);
const CAMPAIGNS = process.env.CAMPAIGNS.split(",").map((c) => c.trim());

try {
  for (const slug of CAMPAIGNS) {
    await client.query("BEGIN;");

    const { rows: rewardPeriods } = await client.query<{
      id: string;
      rewards_last_computed_at: Date;
    }>({
      text: `
        SELECT crp.id AS id, crp.rewards_last_computed_at
        FROM incentives.campaign_reward_periods crp
        WHERE crp.campaign_id = (SELECT id FROM incentives.campaigns WHERE slug = $1)
          AND crp.end_time <= CURRENT_TIMESTAMP
          AND crp.id NOT IN (SELECT campaign_reward_period_id FROM incentives.generated_drop_reward_periods)
      `,
      values: [slug],
    });

    if (rewardPeriods.length === 0) {
      console.log(`No reward periods for campaign ${slug}`);
      continue;
    }

    if (rewardPeriods.some((rp) => rp.rewards_last_computed_at === null)) {
      console.log(
        `Some reward periods have not been computed: ${rewardPeriods
          .filter((rp) => rp.rewards_last_computed_at === null)
          .map((rp) => rp.id)
          .join(",")}`,
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
                                WHERE crp.id IN (${rewardPeriods.map((rp) => rp.id).join(", ")})),

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

    await client.query("COMMIT;");

    const amounts: Allocation[] = rewardsRaw
      .map(({ owner, total }) => ({
        owner: BigInt(owner),
        total: BigInt(total),
      }))
      // amounts less than 0.0001 STRK are not included
      .filter(({ total }) => total >= 10n ** 13n)
      .sort(({ total: a }, { total: b }) => Number(b - a))
      .map(({ total, owner }) => ({ address: owner, amount: total }));

    const sum = amounts.reduce((memo, { amount }) => memo + amount, 0n);

    if (Number(sum) < MIN_DROP_SIZE) {
      console.log(
        `Skipping for campaign ${slug} because total ${sum} < ${MIN_DROP_SIZE}`,
      );
      continue;
    }

    const dropId = await generateAndInsertDrop(
      client,
      amounts,
      rewardPeriods.map((rp) => rp.id),
      EVM_AIRDROP_CONTRACT_OPTIONS,
    );

    console.log(
      "Included periods: ",
      rewardPeriods.map((rp) => rp.id).join(", "),
    );
    console.log("Created drop ID: ", dropId);
    console.log("Raw total: ", sum);
    console.log("Formatted amount: ", Number(sum) / 1e18);
  }
} finally {
  await client.end();
}
