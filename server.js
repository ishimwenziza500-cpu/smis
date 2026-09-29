"use strict";

const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { createAuth } = require("./auth");

const publicFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);
const rolePermissions = Object.freeze({
  admin: { read: ["students", "parents", "staff", "items", "distributions", "payments", "transport"], write: ["students", "parents", "staff", "items", "distributions", "payments", "transport"], delete: ["students", "parents", "staff", "items", "distributions", "payments", "transport"] },
  registrar: { read: ["students", "parents", "payments"], write: ["students", "parents", "payments"], delete: [] },
  inventory: { read: ["items", "distributions", "transport"], write: ["items", "distributions", "transport"], delete: [] },
  viewer: { read: ["items", "transport"], write: [], delete: [] }
});

const collectionDefinitions = Object.freeze({
  students: {
    table: "students",
    from: "students s",
    select: {
      id: "s.id",
      name: "s.name",
      grade: "s.grade",
      guardian: "s.guardian",
      phone: "s.phone",
      area: "s.area",
      status: "s.status"
    },
    write: ["name", "grade", "guardian", "phone", "area", "status"],
    required: ["name", "grade", "guardian", "phone", "status"],
    searchable: ["name", "grade", "guardian", "phone", "area", "status"]
  },
  parents: {
    table: "parents",
    from: "parents p JOIN students s ON s.id = p.student_id",
    select: {
      id: "p.id",
      name: "p.name",
      student: "s.name",
      studentId: "p.student_id",
      relationship: "p.relationship",
      phone: "p.phone",
      email: "p.email"
    },
    write: ["name", "student", "studentId", "relationship", "phone", "email"],
    required: ["name", "student", "relationship", "phone"],
    searchable: ["name", "s.name", "relationship", "phone", "email"]
  },
  staff: {
    table: "staff",
    from: "staff s",
    select: { id: "s.id", name: "s.name", role: "s.role", phone: "s.phone", email: "s.email" },
    write: ["name", "role", "phone", "email"],
    required: ["name", "role", "phone", "email"],
    searchable: ["name", "role", "phone", "email"]
  },
  items: {
    table: "items",
    from: "items i",
    select: { id: "i.id", name: "i.name", category: "i.category", price: "i.price", required: "i.required", stock: "i.stock" },
    write: ["name", "category", "price", "required", "stock"],
    required: ["name", "category", "price", "required", "stock"],
    searchable: ["name", "category", "required"]
  },
  distributions: {
    table: "distributions",
    from: "distributions d JOIN students s ON s.id = d.student_id JOIN items i ON i.id = d.item_id",
    select: {
      id: "d.id",
      student: "s.name",
      studentId: "d.student_id",
      item: "i.name",
      itemId: "d.item_id",
      quantity: "d.quantity",
      issued: "d.issued",
      returned: "d.returned",
      status: "d.status"
    },
    write: ["student", "studentId", "item", "itemId", "quantity", "issued", "returned"],
    required: ["student", "item", "quantity", "issued", "returned"],
    searchable: ["s.name", "i.name", "d.status"]
  },
  payments: {
    table: "payments",
    from: "payments p JOIN students s ON s.id = p.student_id",
    select: {
      id: "p.id",
      student: "s.name",
      studentId: "p.student_id",
      purpose: "p.purpose",
      amount: "p.amount",
      method: "p.method",
      date: "p.date",
      status: "p.status"
    },
    write: ["student", "studentId", "purpose", "amount", "method", "date", "status"],
    required: ["student", "purpose", "amount", "method", "date", "status"],
    searchable: ["s.name", "p.purpose", "p.method", "p.status"]
  },
  transport: {
    table: "transport",
    from: "transport t",
    select: { id: "t.id", area: "t.area", fee: "t.fee", capacity: "t.capacity", driver: "t.driver", status: "t.status" },
    write: ["area", "fee", "capacity", "driver", "status"],
    required: ["area", "fee", "capacity", "status"],
    searchable: ["area", "driver", "status"]
  }
});

