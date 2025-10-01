export function fetchEkuboBtcFiData(
  baseApiUrl: string = "https://www.data-openblocklabs.com/starknet/dex-incentives/ekubo",
  page: number = 1,
  size: number = 1000
): Promise<{
  items: {
    date: string;
    protocol: "ekubo";
    pair: string;
    token0_address: `0x${string}`;
    token1_address: `0x${string}`;
    total_allocated_tokens: number;
    apr: number;
    tvl: number;
    realized_volatility: number;
    token0_allocation: number;
    token1_allocation: number;
    token0_symbol: string;
    token1_symbol: string;
  }[];
  total: number;
  size: number;
  pages: number;
}> {
  const params = new URLSearchParams();
  params.set("page", page.toString());
  params.set("size", size.toString());
  return fetch(`${baseApiUrl}?${params.toString()}`).then((r) => r.json());
}
