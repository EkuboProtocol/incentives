import initializeIncentivesClient from "./util/initializeIncentivesClient.js";

const client = await initializeIncentivesClient();

try {
  await client.query("BEGIN;");

  const { rows: pendingRewardPeriods } = await client.query<{
    id: string;
  }>(
    `
      SELECT id
      FROM incentives.campaign_reward_periods
      WHERE rewards_last_computed_at IS NULL
        AND end_time <= CURRENT_TIMESTAMP
    `,
  );

  console.log(`Found ${pendingRewardPeriods.length} periods to process`);

  const PRICE_COMPUTATION_INTERVAL = "1 hour";

  for (const period of pendingRewardPeriods) {
    console.log(`Processing period ID ${period.id}`);

    // first delete all the data for the day
    await client.query({
      text: `DELETE
                   FROM incentives.computed_rewards
                   WHERE campaign_reward_period_id = $1`,
      values: [period.id],
    });

    const queryText = `
        INSERT INTO incentives.computed_rewards (WITH period_info AS (SELECT *,
                                                                             ROUND(LOG(EXP(realized_volatility)) / LOG(1.000001)) AS volatility_in_ticks
                                                                      FROM incentives.campaign_reward_periods
                                                                      WHERE id = :period_id),

                                                      -- the first event contained in the period
                                                      min_event_id AS (SELECT id
                                                                       FROM event_keys
                                                                       WHERE block_number >= (SELECT number
                                                                                              FROM blocks,
                                                                                                   period_info
                                                                                              WHERE time >= period_info.start_time
                                                                                              ORDER BY number
                                                                                              LIMIT 1)
                                                                       ORDER BY id
                                                                       LIMIT 1),

                                                      -- the last event contained in the period
                                                      max_event_id AS (SELECT id
                                                                       FROM event_keys
                                                                       WHERE block_number <= (SELECT number
                                                                                              FROM blocks,
                                                                                                   period_info
                                                                                              WHERE time < period_info.end_time
                                                                                              ORDER BY number DESC
                                                                                              LIMIT 1)
                                                                       ORDER BY id DESC
                                                                       LIMIT 1),

                                                      -- the weights corresponding to each multiple of the standard deviation
                                                      stddev_multiple_weights AS (SELECT multiple,
                                                                                         (weight - COALESCE(LAG(weight) OVER (ORDER BY multiple), 0)) AS weight
                                                                                  FROM period_info pi
                                                                                           JOIN incentives.campaigns c ON pi.campaign_id = c.id
                                                                                           JOIN incentives.stddevs_table_entries ste
                                                                                                ON c.price_weights = ste.stddevs_table_id),

                                                      fee_calc AS (SELECT DISTINCT(fee),
                                                                                  int4(
                                                                                          LOG(1::NUMERIC + (fee / 340282366920938463463374607431768211456)) /
                                                                                          LOG(1.000001::NUMERIC)) *
                                                                                  4 AS fee_ticks_penalty
                                                                   FROM pool_keys),

                                                      -- all the pool keys related to the incentivized pools
                                                      relevant_pool_key_hashes
                                                          AS (SELECT pk.key_hash,
                                                                     pk.token0,
                                                                     pk.token1,
                                                                     pk.fee,
                                                                     fc.fee_ticks_penalty
                                                              FROM pool_keys pk
                                                                       JOIN period_info p
                                                                            ON p.token0 = pk.token0 AND
                                                                               p.token1 = pk.token1 AND
                                                                                -- one of the allowed extensions
                                                                               extension IN (SELECT cae.extension
                                                                                             FROM incentives.campaigns_allowed_extension cae
                                                                                             WHERE cae.campaign_id = p.campaign_id)
                                                                       JOIN fee_calc fc
                                                                            ON pk.fee = fc.fee),

                                                      interval_pair_prices_without_next_start
                                                          AS (SELECT pool_keys.token0,
                                                                     pool_keys.token1,
                                                                     date_bin(
                                                                             INTERVAL :price_interval,
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
                                                                       JOIN period_info p
                                                                            ON pool_keys.token0 = p.token0 AND pool_keys.token1 = p.token1
                                                                       JOIN event_keys ON swaps.event_id = event_keys.id
                                                                       JOIN blocks ON event_keys.block_number = blocks.number
                                                              WHERE event_id BETWEEN (SELECT id
                                                                                      FROM event_keys
                                                                                      WHERE block_number >=
                                                                                            (SELECT number
                                                                                             FROM blocks,
                                                                                                  period_info
                                                                                             WHERE time >=
                                                                                                   start_time -
                                                                                                   (4 * INTERVAL :price_interval)
                                                                                             ORDER BY number
                                                                                             LIMIT 1)
                                                                                      ORDER BY id
                                                                                      LIMIT 1) AND (SELECT id FROM max_event_id)
                                                                AND swaps.delta0 != 0
                                                                AND swaps.delta1 != 0
                                                              GROUP BY pool_keys.token0, pool_keys.token1, period_start),

                                                      interval_pair_prices AS (SELECT ipp.*,
                                                                                      LEAD(period_start)
                                                                                      OVER (PARTITION BY ipp.token0, ipp.token1, multiple ORDER BY period_start) AS next_period_start,
                                                                                      weight,
                                                                                      INT4RANGE(
                                                                                              CEIL(ipp.tick - multiple * volatility_in_ticks)::INT,
                                                                                              ipp.tick::INT)                                                        stddev_range_lower,
                                                                                      INT4RANGE(
                                                                                              ipp.tick::INT,
                                                                                              FLOOR(ipp.tick + multiple * volatility_in_ticks)::INT)                stddev_range_upper
                                                                               FROM interval_pair_prices_without_next_start ipp,
                                                                                    period_info
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
                                                          AS (SELECT pu.event_id     update_event_id,
                                                                     pu.pool_key_hash,
                                                                     pu.locker,
                                                                     pu.salt,
                                                                     pu.lower_bound,
                                                                     pu.upper_bound,
                                                                     pu.liquidity_delta,
                                                                     -- pretend like the position was updated at the very beginning of the period
                                                                     p.start_time AS update_time
                                                              FROM positions_created_before_start_with_nonzero_liquidity pu,
                                                                   period_info p
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
                                                                                               lower_bound,
                                                                                               upper_bound,

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
                                                          AS (SELECT psdp.pool_key_hash                           AS pool_key_hash,
                                                                     locker,
                                                                     salt,
                                                                     psdp.liquidity,

                                                                     (CASE
                                                                          WHEN lower_bound < ipp.tick THEN
                                                                              stddev_range_lower *
                                                                              INT4RANGE(lower_bound -
                                                                                        rpkh.fee_ticks_penalty,
                                                                                        LEAST(upper_bound, ipp.tick) -
                                                                                        rpkh.fee_ticks_penalty)
                                                                          ELSE INT4RANGE(ipp.tick, ipp.tick) END) AS tick_range_intersection_lower,
                                                                     (CASE
                                                                          WHEN upper_bound > ipp.tick THEN
                                                                              stddev_range_upper *
                                                                              INT4RANGE(
                                                                                      GREATEST(ipp.tick, lower_bound) +
                                                                                      rpkh.fee_ticks_penalty,
                                                                                      upper_bound +
                                                                                      rpkh.fee_ticks_penalty)
                                                                          ELSE INT4RANGE(ipp.tick, ipp.tick) END) AS tick_range_intersection_upper,
                                                                     weight,
                                                                     ipp.tick,
                                                                     ipp.price,

                                                                     ROUND(
                                                                             GREATEST(EXTRACT(
                                                                                              EPOCH FROM (
                                                                                         LEAST(
                                                                                                 COALESCE(
                                                                                                         psdp.next_update_time,
                                                                                                         (p.end_time)),
                                                                                                 COALESCE(
                                                                                                         ipp.next_period_start,
                                                                                                         (p.end_time))) -
                                                                                         GREATEST(psdp.update_time, ipp.period_start)
                                                                                         )
                                                                                      ), 0)
                                                                     )                                            AS row_seconds

                                                              FROM position_states_during_period psdp
                                                                       JOIN relevant_pool_key_hashes rpkh ON psdp.pool_key_hash = rpkh.key_hash
                                                                       LEFT JOIN interval_pair_prices ipp
                                                                                 ON rpkh.token0 = ipp.token0 AND rpkh.token1 = ipp.token1
                                                                       JOIN period_info p ON rpkh.token0 = p.token0 AND rpkh.token1 = p.token1),

                                                      position_depth_per_time
                                                          AS (SELECT pool_key_hash AS pool_key_hash,
                                                                     locker,
                                                                     salt,

                                                                     (CASE
                                                                          WHEN ISEMPTY(tick_range_intersection_lower)
                                                                              THEN 0
                                                                          ELSE FLOOR(liquidity *
                                                                                     (POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection_lower)) -
                                                                                      POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection_lower))))
                                                                         END)      AS amount1_lower,

                                                                     (CASE
                                                                          WHEN ISEMPTY(tick_range_intersection_upper)
                                                                              THEN 0
                                                                          ELSE FLOOR(
                                                                                  liquidity *
                                                                                  ((1::NUMERIC /
                                                                                    POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection_upper))) -
                                                                                   (1::NUMERIC /
                                                                                    POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection_upper)))))
                                                                         END)      AS amount0_upper,

                                                                     row_seconds,
                                                                     weight

                                                              FROM position_states_during_period_with_intersections
                                                              WHERE row_seconds > 0),


                                                      position_depth_seconds AS (SELECT pool_key_hash,
                                                                                        locker,
                                                                                        salt,
                                                                                        SUM(
                                                                                                amount0_upper *
                                                                                                row_seconds *
                                                                                                weight
                                                                                        ) AS market_depth_score_lower,
                                                                                        SUM(
                                                                                                amount1_lower *
                                                                                                row_seconds *
                                                                                                weight
                                                                                        ) AS market_depth_score_upper
                                                                                 FROM position_depth_per_time
                                                                                 GROUP BY pool_key_hash, locker, salt),

                                                      -- compute each positions liquidity seconds by pair
                                                      position_pair_depth_seconds AS (SELECT token0,
                                                                                             token1,
                                                                                             locker,
                                                                                             salt,
                                                                                             SUM(market_depth_score_lower) AS total_score_lower,
                                                                                             SUM(market_depth_score_upper) AS total_score_upper
                                                                                      FROM position_depth_seconds
                                                                                               JOIN pool_keys ON key_hash = pool_key_hash
                                                                                      GROUP BY token0, token1, locker, salt),

                                                      -- sum up the total liquidity seconds by pair
                                                      total_depth_seconds_per_pair AS (SELECT token0,
                                                                                              token1,
                                                                                              SUM(total_score_lower) total_lower,
                                                                                              SUM(total_score_upper) total_upper
                                                                                       FROM position_pair_depth_seconds
                                                                                       GROUP BY token0, token1),

                                                      -- the percentage of each position's share of total depth seconds per pair
                                                      position_percent_of_pair_rewards AS (SELECT locker,
                                                                                                  salt,
                                                                                                  ppds.token0,
                                                                                                  ppds.token1,
                                                                                                  ((ppds.total_score_lower / GREATEST(tdspp.total_lower, 1)) +
                                                                                                   (ppds.total_score_upper / GREATEST(tdspp.total_upper, 1))) /
                                                                                                  2 AS position_rewards_share
                                                                                           FROM position_pair_depth_seconds ppds
                                                                                                    JOIN total_depth_seconds_per_pair tdspp
                                                                                                         ON ppds.token0 = tdspp.token0 AND ppds.token1 = tdspp.token1
                                                                                           WHERE ppds.total_score_lower > 0
                                                                                              OR ppds.total_score_upper > 0)

                                                 SELECT :period_id                         AS campaign_reward_period_id,
                                                        locker,
                                                        salt,
                                                        (position_rewards_share * period_info.token0_reward_amount +
                                                         period_info.token1_reward_amount) AS incentives
                                                 FROM position_percent_of_pair_rewards ppopr,
                                                      period_info);
    `;

    await client.query(queryText);
  }

  await client.query(`COMMIT;`);
} catch (e) {
  console.error("Encountered error", e);
  await client.query("ROLLBACK;");
  process.exit(1);
} finally {
  await client.end();
}