const fieldExpressions = Object.freeze({
  students: { id: "s.id", name: "s.name", grade: "s.grade", guardian: "s.guardian", phone: "s.phone", area: "s.area", status: "s.status" },
  parents: { id: "p.id", name: "p.name", student: "s.name", studentId: "p.student_id", relationship: "p.relationship", phone: "p.phone", email: "p.email" },
  staff: { id: "s.id", name: "s.name", role: "s.role", phone: "s.phone", email: "s.email" },
  items: { id: "i.id", name: "i.name", category: "i.category", price: "i.price", required: "i.required", stock: "i.stock" },
  distributions: { id: "d.id", student: "s.name", studentId: "d.student_id", item: "i.name", itemId: "d.item_id", quantity: "d.quantity", issued: "d.issued", returned: "d.returned", status: "d.status" },
  payments: { id: "p.id", student: "s.name", studentId: "p.student_id", purpose: "p.purpose", amount: "p.amount", method: "p.method", date: "p.date", status: "p.status" },
  transport: { id: "t.id", area: "t.area", fee: "t.fee", capacity: "t.capacity", driver: "t.driver", status: "t.status" }
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const sslSetting = String(env.DATABASE_SSL || "false").toLowerCase();
  if (!["true", "false"].includes(sslSetting)) {
    throw new Error("DATABASE_SSL must be either true or false.");
  }
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Set it to your PostgreSQL connection URL.");
  }
  const sessionSecret = env.SESSION_SECRET || "";
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes of random secret material.");
  }
  const corsOrigin = env.CORS_ORIGIN || "";
  if (corsOrigin) {
    let origin;
    try {
      origin = new URL(corsOrigin);
    } catch {
      throw new Error("CORS_ORIGIN must be an exact http(s) origin without a path.");
    }
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== corsOrigin) {
      throw new Error("CORS_ORIGIN must be an exact http(s) origin without a path.");
    }
  }
  return {
    port,
    host: env.HOST || "127.0.0.1",
    databaseUrl: env.DATABASE_URL,
    databaseSsl: sslSetting === "true",
    corsOrigin,
    sessionSecret
  };
}

function distributionStatus(quantity, returned) {
  if (returned >= quantity) return "Returned";
  if (returned > 0) return "Partially returned";
  return "Collected";
}

function distributionInventoryChanges(previous, next) {
  const previousOutstanding = previous ? Number(previous.quantity) - Number(previous.returned || 0) : 0;
  const nextOutstanding = next ? Number(next.quantity) - Number(next.returned || 0) : 0;
  const changes = [];
  if (previous && next && previous.itemId === next.itemId) {
    const delta = previousOutstanding - nextOutstanding;
    if (delta) changes.push({ itemId: previous.itemId, delta });
    return changes;
  }
  if (previous && previousOutstanding) changes.push({ itemId: previous.itemId, delta: previousOutstanding });
  if (next && nextOutstanding) changes.push({ itemId: next.itemId, delta: -nextOutstanding });
  return changes;
}

async function adjustInventory(client, changes) {
  for (const { itemId, delta } of changes) {
    const result = await client.query(
      "UPDATE items SET stock = stock + $1 WHERE id = $2 AND stock + $1 >= 0 RETURNING id",
      [delta, itemId]
    );
    if (!result.rowCount) {
      if (delta < 0) throw new HttpError(409, "There is not enough stock to issue this item.");
      throw new HttpError(404, "The distributed item no longer exists.");
    }
  }
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(req, res, corsOrigin) {
  const origin = req.headers.origin;
  if (corsOrigin && origin === corsOrigin) {
    res.setHeader("access-control-allow-origin", corsOrigin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization, x-csrf-token");
    res.setHeader("access-control-allow-credentials", "true");
  }
}

function setSecurityHeaders(res, production, corsOrigin) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'${corsOrigin ? ` ${corsOrigin}` : ""}; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`);
  if (production) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

async function servePublicFile(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const publicFile = publicFiles.get(url.pathname);
  if (!publicFile) return false;
  const filePath = path.join(__dirname, publicFile[0]);
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": publicFile[1],
    "cache-control": "no-cache",
    "content-length": content.length
  });
  res.end(req.method === "HEAD" ? undefined : content);
  return true;
}

async function readJsonBody(req) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, "Request body must be 1 MB or smaller.");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body;
}

