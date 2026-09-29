"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { applySchema } = require("../scripts/migrate");

test("schema migration runs under an advisory lock and commits", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(sql.trim());
      return { rows: [], rowCount: 0 };
    },
    release() { released = true; }
  };
  await applySchema({ async connect() { return client; } });
  assert.equal(statements[0], "BEGIN");
  assert.match(statements[1], /pg_advisory_xact_lock/);
  assert.match(statements[2], /CREATE TABLE IF NOT EXISTS students/);
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(released, true);
});

test("schema migration rolls back and releases the connection on failure", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(sql.trim());
      if (sql.includes("CREATE TABLE IF NOT EXISTS")) throw new Error("schema failure");
      return { rows: [], rowCount: 0 };
    },
    release() { released = true; }
  };
  await assert.rejects(applySchema({ async connect() { return client; } }), /schema failure/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(released, true);
});
