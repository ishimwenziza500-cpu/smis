"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hashPassword, verifyPassword, createAuth } = require("../auth");

test("password hashes use scrypt and reject incorrect passwords", async () => {
  const passwordHash = await hashPassword("correct horse battery staple");
  assert.match(passwordHash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery staple", passwordHash), true);
  assert.equal(await verifyPassword("incorrect password", passwordHash), false);
  await assert.rejects(hashPassword("short"), /between 12 and 256/);
});

test("PostgreSQL authentication creates hashed-token sessions and revokes them", async () => {
  const passwordHash = await hashPassword("another correct horse");
  const queries = [];
  let activeSessionHash;
  const pool = {
    async query(sql, params = []) {
      queries.push(sql);
      if (sql.includes("FROM users WHERE email")) return {
        rowCount: 1,
        rows: [{ id: "user-1", email: "admin@example.test", name: "School Admin", role: "admin", password_hash: passwordHash }]
      };
      if (sql.startsWith("INSERT INTO sessions")) {
        activeSessionHash = params[0];
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("DELETE FROM sessions") && sql.includes("token_hash")) {
        activeSessionHash = undefined;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("FROM sessions s JOIN users")) {
        return activeSessionHash === params[0]
          ? { rowCount: 1, rows: [{ id: "user-1", email: "admin@example.test", name: "School Admin", role: "admin" }] }
          : { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
  const auth = createAuth({ pool, sessionSecret: "s".repeat(48), secureCookie: true });
  const headers = {};
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
  const result = await auth.login(req, { setHeader: (key, value) => { headers[key] = value; } }, {
    email: "ADMIN@example.test",
    password: "another correct horse"
  });
  assert.equal(result.user.role, "admin");
  assert.match(headers["set-cookie"], /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  const token = headers["set-cookie"].match(/^smis_session=([^;]+)/)[1];
  const session = await auth.getSession({ headers: { cookie: `smis_session=${token}` } });
  assert.equal(session.user.id, "user-1");
  assert.equal(session.csrfToken, result.csrfToken);
  assert.equal(session.token, token);
  await auth.logout({ headers: { cookie: `smis_session=${token}` } }, { setHeader() {} }, session);
  assert.equal(await auth.getSession({ headers: { cookie: `smis_session=${token}` } }), null);
  assert.ok(queries.some((sql) => sql.startsWith("DELETE FROM sessions")));
});
