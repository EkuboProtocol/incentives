import initializeIncentivesClient from "./initializeIncentivesClient.js";

const campaignSlug = process.env.CAMPAIGN_SLUG ?? "starknet_defi_spring";

const incentiveDataResponse = await fetch(
  process.env.DEFI_SPRING_INCENTIVES_URL ??
    "https://kx58j6x5me.execute-api.us-east-1.amazonaws.com/starknet/fetchFile?file=strk_grant.json",
);

if (!incentiveDataResponse.ok) {
  throw new Error(
    `Failed to fetch incentive data: ${await incentiveDataResponse.text()}`,
  );
}

const tokensResponse = await fetch(
  process.env.TOKENS_URL ?? "https://starknet-mainnet-api.ekubo.org/tokens",
);

if (!tokensResponse.ok) {
  throw new Error(
    `Failed to fetch tokens data: ${await tokensResponse.text()}`,
  );
}

interface Token {
  name: string;
  symbol: string;
  decimals: number;
  l2_token_address: string;
  sort_order: number;
  total_supply: number | null;
  logo_url: string;
}

const tokensJson = (await tokensResponse.json()) as Token[];

// common pool data shape
interface PoolData {
  date: string;
  allocation: number;
  token0_allocation: number;
  token1_allocation: number;
  thirty_day_realized_volatility: number;
  tvl_usd: number;
  apr: number;
}

// generic per-exchange mapping of pair ⇒ data[]
type ExchangeData = Record<`${string}/${string}`, PoolData[]>;

interface ApiResponse {
  Ekubo: ExchangeData;
  MySwap: ExchangeData;
  Haiko: ExchangeData;
  "10kSwap": ExchangeData;
  StarkDefi: ExchangeData;
  Sithswap: ExchangeData;
  Nostra: ExchangeData;
  Jediswap_v1: ExchangeData;
  Jediswap_v2: ExchangeData;
  Haiko_Solvers: ExchangeData;
}

const incentiveData = (await incentiveDataResponse.json()) as ApiResponse;

const ekuboIncentivesData = incentiveData.Ekubo;

const incentiveRwardPeriodRowData = Object.entries(ekuboIncentivesData).flatMap(
  ([pair, data]) => {
    if (pair === "Discretionary") return [];

    const [symbolA, symbolB] = pair.split("/");

    const tokenA = tokensJson.find((t) => t.symbol.toUpperCase() === symbolA);
    const tokenB = tokensJson.find((t) => t.symbol.toUpperCase() === symbolB);

    if (!tokenA || !tokenB) throw new Error(`Unrecognized pair: ${pair}`);

    const [token0, token1] =
      BigInt(tokenA.l2_token_address) < BigInt(tokenB.l2_token_address)
        ? [BigInt(tokenA.l2_token_address), BigInt(tokenB.l2_token_address)]
        : [BigInt(tokenB.l2_token_address), BigInt(tokenA.l2_token_address)];

    const strkToken = tokensJson.find((t) => t.symbol === "STRK");

    return data.map((d) => {
      const startDate = new Date(`${d.date}T00:00:00Z`);
      const endDate = new Date(startDate.getTime() + 86_400_000);
      const realizedVolatility = d.thirty_day_realized_volatility;
      const token0RewardAmount = BigInt(
        d.token0_allocation * 10 ** strkToken.decimals,
      );
      const token1RewardAmount = BigInt(
        d.token1_allocation * 10 ** strkToken.decimals,
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
    });
  },
);

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

  const { rowCount } = await client.query({
    text: `
        INSERT INTO incentives.campaign_reward_periods (campaign_id, token0, token1, start_time, end_time,
                                                        realized_volatility, token0_reward_amount,
                                                        token1_reward_amount)
        VALUES
        ${incentiveRwardPeriodRowData
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
              `(${campaign.id}, ${token0}, ${token1}, '${startDate.toISOString()}', '${endDate.toISOString()}', ${realizedVolatility}, ${token0RewardAmount}, ${token1RewardAmount})`,
          )
          .join(",\n")}
            ON CONFLICT
        DO NOTHING;
    `,
  });

  await client.query(`COMMIT;`);

  console.log(`Successfully finished import of ${rowCount} rows`);
} finally {
  await client.end();
}
