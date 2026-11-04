import { createHash, randomBytes, scrypt as callbackScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(callbackScrypt);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const ADMIN_COOKIE = 'mbr_admin_session';
const VISITOR_COOKIE = 'mbr_visitor_session';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
}

function equalSecret(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(request, name) {
  const cookie = (request.headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!cookie) return null;
  const token = cookie.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{40,50}$/.test(token) ? token : null;
}

function hashedToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function cookieHeader(name, value, maxAge, secure) {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3–32 letters, numbers, dots, underscores, or hyphens.');
  }
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new HttpError(400, 'Password must be at least 12 characters.');
  }
}

function validateEmail(email) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  return email.trim().toLowerCase();
}

function validatePhone(phone) {
  if (typeof phone !== 'string' || phone.length > 32 || !/^\+?[0-9][0-9\s().-]{5,30}$/.test(phone.trim())) {
    throw new HttpError(400, 'Enter a valid phone number.');
  }
  return phone.trim();
}

function validateDisplayName(displayName) {
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 80) {
    throw new HttpError(400, 'Enter a name up to 80 characters.');
  }
  return displayName.trim();
}

async function passwordHash(password, salt = randomBytes(16)) {
  const hash = await scrypt(password, salt, 64);
  return { salt: salt.toString('base64url'), hash: Buffer.from(hash).toString('base64url') };
}

