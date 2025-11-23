interface ApiToken {
  chain_id: `0x${string}`;
  name: string;
  symbol: string;
  decimals: number;
  address: string;
  sort_order: number;
  total_supply: number | null;
}

export async function fetchTokens(chainId: bigint) {
  const tokensResponse = await fetch(
    `https://prod-api.ekubo.org/tokens?chainId=${chainId}`,
  );

  if (!tokensResponse.ok) {
    throw new Error(
      `Failed to fetch tokens data: ${await tokensResponse.text()}`,
    );
  }

  return (await tokensResponse.json()) as ApiToken[];
}
