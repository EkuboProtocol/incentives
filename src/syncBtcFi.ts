import postgres from "postgres";
import { fetchEkuboDefiSpringData } from "./util/defiSpringApi.js";
import { fetchTokens } from "./util/tokens.js";
import { floatToRawValue } from "./util/floatToRawValue.js";
import { fetchEkuboBtcFiData } from "./util/btcFiApi.js";

const campaignSlug = "btcfi_season";

const [ekuboIncentivesData, tokens] = await Promise.all([
  fetchEkuboBtcFiData(
    "https://www.data-openblocklabs.com/starknet/dex-incentives/ekubo",
  ),
  fetchTokens(0x534e5f4d41494en),
]);

const tokensWithStrkSymbol = tokens.filter((t) => t.symbol === "STRK");

if (tokensWithStrkSymbol.length !== 1) throw new Error("No STRK token found");

const strkToken = tokensWithStrkSymbol[0];

const incentiveRewardPeriodRowData = ekuboIncentivesData.items
  .map((d) => {
    try {
      const token0 = tokens.find(
        (t) => BigInt(t.address) === BigInt(d.token0_address),
      );
      const token1 = tokens.find(
        (t) => BigInt(t.address) === BigInt(d.token1_address),
      );

      if (!token0) throw new Error(`Token not found: ${d.token0_symbol}`);
      if (!token1) throw new Error(`Token not found: ${d.token1_symbol}`);

      if (BigInt(token0.address) >= BigInt(token1.address)) {
        throw new Error("Invalid sort order");
      }

      const startDate = new Date(`${d.date}T00:00:00Z`);
      const endDate = new Date(startDate.getTime() + 86_400_000);
      const realizedVolatility = d.realized_volatility;
      const token0RewardAmount = BigInt(
        floatToRawValue(d.token0_allocation, strkToken.decimals),
      );
      const token1RewardAmount = BigInt(
        floatToRawValue(d.token1_allocation, strkToken.decimals),
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
    } catch (e) {
      console.error("Failed to parse row: ", d, e);
      throw e;
    }
  })
  .filter((d) => d.token0RewardAmount !== 0n || d.token1RewardAmount !== 0n);

const sql = postgres();
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
        BigInt(token0.address).toString(),
        BigInt(token1.address).toString(),
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
