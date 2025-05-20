import initializeIncentivesClient from "./util/initializeIncentivesClient.js";

const client = await initializeIncentivesClient();

try {
  await client.query("BEGIN;");

  const rewardPeriodIds = process.env.REWARD_PERIODS
    ? process.env.REWARD_PERIODS.split(",").map((p) => p.trim())
    : (
        await client.query<{
          id: string;
        }>({
          text: `
              SELECT id
              FROM incentives.campaign_reward_periods
              WHERE rewards_last_computed_at IS NULL
                AND end_time <= CURRENT_TIMESTAMP
              ORDER BY end_time
              LIMIT $1
          `,
          values: [10],
        })
      ).rows.map(({ id }) => id);

  console.log(`Found ${rewardPeriodIds.length} periods to process`);

  for (const id of rewardPeriodIds) {
    console.log(`Processing period ID ${id}`);

    const processingStartTime = new Date().getTime();

    // first delete all the data for the day
    await client.query({
      text: `DELETE
                   FROM incentives.computed_rewards
                   WHERE campaign_reward_period_id = $1`,
      values: [id],
    });

    await client.query({
      text: `
          INSERT INTO incentives.computed_rewards (WITH period_info AS (SELECT *,
                                                                               ROUND(LOG(EXP(realized_volatility)) / LOG(1.000001))::INT   AS volatility_in_ticks,
                                                                               GREATEST((end_time - start_time)::INTERVAL / 30, '1 hours') AS price_interval
                                                                        FROM incentives.campaign_reward_periods
                                                                        WHERE id = $1),

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
                                                                                                  ON c.stddevs_table_id = ste.stddevs_table_id),

                                                        -- all the pool keys related to the incentivized pools
                                                        relevant_pool_key_hashes
                                                            AS (SELECT pk.key_hash,
                                                                       int4(
                                                                               LOG(1::NUMERIC + (fee / $2::NUMERIC)) /
                                                                               LOG(1.000001::NUMERIC)
                                                                       ) AS mid_distance_in_ticks
                                                                FROM pool_keys pk
                                                                         JOIN period_info p
                                                                              ON p.token0 = pk.token0 AND
                                                                                 p.token1 = pk.token1 AND
                                                                                  -- one of the allowed extensions
                                                                                 extension IN
                                                                                 (SELECT cae.extension
                                                                                  FROM incentives.campaigns_allowed_extension cae
                                                                                  WHERE cae.campaign_id = p.campaign_id)),

                                                        interval_pair_prices_without_next_start
                                                            AS (SELECT date_bin(
                                                                               price_interval,
                                                                               blocks.time,
                                                                               '2000-01-01 00:00:00'::timestamptz) AS period_start,
                                                                       SUM(swaps.delta1 * swaps.delta1) /
                                                                       SUM(ABS(swaps.delta0 * swaps.delta1))       AS price,
                                                                       FLOOR(LOG(SUM(swaps.delta1 * swaps.delta1) /
                                                                                 SUM(ABS(swaps.delta0 * swaps.delta1))) /
                                                                             LOG(1.000001))::INT                   AS tick
                                                                FROM swaps
                                                                         JOIN relevant_pool_key_hashes rpkh ON swaps.pool_key_hash = rpkh.key_hash
                                                                         JOIN event_keys ON swaps.event_id = event_keys.id
                                                                         JOIN blocks ON event_keys.block_number = blocks.number,
                                                                     period_info
                                                                WHERE event_id BETWEEN (SELECT id
                                                                                        FROM event_keys
                                                                                        WHERE block_number >=
                                                                                              (SELECT number
                                                                                               FROM blocks,
                                                                                                    period_info
                                                                                               WHERE time >= start_time - (4 * price_interval)
                                                                                               ORDER BY number
                                                                                               LIMIT 1)
                                                                                        ORDER BY id
                                                                                        LIMIT 1) AND (SELECT id FROM max_event_id)
                                                                  AND swaps.delta0 != 0
                                                                  AND swaps.delta1 != 0
                                                                GROUP BY period_start),

                                                        interval_pair_prices AS (SELECT ipp.*,
                                                                                        LEAD(period_start) OVER (PARTITION BY multiple ORDER BY period_start) AS next_period_start,
                                                                                        weight,
                                                                                        INT4RANGE(
                                                                                                CEIL(ipp.tick - multiple * volatility_in_ticks)::INT,
                                                                                                ipp.tick::INT)                                                   stddev_range_lower,
                                                                                        INT4RANGE(
                                                                                                ipp.tick::INT,
                                                                                                FLOOR(ipp.tick + multiple * volatility_in_ticks)::INT)           stddev_range_upper
                                                                                 FROM interval_pair_prices_without_next_start ipp,
                                                                                      period_info,
                                                                                      stddev_multiple_weights),

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

                                                                                                 SUM(
                                                                                                 liquidity_delta)
                                                                                                 OVER (PARTITION BY pool_key_hash, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS liquidity,

                                                                                                 update_event_id,
                                                                                                 LEAD(
                                                                                                 update_event_id)
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
                                                                                          rpkh.mid_distance_in_ticks,
                                                                                          LEAST(upper_bound, ipp.tick) -
                                                                                          rpkh.mid_distance_in_ticks)
                                                                            ELSE INT4RANGE(ipp.tick, ipp.tick) END) AS tick_range_intersection_lower,
                                                                       (CASE
                                                                            WHEN upper_bound > ipp.tick THEN
                                                                                stddev_range_upper *
                                                                                INT4RANGE(
                                                                                        GREATEST(ipp.tick, lower_bound) +
                                                                                        rpkh.mid_distance_in_ticks,
                                                                                        upper_bound +
                                                                                        rpkh.mid_distance_in_ticks)
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
                                                                         JOIN relevant_pool_key_hashes rpkh ON psdp.pool_key_hash = rpkh.key_hash,
                                                                     interval_pair_prices ipp,
                                                                     period_info p),

                                                        position_depth_per_time
                                                            AS (SELECT pool_key_hash,
                                                                       locker,
                                                                       salt,

                                                                       (CASE
                                                                            WHEN ISEMPTY(tick_range_intersection_lower)
                                                                                THEN 0
                                                                            ELSE FLOOR(liquidity *
                                                                                       (POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection_lower)) -
                                                                                        POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection_lower))))
                                                                           END) AS amount1_lower,

                                                                       (CASE
                                                                            WHEN ISEMPTY(tick_range_intersection_upper)
                                                                                THEN 0
                                                                            ELSE FLOOR(
                                                                                    liquidity *
                                                                                    ((1::NUMERIC /
                                                                                      POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection_upper))) -
                                                                                     (1::NUMERIC /
                                                                                      POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection_upper)))))
                                                                           END) AS amount0_upper,

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

                                                        -- compute each position's total market depth score on the lower and upper side
                                                        position_pair_score_seconds AS (SELECT locker,
                                                                                               salt,
                                                                                               SUM(market_depth_score_lower) AS total_score_lower,
                                                                                               SUM(market_depth_score_upper) AS total_score_upper
                                                                                        FROM position_depth_seconds
                                                                                                 JOIN pool_keys ON key_hash = pool_key_hash
                                                                                        GROUP BY locker, salt),

                                                        -- sum up the total seconds * market depth score by pair
                                                        total_score_seconds
                                                            AS (SELECT SUM(total_score_lower) total_lower,
                                                                       SUM(total_score_upper) total_upper
                                                                FROM position_pair_score_seconds),

                                                        -- the percentage of each position's share of total depth seconds per pair
                                                        position_rewards AS (SELECT locker,
                                                                                    salt,
                                                                                    ((ppds.total_score_lower / GREATEST(tdspp.total_lower, 1)) *
                                                                                     pi.token0_reward_amount +
                                                                                     (ppds.total_score_upper / GREATEST(tdspp.total_upper, 1)) *
                                                                                     pi.token1_reward_amount)
                                                                                        AS incentives
                                                                             FROM position_pair_score_seconds ppds,
                                                                                  total_score_seconds tdspp,
                                                                                  period_info pi)

                                                   SELECT pi.id, -- campaign period id
                                                          locker,
                                                          salt,
                                                          incentives
                                                   FROM position_rewards pr,
                                                        period_info pi
                                                   WHERE incentives > 0);
      `,
      values: [
        // the period
        id,
        // fee denominator
        // to increase effect of fee, decrease the denominator, e.g. double effect by halving fee denominator
        0x0100000000000000000000000000000000n,
      ],
    });

    await client.query({
      text: `UPDATE incentives.campaign_reward_periods
                   SET rewards_last_computed_at = CURRENT_TIMESTAMP
                   WHERE id = $1`,
      values: [id],
    });

    console.log(
      `Finished processing period ${id} in ${(new Date().getTime() - processingStartTime) / 1000} seconds`,
    );
  }

  await client.query(`COMMIT;`);
  console.log(
    `Successfully finished processing ${rewardPeriodIds.length} periods`,
  );
} catch (e) {
  console.error("Encountered error", e);
  await client.query("ROLLBACK;");
  process.exit(1);
} finally {
  await client.end();
}