function validateValues(collection, definition, body, { partial = false } = {}) {
  const unknown = Object.keys(body).filter((key) => !definition.write.includes(key));
  if (unknown.length) throw new HttpError(400, `Unsupported field: ${unknown[0]}.`);
  for (const key of definition.required) {
    if (!partial && (body[key] === undefined || body[key] === null || body[key] === "")) {
      if ((key === "student" || key === "item") && body[`${key}Id`]) continue;
      throw new HttpError(400, `${key} is required.`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "student") && Object.prototype.hasOwnProperty.call(body, "studentId")) {
    throw new HttpError(400, "Provide either student or studentId, not both.");
  }
  if (Object.prototype.hasOwnProperty.call(body, "item") && Object.prototype.hasOwnProperty.call(body, "itemId")) {
    throw new HttpError(400, "Provide either item or itemId, not both.");
  }

  const numericFields = {
    items: { price: false, stock: true },
    distributions: { quantity: true, returned: true },
    payments: { amount: false },
    transport: { fee: false, capacity: true }
  }[collection] || {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "studentId" || key === "itemId") {
      if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} must be a non-empty string.`);
    } else if (Object.prototype.hasOwnProperty.call(numericFields, key)) {
      if (value === "" || value === null || !Number.isFinite(Number(value)) || Number(value) < 0 ||
          (numericFields[key] && !Number.isInteger(Number(value)))) {
        throw new HttpError(400, `${key} must be a valid ${numericFields[key] ? "non-negative integer" : "non-negative number"}.`);
      }
      if (collection === "distributions" && key === "quantity" && Number(value) < 1) {
        throw new HttpError(400, "quantity must be a positive integer.");
      }
    } else if (typeof value === "string") {
      if (value.length > 500) throw new HttpError(400, `${key} must be 500 characters or fewer.`);
      if (value.trim() === "" && definition.required.includes(key)) throw new HttpError(400, `${key} must not be empty.`);
      if (["issued", "date"].includes(key) && !isValidDate(value)) throw new HttpError(400, `${key} must be a valid date in YYYY-MM-DD format.`);
    } else if (value !== null) {
      throw new HttpError(400, `${key} must be a string, number, or null.`);
    }
  }
  if (collection === "distributions" && body.quantity !== undefined && body.returned !== undefined &&
      Number(body.returned) > Number(body.quantity)) {
    throw new HttpError(400, "returned cannot exceed quantity.");
  }
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function selectSql(definition) {
  const fields = Object.entries(definition.select)
    .map(([key, expression]) => `${expression} AS "${key}"`)
    .join(", ");
  return `SELECT ${fields} FROM ${definition.from}`;
}

function parseListOptions(url, collection) {
  const definition = collectionDefinitions[collection];
  const fields = fieldExpressions[collection];
  const allowed = new Set(["limit", "offset", "sort", "order", "search", "q", ...Object.keys(fields)]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new HttpError(400, `Unsupported query parameter: ${key}.`);
    if (url.searchParams.getAll(key).length > 1) throw new HttpError(400, `Query parameter ${key} may only appear once.`);
  }
  if (url.searchParams.has("q") && url.searchParams.has("search")) {
    throw new HttpError(400, "Use either q or search, not both.");
  }
  const rawLimit = url.searchParams.get("limit") || "100";
  const rawOffset = url.searchParams.get("offset") || "0";
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
    throw new HttpError(400, "limit must be an integer between 1 and 100.");
  }
  if (!/^\d+$/.test(rawOffset) || Number(rawOffset) > 1000000) {
    throw new HttpError(400, "offset must be a non-negative integer no greater than 1000000.");
  }
  const sort = url.searchParams.get("sort") || "id";
  if (!Object.prototype.hasOwnProperty.call(fields, sort)) throw new HttpError(400, `Cannot sort by ${sort}.`);
  const order = (url.searchParams.get("order") || "asc").toLowerCase();
  if (!["asc", "desc"].includes(order)) throw new HttpError(400, "order must be asc or desc.");

  const params = [];
  const filters = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    params.push(value);
    filters.push(`${fields[key]} = $${params.length}`);
  }
  const search = url.searchParams.get("q") ?? url.searchParams.get("search");
  if (search !== null) {
    if (search.length > 200) throw new HttpError(400, "search must be 200 characters or fewer.");
    params.push(`%${search}%`);
    const searchParam = `$${params.length}`;
    filters.push(`(${definition.searchable.map((expression) => `CAST(${expression} AS TEXT) ILIKE ${searchParam}`).join(" OR ")})`);
  }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const countParams = [...params];
  params.push(Number(rawLimit), Number(rawOffset));
  return {
    sql: `${selectSql(definition)}${where} ORDER BY ${fields[sort]} ${order.toUpperCase()} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    countSql: `SELECT COUNT(*)::int AS total FROM ${definition.from}${where}`,
    countParams,
    params
  };
}

