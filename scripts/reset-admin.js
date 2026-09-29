"use strict";

const { Pool } = require("pg");
const { hashPassword } = require("../auth");
const { readHiddenValue, readPassword } = require("./prompt-password");

async function resetAdminPassword(pool, email, passwordHash) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query(
      "UPDATE users SET password_hash = $1 WHERE email = $2 AND role = 'admin' RETURNING id",
      [passwordHash, email]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return false;
    }
    await client.query("DELETE FROM sessions WHERE user_id = $1", [result.rows[0].id]);
    await client.query("COMMIT");
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const [emailArgument] = process.argv.slice(2);
  if (!emailArgument || process.argv.length !== 3) {
    console.error("Usage: npm run reset-admin -- <admin-email>");
    process.exitCode = 2;
    return;
  }
  const email = emailArgument.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Provide a valid administrator email.");
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.DATABASE_URL || await readHiddenValue("Neon PostgreSQL connection string");
  const passwordHash = await hashPassword(await readPassword());
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true }
  });
  try {
    const updated = await resetAdminPassword(pool, email, passwordHash);
    if (!updated) {
      console.error(`No administrator account exists for ${email}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Administrator password reset for ${email}. Existing sessions have been signed out.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Administrator password reset failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { resetAdminPassword };
