// db.js — Supabase PostgreSQL helper
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, // <-- THIS IS THE FIX for pooler
});

pool.on("connect", () => {
  console.log("🔥 Connected to Supabase PostgreSQL");
});

pool.on("error", (err) => {
  console.error("❌ PostgreSQL error:", err);
});

module.exports = { pool };