async function getDashboardStats(pool, role) {
  const readable = rolePermissions[role]?.read || [];
  const stats = {};
  const queries = [];
  if (readable.includes("students")) {
    queries.push(pool.query(
      "SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending FROM students"
    ).then(async (result) => {
      const recent = await pool.query(
        "SELECT id, name, grade, guardian, area, status FROM students ORDER BY id DESC LIMIT 4"
      );
      stats.students = { ...result.rows[0], recent: recent.rows };
    }));
  }
  if (readable.includes("items")) {
    queries.push(pool.query(
      "SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE stock < 20)::int AS low_stock FROM items"
    ).then((result) => { stats.items = result.rows[0]; }));
  }
  if (readable.includes("payments")) {
    queries.push(pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = 'Paid'), 0)::numeric AS paid_total,
         COALESCE(SUM(amount) FILTER (WHERE status = 'Paid' AND date >= date_trunc('month', CURRENT_DATE)), 0)::numeric AS monthly_total
       FROM payments`
    ).then(async (result) => {
      const recent = await pool.query(
        `SELECT p.id, s.name AS student, p.purpose, p.amount, p.method, p.date, p.status
         FROM payments p JOIN students s ON s.id = p.student_id
         ORDER BY p.date DESC, p.id DESC LIMIT 4`
      );
      stats.payments = { ...result.rows[0], recent: recent.rows };
    }));
  } else if (readable.includes("distributions")) {
    queries.push(pool.query(
      `SELECT d.id, s.name AS student, i.name AS item, d.quantity, d.issued, d.returned, d.status
       FROM distributions d JOIN students s ON s.id = d.student_id JOIN items i ON i.id = d.item_id
       ORDER BY d.issued DESC, d.id DESC LIMIT 4`
    ).then((result) => { stats.distributions = { recent: result.rows }; }));
  }
  if (readable.includes("transport")) {
    queries.push(pool.query(
      "SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE status = 'Available')::int AS available FROM transport"
    ).then((result) => { stats.transport = result.rows[0]; }));
  }
  await Promise.all(queries);
  return stats;
}

async function resolveReference(client, type, body) {
  const idKey = `${type}Id`;
  if (body[idKey] !== undefined) {
    const query = type === "student" ? "SELECT id FROM students WHERE id = $1" : "SELECT id FROM items WHERE id = $1";
    const result = await client.query(query, [body[idKey]]);
    if (!result.rowCount) throw new HttpError(400, `No ${type} found with id ${body[idKey]}.`);
    return result.rows[0].id;
  }
  if (body[type] === undefined) return undefined;
  const query = type === "student"
    ? "SELECT id FROM students WHERE name = $1 ORDER BY id LIMIT 2"
    : "SELECT id FROM items WHERE name = $1 ORDER BY id LIMIT 2";
  const result = await client.query(query, [body[type]]);
  if (!result.rowCount) throw new HttpError(400, `No ${type} found with that name.`);
  if (result.rowCount > 1) throw new HttpError(400, `That ${type} name is ambiguous; provide ${idKey} instead.`);
  return result.rows[0].id;
}

async function normalizeWriteValues(client, collection, body) {
  const values = { ...body };
  if (["parents", "distributions", "payments"].includes(collection)) {
    const studentId = await resolveReference(client, "student", body);
    delete values.student;
    delete values.studentId;
    if (studentId !== undefined) values.student_id = studentId;
  }
  if (collection === "distributions") {
    const itemId = await resolveReference(client, "item", body);
    delete values.item;
    delete values.itemId;
    if (itemId !== undefined) values.item_id = itemId;
  }
  const dbColumns = {
    parents: { student_id: "student_id" },
    distributions: { student_id: "student_id", item_id: "item_id" },
    payments: { student_id: "student_id" }
  }[collection] || {};
  for (const [source, target] of Object.entries(dbColumns)) {
    if (Object.prototype.hasOwnProperty.call(values, source)) {
      values[target] = values[source];
      if (source !== target) delete values[source];
    }
  }
  return values;
}

function serializeDatabaseError(error) {
  if (error.code === "23503") return new HttpError(409, "This record is still referenced by other records.");
  if (error.code === "23505") return new HttpError(409, "A record with this identifier already exists.");
  if (["23502", "23514", "22P02", "22007", "22003"].includes(error.code)) {
    return new HttpError(400, "The record contains a value that violates the collection schema.");
  }
  return null;
}

async function handleCollectionRequest(req, res, url, collection, id, pool) {
  const definition = collectionDefinitions[collection];
  if (!definition) throw new HttpError(404, "Collection not found.");
  const idClause = id === undefined ? "" : ` WHERE ${fieldExpressions[collection].id} = $1`;

  if (req.method === "GET") {
    if (id !== undefined) {
      const result = await pool.query(`${selectSql(definition)}${idClause}`, [id]);
      if (!result.rowCount) throw new HttpError(404, "Record not found.");
      return jsonResponse(res, 200, result.rows[0]);
    }
    const { sql, params, countSql, countParams } = parseListOptions(url, collection);
    const [result, count] = await Promise.all([pool.query(sql, params), pool.query(countSql, countParams)]);
    return jsonResponse(res, 200, { records: result.rows, total: count.rows[0].total, limit: params.at(-2), offset: params.at(-1) });
  }

  if (req.method === "POST") {
    if (id !== undefined) throw new HttpError(405, "Use the collection URL to create a record.");
    const body = await readJsonBody(req);
    validateValues(collection, definition, body);
    const client = await pool.connect();
    const transaction = collection === "distributions";
    let transactionStarted = false;
    try {
      if (transaction) {
        await client.query("BEGIN");
        transactionStarted = true;
      }
      const values = await normalizeWriteValues(client, collection, body);
      if (transaction) {
        values.status = distributionStatus(Number(values.quantity), Number(values.returned));
        await adjustInventory(client, distributionInventoryChanges(null, {
          itemId: values.item_id,
          quantity: values.quantity,
          returned: values.returned
        }));
      }
      const columns = Object.keys(values);
      const params = columns.map((column) => values[column]);
      const sql = columns.length
        ? `INSERT INTO ${definition.table} (${columns.join(", ")}) VALUES (${params.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id`
        : `INSERT INTO ${definition.table} DEFAULT VALUES RETURNING id`;
      const inserted = await client.query(sql, params);
      const record = await client.query(`${selectSql(definition)}${idClause || ` WHERE ${fieldExpressions[collection].id} = $1`}`, [inserted.rows[0].id]);
      if (transaction) await client.query("COMMIT");
      return jsonResponse(res, 201, { record: record.rows[0] });
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    if (id === undefined) throw new HttpError(405, "Provide a record id to update.");
    const body = await readJsonBody(req);
    validateValues(collection, definition, body, { partial: req.method === "PATCH" });
    if (!Object.keys(body).length) throw new HttpError(400, "Provide at least one field to update.");
    const client = await pool.connect();
    const transaction = collection === "distributions";
    let transactionStarted = false;
    try {
      let previous;
      if (transaction) {
        await client.query("BEGIN");
        transactionStarted = true;
        const selected = await client.query(
          "SELECT item_id, quantity, returned FROM distributions WHERE id = $1 FOR UPDATE",
          [id]
        );
        previous = selected.rows[0];
        if (!previous) throw new HttpError(404, "Record not found.");
      }
      const values = await normalizeWriteValues(client, collection, body);
      if (transaction) {
        const next = {
          itemId: values.item_id ?? previous.item_id,
          quantity: values.quantity ?? previous.quantity,
          returned: values.returned ?? previous.returned
        };
        if (Number(next.returned) > Number(next.quantity)) throw new HttpError(400, "returned cannot exceed quantity.");
        values.status = distributionStatus(Number(next.quantity), Number(next.returned));
        await adjustInventory(client, distributionInventoryChanges({
          itemId: previous.item_id,
          quantity: previous.quantity,
          returned: previous.returned
        }, next));
      }
      const columns = Object.keys(values);
      if (!columns.length) throw new HttpError(400, "Provide at least one field to update.");
      const params = [...columns.map((column) => values[column]), id];
      const updates = columns.map((column, index) => `${column} = $${index + 1}`).join(", ");
      const result = await client.query(`UPDATE ${definition.table} SET ${updates} WHERE id = $${params.length} RETURNING id`, params);
      if (!result.rowCount) throw new HttpError(404, "Record not found.");
      const record = await client.query(`${selectSql(definition)} WHERE ${fieldExpressions[collection].id} = $1`, [id]);
      if (transaction) await client.query("COMMIT");
      return jsonResponse(res, 200, { record: record.rows[0] });
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  if (req.method === "DELETE") {
    if (id === undefined) throw new HttpError(405, "Provide a record id to delete.");
    if (collection === "distributions") {
      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        const selected = await client.query(
          "SELECT item_id, quantity, returned FROM distributions WHERE id = $1 FOR UPDATE",
          [id]
        );
        const previous = selected.rows[0];
        if (!previous) throw new HttpError(404, "Record not found.");
        await adjustInventory(client, distributionInventoryChanges({
          itemId: previous.item_id,
          quantity: previous.quantity,
          returned: previous.returned
        }, null));
        await client.query("DELETE FROM distributions WHERE id = $1", [id]);
        await client.query("COMMIT");
        return jsonResponse(res, 200, { ok: true });
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const result = await pool.query(`DELETE FROM ${definition.table} WHERE id = $1 RETURNING id`, [id]);
    if (!result.rowCount) throw new HttpError(404, "Record not found.");
    return jsonResponse(res, 200, { ok: true });
  }

  res.setHeader("allow", id === undefined ? "GET, POST, OPTIONS" : "GET, PATCH, PUT, DELETE, OPTIONS");
  throw new HttpError(405, "Method not allowed.");
}

function equalToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createServer({ pool, authenticate, auth = {}, corsOrigin = process.env.CORS_ORIGIN || "" } = {}) {
  if (!pool || typeof pool.query !== "function") throw new Error("createServer requires a PostgreSQL pool.");
  const authenticateRequest = authenticate || auth.authenticate;
  const server = http.createServer(async (req, res) => {
    setCorsHeaders(req, res, corsOrigin);
    setSecurityHeaders(res, process.env.NODE_ENV === "production", corsOrigin);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    let url;
    let segments;
    try {
      url = new URL(req.url, "http://localhost");
      segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    } catch {
      return jsonResponse(res, 400, { error: "Malformed request URL." });
    }
    if (segments.length === 2 && segments[0] === "api" && segments[1] === "health" && req.method === "GET") {
      try {
        await pool.query("SELECT 1");
        return jsonResponse(res, 200, { status: "ok", database: "connected" });
      } catch {
        return jsonResponse(res, 503, { status: "unavailable", database: "disconnected" });
      }
    }
    if (segments[0] !== "api") {
      try {
        if (await servePublicFile(req, res, url)) return;
        return jsonResponse(res, 404, { error: "Page not found." });
      } catch (error) {
        console.error("SMIS public file serving failed.", error.code ? `File error ${error.code}.` : "Unexpected file error.");
        return jsonResponse(res, 500, { error: "An unexpected server error occurred." });
      }
    }
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "auth" && segments[2] === "me" && req.method === "GET") {
      if (typeof auth.getSession !== "function") return jsonResponse(res, 401, { error: "Authentication required." });
      try {
        const session = await auth.getSession(req);
        if (!session?.user || !session?.csrfToken) return jsonResponse(res, 401, { error: "Authentication required." });
        return jsonResponse(res, 200, { user: session.user, csrfToken: session.csrfToken });
      } catch (error) {
        console.error("SMIS session lookup failed.", error.code ? `Database error ${error.code}.` : "Unexpected server error.");
        return jsonResponse(res, 500, { error: "Could not check the current sign-in session." });
      }
    }
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "auth" && segments[2] === "login" && req.method === "POST") {
      if (typeof auth.login !== "function") {
        return jsonResponse(res, 503, { error: "Secure authentication is not configured." });
      }
      try {
        const body = await readJsonBody(req);
        if (Object.keys(body).some((key) => !["email", "password"].includes(key)) ||
            typeof body.email !== "string" || !body.email.trim() || body.email.length > 254 ||
            typeof body.password !== "string" || !body.password || body.password.length > 256) {
          throw new HttpError(400, "Provide email and password.");
        }
        const session = await auth.login(req, res, { email: body.email, password: body.password });
        if (!session?.user || !session?.csrfToken) throw new HttpError(401, "Invalid email or password.");
        return jsonResponse(res, 200, { user: session.user, csrfToken: session.csrfToken });
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof HttpError || [401, 429].includes(error.status)) return jsonResponse(res, error.status, { error: error.message });
        console.error("SMIS login integration failed.");
        return jsonResponse(res, 500, { error: "An unexpected server error occurred." });
      }
    }
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "auth" && segments[2] === "logout" && req.method === "POST") {
      if (typeof auth.getSession !== "function" || typeof auth.logout !== "function") {
        return jsonResponse(res, 503, { error: "Secure authentication is not configured." });
      }
      try {
        const session = await auth.getSession(req);
        if (!session?.user || !session?.csrfToken) return jsonResponse(res, 401, { error: "Authentication required." });
        if (!equalToken(req.headers["x-csrf-token"], session.csrfToken)) {
          return jsonResponse(res, 403, { error: "A valid X-CSRF-Token header is required." });
        }
        await auth.logout(req, res, session);
        return jsonResponse(res, 200, { ok: true });
      } catch (error) {
        if (error instanceof HttpError) return jsonResponse(res, error.status, { error: error.message });
        console.error("SMIS logout integration failed.");
        return jsonResponse(res, 500, { error: "An unexpected server error occurred." });
      }
    }
    if (segments[0] !== "api" || segments.length < 2 || segments.length > 3) {
      return jsonResponse(res, 404, { error: "Route not found." });
    }
    if (typeof authenticateRequest !== "function" && typeof auth.getSession !== "function") {
      return jsonResponse(res, 503, { error: "Authentication is not configured; API access is disabled." });
    }
    try {
      const mutating = !["GET", "HEAD"].includes(req.method);
      let allowed = false;
      if (typeof auth.getSession === "function") {
        const session = await auth.getSession(req);
        if (!session?.user) return jsonResponse(res, 401, { error: "Authentication required." });
        if (mutating && !equalToken(req.headers["x-csrf-token"], session.csrfToken)) {
          return jsonResponse(res, 403, { error: "A valid X-CSRF-Token header is required." });
        }
        req.smisUser = session.user;
        allowed = true;
      } else if (mutating) {
        return jsonResponse(res, 503, { error: "A CSRF-protected session is required for changes." });
      } else {
        allowed = await authenticateRequest(req);
      }
      if (!allowed) return jsonResponse(res, 401, { error: "Authentication required." });
      const user = req.smisUser;
      if (!user || !Object.prototype.hasOwnProperty.call(rolePermissions, user.role)) {
        return jsonResponse(res, 403, { error: "This account does not have an SMIS role." });
      }
      const [collection] = segments.slice(1);
      const permission = rolePermissions[user.role];
      const action = req.method === "GET" ? "read" : req.method === "DELETE" ? "delete" : "write";
      if (collection === "dashboard" && segments.length === 2 && req.method === "GET") {
        return jsonResponse(res, 200, await getDashboardStats(pool, user.role));
      }
      if (!permission[action].includes(collection)) return jsonResponse(res, 403, { error: "Your staff role cannot access this operation." });
      await handleCollectionRequest(req, res, url, segments[1], segments[2], pool);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const knownError = error instanceof HttpError ? error : serializeDatabaseError(error);
      if (knownError) return jsonResponse(res, knownError.status, { error: knownError.message });
      console.error("SMIS API request failed.", error.code ? `Database error ${error.code}.` : "Unexpected server error.");
      return jsonResponse(res, 500, { error: "An unexpected server error occurred." });
    }
  });
  return server;
}

async function main() {
  let config;
  try {
    config = readConfig();
  } catch (error) {
    console.error(`SMIS server configuration error: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
  });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    console.error(`Could not connect to PostgreSQL (error ${error.code || "unknown"}). Check DATABASE_URL, database availability, and credentials.`);
    await pool.end();
    process.exitCode = 1;
    return;
  }
  const auth = createAuth({ pool, sessionSecret: config.sessionSecret });
  const server = createServer({ pool, auth, corsOrigin: config.corsOrigin });
  server.on("error", async (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`SMIS server could not listen on ${config.host}:${config.port}; the address is already in use.`);
    } else {
      console.error(`SMIS server failed to start (error ${error.code || "unknown"}).`);
    }
    await pool.end();
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`SMIS application listening on http://${config.host}:${config.port}`);
  });
  const close = () => server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (require.main === module) main();

module.exports = { collectionDefinitions, createServer, readConfig, parseListOptions, validateValues, distributionInventoryChanges, distributionStatus, getDashboardStats };
