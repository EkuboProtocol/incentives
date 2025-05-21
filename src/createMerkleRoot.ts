import { Allocation } from "./util/airdrop.js";
import { generateAndInsertDrop } from "./util/generateAndInsertDrop.js";
import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import { STARKNET_AIRDROP_CONTRACT_OPTIONS } from "./util/starknetAirdropContract.js";

if (!process.env.START_DATE || !process.env.END_DATE)
  throw new Error("Must specify START_DATE and END_DATE");

const endDate = new Date(`${process.env.END_DATE}T00:00:00Z`);

const startDate = new Date(`${process.env.START_DATE}T00:00:00Z`);

if (endDate.getTime() <= startDate.getTime())
  throw new Error("END_DATE must be greater than START_DATE");

if (endDate.getTime() > Date.now()) {
  throw new Error("END_DATE cannot be in the future");
}

const client = await initializeIncentivesClient();

await client.query("BEGIN;");

const { rows: rewardPeriods } = await client.query<{
  id: string;
  rewards_last_computed_at: string | null;
}>({
  text: `
    SELECT crp.id AS id, crp.rewards_last_computed_at
    FROM incentives.campaign_reward_periods crp
    WHERE crp.start_time BETWEEN $1 AND $2
      AND crp.end_time BETWEEN $1 AND $2
  `,
  values: [startDate, endDate],
});

if (rewardPeriods.length === 0) {
  throw new Error("No reward periods between start and end date");
}

if (rewardPeriods.some((rp) => rp.rewards_last_computed_at === null)) {
  throw new Error(
    `Some reward periods have not been computed: ${rewardPeriods
      .filter((rp) => rp.rewards_last_computed_at === null)
      .map((rp) => rp.id)
      .join(",")}`,
  );
}

const { rows: rewardsRaw } = await client.query<{
  owner: string;
  total: string;
}>({
  text: `
    WITH rewards_by_token AS (SELECT salt::BIGINT       AS token_id,
                                     SUM(reward_amount) AS total
                              FROM incentives.computed_rewards cr
                                     WHERE cr.campaign_reward_period_id in (${rewardPeriods.map((rp) => rp.id).join(", ")})
                              GROUP BY salt),

         ranked_transfers AS (SELECT token_id,
                                     to_address,
                                     ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY event_id DESC) AS row_no
                              FROM position_transfers pt
                                     JOIN event_keys ek ON pt.event_id = ek.id
                                     JOIN blocks b ON ek.block_number = b.number
                              WHERE to_address != 0
                                AND b.time < $1),

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
  values: [endDate],
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

const dropId = await generateAndInsertDrop(
  client,
  amounts,
  rewardPeriods.map((rp) => rp.id),
  STARKNET_AIRDROP_CONTRACT_OPTIONS,
);

console.log("Start date: ", startDate);
console.log("End date: ", endDate);
console.log("Included periods: ", rewardPeriods.map((rp) => rp.id).join(", "));
console.log("Created drop ID: ", dropId);
const rawTotal = amounts.reduce((memo, { amount }) => memo + amount, 0n);
console.log("Raw total: ", rawTotal);
console.log("Formatted amount: ", Number(rawTotal) / 1e18);

await client.end();
