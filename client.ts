import pg from "pg";

const client = new pg.Client({
  ssl: {
    rejectUnauthorized: false,
  },
});

export default client;
