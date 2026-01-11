export function fetchEkuboBtcFiData(
  baseApiUrl: string = "https://5xyjxn0qoe.execute-api.eu-west-1.amazonaws.com/prod/dex-pairs",
  page: number = 1,
  size: number = 1000,
): Promise<
  {
    date: string;
    protocol: "ekubo";
    pair: string;
    token0_address: `0x${string}`;
    token1_address: `0x${string}`;
    total_allocated_tokens: string;
    apr: string;
    tvl: string;
    realized_volatility: string;
    token0_allocation: string;
    token1_allocation: string;
    token0_symbol: string;
    token1_symbol: string;
  }[]
> {
  const params = new URLSearchParams();
  params.set("page", page.toString());
  params.set("size", size.toString());
  return fetch(`${baseApiUrl}?${params.toString()}`).then((r) => r.json());
}
