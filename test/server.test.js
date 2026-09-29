"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectionDefinitions, createServer, parseListOptions, readConfig, validateValues, distributionInventoryChanges, distributionStatus, getDashboardStats } = require("../server");

test("configuration requires database URL and validates port and TLS flags", () => {
  assert.throws(() => readConfig({}), /DATABASE_URL is required/);
  assert.throws(() => readConfig({ DATABASE_URL: "postgres://local" }), /SESSION_SECRET must contain at least 32 bytes/);
  assert.throws(() => readConfig({ DATABASE_URL: "postgres://local", SESSION_SECRET: "s".repeat(32), PORT: "0" }), /PORT must be an integer/);
  assert.throws(() => readConfig({ DATABASE_URL: "postgres://local", SESSION_SECRET: "s".repeat(32), DATABASE_SSL: "sometimes" }), /DATABASE_SSL must be either/);
  assert.throws(() => readConfig({ DATABASE_URL: "postgres://local", SESSION_SECRET: "s".repeat(32), CORS_ORIGIN: "https://school.example/path" }), /exact http\(s\) origin/);
  assert.deepEqual(readConfig({ DATABASE_URL: "postgres://local", SESSION_SECRET: "s".repeat(32) }), {
    port: 3000,
    host: "127.0.0.1",
    databaseUrl: "postgres://local",
    databaseSsl: false,
    corsOrigin: "",
    sessionSecret: "s".repeat(32)
  });
});

test("query values are bound parameters and fields/order come from allowlists", () => {
  const url = new URL("http://localhost/api/students?status=Active&search=%27%20OR%201%3D1%20--&sort=name&order=DESC");
  const query = parseListOptions(url, "students");
  assert.match(query.sql, /s\.status = \$1/);
  assert.match(query.countSql, /COUNT\(\*\)::int AS total/);
  assert.deepEqual(query.countParams, ["Active", "%' OR 1=1 --%"]);
  assert.match(query.sql, /ORDER BY s\.name DESC LIMIT \$3 OFFSET \$4/);
  assert.deepEqual(query.params, ["Active", "%' OR 1=1 --%", 100, 0]);

  assert.throws(() => parseListOptions(new URL("http://localhost/api/students?sort=name;DROP%20TABLE%20students"), "students"), /Cannot sort by/);
  assert.throws(() => parseListOptions(new URL("http://localhost/api/students?unexpected=x"), "students"), /Unsupported query parameter/);
});

test("collection definitions expose only the seven UI record collections", () => {
  assert.deepEqual(Object.keys(collectionDefinitions), [
    "students", "parents", "staff", "items", "distributions", "payments", "transport"
  ]);
  assert.equal(collectionDefinitions.distributions.select.studentId, "d.student_id");
  assert.equal(collectionDefinitions.parents.select.student, "s.name");
});

test("record values enforce fields, relation references, numbers, and dates", () => {
  assert.doesNotThrow(() => validateValues("payments", collectionDefinitions.payments, {
    studentId: "ST-0001",
    purpose: "Uniform",
    amount: 30,
    method: "Cash",
    date: "2026-09-28",
    status: "Paid"
  }));
  assert.throws(() => validateValues("payments", collectionDefinitions.payments, {
    purpose: "Uniform",
    amount: 30,
    method: "Cash",
    date: "2026-09-28",
    status: "Paid"
  }), /student is required/);
  assert.throws(() => validateValues("items", collectionDefinitions.items, {
    name: "Kit", category: "Learning", price: -1, required: "Optional", stock: 1
  }), /price must be/);
  assert.throws(() => validateValues("distributions", collectionDefinitions.distributions, {
    studentId: "ST-0001", itemId: "IT-001", quantity: 1, returned: 0, issued: "2026-02-30"
  }), /issued must be a valid date/);
  assert.throws(() => validateValues("staff", collectionDefinitions.staff, {
    name: "Taylor", role: "Teacher", phone: "123", email: "taylor@example.com", id: "SF-001"
  }), /Unsupported field/);
});

test("item issue and return changes keep inventory in sync and derive distribution status", () => {
  assert.deepEqual(distributionInventoryChanges(null, { itemId: "IT-001", quantity: 4, returned: 1 }), [
    { itemId: "IT-001", delta: -3 }
  ]);
  assert.deepEqual(distributionInventoryChanges(
    { itemId: "IT-001", quantity: 4, returned: 0 },
    { itemId: "IT-001", quantity: 4, returned: 2 }
  ), [{ itemId: "IT-001", delta: 2 }]);
  assert.deepEqual(distributionInventoryChanges(
    { itemId: "IT-001", quantity: 4, returned: 1 },
    { itemId: "IT-002", quantity: 2, returned: 0 }
  ), [{ itemId: "IT-001", delta: 3 }, { itemId: "IT-002", delta: -2 }]);
  assert.equal(distributionStatus(2, 0), "Collected");
  assert.equal(distributionStatus(2, 1), "Partially returned");
  assert.equal(distributionStatus(2, 2), "Returned");
  assert.throws(() => validateValues("distributions", collectionDefinitions.distributions, {
    studentId: "ST-0001", itemId: "IT-001", quantity: 0, issued: "2026-09-28", returned: 0
  }), /quantity must be a positive integer/);
});

test("dashboard metrics aggregate all records while keeping restricted roles scoped", async () => {
  const sqlQueries = [];
  const pool = {
    async query(sql) {
      sqlQueries.push(sql);
      if (sql.includes("FROM items")) return { rows: [{ count: 125, low_stock: 4 }], rowCount: 1 };
      if (sql.includes("FROM transport")) return { rows: [{ count: 7, available: 5 }], rowCount: 1 };
      throw new Error(`Unexpected viewer dashboard query: ${sql}`);
    }
  };
  assert.deepEqual(await getDashboardStats(pool, "viewer"), {
    items: { count: 125, low_stock: 4 },
    transport: { count: 7, available: 5 }
  });
  assert.equal(sqlQueries.some((sql) => sql.includes("FROM students")), false);
  assert.equal(sqlQueries.some((sql) => sql.includes("FROM payments")), false);
});

