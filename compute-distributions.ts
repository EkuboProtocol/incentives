import pg from "pg";

const incentiveDataResponse = await fetch(
  "https://mainnet-api.ekubo.org/defi-spring-incentives"
);

const incentiveData = (await incentiveDataResponse.json()) as {
  pairs: {
    token0: { symbol: string; l2_token_address: string };
    token1: { symbol: string; l2_token_address: string };
    allocations: {
      date: string;
      allocation: number;
      thirty_day_realized_volatility: number;
    }[];
  }[];
};

const dates = process.env.RUN_DATES?.length
  ? process.env.RUN_DATES.split(",")
  : [new Date(Date.now() - 86_400_000).toISOString().split("T")[0]];

const overwrite = process.env.OVERWRITE === "true";

const client = new pg.Client({
  ssl: {
    rejectUnauthorized: false,
  },
});

await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS strk_defi_spring_incentives
                    (
                        locker       NUMERIC     NOT NULL,
                        salt         NUMERIC     NOT NULL,
                        day          timestamptz NOT NULL,
                        incentives   NUMERIC     NOT NULL,
                        last_updated timestamptz NOT NULL,
                        PRIMARY KEY (locker, salt, day)
                    );`);

console.log("Schema initialized");

for (const date of dates) {
  const isoFormattedDate = `${date}T00:00:00Z`;

  if (!overwrite) {
    const { rows } = await client.query<{ exists: 1 }>(
      `SELECT 1 AS exists
       FROM strk_defi_spring_incentives
       WHERE day = '${isoFormattedDate}'
       LIMIT 1`
    );
    if (rows.length) {
      console.log(
        `Skipping ${date} because data exists. To process anyway, set OVERWRITE to true`
      );
      continue;
    }
  }

  console.log("Starting processing for date", date);

  const pairData: {
    token0: { l2_token_address: string; symbol: string };
    token1: { l2_token_address: string; symbol: string };
    allocation: number;
    volatility_in_ticks: number;
  }[] = await Promise.all(
    incentiveData.pairs
      .filter((p) => p.allocations.find((a) => a.date === date))
      .map(async ({ token0, token1, allocations }) => {
        const dayData = allocations?.find((a) => a.date === date);
        if (!dayData)
          throw new Error(
            `Missing day data for ${token0.symbol}/${token1.symbol}`
          );

        const datePlusOne = new Date(
          new Date(isoFormattedDate).getTime() + 86_400_000
        );

        const volatilityResponse = await fetch(
          `https://mainnet-api.ekubo.org/volatility/${
            token0.l2_token_address
          }/${
            token1.l2_token_address
          }?numDays=30&fromDate=${datePlusOne.toISOString()}`
        );

        const volatilityData = await volatilityResponse.json();

        let volatility_in_ticks = volatilityData?.volatility?.ticks;

        if (!volatility_in_ticks) {
          console.log(
            `Missing volatility data for ${token0.symbol}/${token1.symbol}, falling back to OBL day level data`
          );
          volatility_in_ticks = Math.round(
            Math.log(Math.exp(dayData.thirty_day_realized_volatility)) /
              Math.log(1.000001)
          );
        }

        return {
          token0: {
            l2_token_address: token0.l2_token_address,
            symbol: token0.symbol,
          },
          token1: {
            l2_token_address: token1.l2_token_address,
            symbol: token1.symbol,
          },
          allocation: dayData.allocation,
          volatility_in_ticks,
        };
      })
  );

  if (!pairData.length) {
    throw new Error(`No pair data found for date: ${date}`);
  }

  const pairDataValuesTable = pairData
    .map(
      (p) =>
        `(${BigInt(p.token0.l2_token_address)}::NUMERIC, ${BigInt(
          p.token1.l2_token_address
        )}::NUMERIC, ${p.allocation}::NUMERIC, ${p.volatility_in_ticks}::INT)`
    )
    .join("\n,");

  console.log("Using pair data", date, pairData);

  const standardDeviationWeights = [
    { multiple: 0.03, weight: 0.024 },
    { multiple: 0.06, weight: 0.0478 },
    { multiple: 0.09, weight: 0.0718 },
    { multiple: 0.12, weight: 0.0956 },
    { multiple: 0.15, weight: 0.1192 },
    { multiple: 0.18, weight: 0.1428 },
    { multiple: 0.22, weight: 0.1742 },
    { multiple: 0.25, weight: 0.1974 },
    { multiple: 0.3, weight: 0.2358 },
    { multiple: 0.35, weight: 0.2736 },
    { multiple: 0.4, weight: 0.3108 },
    { multiple: 0.45, weight: 0.3472 },
    { multiple: 0.5, weight: 0.3829 },
    { multiple: 0.6, weight: 0.4514 },
    { multiple: 0.7, weight: 0.516 },
    { multiple: 0.8, weight: 0.5762 },
    { multiple: 0.9, weight: 0.6318 },
    { multiple: 1.0, weight: 0.6827 },
    { multiple: 1.25, weight: 0.7888 },
    { multiple: 1.5, weight: 0.8664 },
    { multiple: 1.75, weight: 0.9198 },
    { multiple: 2.0, weight: 0.9545 },
    { multiple: 3.0, weight: 0.9973 },
  ]
    .map(({ multiple, weight }, ix, list) =>
      ix === 0
        ? `(${multiple}::float, ${weight}::float)`
        : `(${multiple}, ${weight - list[ix - 1].weight})`
    )
    .join(", ");

  const priceInterval = "1 hour";

  // first delete all the data for the day
  await client.query(
    `DELETE
         FROM strk_defi_spring_incentives
         WHERE day = '${isoFormattedDate}'::timestamptz;`
  );

  const queryText = `
        INSERT INTO strk_defi_spring_incentives (WITH
                                                     -- the first event contained in the period
                                                     min_event_id AS (SELECT id
                                                                      FROM event_keys
                                                                      WHERE block_number >= (SELECT number
                                                                                             FROM blocks
                                                                                             WHERE time >= '${isoFormattedDate}'::timestamptz
                                                                                             ORDER BY number
                                                                                             LIMIT 1)
                                                                      ORDER BY id
                                                                      LIMIT 1),

                                                     -- the last event contained in the period
                                                     max_event_id AS (SELECT id
                                                                      FROM event_keys
                                                                      WHERE block_number <= (SELECT number
                                                                                             FROM blocks
                                                                                             WHERE time < ('${isoFormattedDate}'::timestamptz + INTERVAL '1 day')
                                                                                             ORDER BY number DESC
                                                                                             LIMIT 1)
                                                                      ORDER BY id DESC
                                                                      LIMIT 1),

                                                     -- each of the pairs that are included in the program and their total share of incentives
                                                     pairs
                                                         AS (SELECT token0, token1, strk_rewards, volatility_in_ticks
                                                             FROM (values ${pairDataValuesTable}) AS pairs (token0, token1, strk_rewards, volatility_in_ticks)),

                                                     -- the weights corresponding to each multiple of the standard deviation 
                                                     stddev_multiple_weights AS (SELECT multiple, weight
                                                                                 FROM (values ${standardDeviationWeights}) AS weights (multiple, weight)),

                                                     -- all the pool keys related to the incentivized pools
                                                     relevant_pool_key_hashes
                                                         AS (SELECT key_hash, pool_keys.token0, pool_keys.token1, fee
                                                             FROM pool_keys
                                                                      JOIN pairs
                                                                           ON pairs.token0 = pool_keys.token0 AND
                                                                              pairs.token1 = pool_keys.token1 AND
                                                                              -- no extension or twamm extension
                                                                              extension in (0, 0x043e4f09c32d13d43a880e85f69f7de93ceda62d6cf2581a582c6db635548fdc::numeric)),

                                                     interval_pair_prices_without_next_start
                                                         AS (SELECT pool_keys.token0,
                                                                    pool_keys.token1,
                                                                    date_bin(
                                                                            INTERVAL '${priceInterval}',
                                                                            blocks.time,
                                                                            '2000-01-01 00:00:00'::timestamptz) AS period_start,
                                                                    SUM(swaps.delta1 * swaps.delta1) /
                                                                    SUM(ABS(swaps.delta0 * swaps.delta1))       AS price,
                                                                    FLOOR(LOG(SUM(swaps.delta1 * swaps.delta1) /
                                                                              SUM(ABS(swaps.delta0 * swaps.delta1))) /
                                                                          LOG(1.000001))::INT                   AS tick
                                                             FROM swaps
                                                                      JOIN pool_keys
                                                                           ON swaps.pool_key_hash = pool_keys.key_hash
                                                                      JOIN pairs
                                                                           ON pool_keys.token0 = pairs.token0 AND pool_keys.token1 = pairs.token1
                                                                      JOIN event_keys ON swaps.event_id = event_keys.id
                                                                      JOIN blocks ON event_keys.block_number = blocks.number
                                                             WHERE event_id BETWEEN (SELECT id
                                                                                     FROM event_keys
                                                                                     WHERE block_number >=
                                                                                           (SELECT number
                                                                                            FROM blocks
                                                                                            WHERE time >= '${isoFormattedDate}'::timestamptz - (4 * INTERVAL '${priceInterval}')
                                                                                            ORDER BY number
                                                                                            LIMIT 1)
                                                                                     ORDER BY id
                                                                                     LIMIT 1) AND (SELECT id FROM max_event_id)
                                                             GROUP BY pool_keys.token0, pool_keys.token1, period_start),

                                                     interval_pair_prices AS (SELECT ipp.*,
                                                                                     LEAD(period_start)
                                                                                     OVER (PARTITION BY ipp.token0, ipp.token1, multiple ORDER BY period_start) AS next_period_start,
                                                                                     weight,
                                                                                     INT4RANGE(
                                                                                             CEIL(ipp.tick - multiple * volatility_in_ticks)::INT,
                                                                                             FLOOR(ipp.tick + multiple * volatility_in_ticks)::INT)                stddev_range
                                                                              FROM interval_pair_prices_without_next_start ipp
                                                                                       JOIN pairs ON ipp.token0 = pairs.token0 AND ipp.token1 = pairs.token1
                                                                                       JOIN stddev_multiple_weights ON TRUE),

                                                     -- the state of all the positions aggregated at the beginning of the period
                                                     positions_created_before_start
                                                         AS (SELECT MAX(event_id)           AS event_id,
                                                                    pu.pool_key_hash,
                                                                    pu.locker,
                                                                    pu.salt,
                                                                    pu.lower_bound,
                                                                    pu.upper_bound,
                                                                    SUM(pu.liquidity_delta) AS liquidity_delta
                                                             FROM position_updates pu
                                                                      JOIN relevant_pool_key_hashes rpkh ON pu.pool_key_hash = rpkh.key_hash
                                                             WHERE event_id < (SELECT id FROM min_event_id)
                                                             GROUP BY pu.pool_key_hash,
                                                                      pu.locker,
                                                                      pu.salt,
                                                                      pu.lower_bound,
                                                                      pu.upper_bound),

                                                     -- ignore any positions that were already fully withdrawn
                                                     positions_created_before_start_with_nonzero_liquidity
                                                         AS (SELECT *
                                                             FROM positions_created_before_start
                                                             WHERE liquidity_delta != 0),


                                                     -- treat these initial positions as if they were created exactly at the beginning of the period by creating
                                                     -- one row for a position update for each of them
                                                     -- there is no filter on the time of the tick update, because all tick updates happened in the period and these positions happened before
                                                     all_position_updates_in_period
                                                         AS (SELECT pu.event_id                  update_event_id,
                                                                    pu.pool_key_hash,
                                                                    pu.locker,
                                                                    pu.salt,
                                                                    pu.lower_bound,
                                                                    pu.upper_bound,
                                                                    pu.liquidity_delta,
                                                                    -- pretend like the position was updated at the very beginning of the period
                                                                    '${isoFormattedDate}'::timestamptz AS update_time
                                                             FROM positions_created_before_start_with_nonzero_liquidity pu
                                                             UNION ALL
                                                             SELECT pu.event_id  update_event_id,
                                                                    pu.pool_key_hash,
                                                                    pu.locker,
                                                                    pu.salt,
                                                                    pu.lower_bound,
                                                                    pu.upper_bound,
                                                                    pu.liquidity_delta,
                                                                    pu_b.time AS update_time
                                                             FROM position_updates pu
                                                                      JOIN event_keys pu_ek ON pu.event_id = pu_ek.id
                                                                      JOIN blocks pu_b ON pu_ek.block_number = pu_b.number
                                                             WHERE pu.event_id BETWEEN (SELECT id FROM min_event_id) AND (SELECT id FROM max_event_id)),

                                                     -- the position state at each point during the period
                                                     position_states_during_period AS (SELECT pool_key_hash,
                                                                                              locker,
                                                                                              salt,
                                                                                              INT4RANGE(lower_bound,
                                                                                                        upper_bound)                                                                             AS position_tick_range,
                                                                                              upper_bound - lower_bound                                                                          AS position_width,

                                                                                              SUM(liquidity_delta)
                                                                                              OVER (PARTITION BY pool_key_hash, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS liquidity,

                                                                                              update_event_id,
                                                                                              LEAD(update_event_id)
                                                                                              OVER (PARTITION BY pool_key_hash, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS next_update_event_id,

                                                                                              update_time,
                                                                                              LEAD(update_time)
                                                                                              OVER (PARTITION BY pool_key_hash, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS next_update_time
                                                                                       FROM all_position_updates_in_period),

                                                     position_states_during_period_with_intersections
                                                         AS (SELECT psdp.pool_key_hash                 AS pool_key_hash,
                                                                    locker,
                                                                    salt,
                                                                    psdp.liquidity,

                                                                    stddev_range * position_tick_range AS tick_range_intersection,
                                                                    weight,
                                                                    ipp.tick,
                                                                    ipp.price,

                                                                    ROUND(
                                                                            GREATEST(EXTRACT(
                                                                                             EPOCH FROM (
                                                                                        LEAST(
                                                                                                COALESCE(
                                                                                                        psdp.next_update_time,
                                                                                                        ('${isoFormattedDate}'::timestamptz + INTERVAL '1 day')),
                                                                                                COALESCE(
                                                                                                        ipp.next_period_start,
                                                                                                        ('${isoFormattedDate}'::timestamptz + INTERVAL '1 day'))) -
                                                                                        GREATEST(psdp.update_time, ipp.period_start)
                                                                                        )
                                                                                     ), 0)
                                                                    )                                  AS row_seconds

                                                             FROM position_states_during_period psdp
                                                                      JOIN pool_keys pk ON psdp.pool_key_hash = pk.key_hash
                                                                      LEFT JOIN interval_pair_prices ipp
                                                                                ON pk.token0 = ipp.token0 AND pk.token1 = ipp.token1
                                                                      JOIN relevant_pool_key_hashes rpkh ON psdp.pool_key_hash = rpkh.key_hash
                                                                      JOIN pairs ON rpkh.token0 = pairs.token0 AND rpkh.token1 = pairs.token1),

                                                     position_depth_per_time
                                                         AS (SELECT pool_key_hash                                                                     AS pool_key_hash,
                                                                    locker,
                                                                    salt,

                                                                    (CASE
                                                                         WHEN tick < LOWER(tick_range_intersection)
                                                                             THEN FLOOR(
                                                                                 liquidity *
                                                                                 ((1::NUMERIC /
                                                                                   POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection))) -
                                                                                  (1::NUMERIC /
                                                                                   POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection)))))
                                                                         WHEN tick < UPPER(tick_range_intersection)
                                                                             THEN FLOOR(
                                                                                 liquidity *
                                                                                 ((1::NUMERIC / POWER(1.0000005::NUMERIC, tick)) -
                                                                                  (1::NUMERIC /
                                                                                   POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection)))))
                                                                         ELSE 0 END) *
                                                                    price                                                                             AS amount0_in_terms_of_amount1,

                                                                    (CASE
                                                                         WHEN tick < LOWER(tick_range_intersection)
                                                                             THEN 0
                                                                         WHEN tick < UPPER(tick_range_intersection)
                                                                             THEN FLOOR(
                                                                                 liquidity *
                                                                                 (POWER(1.0000005::NUMERIC, tick) -
                                                                                  POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection))))
                                                                         ELSE FLOOR(liquidity *
                                                                                    (POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection)) -
                                                                                     POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection)))) END) AS amount1,

                                                                    row_seconds,
                                                                    weight

                                                             FROM position_states_during_period_with_intersections
                                                             WHERE NOT ISEMPTY(tick_range_intersection)
                                                               AND row_seconds > 0),


                                                     position_depth_seconds AS (SELECT pool_key_hash,
                                                                                       locker,
                                                                                       salt,
                                                                                       SUM(
                                                                                               (amount0_in_terms_of_amount1 + amount1) *
                                                                                               row_seconds *
                                                                                               weight
                                                                                       ) AS market_depth_score
                                                                                FROM position_depth_per_time
                                                                                GROUP BY pool_key_hash, locker, salt),

                                                     -- compute each positions liquidity seconds by pair
                                                     position_pair_depth_seconds AS (SELECT token0,
                                                                                            token1,
                                                                                            locker,
                                                                                            salt,
                                                                                            SUM(market_depth_score *
                                                                                                ((340282366920938463463374607431768211456 - fee) /
                                                                                                 340282366920938463463374607431768211456)) AS fee_adjusted_total_score
                                                                                     FROM position_depth_seconds
                                                                                              JOIN pool_keys ON key_hash = pool_key_hash
                                                                                     GROUP BY token0, token1, locker, salt),

                                                     -- sum up the total liquidity seconds by pair
                                                     total_depth_seconds_per_pair AS (SELECT token0,
                                                                                             token1,
                                                                                             SUM(fee_adjusted_total_score) total
                                                                                      FROM position_pair_depth_seconds
                                                                                      GROUP BY token0, token1),

                                                     -- the percentage of each position's share of total depth seconds per pair
                                                     position_percent_of_pair_rewards AS (SELECT locker,
                                                                                                 salt,
                                                                                                 ppds.token0,
                                                                                                 ppds.token1,
                                                                                                 (ppds.fee_adjusted_total_score / tdspp.total) AS position_rewards_share
                                                                                          FROM position_pair_depth_seconds ppds
                                                                                                   JOIN total_depth_seconds_per_pair tdspp
                                                                                                        ON ppds.token0 = tdspp.token0 AND ppds.token1 = tdspp.token1
                                                                                          WHERE ppds.fee_adjusted_total_score > 0
                                                                                            AND tdspp.total > 0)

                                                 SELECT locker,
                                                        salt,
                                                        '${isoFormattedDate}'::timestamptz                     AS day,
                                                        (position_rewards_share * pairs.strk_rewards) AS incentives,
                                                        NOW()                                         AS last_updated
                                                 FROM position_percent_of_pair_rewards ppopr
                                                          JOIN pairs ON ppopr.token0 = pairs.token0 AND ppopr.token1 = pairs.token1);
    `;

  console.debug("Executing query", queryText);

  await client.query(`BEGIN;`);
  await client.query(queryText);
  await client.query(`COMMIT;`);
}

await client.end();
