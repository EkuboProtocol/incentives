import { Allocation } from "./util/airdrop.js";
import { generateAndInsertDrop } from "./util/generateAndInsertDrop.js";
import postgres from "postgres";
import { EVM_AIRDROP_CONTRACT_OPTIONS } from "./util/evmAirdropContract.js";
import { STARKNET_AIRDROP_CONTRACT_OPTIONS } from "./util/starknetAirdropContract.js";

const AIRDROP_CONTRACT_OPTIONS_BY_CHAIN_ID = {
  ["23448594291968334"]: STARKNET_AIRDROP_CONTRACT_OPTIONS,
  ["1"]: EVM_AIRDROP_CONTRACT_OPTIONS,
};

const NumericIntegerType: postgres.PostgresType<bigint> = {
  from: [1700],
  to: 1700,
  parse(v: string) {
    try {
      return BigInt(v);
    } catch (e) {
      throw new Error(`Failed to parse numeric integer type: "${v}"`);
    }
  },
  serialize(v: any) {
    if (typeof v === "string") {
      return v;
    }
    if (typeof v !== "bigint")
      throw new Error(`Unexpected numeric integer type: "${v}"`);
    return v.toString();
  },
};

const sql = postgres({
  ssl: "prefer",
  types: { bigint: postgres.BigInt, numeric: NumericIntegerType },
});

try {
  await sql.begin(async (sql) => {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;`;

    const pendingDrops = await sql<
      {
        chain_id: bigint;
        slug: string;
        minimum_allocation: string;
        period_ids: string[];
        first_start_time: Date;
        last_end_time: Date;
      }[]
    >`
SELECT chain_id,
       slug,
       minimum_allocation,
       period_ids,
       first_start_time,
       last_end_time
FROM incentives.pending_drop_cadences
`;

    for (const {
      chain_id,
      slug,
      period_ids,
      minimum_allocation,
      first_start_time,
      last_end_time,
    } of pendingDrops) {
      const airdropContractOptions =
        AIRDROP_CONTRACT_OPTIONS_BY_CHAIN_ID[chain_id.toString()];
      if (!airdropContractOptions) {
        console.error(
          `Skipping drop for ${slug} because no airdrop contract options for chain id ${chain_id}`,
        );
        continue;
      }

      console.log(
        `Computing drop for ${slug} for periods between ${first_start_time} to ${last_end_time}`,
      );

      const rewardsRaw = await sql<
        {
          owner: string;
          total: string;
        }[]
      >`SELECT recipient as owner, amount as total FROM incentives.drop_allocations(${sql.array(period_ids)})`;

      console.log(`Found ${rewardsRaw.length} recipients`);

      const minimumAllocation = BigInt(minimum_allocation);

      const filteredStats = rewardsRaw.reduce<{
        amount: bigint;
        count: number;
      }>(
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
        sql,
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
    }
  });
} finally {
  await sql.end({ timeout: 5 });
}
