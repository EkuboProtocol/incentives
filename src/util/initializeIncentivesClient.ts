import pg from "pg";

export default async function initializeIncentivesClient() {
  const client = new pg.Client();
  await client.connect();
  console.log("Schema initialized");
  return client;
}
