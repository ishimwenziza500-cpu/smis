"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server");

test("distribution API updates stock atomically on issue, return, and removal", async (t) => {
  let stock = 5;
  let distribution;
  let rollbackState;
  const student = { id: "ST-0001", name: "Demo Student" };
  const item = { id: "IT-0001", name: "Exercise books" };
  const toRecord = () => ({
    id: distribution.id,
    student: student.name,
    studentId: student.id,
    item: item.name,
    itemId: item.id,
    quantity: Number(distribution.quantity),
    issued: distribution.issued,
    returned: Number(distribution.returned),
    status: distribution.status
  });
  const clientQuery = async (sql, params = []) => {
    if (sql === "BEGIN") {
      rollbackState = { stock, distribution: distribution && { ...distribution } };
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      rollbackState = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      stock = rollbackState.stock;
      distribution = rollbackState.distribution;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "SELECT id FROM students WHERE id = $1") return { rows: params[0] === student.id ? [{ id: student.id }] : [], rowCount: params[0] === student.id ? 1 : 0 };
    if (sql === "SELECT id FROM items WHERE id = $1") return { rows: params[0] === item.id ? [{ id: item.id }] : [], rowCount: params[0] === item.id ? 1 : 0 };
    if (sql.startsWith("UPDATE items SET stock")) {
      if (stock + params[0] < 0) return { rows: [], rowCount: 0 };
      stock += params[0];
      return { rows: [{ id: item.id }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO distributions")) {
      const columns = sql.match(/INSERT INTO distributions \(([^)]+)\)/)[1].split(", ");
      distribution = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
      distribution.id = "DI-0001";
      return { rows: [{ id: distribution.id }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT item_id, quantity, returned FROM distributions")) {
      return distribution?.id === params[0]
        ? { rows: [{ item_id: distribution.item_id, quantity: distribution.quantity, returned: distribution.returned }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE distributions SET")) {
      const columns = sql.match(/UPDATE distributions SET (.+) WHERE/)[1].split(", ").map((entry) => entry.split(" = ")[0]);
      if (distribution?.id !== params.at(-1)) return { rows: [], rowCount: 0 };
      columns.forEach((column, index) => { distribution[column] = params[index]; });
      return { rows: [{ id: distribution.id }], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM distributions")) {
      const removed = distribution?.id === params[0];
      distribution = undefined;
      return { rows: [], rowCount: removed ? 1 : 0 };
    }
    if (sql.startsWith('SELECT d.id AS "id"')) {
      return { rows: distribution ? [toRecord()] : [], rowCount: distribution ? 1 : 0 };
    }
    throw new Error(`Unexpected database query: ${sql}`);
  };
  const pool = {
    async query(sql, params = []) {
      if (sql === "SELECT 1") return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.startsWith('SELECT d.id AS "id"')) return { rows: distribution ? [toRecord()] : [], rowCount: distribution ? 1 : 0 };
      throw new Error(`Unexpected pool query: ${sql} ${params}`);
    },
    async connect() {
      return { query: clientQuery, release() {} };
    }
  };
  const auth = { async getSession() { return { user: { id: "admin", role: "admin" }, csrfToken: "csrf" }; } };
  const server = createServer({ pool, auth });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/distributions`;
  const headers = { "content-type": "application/json", "x-csrf-token": "csrf" };

  const created = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ studentId: student.id, itemId: item.id, quantity: 3, issued: "2026-09-28", returned: 1 })
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).record.status, "Partially returned");
  assert.equal(stock, 3);

  const insufficient = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ studentId: student.id, itemId: item.id, quantity: 9, issued: "2026-09-28", returned: 0 })
  });
  assert.equal(insufficient.status, 409);
  assert.equal(stock, 3);

  const returned = await fetch(`${base}/DI-0001`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ studentId: student.id, itemId: item.id, quantity: 3, issued: "2026-09-28", returned: 2 })
  });
  assert.equal(returned.status, 200);
  assert.equal((await returned.json()).record.status, "Partially returned");
  assert.equal(stock, 4);

  const deleted = await fetch(`${base}/DI-0001`, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  assert.equal(stock, 5);
});
