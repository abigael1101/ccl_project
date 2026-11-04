'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'mbr_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createDatabase(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  `);
  return db;
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(body);
}

function sessionCookie(value, maxAge, secure) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function timingSafeStringEqual(first, second) {
  const left = Buffer.from(first);
  const right = Buffer.from(second);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3–32 letters, numbers, dots, underscores, or hyphens.');
  }
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new HttpError(400, 'Password must be at least 12 characters.');
  }
}

async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = await scrypt(password, salt, 64);
  return {
    salt: salt.toString('base64url'),
    hash: Buffer.from(hash).toString('base64url')
  };
}

function readSessionToken(request) {
  const cookie = (request.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;

  const token = cookie.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{40,50}$/.test(token) ? token : null;
}

function createApp(options = {}) {
  const root = path.resolve(options.root || __dirname);
  const databasePath = path.resolve(options.databasePath || process.env.DATABASE_PATH || path.join(root, 'data', 'admin.sqlite'));
  const setupToken = options.setupToken ?? process.env.ADMIN_SETUP_TOKEN ?? '';
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const db = createDatabase(databasePath);
  const loginAttempts = new Map();
  const statements = {
    adminCount: db.prepare('SELECT COUNT(*) AS count FROM admins'),
    adminByUsername: db.prepare('SELECT * FROM admins WHERE username = ?'),
    adminById: db.prepare('SELECT id, username, display_name FROM admins WHERE id = ?'),
    insertAdmin: db.prepare(`
      INSERT INTO admins (username, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertSession: db.prepare(`
      INSERT INTO sessions (token_hash, admin_id, csrf_token, expires_at)
      VALUES (?, ?, ?, ?)
    `),
    sessionByHash: db.prepare(`
      SELECT sessions.csrf_token, sessions.expires_at, admins.id, admins.username, admins.display_name
      FROM sessions JOIN admins ON admins.id = sessions.admin_id
      WHERE sessions.token_hash = ?
    `),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
  };
  const dummySalt = crypto.randomBytes(16);
  const dummyPasswordHash = crypto.scryptSync(crypto.randomBytes(32).toString('hex'), dummySalt, 64);

  function getAdminCount() {
    return Number(statements.adminCount.get().count);
  }

  function addAdmin(username, displayName, credentials) {
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.insertAdmin.run(
        username.toLowerCase(),
        displayName,
        credentials.salt,
        credentials.hash,
        now
      );
      db.exec('COMMIT');
      return statements.adminById.get(Number(result.lastInsertRowid));
    } catch (error) {
      db.exec('ROLLBACK');
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
        throw new HttpError(409, 'That username is already in use.');
      }
      throw error;
    }
  }

  function createSession(response, admin) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    statements.insertSession.run(
      crypto.createHash('sha256').update(token).digest('hex'),
      admin.id,
      csrfToken,
      expiresAt
    );
    response.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000, secureCookies));
    return {
      user: { id: admin.id, username: admin.username, displayName: admin.display_name, role: 'Administrator' },
      csrfToken
    };
  }

  function getSession(request) {
    const token = readSessionToken(request);
    if (!token) return null;

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = statements.sessionByHash.get(tokenHash);
    if (!session) return null;
    if (session.expires_at <= Date.now()) {
      statements.deleteSession.run(tokenHash);
      return null;
    }
    return { ...session, tokenHash };
  }

  async function readJson(request) {
    const contentType = request.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Send request data as JSON.');
    }

    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        throw new HttpError(413, 'Request is too large.');
      }
      chunks.push(chunk);
    }

    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected a JSON object.');
      }
      return parsed;
    } catch {
      throw new HttpError(400, 'Request body must be a valid JSON object.');
    }
  }

  function allowAttempt(request, key) {
    const identifier = `${key}:${request.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const previous = loginAttempts.get(identifier);
    if (!previous || now - previous.startedAt >= 15 * 60 * 1000) {
      loginAttempts.set(identifier, { startedAt: now, count: 0 });
    }
    const attempt = loginAttempts.get(identifier);
    if (attempt.count >= 10) {
      throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    }
    attempt.count += 1;
  }

  function clearAttempts(request, key) {
    loginAttempts.delete(`${key}:${request.socket.remoteAddress || 'unknown'}`);
  }

  function requireCsrf(request, session) {
    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || !timingSafeStringEqual(supplied, session.csrf_token)) {
      throw new HttpError(403, 'Your session has expired or the request could not be verified. Reload and try again.');
    }
  }

  function createPublicUser(admin) {
    return {
      id: admin.id,
      username: admin.username,
      displayName: admin.display_name,
      role: 'Administrator'
    };
  }

  async function handleApi(request, response, pathname) {
    if (request.method === 'GET' && pathname === '/api/setup-state') {
      sendJson(response, 200, { setupRequired: getAdminCount() === 0 });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/session') {
      const session = getSession(request);
      if (!session) {
        sendJson(response, 401, { error: 'You are not signed in.' });
        return;
      }
      sendJson(response, 200, {
        user: createPublicUser(session),
        csrfToken: session.csrf_token
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/setup') {
      allowAttempt(request, 'setup');
      const data = await readJson(request);
      if (!setupToken) throw new HttpError(503, 'Admin setup is not configured on this server.');
      if (typeof data.setupToken !== 'string' || !timingSafeStringEqual(data.setupToken, setupToken)) {
        throw new HttpError(401, 'The setup token is incorrect.');
      }
      if (getAdminCount() !== 0) throw new HttpError(409, 'Initial setup is already complete.');

      const username = typeof data.username === 'string' ? data.username.trim() : '';
      const displayName = typeof data.displayName === 'string' && data.displayName.trim()
        ? data.displayName.trim().slice(0, 80)
        : username;
      validateCredentials(username, data.password);
      const credentials = await hashPassword(data.password);
      if (getAdminCount() !== 0) throw new HttpError(409, 'Initial setup is already complete.');
      const admin = addAdmin(username, displayName, credentials);
      clearAttempts(request, 'setup');
      sendJson(response, 201, createSession(response, admin));
      return;
    }

    if (request.method === 'POST' && pathname === '/api/login') {
      allowAttempt(request, 'login');
      const data = await readJson(request);
      const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
      const password = typeof data.password === 'string' ? data.password : '';
      if (Buffer.byteLength(password, 'utf8') > 1024) throw new HttpError(400, 'Password must be at most 1024 bytes.');
      const admin = statements.adminByUsername.get(username);
      const salt = admin ? Buffer.from(admin.password_salt, 'base64url') : dummySalt;
      const expected = admin ? Buffer.from(admin.password_hash, 'base64url') : dummyPasswordHash;
      const actual = Buffer.from(await scrypt(password, salt, 64));
      if (!admin || !crypto.timingSafeEqual(actual, expected)) {
        throw new HttpError(401, 'Username or password is incorrect.');
      }
      clearAttempts(request, 'login');
      statements.deleteExpiredSessions.run(Date.now());
      sendJson(response, 200, createSession(response, admin));
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admins') {
      const session = getSession(request);
      if (!session) throw new HttpError(401, 'Sign in to create an account.');
      requireCsrf(request, session);
      const data = await readJson(request);
      const username = typeof data.username === 'string' ? data.username.trim() : '';
      const displayName = typeof data.displayName === 'string' && data.displayName.trim()
        ? data.displayName.trim().slice(0, 80)
        : username;
      validateCredentials(username, data.password);
      const credentials = await hashPassword(data.password);
      if (getAdminCount() >= 100) throw new HttpError(403, 'The maximum number of admin accounts has been reached.');
      const admin = addAdmin(username, displayName, credentials);
      sendJson(response, 201, { user: createPublicUser(admin) });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/logout') {
      const session = getSession(request);
      if (!session) {
        sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, secureCookies) });
        return;
      }
      requireCsrf(request, session);
      statements.deleteSession.run(session.tokenHash);
      sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, secureCookies) });
      return;
    }

    sendJson(response, 404, { error: 'API endpoint not found.' });
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.startsWith('/api/')) {
        await handleApi(request, response, pathname);
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed.');
      }
      const requestedPath = pathname === '/' ? '/Index.html' : pathname;
      const filename = path.basename(requestedPath);
      if (!filename || filename.startsWith('.') || filename.toLowerCase() === 'server.js'
        || !/^[A-Za-z0-9_-]+\.(?:html|css|js|jpg|jpeg|png|mp4)$/i.test(filename)) {
        throw new HttpError(404, 'Page not found.');
      }
      const filePath = path.join(root, filename);
      const content = await fs.promises.readFile(filePath).catch((error) => {
        if (error.code === 'ENOENT') throw new HttpError(404, 'Page not found.');
        throw error;
      });
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Length': content.length,
        'Content-Type': MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error('Request failed:', error);
      sendJson(response, 500, { error: 'An unexpected server error occurred.' });
    }
  });

  return {
    server,
    close() {
      db.close();
    }
  };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`Make A Blood Relation server listening on port ${port}`);
  });
  app.server.on('close', () => app.close());
}

module.exports = { createApp };
