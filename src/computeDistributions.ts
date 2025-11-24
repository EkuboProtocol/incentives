import postgres from "postgres";

const sql = postgres();
let rewardPeriodIds: string[] = [];

try {
  await sql.begin(async (tx) => {
    rewardPeriodIds = (
      await tx<
        {
          id: string;
        }[]
      >`
            SELECT id
            FROM incentives.campaign_reward_periods
            WHERE rewards_last_computed_at IS NULL
              AND end_time <= (
                SELECT time
                FROM blocks
                WHERE hash != 0
                ORDER BY number DESC
                LIMIT 1
              )
            ORDER BY end_time
          `
    ).map(({ id }) => id);

    console.log(`Found ${rewardPeriodIds.length} periods to process`);

    for (const id of rewardPeriodIds) {
      console.log(`Processing period ID ${id}`);

      const processingStartTime = Date.now();

      await tx`
        DELETE
        FROM incentives.computed_rewards
        WHERE campaign_reward_period_id = ${id};
      `;

      await tx`
INSERT INTO incentives.computed_rewards (campaign_reward_period_id, locker, salt, reward_amount) (
WITH period_info AS (
	SELECT
		crp.id,
		crp.start_time,
		crp.end_time,
		crp.token0,
		crp.token1,
		crp.token0_reward_amount,
		crp.token1_reward_amount,
		c.allowed_extensions,
		c.excluded_locker_salts,
		coalesce(crp.fee_denominator, c.default_fee_denominator) AS fee_denominator,
		coalesce(crp.max_coverage, c.default_max_coverage) AS max_coverage,
		coalesce(crp.percent_step, c.default_percent_step) AS percent_step,
		round(log(exp(realized_volatility)) / log(1.000001))::int AS volatility_in_ticks,
		GREATEST ((crp.end_time - crp.start_time)::interval / 30, '1 hours') AS price_interval
	FROM
		incentives.campaign_reward_periods crp
		JOIN incentives.campaigns c ON crp.campaign_id = c.id
	WHERE
		crp.id = ${id}
),
-- the first event contained in the period
min_event_id AS (
	SELECT
		id
	FROM
		event_keys
	WHERE
		block_number >= (
			SELECT
				number
			FROM
				blocks,
				period_info
			WHERE
				time >= period_info.start_time
			ORDER BY
				number
			LIMIT 1)
	ORDER BY
		id
	LIMIT 1
),
-- the last event contained in the period
max_event_id AS (
	SELECT
		id
	FROM
		event_keys
	WHERE
		block_number <= (
			SELECT
				number
			FROM
				blocks,
				period_info
			WHERE
				time < period_info.end_time
			ORDER BY
				number DESC
			LIMIT 1)
	ORDER BY
		id DESC
	LIMIT 1
),
-- the weights corresponding to each multiple of the standard deviation
stddev_multiple_weights AS (
	SELECT
		row_number() OVER (ORDER BY multiple) row_no,
		GREATEST (ceil(volatility_in_ticks * multiple), 1) AS tick_weight,
	(incentives.percent_within_std (multiple) - coalesce(lag(incentives.percent_within_std (multiple)) OVER (ORDER BY multiple), 0)) AS weight
FROM
	period_info pi,
	unnest(incentives.linear_percent_std_multiples (pi.percent_step, pi.max_coverage)) AS multiple
),
-- all the pool keys related to the incentivized pools
relevant_pool_key_hashes AS (
	SELECT
		pk.key_hash,
		int4(log(1::numeric + (fee / fee_denominator)) / log(1.000001::numeric)) AS mid_distance_in_ticks
FROM
	pool_keys pk
	JOIN period_info p ON p.token0 = pk.token0
		AND p.token1 = pk.token1
		AND
		-- one of the allowed extensions
		pk.extension = ANY (p.allowed_extensions)
),
seed_tick AS (
	SELECT
		s.tick_after AS tick
	FROM
		swaps s
	JOIN event_keys ek ON s.event_id = ek.id
	JOIN blocks b ON ek.block_number = b.number
	JOIN relevant_pool_key_hashes rpkh ON s.pool_key_hash = rpkh.key_hash,
	period_info p
	WHERE
		b.time < p.start_time
	ORDER BY
		b.time DESC
	LIMIT 1
),
time_bins AS (
	SELECT
		generate_series(date_bin (p.price_interval, p.start_time, '2000-01-01'::timestamptz), date_bin (p.price_interval, p.end_time, '2000-01-01'::timestamptz), p.price_interval) AS period_start
FROM
	period_info p
),
bin_medians AS (
	SELECT
		date_bin (p.price_interval, b.time, '2000-01-01'::timestamptz) AS period_start,
	round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.tick_after))::int4 AS tick
FROM
	swaps s
	JOIN event_keys ek ON s.event_id = ek.id
	JOIN blocks b ON ek.block_number = b.number
	JOIN relevant_pool_key_hashes rpkh ON s.pool_key_hash = rpkh.key_hash
	JOIN period_info p ON TRUE
	WHERE
		s.event_id BETWEEN (
			SELECT
				id
			FROM
				min_event_id)
			AND (
				SELECT
					id
				FROM
					max_event_id)
				AND s.liquidity_after != 0 GROUP BY
					1
),
interval_pair_prices_without_next_start AS (
	SELECT
		tb.period_start,
		coalesce((
			SELECT
				bm.tick
			FROM bin_medians bm
		WHERE
			bm.period_start < tb.period_start ORDER BY bm.period_start DESC LIMIT 1), st.tick) AS tick
	FROM
		time_bins tb,
		seed_tick st
),
interval_pair_prices AS (
	SELECT
		ipp.*,
		lead(period_start) OVER (PARTITION BY weights.row_no ORDER BY period_start) AS next_period_start,
		weight,
		int4range(ceil(ipp.tick - tick_weight)::int, ipp.tick::int) stddev_range_lower,
		int4range(ipp.tick::int, floor(ipp.tick + tick_weight)::int) stddev_range_upper
	FROM
		interval_pair_prices_without_next_start ipp,
		period_info,
		stddev_multiple_weights weights
),
-- the state of all the positions aggregated at the beginning of the period
positions_created_before_start AS (
	SELECT
		max(event_id) AS event_id,
		pu.pool_key_hash,
		pu.locker,
		pu.salt,
		pu.lower_bound,
		pu.upper_bound,
		sum(pu.liquidity_delta) AS liquidity_delta
FROM
	position_updates pu
	JOIN relevant_pool_key_hashes rpkh ON pu.pool_key_hash = rpkh.key_hash
	WHERE
		event_id < (
			SELECT
				id
			FROM
				min_event_id)
			GROUP BY
				pu.pool_key_hash,
				pu.locker,
				pu.salt,
				pu.lower_bound,
				pu.upper_bound
),
-- ignore any positions that were already fully withdrawn
positions_created_before_start_with_nonzero_liquidity AS (
	SELECT
		*
	FROM
		positions_created_before_start
	WHERE
		liquidity_delta != 0
),
-- treat these initial positions as if they were created exactly at the beginning of the period by creating
-- one row for a position update for each of them
-- there is no filter on the time of the tick update, because all tick updates happened in the period and these positions happened before
all_position_updates_in_period AS (
	SELECT
		pu.event_id update_event_id,
		pu.pool_key_hash,
		pu.locker,
		pu.salt,
		pu.lower_bound,
		pu.upper_bound,
		pu.liquidity_delta,
		-- pretend like the position was updated at the very beginning of the period
		p.start_time AS update_time
	FROM
		positions_created_before_start_with_nonzero_liquidity pu,
		period_info p
	UNION ALL
	SELECT
		pu.event_id update_event_id,
		pu.pool_key_hash,
		pu.locker,
		pu.salt,
		pu.lower_bound,
		pu.upper_bound,
		pu.liquidity_delta,
		pu_b.time AS update_time
	FROM
		position_updates pu
		JOIN event_keys pu_ek ON pu.event_id = pu_ek.id
		JOIN blocks pu_b ON pu_ek.block_number = pu_b.number
	WHERE
		pu.event_id BETWEEN (
			SELECT
				id
			FROM
				min_event_id)
			AND (
				SELECT
					id
				FROM
					max_event_id)
),
-- the position state at each point during the period
position_states_during_period AS (
	SELECT
		pool_key_hash,
		locker,
		salt,
		lower_bound,
		upper_bound,
		sum(liquidity_delta) OVER (PARTITION BY pool_key_hash,
			locker,
			salt,
			lower_bound,
			upper_bound ORDER BY update_event_id) AS liquidity,
	update_event_id,
	lead(update_event_id) OVER (PARTITION BY pool_key_hash,
		locker,
		salt,
		lower_bound,
		upper_bound ORDER BY update_event_id) AS next_update_event_id,
	update_time,
	lead(update_time) OVER (PARTITION BY pool_key_hash,
		locker,
		salt,
		lower_bound,
		upper_bound ORDER BY update_event_id) AS next_update_time
FROM
	all_position_updates_in_period
),
position_states_during_period_with_intersections AS (
	SELECT
		psdp.pool_key_hash AS pool_key_hash,
		locker,
		salt,
		psdp.liquidity,
		(
			CASE WHEN lower_bound < ipp.tick THEN
				stddev_range_lower * int4range(lower_bound - rpkh.mid_distance_in_ticks, LEAST (upper_bound, ipp.tick) - rpkh.mid_distance_in_ticks)
			ELSE
				int4range(ipp.tick, ipp.tick)
			END) AS tick_range_intersection_lower,
	(
		CASE WHEN upper_bound > ipp.tick THEN
			stddev_range_upper * int4range(GREATEST (ipp.tick, lower_bound) + rpkh.mid_distance_in_ticks, upper_bound + rpkh.mid_distance_in_ticks)
		ELSE
			int4range(ipp.tick, ipp.tick)
		END) AS tick_range_intersection_upper,
	weight,
	ipp.tick,
	round(GREATEST (extract(EPOCH FROM (LEAST (coalesce(psdp.next_update_time, (p.end_time)), coalesce(ipp.next_period_start, (p.end_time))) - GREATEST (psdp.update_time, ipp.period_start))), 0)) AS row_seconds
FROM
	position_states_during_period psdp
	JOIN relevant_pool_key_hashes rpkh ON psdp.pool_key_hash = rpkh.key_hash,
	interval_pair_prices ipp,
	period_info p
	WHERE (psdp.locker,
		psdp.salt)::incentives.locker_salt_pair <> ALL (p.excluded_locker_salts)
),
position_depth_per_time AS (
	SELECT
		pool_key_hash,
		locker,
		salt,
		(
			CASE WHEN isempty(tick_range_intersection_lower) THEN
				0
			ELSE
				floor(liquidity * (power(1.0000005::numeric, upper(tick_range_intersection_lower)) - power(1.0000005::numeric, lower(tick_range_intersection_lower))))
			END) AS amount1_lower,
		(
			CASE WHEN isempty(tick_range_intersection_upper) THEN
				0
			ELSE
				floor(liquidity * ((1::numeric / power(1.0000005::numeric, lower(tick_range_intersection_upper))) - (1::numeric / power(1.0000005::numeric, upper(tick_range_intersection_upper)))))
			END) AS amount0_upper,
		row_seconds,
		weight
	FROM
		position_states_during_period_with_intersections
	WHERE
		row_seconds > 0
),
position_depth_seconds AS (
	SELECT
		pool_key_hash,
		locker,
		salt,
		sum(amount0_upper * row_seconds * weight) AS market_depth_score_lower,
		sum(amount1_lower * row_seconds * weight) AS market_depth_score_upper
	FROM
		position_depth_per_time GROUP BY
			pool_key_hash,
			locker,
			salt
),
-- compute each position's total market depth score on the lower and upper side
position_pair_score_seconds AS (
	SELECT
		locker,
		salt,
		sum(market_depth_score_lower) AS total_score_lower,
		sum(market_depth_score_upper) AS total_score_upper
	FROM
		position_depth_seconds
		JOIN pool_keys ON key_hash = pool_key_hash GROUP BY
			locker,
			salt
),
-- sum up the total seconds * market depth score by pair
total_score_seconds AS (
	SELECT
		sum(total_score_lower) total_lower,
		sum(total_score_upper) total_upper
	FROM
		position_pair_score_seconds
),
-- the percentage of each position's share of total depth seconds per pair
position_rewards AS (
	SELECT
		locker,
		salt,
		floor(((ppds.total_score_lower / GREATEST (tdspp.total_lower, 1)) * pi.token0_reward_amount + (ppds.total_score_upper / GREATEST (tdspp.total_upper, 1)) * pi.token1_reward_amount)) AS reward_amount
	FROM
		position_pair_score_seconds ppds,
		total_score_seconds tdspp,
		period_info pi
)
SELECT
	pi.id, -- campaign period id
	locker,
	salt,
	reward_amount
FROM
	position_rewards pr,
	period_info pi
WHERE
	reward_amount > 0
);
      `;

      await tx`
        UPDATE incentives.campaign_reward_periods
        SET rewards_last_computed_at = CURRENT_TIMESTAMP
        WHERE id = ${id};
      `;

      console.log(
        `Finished processing period ${id} in ${
          (Date.now() - processingStartTime) / 1000
        } seconds`,
      );
    }
  });

  console.log(
    `Successfully finished processing ${rewardPeriodIds.length} periods`,
  );
} catch (e) {
  console.error("Encountered error", e);
  process.exit(1);
} finally {
  await sql.end();
}
