"use strict";

const { Pool } = require("pg");
const { hashPassword } = require("../auth");
const { readPassword } = require("./prompt-password");

const roles = new Set(["registrar", "inventory", "viewer"]);

async function main() {
  const [emailArgument, nameArgument, role] = process.argv.slice(2);
  if (!emailArgument || !nameArgument || !roles.has(role) || process.argv.length !== 5) {
    console.error('Usage: node scripts/create-user.js <email> "<full name>" <registrar|inventory|viewer>');
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
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exitCode = 2;
    return;
  }
  const passwordHash = await hashPassword(await readPassword());
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false
  });
  try {
    const admin = await pool.query("SELECT id FROM users WHERE role = 'admin' AND disabled = FALSE LIMIT 1");
    if (!admin.rowCount) {
      console.error("Provision the first administrator before creating additional staff accounts.");
      process.exitCode = 1;
      return;
    }
    await pool.query("INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)", [email, name, role, passwordHash]);
    console.log(`SMIS ${role} account created for ${email}.`);
  } catch (error) {
    if (error.code === "23505") {
      console.error("An account with that email already exists.");
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Staff account provisioning failed: ${error.message}`);
  process.exitCode = 1;
});
