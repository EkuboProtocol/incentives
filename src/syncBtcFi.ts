import initializeIncentivesClient from "./util/initializeIncentivesClient.js";
import { fetchEkuboDefiSpringData } from "./util/defiSpringApi.js";
import { fetchTokens } from "./util/tokens.js";
import { floatToRawValue } from "./util/floatToRawValue.js";
import { fetchEkuboBtcFiData } from "./util/btcFiApi.js";

const campaignSlug = process.env.CAMPAIGN_SLUG || "btcfi_season";

const [ekuboIncentivesData, tokens] = await Promise.all([
  fetchEkuboBtcFiData(
    process.env.BTC_FI_INCENTIVES_URL ||
      "https://www.data-openblocklabs.com/starknet/dex-incentives/ekubo",
  ),
  fetchTokens(
    process.env.TOKENS_URL || "https://starknet-mainnet-api.ekubo.org/tokens",
  ),
]);

const tokensWithStrkSymbol = tokens.filter((t) => t.symbol === "STRK");

if (tokensWithStrkSymbol.length !== 1) throw new Error("No STRK token found");

const strkToken = tokensWithStrkSymbol[0];

const incentiveRewardPeriodRowData = ekuboIncentivesData.items
  .map((d) => {
    try {
      const token0 = tokens.find(
        (t) => BigInt(t.l2_token_address) === BigInt(d.token0_address),
      );
      const token1 = tokens.find(
        (t) => BigInt(t.l2_token_address) === BigInt(d.token1_address),
      );

      if (!token0) throw new Error(`Token not found: ${d.token0_symbol}`);
      if (!token1) throw new Error(`Token not found: ${d.token1_symbol}`);

      if (BigInt(token0.l2_token_address) >= BigInt(token1.l2_token_address)) {
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

const client = await initializeIncentivesClient();

await client.query(`BEGIN;`);

try {
  const {
    rows: [campaign],
  } = await client.query({
    text: `SELECT id
               FROM incentives.campaigns
               WHERE slug = $1`,
    values: [campaignSlug],
  });

  if (!campaign) {
    throw new Error(`Campaign with slug ${campaignSlug} not found`);
  }

  const queryText = `
        INSERT INTO incentives.campaign_reward_periods (campaign_id, token0, token1, start_time, end_time,
                                                        realized_volatility, token0_reward_amount,
                                                        token1_reward_amount, rewards_last_computed_at)
        VALUES
        ${incentiveRewardPeriodRowData
          .map(
            ({
              token0,
              token1,
              startDate,
              endDate,
              realizedVolatility,
              token0RewardAmount,
              token1RewardAmount,
            }) =>
              `(${campaign.id}, ${BigInt(token0.l2_token_address)}, ${BigInt(
                token1.l2_token_address,
              )}, '${startDate.toISOString()}', '${endDate.toISOString()}', ${realizedVolatility}, ${token0RewardAmount}, ${token1RewardAmount}, null)`,
          )
          .join(",\n")}
        ON CONFLICT (campaign_id, token0, token1, start_time, end_time)
        DO UPDATE SET
            token0_reward_amount = EXCLUDED.token0_reward_amount,
            token1_reward_amount = EXCLUDED.token1_reward_amount,
            rewards_last_computed_at = CASE
                WHEN (incentives.campaign_reward_periods.token0_reward_amount != EXCLUDED.token0_reward_amount
                  OR incentives.campaign_reward_periods.token1_reward_amount != EXCLUDED.token1_reward_amount) AND
                  incentives.campaign_reward_periods.id NOT IN (SELECT campaign_reward_period_id FROM incentives.generated_drop_reward_periods)
                THEN NULL
                ELSE incentives.campaign_reward_periods.rewards_last_computed_at
            END;
    `;

  console.log("Running query", queryText);

  const { rowCount } = await client.query({
    text: queryText,
  });

  await client.query(`COMMIT;`);

  console.log(`Successfully finished import of ${rowCount} rows`);
} finally {
  await client.end();
}
