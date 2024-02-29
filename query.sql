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

    -- the state of the pools at the beginning of the period or when it was created _iff_ it was created during the period
    starting_pool_states AS (SELECT rpkh.key_hash         AS key_hash,
                                    COALESCE(last_swap_before_start.event_id,
                                             pi.event_id) AS first_event_id,
                                    COALESCE(last_swap_before_start.tick_after,
                                             pi.tick)     AS starting_tick
                             FROM relevant_pool_key_hashes rpkh
                                      JOIN pool_initializations pi
                                           ON rpkh.key_hash = pi.pool_key_hash AND
                                              pi.event_id <= (SELECT id FROM max_event_id)
                                      LEFT JOIN LATERAL (
                                 SELECT event_id, tick_after
                                 FROM swaps
                                 WHERE swaps.pool_key_hash = rpkh.key_hash
                                   AND swaps.event_id < (SELECT id FROM min_event_id)
                                 ORDER BY event_id DESC
                                 LIMIT 1
                                 ) AS last_swap_before_start ON TRUE),

    -- each block with a swap and the ranking within the block, plus the resulting tick
    all_pool_tick_changes_due_to_events AS (SELECT sps.first_event_id           AS event_id,
                                                   key_hash                     AS pool_key_hash,
                                                   starting_tick                AS tick,
                                                   GREATEST(sps_b.time, :start) AS time
                                            FROM starting_pool_states sps
                                                     JOIN event_keys sps_ek ON sps.first_event_id = sps_ek.id
                                                     JOIN blocks sps_b ON sps_ek.block_number = sps_b.number
                                            UNION ALL
                                            SELECT s.event_id AS event_id,
                                                   s.pool_key_hash,
                                                   tick_after AS tick,
                                                   s_b.time   AS time
                                            FROM swaps s
                                                     JOIN starting_pool_states sps ON s.pool_key_hash = sps.key_hash
                                                     JOIN event_keys s_ek ON s.event_id = s_ek.id
                                                     JOIN blocks s_b ON s_ek.block_number = s_b.number
                                            WHERE s.event_id BETWEEN GREATEST(sps.first_event_id + 1, (SELECT id FROM min_event_id)) AND (SELECT id FROM max_event_id)),

    -- all the relevant times and their rank within block, to be filtered next
    all_pool_tick_changes_with_ranks AS (SELECT pool_key_hash,
                                                event_id,
                                                tick,
                                                time,
                                                RANK()
                                                OVER (PARTITION BY pool_key_hash, time ORDER BY event_id DESC) AS rank_per_time
                                         FROM all_pool_tick_changes_due_to_events),

    -- the last tick change per time per pool
    pool_tick_changes_per_time_rank_1 AS (SELECT pool_key_hash,
                                                 time,
                                                 event_id,
                                                 tick
                                          FROM all_pool_tick_changes_with_ranks
                                          WHERE rank_per_time = 1),


    pool_tick_changes_per_time AS (SELECT pool_key_hash,
                                          event_id,
                                          time                                                           AS tick_change_time,
                                          tick,
                                          LEAD(time) OVER (PARTITION BY pool_key_hash ORDER BY event_id) AS next_tick_change_time
                                   FROM pool_tick_changes_per_time_rank_1),

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

    position_liquidity_seconds_per_row AS (SELECT psdp.pool_key_hash                                                 AS pool_key_hash,
                                                  locker,
                                                  salt,
                                                  lower_bound,
                                                  upper_bound,

                                                  (CASE
                                                       WHEN ptc.tick < psdp.lower_bound THEN
                                                           psdp.liquidity *
                                                           ((1::NUMERIC / POWER(1.0000005::NUMERIC, lower_bound)) -
                                                            (1::NUMERIC / POWER(1.0000005::NUMERIC, upper_bound)))
                                                       WHEN ptc.tick < psdp.upper_bound THEN
                                                           psdp.liquidity *
                                                           ((1::NUMERIC / POWER(1.0000005::NUMERIC, ptc.tick)) -
                                                            (1::NUMERIC / POWER(1.0000005::NUMERIC, upper_bound)))
                                                       ELSE 0 END)                                                   AS amount0,

                                                  (CASE
                                                       WHEN ptc.tick < psdp.lower_bound THEN
                                                           psdp.liquidity *
                                                           (POWER(1.0000005::NUMERIC, psdp.upper_bound) -
                                                            POWER(1.0000005::NUMERIC, psdp.lower_bound))
                                                       WHEN ptc.tick < psdp.upper_bound THEN
                                                           psdp.liquidity *
                                                           (POWER(1.0000005::NUMERIC, psdp.upper_bound) -
                                                            POWER(1.0000005::NUMERIC, ptc.tick))
                                                       ELSE
                                                           0
                                                      END)                                                           AS amount1,

                                                  (LEAST(ptc.tick + pairs.volatility_in_ticks, psdp.upper_bound) -
                                                   GREATEST(ptc.tick - pairs.volatility_in_ticks, psdp.lower_bound)) AS ticks_in_range,

                                                  psdp.upper_bound - psdp.lower_bound                                AS position_width,

                                                  ROUND(
                                                          GREATEST(EXTRACT(
                                                                           EPOCH FROM (
                                                                      LEAST(
                                                                              COALESCE(psdp.next_update_time, :end),
                                                                              COALESCE(ptc.next_tick_change_time, :end)) -
                                                                      GREATEST(psdp.update_time, ptc.tick_change_time)
                                                                      )
                                                                   ), 0)
                                                  )                                                                  AS row_seconds

                                           FROM position_states_during_period psdp
                                                    LEFT JOIN pool_tick_changes_per_time ptc
                                                              ON psdp.pool_key_hash = ptc.pool_key_hash
                                                    JOIN relevant_pool_key_hashes rpkh ON psdp.pool_key_hash = rpkh.key_hash
                                                    JOIN pairs ON rpkh.token0 = pairs.token0 AND rpkh.token1 = pairs.token1),

    position_liquidity_seconds AS (SELECT pool_key_hash,
                                          locker,
                                          salt,
                                          lower_bound,
                                          upper_bound,
                                          SUM(SQRT(amount0 * amount1) * (ticks_in_range / position_width) *
                                              row_seconds) AS amount1_seconds

                                   FROM position_liquidity_seconds_per_row

                                   GROUP BY pool_key_hash, locker, salt, lower_bound, upper_bound),

    -- compute each positions liquidity seconds by pair
    position_pair_liquidity_seconds AS (SELECT token0,
                                               token1,
                                               locker,
                                               salt,
                                               SUM(amount1_seconds *
                                                   POWER((340282366920938463463374607431768211456 - fee) /
                                                         340282366920938463463374607431768211456,
                                                         2)) AS liquidity_seconds
                                        FROM position_liquidity_seconds
                                                 JOIN pool_keys ON key_hash = pool_key_hash
                                        GROUP BY token0, token1, locker, salt),


    -- sum up the total liquidity seconds by pair
    total_liquidity_seconds_by_pair AS (SELECT token0,
                                               token1,
                                               GREATEST(SUM(liquidity_seconds), 1) total
                                        FROM position_pair_liquidity_seconds
                                        GROUP BY token0, token1),

    -- the percentage of each position's share of total liquidity seconds per pair
    position_percent_of_pair_rewards AS (SELECT locker,
                                                salt,
                                                pls.token0,
                                                pls.token1,
                                                (pls.liquidity_seconds / tlsbp.total) AS rewards_percent
                                         FROM position_pair_liquidity_seconds pls
                                                  JOIN total_liquidity_seconds_by_pair tlsbp
                                                       ON pls.token0 = tlsbp.token0 AND pls.token1 = tlsbp.token1
                                         WHERE pls.liquidity_seconds > 0),

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

SELECT numeric_to_hex(owner)                 AS owner,
       token_id,
       rewards_percent * pairs.percent_total AS percent_of_total
FROM position_percent_of_pair_rewards ppopr
         JOIN pairs ON ppopr.token0 = pairs.token0 AND ppopr.token1 = pairs.token1
         JOIN token_owners ON token_id = salt
ORDER BY 3 DESC;
