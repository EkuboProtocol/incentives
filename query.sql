WITH
    -- the first event contained in the period
    min_event_id AS (SELECT id
                     FROM event_keys
                     WHERE block_number >= (SELECT number
                                            FROM blocks
                                            WHERE time >= :start
                                            ORDER BY number
                                            LIMIT 1)
                     ORDER BY id
                     LIMIT 1),

    -- the last event contained in the period
    max_event_id AS (SELECT id
                     FROM event_keys
                     WHERE block_number <= (SELECT number
                                            FROM blocks
                                            WHERE time < :end
                                            ORDER BY number DESC
                                            LIMIT 1)
                     ORDER BY id DESC
                     LIMIT 1),

    -- each of the pairs that are included in the program and their total share of incentives
    pairs AS (SELECT token0, token1, percent_total, volatility_in_ticks
              FROM (VALUES
                        -- strk/usdc
                        (0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d::NUMERIC,
                         0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8::NUMERIC,
                         0.21027095439414::NUMERIC,
                         553242::INT),
                        -- eth/usdc
                        (0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7,
                         0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8,
                         0.2790427107711134,
                         103174),
                        -- usdc/usdt
                        (0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8,
                         0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8,
                         0.08266904726513483,
                         14150),
                        -- strk/eth
                        (0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d,
                         0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7,
                         0.4280172875696118,
                         541258)) AS pairs (token0, token1, percent_total, volatility_in_ticks)),


    -- all the pool keys related to the incentivized pools
    relevant_pool_key_hashes AS (SELECT key_hash, pool_keys.token0, pool_keys.token1, fee
                                 FROM pool_keys
                                          JOIN pairs ON pairs.token0 = pool_keys.token0 AND
                                                        pairs.token1 = pool_keys.token1 AND extension = 0),

    hourly_pair_prices AS (SELECT pool_keys.token0,
                                  pool_keys.token1,
                                  date_bin(INTERVAL '1 hour', blocks.time,
                                           '2000-01-01 00:00:00'::TIMESTAMP WITHOUT TIME ZONE) AS period_start,
                                  MIN(event_id)                                                AS first_event_id,
                                  SUM(swaps.delta1 * swaps.delta1) /
                                  SUM(ABS(swaps.delta0 * swaps.delta1))                        AS price,
                                  FLOOR(LOG(SUM(swaps.delta1 * swaps.delta1) / SUM(ABS(swaps.delta0 * swaps.delta1))) /
                                        LOG(1.000001))::INT                                    AS tick
                           FROM swaps
                                    JOIN pool_keys
                                         ON swaps.pool_key_hash = pool_keys.key_hash
                                    JOIN pairs ON pool_keys.token0 = pairs.token0 AND pool_keys.token1 = pairs.token1
                                    JOIN event_keys ON swaps.event_id = event_keys.id
                                    JOIN blocks ON event_keys.block_number = blocks.number
                           WHERE event_id BETWEEN (SELECT id
                                                   FROM event_keys
                                                   WHERE block_number >= (SELECT number
                                                                          FROM blocks
                                                                          WHERE time >= :start::timestamptz - INTERVAL '1 hour'
                                                                          ORDER BY number
                                                                          LIMIT 1)
                                                   ORDER BY id
                                                   LIMIT 1) AND (SELECT id FROM max_event_id)
                           GROUP BY pool_keys.token0, pool_keys.token1, period_start),

    -- the state of all the positions aggregated at the beginning of the period
    positions_created_before_start AS (SELECT MAX(event_id)           AS event_id,
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
    positions_created_before_start_with_nonzero_liquidity AS (SELECT *
                                                              FROM positions_created_before_start
                                                              WHERE liquidity_delta != 0),


    -- treat these initial positions as if they were created exactly at the beginning of the period by creating
    -- one row for a position update for each of them
    -- there is no filter on the time of the tick update, because all tick updates happened in the period and these positions happened before
    all_position_updates_in_period AS (SELECT pu.event_id            update_event_id,
                                              pu.pool_key_hash,
                                              pu.locker,
                                              pu.salt,
                                              pu.lower_bound,
                                              pu.upper_bound,
                                              pu.liquidity_delta,
                                              -- pretend like the position was updated at the very beginning of the period
                                              :start::timestamptz AS update_time
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

    position_depth_per_time AS (SELECT psdp.pool_key_hash                                                 AS pool_key_hash,
                                       locker,
                                       salt,
                                       lower_bound,
                                       upper_bound,

                                       (CASE
                                            WHEN tick < lower_bound THEN FLOOR(liquidity *
                                                                               ((1::NUMERIC / POWER(1.0000005::NUMERIC, lower_bound)) -
                                                                                (1::NUMERIC / POWER(1.0000005::NUMERIC, upper_bound))))
                                            WHEN tick < upper_bound THEN FLOOR(liquidity *
                                                                               ((1::NUMERIC / POWER(1.0000005::NUMERIC, hpp.tick)) -
                                                                                (1::NUMERIC / POWER(1.0000005::NUMERIC, upper_bound))))
                                            ELSE 0 END) *
                                       hpp.price                                                          AS amount0_in_terms_of_amount1,

                                       (CASE
                                            WHEN tick < lower_bound THEN 0
                                            WHEN tick < upper_bound THEN FLOOR(
                                                    liquidity *
                                                    (POWER(1.0000005::NUMERIC, hpp.tick) -
                                                     POWER(1.0000005::NUMERIC, lower_bound)))
                                            ELSE FLOOR(liquidity *
                                                       (POWER(1.0000005::NUMERIC, upper_bound) -
                                                        POWER(1.0000005::NUMERIC, lower_bound))) END)     AS amount1,

                                       (LEAST(hpp.tick + pairs.volatility_in_ticks, psdp.upper_bound) -
                                        GREATEST(hpp.tick - pairs.volatility_in_ticks, psdp.lower_bound)) AS ticks_in_range_of_1_volatility,

                                       (LEAST(hpp.tick + (pairs.volatility_in_ticks * 2), psdp.upper_bound) -
                                        GREATEST(hpp.tick - (pairs.volatility_in_ticks * 2),
                                                 psdp.lower_bound))                                       AS ticks_in_range_of_2_volatility,
                                       (LEAST(hpp.tick + (pairs.volatility_in_ticks * 3), psdp.upper_bound) -
                                        GREATEST(hpp.tick - (pairs.volatility_in_ticks * 3),
                                                 psdp.lower_bound))                                       AS ticks_in_range_of_3_volatility,

                                       psdp.upper_bound - psdp.lower_bound                                AS position_width,

                                       ROUND(
                                               GREATEST(EXTRACT(
                                                                EPOCH FROM (
                                                           LEAST(
                                                                   COALESCE(psdp.next_update_time, :end),
                                                                   hpp.period_start + INTERVAL '1 hour') -
                                                           GREATEST(psdp.update_time, hpp.period_start)
                                                           )
                                                        ), 0)
                                       )                                                                  AS row_seconds

                                FROM position_states_during_period psdp
                                         JOIN pool_keys pk ON psdp.pool_key_hash = pk.key_hash
                                         LEFT JOIN hourly_pair_prices hpp
                                                   ON pk.token0 = hpp.token0 AND pk.token1 = hpp.token1
                                         JOIN relevant_pool_key_hashes rpkh ON psdp.pool_key_hash = rpkh.key_hash
                                         JOIN pairs ON rpkh.token0 = pairs.token0 AND rpkh.token1 = pairs.token1),

    position_depth_seconds AS (SELECT pool_key_hash,
                                      locker,
                                      salt,
                                      lower_bound,
                                      upper_bound,
                                      SUM(((amount0_in_terms_of_amount1 + amount1) *
                                           (ticks_in_range_of_1_volatility / position_width) *
                                           row_seconds * 0.683) +
                                          ((amount0_in_terms_of_amount1 + amount1) *
                                           (ticks_in_range_of_2_volatility / position_width) *
                                           row_seconds * 0.271) +
                                          ((amount0_in_terms_of_amount1 + amount1) *
                                           (ticks_in_range_of_3_volatility / position_width) *
                                           row_seconds * 0.043)
                                      ) AS market_depth_score

                               FROM position_depth_per_time

                               GROUP BY pool_key_hash, locker, salt, lower_bound, upper_bound),

    -- compute each positions liquidity seconds by pair
    position_pair_depth_seconds AS (SELECT token0,
                                           token1,
                                           locker,
                                           salt,
                                           SUM(market_depth_score *
                                               POWER((340282366920938463463374607431768211456 - fee) /
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
                                                pls.token0,
                                                pls.token1,
                                                (pls.fee_adjusted_total_score / tdspp.total) AS position_rewards_share
                                         FROM position_pair_depth_seconds pls
                                                  JOIN total_depth_seconds_per_pair tdspp
                                                       ON pls.token0 = tdspp.token0 AND pls.token1 = tdspp.token1
                                         WHERE pls.fee_adjusted_total_score > 0
                                           AND tdspp.total > 0),

    ranked_transfers AS (SELECT token_id,
                                to_address,
                                ROW_NUMBER() OVER (
                                    PARTITION BY token_id
                                    ORDER BY event_id DESC
                                    ) AS row_no
                         FROM position_transfers
                         WHERE to_address != 0
                           AND event_id <= (SELECT id FROM max_event_id)),

    token_owners AS (SELECT token_id,
                            to_address AS owner
                     FROM ranked_transfers
                     WHERE row_no = 1)

SELECT numeric_to_hex(owner)                        AS owner,
       token_id,
       position_rewards_share * pairs.percent_total AS percent_of_total
FROM position_percent_of_pair_rewards ppopr
         JOIN pairs ON ppopr.token0 = pairs.token0 AND ppopr.token1 = pairs.token1
         JOIN token_owners ON token_id = salt
ORDER BY 3 DESC;
