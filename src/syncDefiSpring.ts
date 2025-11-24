import postgres from "postgres";
import { fetchEkuboDefiSpringData } from "./util/defiSpringApi.js";
import { fetchTokens } from "./util/tokens.js";
import { floatToRawValue } from "./util/floatToRawValue.js";

const campaignSlug = "starknet_defi_spring";

const [ekuboIncentivesData, tokens] = await Promise.all([
  fetchEkuboDefiSpringData(
    "https://kx58j6x5me.execute-api.us-east-1.amazonaws.com/starknet/fetchFile?file=strk_grant.json",
  ),
  fetchTokens(0x534e5f4d41494en),
]);

const tokensWithStrkSymbol = tokens.filter((t) => t.symbol === "STRK");

if (tokensWithStrkSymbol.length !== 1) throw new Error("No STRK token found");

const strkToken = tokensWithStrkSymbol[0];

const incentiveRewardPeriodRowData = Object.entries(
  ekuboIncentivesData,
).flatMap(([pair, data]) => {
  const [symbolA, symbolB] = pair.split("/");

  const tokenA = tokens.filter(
    (t) => t.symbol.toUpperCase() === symbolA.toUpperCase(),
  );
  const tokenB = tokens.filter(
    (t) => t.symbol.toUpperCase() === symbolB.toUpperCase(),
  );

  if (tokenA.length !== 1 || tokenB.length !== 1)
    throw new Error(`Unrecognized pair: ${pair}`);

  const [token0, token1] =
    BigInt(tokenA[0].address) < BigInt(tokenB[0].address)
      ? [BigInt(tokenA[0].address), BigInt(tokenB[0].address)]
      : [BigInt(tokenB[0].address), BigInt(tokenA[0].address)];

  return data
    .map((d) => {
      const startDate = new Date(`${d.date}T00:00:00Z`);
      const endDate = new Date(startDate.getTime() + 86_400_000);
      const realizedVolatility = d.thirty_day_realized_volatility;
      const token0RewardAmount = BigInt(
        floatToRawValue(
          "token0_allocation" in d ? d.token0_allocation : d.allocation / 2,
          strkToken.decimals,
        ),
      );
      const token1RewardAmount = BigInt(
        floatToRawValue(
          "token1_allocation" in d ? d.token1_allocation : d.allocation / 2,
          strkToken.decimals,
        ),
      );

      return {
        token0,
        token1,
        startDate,
        endDate,
        realizedVolatility,
        token0RewardAmount,
        token1RewardAmount,
      };
    })
    .filter((d) => d.token0RewardAmount !== 0n || d.token1RewardAmount !== 0n);
});

const sql = postgres({
  ssl: { rejectUnauthorized: false },
  types: { bigint: postgres.BigInt },
});
let rowCount = 0;

try {
  await sql.begin(async (tx) => {
    const [campaign] = await tx<{ id: string }[]>`
    SELECT id
    FROM incentives.campaigns
    WHERE slug = ${campaignSlug}
  `;

    if (!campaign) {
      throw new Error(`Campaign with slug ${campaignSlug} not found`);
    }

    const rowsToInsert = incentiveRewardPeriodRowData.map(
      ({
        token0,
        token1,
        startDate,
        endDate,
        realizedVolatility,
        token0RewardAmount,
        token1RewardAmount,
      }) => [
        campaign.id,
        token0.toString(),
        token1.toString(),
        startDate.toISOString(),
        endDate.toISOString(),
        realizedVolatility,
        token0RewardAmount.toString(),
        token1RewardAmount.toString(),
      ],
    );

    if (rowsToInsert.length > 0) {
      const insertResult = await tx`
      INSERT INTO incentives.campaign_reward_periods (
        campaign_id,
        token0,
        token1,
        start_time,
        end_time,
        realized_volatility,
        token0_reward_amount,
        token1_reward_amount
      )
      VALUES ${tx(rowsToInsert)}
      ON CONFLICT (campaign_id, token0, token1, start_time, end_time)
      DO UPDATE SET
        token0_reward_amount = EXCLUDED.token0_reward_amount,
        token1_reward_amount = EXCLUDED.token1_reward_amount,
        rewards_last_computed_at = NULL
        WHERE 
          (incentives.campaign_reward_periods.token0_reward_amount != EXCLUDED.token0_reward_amount
            OR incentives.campaign_reward_periods.token1_reward_amount != EXCLUDED.token1_reward_amount)
            AND incentives.campaign_reward_periods.id NOT IN (
              SELECT campaign_reward_period_id
              FROM incentives.generated_drop_reward_periods
            );
    `;

      rowCount = insertResult.count ?? insertResult.length ?? 0;
    } else {
      rowCount = 0;
    }
  });

  console.log(`Successfully finished import of ${rowCount} rows`);
} finally {
  await sql.end();
}
