"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resetAdminPassword } = require("../scripts/reset-admin");

function createPool(userFound = true) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.startsWith("UPDATE users")) {
        return userFound
          ? { rowCount: 1, rows: [{ id: "admin-1" }] }
          : { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      queries.push({ sql: "RELEASE" });
    }
  };
  return {
    queries,
    async connect() {
      return client;
    }
  };
}

test("admin password reset updates only the named admin and revokes sessions transactionally", async () => {
  const pool = createPool();

  assert.equal(await resetAdminPassword(pool, "admin@example.org", "scrypt-hash"), true);
  assert.deepEqual(pool.queries, [
    { sql: "BEGIN", params: [] },
    {
      sql: "UPDATE users SET password_hash = $1 WHERE email = $2 AND role = 'admin' RETURNING id",
      params: ["scrypt-hash", "admin@example.org"]
    },
    { sql: "DELETE FROM sessions WHERE user_id = $1", params: ["admin-1"] },
    { sql: "COMMIT", params: [] },
    { sql: "RELEASE" }
  ]);
});

test("admin password reset leaves the database unchanged when no matching admin exists", async () => {
  const pool = createPool(false);

  assert.equal(await resetAdminPassword(pool, "staff@example.org", "scrypt-hash"), false);
  assert.deepEqual(pool.queries.map(({ sql }) => sql), ["BEGIN", "UPDATE users SET password_hash = $1 WHERE email = $2 AND role = 'admin' RETURNING id", "ROLLBACK", "RELEASE"]);
});

test("admin password reset rolls back on database errors and releases the connection", async () => {
  const pool = createPool();
  const query = pool.queries;
  const originalConnect = pool.connect;
  pool.connect = async () => {
    const client = await originalConnect();
    client.query = async (sql) => {
      query.push({ sql });
      if (sql === "UPDATE users SET password_hash = $1 WHERE email = $2 AND role = 'admin' RETURNING id") {
        throw new Error("database unavailable");
      }
      return { rowCount: 0, rows: [] };
    };
    return client;
  };

  await assert.rejects(resetAdminPassword(pool, "admin@example.org", "scrypt-hash"), /database unavailable/);
  assert.deepEqual(query.map(({ sql }) => sql), [
    "BEGIN",
    "UPDATE users SET password_hash = $1 WHERE email = $2 AND role = 'admin' RETURNING id",
    "ROLLBACK",
    "RELEASE"
  ]);
});
