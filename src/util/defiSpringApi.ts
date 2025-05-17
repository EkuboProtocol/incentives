interface PoolDataV0 {
  date: string;
  allocation: number;
  thirty_day_realized_volatility: number;
}

interface PoolDataV1 extends PoolDataV0 {
  token0_allocation: number;
  token1_allocation: number;
}

export type ExchangeData = Record<
  `${string}/${string}`,
  (PoolDataV0 | PoolDataV1)[]
>;

interface OBLApiResponse {
  Ekubo: ExchangeData;

  [exchangeIdentifier: string]: ExchangeData;
}

function addIncentivesToPoolData(
  map: OBLApiResponse["Ekubo"],
  { pairId, date, amount }: { pairId: string; date: string; amount: number },
) {
  const [tokenA, tokenB] = pairId.split("/");
  const pairDailyData =
    map[`${tokenA}/${tokenB}`] ?? map[`${tokenB}/${tokenA}`];

  if (!pairDailyData) {
    map[`${tokenA}/${tokenB}`] = [
      {
        date,
        allocation: amount,
        // we use the value 1 as a fallback
        thirty_day_realized_volatility: 1,
        token0_allocation: amount / 2,
        token1_allocation: amount / 2,
      },
    ];
  } else {
    const dayData = pairDailyData.find((d) => d.date === date);
    if (dayData) {
      dayData.allocation += amount;
      if ("token0_allocation" in dayData) {
        dayData.token0_allocation += amount / 2;
        dayData.token1_allocation += amount / 2;
      }
    } else {
      pairDailyData.push({
        date,
        allocation: amount,
        thirty_day_realized_volatility: 1,
        token0_allocation: amount / 2,
        token1_allocation: amount / 2,
      });
    }
  }
}

const SPLITS_BY_DATE_RANGE = [
  {
    start: new Date("2024-03-21"),
    end: new Date("2024-03-30"),
    splits: [
      {
        pairId: "ZEND/ETH",
        weight: 1,
      },
      {
        pairId: "LORDS/ETH",
        weight: 10,
      },
      {
        pairId: "rETH/ETH",
        weight: 1,
      },
      {
        pairId: "ETH/USDT",
        weight: 3,
      },
    ],
  },
  {
    start: new Date("2024-03-30"),
    end: new Date("2024-03-31"),
    splits: [
      {
        pairId: "ZEND/ETH",
        weight: 1,
      },
      {
        pairId: "LORDS/ETH",
        weight: 20,
      },
      {
        pairId: "rETH/ETH",
        weight: 3,
      },
      {
        pairId: "ETH/USDT",
        weight: 9,
      },
    ],
  },
  {
    start: new Date("2024-03-31"),
    end: new Date("2024-04-04"),
    splits: [
      {
        pairId: "ZEND/ETH",
        weight: 1,
      },
      {
        pairId: "LORDS/ETH",
        weight: 20,
      },
      {
        pairId: "rETH/ETH",
        weight: 3,
      },
      {
        pairId: "ETH/USDT",
        weight: 12,
      },
    ],
  },
  {
    start: new Date("2024-04-04"),
    splits: [
      {
        pairId: "ETH/USDC",
        weight: 4,
      },
      {
        pairId: "STRK/ETH",
        weight: 12,
      },
      {
        pairId: "STRK/USDC",
        weight: 4,
      },
      {
        pairId: "WBTC/ETH",
        weight: 2,
      },
    ],
  },
];

export async function fetchEkuboDefiSpringData(oblApiUrl: string) {
  const incentiveDataResponse = await fetch(oblApiUrl);

  if (!incentiveDataResponse.ok) {
    throw new Error(
      `Failed to fetch incentive data: ${await incentiveDataResponse.text()}`,
    );
  }

  const incentiveData = (await incentiveDataResponse.json()) as OBLApiResponse;

  const ekuboIncentivesData = incentiveData.Ekubo;

  {
    // manipulate the response object, replacing discretionary with our own allocations
    const discretionary = ekuboIncentivesData["Discretionary"];
    delete ekuboIncentivesData["Discretionary"];

    if (discretionary) {
      discretionary.forEach(({ date, allocation }) => {
        const d = new Date(date);
        const matching = SPLITS_BY_DATE_RANGE.find(
          (s) => d >= s.start && (!s.end || d < s.end),
        );

        if (!matching) return;

        const totalWeight = matching.splits.reduce((m, v) => m + v.weight, 0);

        matching.splits.forEach(({ pairId, weight }) => {
          addIncentivesToPoolData(ekuboIncentivesData, {
            pairId,
            date,
            amount:
              Math.floor((allocation * weight * 1000) / totalWeight) / 1000,
          });
        });
      });
    }
  }

  return ekuboIncentivesData;
}
