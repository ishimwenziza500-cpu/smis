"use strict";

const {
  createHmac,
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
  createHash
} = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(scryptCallback);
const SCRYPT_COST = 32768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SESSION_COOKIE = "smis_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 12;
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const LOGIN_ATTEMPTS = 10;
const loginAttempts = new Map();
const DUMMY_PASSWORD_HASH = `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${Buffer.alloc(16, 1).toString("base64url")}$${Buffer.alloc(64, 2).toString("base64url")}`;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function csrfFor(sessionToken, secret) {
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("base64url");
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? ["", ""] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

function recordLoginAttempt(key) {
  const now = Date.now();
  const previous = loginAttempts.get(key);
  const recent = previous?.started > now - LOGIN_WINDOW_MS ? previous : { started: now, count: 0 };
  recent.count += 1;
  loginAttempts.set(key, recent);
  if (loginAttempts.size > 5000) {
    for (const [entry, value] of loginAttempts) {
      if (value.started <= now - LOGIN_WINDOW_MS) loginAttempts.delete(entry);
    }
  }
  return recent.count <= LOGIN_ATTEMPTS;
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

function createSessionCookie(sessionToken, secure) {
  return `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DURATION_MS / 1000}${secure ? "; Secure" : ""}`;
}

function createLogoutCookie(secure) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function configuredSessionSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes of random secret material.");
  }
  return secret;
}

async function verifyPassword(password, storedHash) {
  const [scheme, costText, blockText, parallelText, saltText, keyText] = String(storedHash).split("$");
  if (scheme !== "scrypt" || !/^\d+$/.test(costText) || !/^\d+$/.test(blockText) ||
      !/^\d+$/.test(parallelText) || !saltText || !keyText) return false;
  const cost = Number(costText);
  const blockSize = Number(blockText);
  const parallelization = Number(parallelText);
  const expected = Buffer.from(keyText, "base64url");
  if (cost < 16384 || cost > 131072 || blockSize < 1 || blockSize > 16 ||
      parallelization < 1 || parallelization > 4 || expected.length !== 64) return false;
  const actual = await scrypt(password, Buffer.from(saltText, "base64url"), expected.length, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 128 * 1024 * 1024
  });
  return timingSafeEqual(actual, expected);
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("Passwords must contain between 12 and 256 characters.");
  }
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 128 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function createAuth({ pool, sessionSecret, secureCookie = process.env.NODE_ENV === "production" }) {
  if (!pool || typeof pool.query !== "function") throw new Error("createAuth requires a PostgreSQL pool.");
  const secret = configuredSessionSecret(sessionSecret);

  async function getSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token || token.length > 128) return null;
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled = FALSE`,
      [hashToken(token)]
    );
    if (!result.rowCount) return null;
    return { user: result.rows[0], csrfToken: csrfFor(token, secret), token };
  }

  return {
    async getSession(req) {
      return getSession(req);
    },

    async authenticate(req) {
      const session = await getSession(req);
      if (!session) return false;
      req.smisUser = session.user;
      return true;
    },

    async login(req, res, { email, password }) {
      const normalizedEmail = email.trim().toLowerCase();
      const address = String(req.socket.remoteAddress || "unknown");
      const attemptKey = address;
      if (!recordLoginAttempt(attemptKey)) {
        const error = new Error("Too many sign-in attempts. Wait 15 minutes and try again.");
        error.status = 429;
        throw error;
      }
      const result = await pool.query(
        "SELECT id, email, name, role, password_hash FROM users WHERE email = $1 AND disabled = FALSE",
        [normalizedEmail]
      );
      const userRecord = result.rows[0];
      const valid = await verifyPassword(password, userRecord?.password_hash || DUMMY_PASSWORD_HASH);
      if (!valid || !userRecord) {
        const error = new Error("Invalid email or password.");
        error.status = 401;
        throw error;
      }
      clearLoginAttempts(attemptKey);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      await pool.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [hashToken(token), userRecord.id, expiresAt]
      );
      await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
      res.setHeader("set-cookie", createSessionCookie(token, secureCookie));
      return {
        user: { id: userRecord.id, email: userRecord.email, name: userRecord.name, role: userRecord.role },
        csrfToken: csrfFor(token, secret)
      };
    },

    async logout(req, res, session) {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(session.token)]);
      res.setHeader("set-cookie", createLogoutCookie(secureCookie));
    }
  };
}

module.exports = { createAuth, hashPassword, verifyPassword };
