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

const client = new pg.Client();
await client.connect();

await client.query(`BEGIN;`);

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
  console.log("Starting processing for date", date);

  const pairData: {
    token0: { l2_token_address: string; symbol: string };
    token1: { l2_token_address: string; symbol: string };
    allocation: number;
    volatility_in_ticks: number;
  }[] = incentiveData.pairs.map(({ token0, token1, allocations }) => {
    const dayData = allocations?.find((a) => a.date === date);
    if (!dayData)
      throw new Error(`Missing day data for ${token0.symbol}/${token1.symbol}`);
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
      volatility_in_ticks: Math.round(
        Math.log(1 + dayData.thirty_day_realized_volatility) /
          Math.log(1.000001)
      ),
    };
  });

  const pairDataValuesTable = pairData
    .map(
      (p) =>
        `(${BigInt(p.token0.l2_token_address)}::NUMERIC, ${BigInt(
          p.token1.l2_token_address
        )}::NUMERIC, ${p.allocation}::NUMERIC, ${p.volatility_in_ticks}::INT)`
    )
    .join("\n,");

  console.log("Using pair data", date, pairData);

  const queryDate = `'${date}T00:00:00Z'`;

  const queryText = `
      INSERT INTO strk_defi_spring_incentives (WITH
                                                   -- the first event contained in the period
                                                   min_event_id AS (SELECT id
                                                                    FROM event_keys
                                                                    WHERE block_number >= (SELECT number
                                                                                           FROM blocks
                                                                                           WHERE time >= ${queryDate}::timestamptz
                                                                                           ORDER BY number
                                                                                           LIMIT 1)
                                                                    ORDER BY id
                                                                    LIMIT 1),

                                                   -- the last event contained in the period
                                                   max_event_id AS (SELECT id
                                                                    FROM event_keys
                                                                    WHERE block_number <= (SELECT number
                                                                                           FROM blocks
                                                                                           WHERE time < (${queryDate}::timestamptz + INTERVAL '1 day')
                                                                                           ORDER BY number DESC
                                                                                           LIMIT 1)
                                                                    ORDER BY id DESC
                                                                    LIMIT 1),

                                                   -- each of the pairs that are included in the program and their total share of incentives
                                                   pairs
                                                       AS (SELECT token0, token1, strk_rewards, volatility_in_ticks
                                                           FROM (values ${pairDataValuesTable}) AS pairs (token0, token1, strk_rewards, volatility_in_ticks)),


                                                   -- all the pool keys related to the incentivized pools
                                                   relevant_pool_key_hashes
                                                       AS (SELECT key_hash, pool_keys.token0, pool_keys.token1, fee
                                                           FROM pool_keys
                                                                    JOIN pairs
                                                                         ON pairs.token0 = pool_keys.token0 AND
                                                                            pairs.token1 = pool_keys.token1 AND
                                                                            extension = 0),

                                                   hourly_pair_prices_without_next_start
                                                       AS (SELECT pool_keys.token0,
                                                                  pool_keys.token1,
                                                                  date_bin(
                                                                          INTERVAL '1 hour',
                                                                          blocks.time,
                                                                          '2000-01-01 00:00:00'::TIMESTAMP WITHOUT TIME ZONE) AS period_start,
                                                                  SUM(swaps.delta1 * swaps.delta1) /
                                                                  SUM(ABS(swaps.delta0 * swaps.delta1))                       AS price,
                                                                  FLOOR(LOG(SUM(swaps.delta1 * swaps.delta1) /
                                                                            SUM(ABS(swaps.delta0 * swaps.delta1))) /
                                                                        LOG(1.000001))::INT                                   AS tick
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
                                                                                          WHERE time >= ${queryDate}::timestamptz - INTERVAL '1 hour'
                                                                                          ORDER BY number
                                                                                          LIMIT 1)
                                                                                   ORDER BY id
                                                                                   LIMIT 1) AND (SELECT id FROM max_event_id)
                                                           GROUP BY pool_keys.token0, pool_keys.token1, period_start),

                                                   hourly_pair_prices AS (SELECT hpp.*,
                                                                                 LEAD(period_start)
                                                                                 OVER (PARTITION BY hpp.token0,hpp.token1 ORDER BY period_start)    AS next_period_start,
                                                                                 INT4RANGE(
                                                                                         CEIL(tick - (pairs.volatility_in_ticks * 0.1))::INT,
                                                                                         FLOOR(tick + (pairs.volatility_in_ticks * 0.1))::INT)      AS range_1,
                                                                                 INT4RANGE(
                                                                                         CEIL(tick - (pairs.volatility_in_ticks * 0.318639))::INT,
                                                                                         FLOOR(tick + (pairs.volatility_in_ticks * 0.318639))::INT) AS range_2,
                                                                                 INT4RANGE(
                                                                                         CEIL(tick - (pairs.volatility_in_ticks * 0.5))::INT,
                                                                                         FLOOR(tick + (pairs.volatility_in_ticks * 0.5))::INT)      AS range_3,
                                                                                 INT4RANGE(
                                                                                         (tick - pairs.volatility_in_ticks)::INT,
                                                                                         (tick +
                                                                                          pairs.volatility_in_ticks)::INT)                          AS range_4,
                                                                                 INT4RANGE(
                                                                                         (tick - pairs.volatility_in_ticks * 2)::INT,
                                                                                         (tick +
                                                                                          pairs.volatility_in_ticks *
                                                                                          2)::INT)                                                  AS range_5,
                                                                                 INT4RANGE(
                                                                                         (tick - pairs.volatility_in_ticks * 3)::INT,
                                                                                         (tick +
                                                                                          pairs.volatility_in_ticks *
                                                                                          3)::INT)                                                  AS range_6
                                                                          FROM hourly_pair_prices_without_next_start hpp
                                                                                   JOIN pairs ON hpp.token0 = pairs.token0 AND hpp.token1 = pairs.token1),

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
                                                                  ${queryDate}::timestamptz AS update_time
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
                                                                                            INT4RANGE(lower_bound, upper_bound)                                                                AS tick_range,

                                                                                            SUM(liquidity_delta)
                                                                                            OVER (PARTITION BY pool_key_hash, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS liquidity,

                                                                                            update_event_id,
                                                                                            LEAD(update_event_id)
                                                                                            OVER (PARTITION BY pool_key_hash, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS next_update_event_id,

                                                                                            update_time,
                                                                                            LEAD(update_time)
                                                                                            OVER (PARTITION BY pool_key_hash, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS next_update_time
                                                                                     FROM all_position_updates_in_period),

                                                   position_depth_per_time
                                                       AS (SELECT psdp.pool_key_hash                                                   AS pool_key_hash,
                                                                  locker,
                                                                  salt,

                                                                  (CASE
                                                                       WHEN tick < LOWER(tick_range) THEN FLOOR(
                                                                               liquidity *
                                                                               ((1::NUMERIC / POWER(1.0000005::NUMERIC, LOWER(tick_range))) -
                                                                                (1::NUMERIC / POWER(1.0000005::NUMERIC, UPPER(tick_range)))))
                                                                       WHEN tick < UPPER(tick_range) THEN FLOOR(
                                                                               liquidity *
                                                                               ((1::NUMERIC / POWER(1.0000005::NUMERIC, hpp.tick)) -
                                                                                (1::NUMERIC / POWER(1.0000005::NUMERIC, UPPER(tick_range)))))
                                                                       ELSE 0 END) *
                                                                  hpp.price                                                            AS amount0_in_terms_of_amount1,

                                                                  (CASE
                                                                       WHEN tick < LOWER(tick_range) THEN 0
                                                                       WHEN tick < UPPER(tick_range) THEN FLOOR(
                                                                               liquidity *
                                                                               (POWER(1.0000005::NUMERIC, hpp.tick) -
                                                                                POWER(1.0000005::NUMERIC, LOWER(tick_range))))
                                                                       ELSE FLOOR(liquidity *
                                                                                  (POWER(1.0000005::NUMERIC, UPPER(tick_range)) -
                                                                                   POWER(1.0000005::NUMERIC, LOWER(tick_range)))) END) AS amount1,

                                                                  hpp.range_1 * tick_range                                             AS ticks_in_range_1,
                                                                  hpp.range_2 * tick_range                                             AS ticks_in_range_2,
                                                                  hpp.range_3 * tick_range                                             AS ticks_in_range_3,
                                                                  hpp.range_4 * tick_range                                             AS ticks_in_range_4,
                                                                  hpp.range_5 * tick_range                                             AS ticks_in_range_5,
                                                                  hpp.range_6 * tick_range                                             AS ticks_in_range_6,

                                                                  UPPER(tick_range) - LOWER(tick_range)                                AS position_width,

                                                                  ROUND(
                                                                          GREATEST(EXTRACT(
                                                                                           EPOCH FROM (
                                                                                      LEAST(
                                                                                              COALESCE(
                                                                                                      psdp.next_update_time,
                                                                                                      (${queryDate}::timestamptz + INTERVAL '1 day')),
                                                                                              COALESCE(
                                                                                                      hpp.next_period_start,
                                                                                                      hpp.period_start +
                                                                                                      INTERVAL '1 hours')) -
                                                                                      GREATEST(psdp.update_time, hpp.period_start)
                                                                                      )
                                                                                   ), 0)
                                                                  )                                                                    AS row_seconds

                                                           FROM position_states_during_period psdp
                                                                    JOIN pool_keys pk ON psdp.pool_key_hash = pk.key_hash
                                                                    LEFT JOIN hourly_pair_prices hpp
                                                                              ON pk.token0 = hpp.token0 AND pk.token1 = hpp.token1
                                                                    JOIN relevant_pool_key_hashes rpkh ON psdp.pool_key_hash = rpkh.key_hash
                                                                    JOIN pairs ON rpkh.token0 = pairs.token0 AND rpkh.token1 = pairs.token1),


                                                   position_depth_seconds AS (SELECT pool_key_hash,
                                                                                     locker,
                                                                                     salt,
                                                                                     SUM(
                                                                                             (amount0_in_terms_of_amount1 + amount1) *
                                                                                             row_seconds *
                                                                                             (COALESCE((UPPER(ticks_in_range_1) - LOWER(ticks_in_range_1)), 0) *
                                                                                              0.0796 +
                                                                                              COALESCE((UPPER(ticks_in_range_2) - LOWER(ticks_in_range_2)), 0) *
                                                                                              0.1704 +
                                                                                              COALESCE((UPPER(ticks_in_range_3) - LOWER(ticks_in_range_3)), 0) *
                                                                                              0.132 +
                                                                                              COALESCE((UPPER(ticks_in_range_4) - LOWER(ticks_in_range_4)), 0) *
                                                                                              0.301 +
                                                                                              COALESCE((UPPER(ticks_in_range_5) - LOWER(ticks_in_range_5)), 0) *
                                                                                              0.271 +
                                                                                              COALESCE((UPPER(ticks_in_range_6) - LOWER(ticks_in_range_6)), 0) *
                                                                                              0.043) /
                                                                                             position_width
                                                                                     ) AS market_depth_score

                                                                              FROM position_depth_per_time

                                                                              GROUP BY pool_key_hash, locker, salt),

                                                   -- compute each positions liquidity seconds by pair
                                                   position_pair_depth_seconds AS (SELECT token0,
                                                                                          token1,
                                                                                          locker,
                                                                                          salt,
                                                                                          SUM(market_depth_score *
                                                                                              POWER(
                                                                                                      (340282366920938463463374607431768211456 - fee) /
                                                                                                      340282366920938463463374607431768211456,
                                                                                                      2)) AS fee_adjusted_total_score
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
                                                      ${queryDate}::timestamptz                     AS day,
                                                      (position_rewards_share * pairs.strk_rewards) AS incentives,
                                                      NOW()                                         AS last_updated
                                               FROM position_percent_of_pair_rewards ppopr
                                                        JOIN pairs ON ppopr.token0 = pairs.token0 AND ppopr.token1 = pairs.token1)
      ON CONFLICT (locker, salt, day)
          DO UPDATE SET incentives   = excluded.incentives,
                        last_updated = NOW();
  `;

  console.log("Executing query", queryText);

  await client.query(queryText);
}

await client.query(`COMMIT;`);
await client.end();
