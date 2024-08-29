import pg from "pg";

export default async function initializeClient() {
  const client = new pg.Client({});
  await client.connect();

  await client.query(`
      CREATE TABLE IF NOT EXISTS strk_defi_spring_incentives
      (
          locker       NUMERIC     NOT NULL,
          salt         NUMERIC     NOT NULL,
          day          timestamptz NOT NULL,
          incentives   NUMERIC     NOT NULL,
          last_updated timestamptz NOT NULL,
          PRIMARY KEY (locker, salt, day)
      );

      CREATE INDEX IF NOT EXISTS idx_strk_defi_spring_incentives_salt_day ON strk_defi_spring_incentives USING btree (salt, day);

      CREATE TABLE IF NOT EXISTS generated_drop
      (
          id           SERIAL PRIMARY KEY,
          root         NUMERIC     NOT NULL,
          start_date   timestamptz NOT NULL,
          end_date     timestamptz NOT NULL,
          generated_at timestamptz DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS generated_drop_proof
      (
          drop_id INT REFERENCES generated_drop (id) ON DELETE CASCADE,
          id      INT       NOT NULL,
          claimee NUMERIC   NOT NULL,
          amount  NUMERIC   NOT NULL,
          proof   NUMERIC[] NOT NULL,
          PRIMARY KEY (drop_id, id, claimee)
      );

      -- meant to be manually populated
      CREATE TABLE IF NOT EXISTS deployed_airdrop_contracts
      (
          address NUMERIC NOT NULL PRIMARY KEY,
          token   NUMERIC NOT NULL,
          drop_id INT REFERENCES generated_drop (id) ON DELETE CASCADE
      );
  `);

  console.log("Schema initialized");

  return client;
}
