interface Token {
  name: string;
  symbol: string;
  decimals: number;
  l2_token_address: string;
  sort_order: number;
  total_supply: number | null;
  logo_url: string;
}

export async function fetchTokens(tokensUrl: string) {
  const tokensResponse = await fetch(tokensUrl);

  if (!tokensResponse.ok) {
    throw new Error(
      `Failed to fetch tokens data: ${await tokensResponse.text()}`,
    );
  }

  return (await tokensResponse.json()) as Token[];
}
