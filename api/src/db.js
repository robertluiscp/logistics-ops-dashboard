const { Pool } = require("pg");
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: process.env.PGPORT || 5432,
  database: process.env.PGDATABASE || "logistics_ops",
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

module.exports = { pool };
