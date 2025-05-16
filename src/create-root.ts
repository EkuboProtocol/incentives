import { Allocation } from "./util/airdrop.js";
import { generateDrop } from "./util/generate-drop.js";
import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import { STARKNET_AIRDROP_CONTRACT_OPTIONS } from "./util/starknetAirdropContract.js";

const endDate = process.env.END_DATE
  ? new Date(`${process.env.END_DATE}T00:00:00Z`)
  : new Date(`${new Date().toISOString().split("T")[0]}T00:00:00Z`);

const startDate = process.env.START_DATE
  ? new Date(`${process.env.START_DATE}T00:00:00Z`)
  : new Date(new Date(endDate).getTime() - 86_400_000 * 14);

if (endDate.getTime() <= startDate.getTime())
  throw new Error("END_DATE must be greater than START_DATE");

const client = await initializeIncentivesClient();

await client.query("BEGIN;");
const { rows: rewardsRaw } = await client.query<{
  owner: string;
  total: string;
}>({
  values: [startDate, endDate],
  text: `
        WITH rewards_by_token AS (SELECT salt::BIGINT    AS token_id,
                                         SUM(incentives) AS total
                                  FROM strk_defi_spring_incentives
                                  WHERE day >= $1
                                    AND day < $2
                                  GROUP BY salt),

             ranked_transfers AS (SELECT token_id,
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
                              WHERE row_no = 1)

        SELECT owner,
               SUM(rbt.total) AS total
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
    total: BigInt(Math.floor(Number(total) * 1e18)),
  }))
  // amounts less than 0.0001 STRK are not included
  .filter(({ total }) => total >= 10n ** 13n)
  .sort(({ total: a }, { total: b }) => Number(b - a))
  .map(({ total, owner }) => ({ claimee: owner, amount: total }));

const dropId = await generateDrop(
  client,
  amounts,
  startDate,
  endDate,
  STARKNET_AIRDROP_CONTRACT_OPTIONS,
);

console.log("Created drop ID: ", dropId);

const rawTotal = amounts.reduce((memo, { amount }) => memo + amount, 0n);
console.log("Raw total: ", rawTotal);
console.log("Formatted amount: ", Number(rawTotal) / 1e18);

await client.end();