test("HTTP list route applies filtering and refuses API use without an auth integration", async (t) => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ total: 1 }], rowCount: 1 };
      return { rows: [{ id: "ST-0001", name: "Example", grade: "Grade 1" }], rowCount: 1 };
    }
  };
  const server = createServer({ pool, authenticate: async (req) => { req.smisUser = { id: "user", role: "admin" }; return true; } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/students?status=Active`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).records[0], { id: "ST-0001", name: "Example", grade: "Grade 1" });
  assert.match(queries[0].sql, /s\.status = \$1/);
  assert.deepEqual(queries[0].params, ["Active", 100, 0]);

  const unauthenticated = createServer({ pool });
  await new Promise((resolve) => unauthenticated.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => unauthenticated.close(resolve)));
  const denied = await fetch(`http://127.0.0.1:${unauthenticated.address().port}/api/students`);
  assert.equal(denied.status, 503);
});

test("authentication contract delegates session security and checks CSRF on logout", async (t) => {
  const csrfToken = "session-csrf-token";
  let loggedOut = false;
  const pool = { async query() { return { rows: [], rowCount: 0 }; } };
  const auth = {
    async getSession(req) {
      return req.headers.cookie === "smis_session=active" ? { user: { id: "user-1" }, csrfToken } : null;
    },
    async login(req, res, credentials) {
      assert.deepEqual(credentials, { email: "staff@example.test", password: "secret" });
      res.setHeader("set-cookie", "smis_session=active; HttpOnly; SameSite=Strict; Path=/");
      return { user: { id: "user-1" }, csrfToken };
    },
    async logout() {
      loggedOut = true;
    },
    async authenticate(req) {
      return req.headers.cookie === "smis_session=active";
    }
  };
  const server = createServer({ pool, auth });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;

  const anonymous = await fetch(`${base}/me`);
  assert.equal(anonymous.status, 401);
  const login = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "staff@example.test", password: "secret" })
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("set-cookie"), "smis_session=active; HttpOnly; SameSite=Strict; Path=/");
  assert.deepEqual(await login.json(), { user: { id: "user-1" }, csrfToken });

  const session = await fetch(`${base}/me`, { headers: { cookie: "smis_session=active" } });
  assert.deepEqual(await session.json(), { user: { id: "user-1" }, csrfToken });
  const rejected = await fetch(`${base}/logout`, {
    method: "POST", headers: { cookie: "smis_session=active", "x-csrf-token": "wrong" }
  });
  assert.equal(rejected.status, 403);
  assert.equal(loggedOut, false);
  const logout = await fetch(`${base}/logout`, {
    method: "POST", headers: { cookie: "smis_session=active", "x-csrf-token": csrfToken }
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  assert.equal(loggedOut, true);
});

test("collection create, update, and delete responses use the frontend contract", async (t) => {
  const pool = {
    async query(sql, params = []) {
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "IT-001" }], rowCount: 1 };
      if (sql.startsWith("UPDATE")) return { rows: [{ id: "IT-001" }], rowCount: 1 };
      if (sql.startsWith("SELECT")) return { rows: [{ id: "IT-001", name: "Notebook" }], rowCount: 1 };
      if (sql.startsWith("DELETE")) return { rows: [{ id: params[0] }], rowCount: 1 };
      throw new Error("Unexpected query");
    },
    async connect() {
      return { query: this.query.bind(this), release() {} };
    }
  };
  const sessionAuth = {
    async getSession() { return { user: { id: "user", role: "admin" }, csrfToken: "valid-csrf" }; }
  };
  const server = createServer({ pool, auth: sessionAuth });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/items`;

  const created = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "valid-csrf" },
    body: JSON.stringify({ name: "Notebook", category: "Learning", price: 3, required: "Required", stock: 4 })
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { record: { id: "IT-001", name: "Notebook" } });
  const updated = await fetch(`${base}/IT-001`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-csrf-token": "valid-csrf" },
    body: JSON.stringify({ name: "Notebook updated", category: "Learning", price: 3, required: "Required", stock: 4 })
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { record: { id: "IT-001", name: "Notebook" } });
  const deleted = await fetch(`${base}/IT-001`, { method: "DELETE", headers: { "x-csrf-token": "valid-csrf" } });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
});

test("collection writes require CSRF and server roles enforce collection permissions", async (t) => {
  const pool = {
    async query(sql) {
      if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ total: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
  const auth = { async getSession() { return { user: { id: "user", role: "inventory" }, csrfToken: "valid-csrf" }; } };
  const server = createServer({ pool, auth });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const forbiddenRole = await fetch(`${base}/students`);
  assert.equal(forbiddenRole.status, 403);
  const allowedRead = await fetch(`${base}/items`);
  assert.equal(allowedRead.status, 200);
  const deniedMutation = await fetch(`${base}/items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "wrong" },
    body: JSON.stringify({ name: "Notebook", category: "Learning", price: 3, required: "Required", stock: 4 })
  });
  assert.equal(deniedMutation.status, 403);
  const missingCsrf = await fetch(`${base}/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Notebook", category: "Learning", price: 3, required: "Required", stock: 4 })
  });
  assert.equal(missingCsrf.status, 403);
});

test("same-origin public client assets are served with restrictive headers", async (t) => {
  const pool = { async query() { return { rows: [], rowCount: 0 }; } };
  const server = createServer({ pool });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await response.text(), /School Management/);
});
