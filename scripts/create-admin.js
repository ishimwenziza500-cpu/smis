"use strict";

const { Pool } = require("pg");
const { hashPassword } = require("../auth");
const { readPassword } = require("./prompt-password");

async function main() {
  const [emailArgument, nameArgument] = process.argv.slice(2);
  if (!emailArgument || !nameArgument || process.argv.length !== 4) {
    console.error('Usage: node scripts/create-admin.js <email> "<full name>"');
    process.exitCode = 2;
    return;
  }
  const email = emailArgument.trim().toLowerCase();
  const name = nameArgument.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length < 1 || name.length > 200) {
    console.error("Provide a valid email and a name of 1–200 characters.");
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || Buffer.byteLength(process.env.SESSION_SECRET || "", "utf8") < 32) {
    console.error("DATABASE_URL and a SESSION_SECRET of at least 32 bytes are required.");
    process.exitCode = 2;
    return;
  }
  const password = await readPassword();
  const passwordHash = await hashPassword(password);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false
  });
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('smis-first-admin'))");
    const existing = await client.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      console.error("An administrator already exists. Ask an existing administrator to provision additional staff.");
      process.exitCode = 1;
      return;
    }
    await client.query(
      "INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'admin', $3)",
      [email, name, passwordHash]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    console.log(`Administrator account created for ${email}. Store the credentials in your approved password manager.`);
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    if (error.code === "23505") {
      console.error("An account with that email already exists.");
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Administrator provisioning failed: ${error.message}`);
  process.exitCode = 1;
});
