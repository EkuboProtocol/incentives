import pg from "pg";

export default async function initializeIncentivesClient() {
  const client = new pg.Client({});

  await client.connect();

  // language=PostgreSQL
  await client.query(`
      CREATE SCHEMA IF NOT EXISTS incentives;

      CREATE TABLE IF NOT EXISTS incentives.stddevs_table
      (
          id   SERIAL  NOT NULL,
          name VARCHAR NOT NULL,
          PRIMARY KEY (id)
      );

      CREATE TABLE IF NOT EXISTS incentives.stddevs_table_entries
      (
          stddevs_table_id INT   NOT NULL REFERENCES incentives.stddevs_table (id) ON DELETE CASCADE,
          multiple         FLOAT NOT NULL,
          weight           FLOAT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incentives.campaigns
      (
          id               SERIAL8     NOT NULL,
          -- when the campaign is expected to start
          start_time       timestamptz NOT NULL,
          -- when campaign will end, if it is known
          end_time         timestamptz,
          -- the name of the campaign
          name             TEXT        NOT NULL,

          slug             VARCHAR(20) NOT NULL,
          -- the token that is being used for rewards
          reward_token     NUMERIC     NOT NULL,
          -- the amount available for rewards
          budget           NUMERIC     NOT NULL,
          -- the weights used for incentive calculations
          stddevs_table_id INT         NOT NULL REFERENCES incentives.stddevs_table,
          PRIMARY KEY (id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_incentive_campaigns_slug ON incentives.campaigns (slug);

      CREATE TABLE IF NOT EXISTS incentives.campaigns_allowed_extension
      (
          campaign_id INT REFERENCES incentives.campaigns (id) ON DELETE CASCADE,
          extension   NUMERIC NOT NULL,
          PRIMARY KEY (campaign_id, extension)
      );

      -- specific dates on which rewards are provided to pairs
      CREATE TABLE IF NOT EXISTS incentives.campaign_reward_periods
      (
          campaign_id              INT REFERENCES incentives.campaigns (id) ON DELETE CASCADE,

          id                       SERIAL8,
          -- token pair being incentivized
          token0                   NUMERIC     NOT NULL,
          token1                   NUMERIC     NOT NULL,
          -- the start of the rewards period
          start_time               timestamptz NOT NULL,
          -- the end of the rewards period
          end_time                 timestamptz NOT NULL,

          -- the realized volatility to use for computing rewards
          realized_volatility      float8      NOT NULL,
          -- the amount that is being distributed for the period
          token0_reward_amount     NUMERIC     NOT NULL,
          token1_reward_amount     NUMERIC     NOT NULL,
          -- when the rewards were last computed for this period, or null if they haven't been computed yet
          rewards_last_computed_at timestamptz,

          PRIMARY KEY (id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_reward_periods_pair_period
          ON incentives.campaign_reward_periods (token0, token1, start_time, end_time);

      CREATE TABLE IF NOT EXISTS incentives.computed_rewards
      (
          campaign_reward_period_id int8    NOT NULL REFERENCES incentives.campaign_reward_periods (id),
          locker                    NUMERIC NOT NULL,
          salt                      NUMERIC NOT NULL,
          reward_amount             NUMERIC NOT NULL,
          PRIMARY KEY (campaign_reward_period_id, locker, salt)
      );

      CREATE TABLE IF NOT EXISTS incentives.generated_drop
      (
          id           SERIAL8 PRIMARY KEY,
          root         NUMERIC NOT NULL,
          generated_at timestamptz DEFAULT CURRENT_TIMESTAMP
      );

      -- the periods that were included in the generated merkle root
      CREATE TABLE IF NOT EXISTS incentives.generated_drop_reward_periods
      (
          drop_id                   int8 NOT NULL REFERENCES incentives.generated_drop (id) ON DELETE CASCADE,

          -- this should not cascade, because it means the source of the data is being deleted
          campaign_reward_period_id int8 NOT NULL REFERENCES incentives.campaign_reward_periods (id),
          
          PRIMARY KEY (drop_id, campaign_reward_period_id)
      );

      -- this prevents us from including the same period id in multiple drops
      CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_drop_reward_periods_period_id
          ON incentives.generated_drop_reward_periods (campaign_reward_period_id);

      CREATE TABLE IF NOT EXISTS incentives.generated_drop_proof
      (
          drop_id INT REFERENCES incentives.generated_drop (id) ON DELETE CASCADE,
          id      INT       NOT NULL,
          address NUMERIC   NOT NULL,
          amount  NUMERIC   NOT NULL,
          proof   NUMERIC[] NOT NULL,
          PRIMARY KEY (drop_id, id)
      );

      -- meant to be manually populated
      CREATE TABLE IF NOT EXISTS incentives.deployed_airdrop_contracts
      (
          address NUMERIC NOT NULL PRIMARY KEY,
          token   NUMERIC NOT NULL,
          drop_id INT REFERENCES incentives.generated_drop (id) ON DELETE CASCADE
      );
  `);

  console.log("Schema initialized");

  return client;
}
