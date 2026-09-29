"use strict";

const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

async function applySchema(pool, schemaPath = path.join(__dirname, "..", "db", "schema.sql")) {
  const schema = await readFile(schemaPath, "utf8");
  if (!schema.trim()) throw new Error("The SMIS database schema file is empty.");
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('smis-schema-migration'))");
    await client.query(schema);
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("SMIS schema migration rollback also failed.", rollbackError.code ? `Database error ${rollbackError.code}.` : "Unexpected database error.");
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 10000
  });
  try {
    await applySchema(pool);
    console.log("SMIS PostgreSQL schema is ready.");
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`SMIS database migration failed: ${error.code ? `database error ${error.code}` : error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { applySchema };
