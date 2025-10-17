import { Allocation } from "./util/airdrop.js";
import { generateAndInsertDrop } from "./util/generateAndInsertDrop.js";
import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import { EVM_AIRDROP_CONTRACT_OPTIONS } from "./util/evmAirdropContract.js";
import { STARKNET_AIRDROP_CONTRACT_OPTIONS } from "./util/starknetAirdropContract.js";
import { uploadCsvToTelegram } from "./util/telegramCsvUpload.js";

const AIRDROP_CONTRACT_OPTIONS_BY_NETWORK_TYPE = {
  STARKNET: STARKNET_AIRDROP_CONTRACT_OPTIONS,
  EVM: EVM_AIRDROP_CONTRACT_OPTIONS,
};

const airdropContractOptions =
  AIRDROP_CONTRACT_OPTIONS_BY_NETWORK_TYPE[process.env.NETWORK_TYPE];

if (!airdropContractOptions) {
  throw new Error(
    `NETWORK_TYPE must be one of ${Object.keys(
      AIRDROP_CONTRACT_OPTIONS_BY_NETWORK_TYPE,
    ).join(", ")}`,
  );
}

const POSITIONS_LOCKER_ADDRESS = BigInt(
  process.env.POSITIONS_LOCKER_ADDRESS ?? 0,
);

if (!POSITIONS_LOCKER_ADDRESS) {
  throw new Error(`Missing "POSITIONS_LOCKER_ADDRESS" env variable`);
}

const DATABASE = process.env.PGDATABASE ?? "unknown";
const NETWORK_TYPE = process.env.NETWORK_TYPE ?? "unknown";

const client = await initializeIncentivesClient();

try {
  await client.query("BEGIN;");
  await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;");

  const { rows: pendingDrops } = await client.query<{
    slug: string;
    minimum_allocation: string;
    period_ids: string[];
    first_start_time: Date;
    last_end_time: Date;
  }>({
    text: `
      WITH campaign_info AS (
        SELECT
          id,
          slug,
          minimum_allocation,
          start_time,
          end_time,
          distribution_cadence,
          floor(extract(epoch FROM CURRENT_TIMESTAMP - start_time) / extract(epoch FROM distribution_cadence)) AS num_distributions
        FROM
          incentives.campaigns
      ),
      cadences AS (
        SELECT
          id AS campaign_id,
          cadence_id,
          (
            CASE WHEN cadence_id = 0 THEN
            (
              SELECT
                min(crp2.start_time)
              FROM
                incentives.campaign_reward_periods crp2
              WHERE
                crp2.campaign_id = ci.id)
            ELSE
              start_time + distribution_cadence * cadence_id
            END) AS start_time,
        LEAST ((start_time + distribution_cadence * (cadence_id + 1)), ci.end_time) AS end_time
      FROM
        campaign_info ci,
        generate_series(0, num_distributions) AS cadence_id
      ),
      cadence_periods AS (
        SELECT
          c.campaign_id,
          c.cadence_id,
          array_agg(crp.id ORDER BY crp.start_time) AS period_ids,
          array_agg(crp.rewards_last_computed_at IS NOT NULL) AS has_been_computed,
          array_agg(crp.id IN (
              SELECT
                campaign_reward_period_id
              FROM incentives.generated_drop_reward_periods)) AS has_been_dropped,
          min(crp.start_time) first_start_time,
          max(crp.end_time) last_end_time
        FROM
          incentives.campaign_reward_periods crp
          JOIN cadences c ON crp.campaign_id = c.campaign_id
            AND crp.start_time >= c.start_time
            AND crp.start_time <= c.end_time
            AND crp.end_time >= c.start_time
            AND crp.end_time <= c.end_time
        GROUP BY
          c.campaign_id,
          cadence_id
      )
      SELECT
        ci.slug,
        ci.minimum_allocation,
        cp.period_ids,
        cp.first_start_time,
        cp.last_end_time
      FROM
        cadence_periods cp
        JOIN cadences c ON cp.campaign_id = c.campaign_id
          AND cp.cadence_id = c.cadence_id
        JOIN campaign_info ci ON c.campaign_id = ci.id
      WHERE
        TRUE = ALL (cp.has_been_computed)
        AND FALSE = ALL (cp.has_been_dropped)
        AND cp.first_start_time = c.start_time
        AND cp.last_end_time = c.end_time;
      `,
  });

  for (const {
    slug,
    period_ids,
    minimum_allocation,
    first_start_time,
    last_end_time,
  } of pendingDrops) {
    console.log(
      `Computing drop for ${slug} for periods between ${first_start_time} to ${last_end_time}`,
    );

    const { rows: rewardsRaw } = await client.query<{
      owner: string;
      total: string;
    }>({
      values: [POSITIONS_LOCKER_ADDRESS],
      text: `
        WITH reward_periods AS (
          SELECT
            id,
            end_time
          FROM
            incentives.campaign_reward_periods crp
          WHERE
            crp.id IN (${period_ids.join(", ")})
        ),
        rewards_by_locker_salt AS (
          SELECT
            locker,
            salt,
            sum(reward_amount) AS total
          FROM
            incentives.computed_rewards cr
          WHERE
            cr.campaign_reward_period_id IN (
              SELECT
                id
              FROM
                reward_periods)
            GROUP BY
              locker,
              salt
        ),
        last_reward_period_end_time AS (
          SELECT
            max(end_time) AS last_end_time
        FROM
          reward_periods
        ),
        ranked_transfers AS (
          SELECT
            token_id,
            to_address,
            row_number() OVER (PARTITION BY token_id ORDER BY event_id DESC) AS row_no
        FROM
          position_transfers pt
          JOIN event_keys ek ON pt.event_id = ek.id
          JOIN blocks b ON ek.block_number = b.number,
          last_reward_period_end_time
          WHERE
            to_address != 0
            AND b.time < last_reward_period_end_time.last_end_time
        ),
        token_owners AS (
          SELECT
            token_id,
            to_address AS owner
          FROM
            ranked_transfers
          WHERE
            row_no = 1
        )
        SELECT
          coalesce(t_o.owner, rbls.locker) AS owner,
          floor(sum(rbls.total)) AS total
        FROM
          rewards_by_locker_salt rbls
          LEFT JOIN token_owners t_o ON t_o.token_id = rbls.salt AND rbls.locker = $1
        GROUP BY
          1
        ORDER BY
          2 DESC
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
      { amount: 0n, count: 0 },
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
          ", ",
        )}`,
      );
      continue;
    }

    const sum = amounts.reduce((memo, { amount }) => memo + amount, 0n);

    const dropId = await generateAndInsertDrop(
      client,
      amounts,
      period_ids,
      airdropContractOptions,
    );

    console.log("Campaign: ", slug);
    console.log("Periods: ", period_ids.join(", "));
    console.log("First start time: ", first_start_time);
    console.log("Last end time: ", last_end_time);
    console.log("Created drop ID: ", dropId);
    console.log("Raw total: ", sum);
    console.log("Minimum allocation: ", Number(minimumAllocation) / 1e18);
    console.log("Filtered out: ", filteredStats);
    console.log("Formatted amount: ", Number(sum) / 1e18);

    await uploadCsvToTelegram(amounts, {
      slug,
      dropId,
      periodIds: period_ids,
      firstStartTime: first_start_time,
      lastEndTime: last_end_time,
      minimumAllocation,
      filteredStats,
      database: DATABASE,
      networkType: NETWORK_TYPE,
    });
  }

  await client.query("COMMIT;");
} finally {
  await client.end();
}