function createHandler({ env = (name) => process.env[name], fetchImpl = fetch } = {}) {
  const requestCounts = new Map();
  const secureCookies = env('NODE_ENV') === 'production' || env('CONTEXT') === 'production';

  function config() {
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new HttpError(503, 'Login is not configured. Set the Supabase environment variables in Netlify.');
    return { url: url.replace(/\/$/, ''), key };
  }

  async function database(path, { method = 'GET', body } = {}) {
    const { url, key } = config();
    const response = await fetchImpl(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new HttpError(502, 'The database returned an invalid response.');
    }
    if (!response.ok) {
      if (response.status === 409 || data?.code === '23505') {
        throw new HttpError(409, 'An account with those details already exists.');
      }
      if (data?.code === 'P0001') throw new HttpError(409, data.message || 'Initial admin setup is already complete.');
      if (response.status >= 500) throw new HttpError(502, 'The database is temporarily unavailable.');
      throw new HttpError(400, data?.message || 'The database rejected the request.');
    }
    return data;
  }

  async function rpc(name, body) {
    const { url, key } = config();
    const response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new HttpError(502, 'The database returned an invalid response.');
    }
    if (!response.ok) {
      if (response.status === 409 || data?.code === '23505') {
        throw new HttpError(409, data?.message || 'An account with those details already exists.');
      }
      if (data?.code === 'P0001') throw new HttpError(409, data.message || 'Initial admin setup is already complete.');
      if (response.status >= 500) throw new HttpError(502, 'The database is temporarily unavailable.');
      throw new HttpError(400, data?.message || 'The database rejected the request.');
    }
    return data;
  }

  async function readJson(request) {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send request data as JSON.');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, 'Request body must be a valid JSON object.');
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new HttpError(413, 'Request is too large.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks, totalBytes).toString('utf8');
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected object.');
      return data;
    } catch {
      throw new HttpError(400, 'Request body must be a valid JSON object.');
    }
  }

  function allowAttempt(request, kind) {
    const address = request.headers.get('x-nf-client-connection-ip') || 'unknown';
    const key = `${kind}:${address}`;
    const now = Date.now();
    let entry = requestCounts.get(key);
    if (!entry || now - entry.startedAt >= 15 * 60 * 1000) {
      entry = { startedAt: now, count: 0 };
      requestCounts.set(key, entry);
    }
    if (entry.count >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    entry.count += 1;
  }

  function clearAttempts(request, kind) {
    const address = request.headers.get('x-nf-client-connection-ip') || 'unknown';
    requestCounts.delete(`${kind}:${address}`);
  }

  async function createSession(table, foreignKey, rowId, cookieName) {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const rows = await database(table, {
      method: 'POST',
      body: [{ token_hash: hashedToken(token), [foreignKey]: rowId, csrf_token: csrfToken, expires_at: expiresAt }]
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw new HttpError(502, 'Unable to create a login session.');
    return {
      csrfToken,
      cookie: cookieHeader(cookieName, token, SESSION_TTL_MS / 1000, secureCookies)
    };
  }

  async function getSession(request, kind) {
    const isAdmin = kind === 'admin';
    const cookieName = isAdmin ? ADMIN_COOKIE : VISITOR_COOKIE;
    const table = isAdmin ? 'admin_sessions' : 'visitor_sessions';
    const foreignKey = isAdmin ? 'admin_id' : 'visitor_id';
    const token = readCookie(request, cookieName);
    if (!token) return null;
    const filter = new URLSearchParams({
      token_hash: `eq.${hashedToken(token)}`,
      expires_at: `gt.${new Date().toISOString()}`,
      select: `csrf_token,expires_at,${isAdmin ? 'admin_accounts!inner(id,username,display_name,email,phone)' : 'visitor_accounts!inner(id,display_name,email)'}`,
      limit: '1'
    });
    const sessions = await database(`${table}?${filter}`);
    const session = sessions?.[0];
    if (!session) return null;
    const account = session[isAdmin ? 'admin_accounts' : 'visitor_accounts'];
    return {
      tokenHash: hashedToken(token),
      csrfToken: session.csrf_token,
      expiresAt: session.expires_at,
      account,
      kind,
      table,
      foreignKey,
      cookieName
    };
  }

  function requireCsrf(request, session) {
    const supplied = request.headers.get('x-csrf-token') || '';
    if (!equalSecret(supplied, session.csrfToken)) {
      throw new HttpError(403, 'Your session has expired or the request could not be verified. Reload and try again.');
    }
  }

  function publicAdmin(admin) {
    return {
      id: admin.id,
      username: admin.username,
      displayName: admin.display_name,
      email: admin.email || '',
      phone: admin.phone || '',
      role: 'Administrator'
    };
  }

  function publicVisitor(visitor) {
    return { id: visitor.id, displayName: visitor.display_name, email: visitor.email };
  }

  async function getAccountByLogin(login, kind) {
    const table = kind === 'admin' ? 'admin_accounts' : 'visitor_accounts';
    const columns = kind === 'admin'
      ? 'id,username,display_name,email,phone,password_salt,password_hash'
      : 'id,display_name,email,password_salt,password_hash';
    const column = kind === 'admin' ? 'username' : 'email';
    const query = new URLSearchParams({ [column]: `eq.${login}`, select: columns, limit: '1' });
    const rows = await database(`${table}?${query}`);
    return rows?.[0] || null;
  }

  async function login(request, kind) {
    allowAttempt(request, `${kind}-login`);
    const data = await readJson(request);
    const identity = kind === 'admin'
      ? (typeof data.username === 'string' ? data.username.trim().toLowerCase() : '')
      : validateEmail(data.email);
    if (kind === 'admin' && !/^[a-zA-Z0-9._-]{3,32}$/.test(identity)) {
      throw new HttpError(400, 'Enter a valid username.');
    }
    const password = typeof data.password === 'string' ? data.password : '';
    if (Buffer.byteLength(password, 'utf8') > 1024) throw new HttpError(400, 'Password must be at most 1024 bytes.');
    const account = await getAccountByLogin(identity, kind);
    const salt = account ? Buffer.from(account.password_salt, 'base64url') : randomBytes(16);
    const expected = account ? Buffer.from(account.password_hash, 'base64url') : Buffer.from(await scrypt(randomBytes(32), salt, 64));
    const actual = Buffer.from(await scrypt(password, salt, 64));
    if (!account || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'Email or password is incorrect.');

    const isAdmin = kind === 'admin';
    const session = await createSession(
      isAdmin ? 'admin_sessions' : 'visitor_sessions',
      isAdmin ? 'admin_id' : 'visitor_id',
      account.id,
      isAdmin ? ADMIN_COOKIE : VISITOR_COOKIE
    );
    clearAttempts(request, `${kind}-login`);
    return jsonResponse(200, {
      user: isAdmin ? publicAdmin(account) : publicVisitor(account),
      csrfToken: session.csrfToken
    }, { 'Set-Cookie': session.cookie });
  }

  async function registerVisitor(request) {
    allowAttempt(request, 'visitor-register');
    const data = await readJson(request);
    const displayName = validateDisplayName(data.displayName);
    const email = validateEmail(data.email);
    validateCredentials('visitor', data.password);
    const credentials = await passwordHash(data.password);
    const rows = await database('visitor_accounts', {
      method: 'POST',
      body: [{
        display_name: displayName,
        email,
        password_salt: credentials.salt,
        password_hash: credentials.hash,
        created_at: new Date().toISOString()
      }]
    });
    const visitor = rows?.[0];
    if (!visitor) throw new HttpError(502, 'Unable to create the account.');
    const session = await createSession('visitor_sessions', 'visitor_id', visitor.id, VISITOR_COOKIE);
    clearAttempts(request, 'visitor-register');
    return jsonResponse(201, {
      user: publicVisitor(visitor),
      csrfToken: session.csrfToken
    }, { 'Set-Cookie': session.cookie });
  }

  async function createAdmin(request, existingSession) {
    requireCsrf(request, existingSession);
    const data = await readJson(request);
    const username = typeof data.username === 'string' ? data.username.trim() : '';
    validateCredentials(username, data.password);
    const displayName = validateDisplayName(data.displayName);
    const email = validateEmail(data.email);
    const phone = validatePhone(data.phone);
    const credentials = await passwordHash(data.password);
    const rows = await database('admin_accounts', {
      method: 'POST',
      body: [{
        username: username.toLowerCase(),
        display_name: displayName,
        email,
        phone,
        password_salt: credentials.salt,
        password_hash: credentials.hash,
        created_at: new Date().toISOString()
      }]
    });
    if (!rows?.[0]) throw new HttpError(502, 'Unable to create the admin account.');
    return jsonResponse(201, { user: publicAdmin(rows[0]) });
  }

  async function route(request, pathname) {
    if (request.method === 'POST' && pathname === '/api/register') return registerVisitor(request);
    if (request.method === 'POST' && pathname === '/api/visitor-login') return login(request, 'visitor');
    if (request.method === 'POST' && pathname === '/api/login') return login(request, 'admin');

    if (request.method === 'GET' && pathname === '/api/visitor-session') {
      const session = await getSession(request, 'visitor');
      if (!session) return jsonResponse(401, { error: 'You are not signed in.' });
      return jsonResponse(200, { user: publicVisitor(session.account), csrfToken: session.csrfToken });
    }

    if (request.method === 'POST' && pathname === '/api/visitor-logout') {
      const session = await getSession(request, 'visitor');
      if (session) {
        requireCsrf(request, session);
        const filter = new URLSearchParams({ token_hash: `eq.${session.tokenHash}` });
        await database(`${session.table}?${filter}`, { method: 'DELETE' });
      }
      return jsonResponse(200, { ok: true }, {
        'Set-Cookie': cookieHeader(VISITOR_COOKIE, '', 0, secureCookies)
      });
    }

    if (request.method === 'GET' && pathname === '/api/session') {
      const session = await getSession(request, 'admin');
      if (!session) return jsonResponse(401, { error: 'You are not signed in.' });
      return jsonResponse(200, { user: publicAdmin(session.account), csrfToken: session.csrfToken });
    }

    if (request.method === 'GET' && pathname === '/api/admin-profiles') {
      const rows = await database('admin_accounts?select=id,username,display_name,email,phone&order=id.asc');
      return jsonResponse(200, { admins: (rows || []).map(publicAdmin) });
    }

    if (request.method === 'GET' && pathname === '/api/setup-state') {
      const rows = await database('admin_accounts?select=id&limit=1');
      return jsonResponse(200, { setupRequired: !rows?.length });
    }

    if (request.method === 'POST' && pathname === '/api/setup') {
      allowAttempt(request, 'admin-setup');
      const data = await readJson(request);
      const setupToken = env('ADMIN_SETUP_TOKEN');
      if (!setupToken) throw new HttpError(503, 'Initial admin setup is not configured in Netlify.');
      if (typeof data.setupToken !== 'string' || !equalSecret(data.setupToken, setupToken)) {
        throw new HttpError(401, 'The setup token is incorrect.');
      }
      const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
      validateCredentials(username, data.password);
      const displayName = validateDisplayName(data.displayName);
      const email = validateEmail(data.email);
      const phone = validatePhone(data.phone);
      const credentials = await passwordHash(data.password);
      const created = await rpc('create_initial_admin', {
        p_username: username,
        p_display_name: displayName,
        p_email: email,
        p_phone: phone,
        p_password_salt: credentials.salt,
        p_password_hash: credentials.hash
      });
      const account = Array.isArray(created) ? created[0] : created;
      if (!account?.id) throw new HttpError(409, 'Initial admin setup is already complete.');
      const session = await createSession('admin_sessions', 'admin_id', account.id, ADMIN_COOKIE);
      clearAttempts(request, 'admin-setup');
      return jsonResponse(201, { user: publicAdmin(account), csrfToken: session.csrfToken }, {
        'Set-Cookie': session.cookie
      });
    }

    if (request.method === 'POST' && pathname === '/api/admins') {
      const session = await getSession(request, 'admin');
      if (!session) throw new HttpError(401, 'Sign in as an admin to create an account.');
      return createAdmin(request, session);
    }

    if (request.method === 'POST' && pathname === '/api/logout') {
      const session = await getSession(request, 'admin');
      if (session) {
        requireCsrf(request, session);
        const filter = new URLSearchParams({ token_hash: `eq.${session.tokenHash}` });
        await database(`${session.table}?${filter}`, { method: 'DELETE' });
      }
      return jsonResponse(200, { ok: true }, {
        'Set-Cookie': cookieHeader(ADMIN_COOKIE, '', 0, secureCookies)
      });
    }

    return jsonResponse(404, { error: 'API endpoint not found.' });
  }

  return async function handler(request) {
    try {
      const url = new URL(request.url);
      let pathname = url.pathname;
      if (pathname === '/.netlify/functions/api') {
        const endpoint = url.searchParams.get('endpoint');
        if (!endpoint || endpoint.includes('..')) return jsonResponse(404, { error: 'API endpoint not found.' });
        pathname = `/api/${endpoint.replace(/^\/+/, '')}`;
      }
      return await route(request, pathname);
    } catch (error) {
      if (error instanceof HttpError) return jsonResponse(error.status, { error: error.message });
      console.error('Netlify API request failed:', error);
      return jsonResponse(500, { error: 'An unexpected server error occurred.' });
    }
  };
}

const handler = createHandler();

export default async (request) => handler(request);
export { createHandler };
