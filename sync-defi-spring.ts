import initializeIncentivesClient from "./initializeIncentivesClient.js";

const campaignId = Number(process.env.CAMPAIGN_ID ?? "1");

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
type ExchangeData = Record<string, PoolData[]>;

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

const client = await initializeIncentivesClient();

await client.query(`
  CREATE TEMPORARY TABLE temp_campaign_reward_periods(name, name_slug, status);
`);

console.log("Finished import");

await client.end();
