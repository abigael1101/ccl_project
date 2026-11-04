const assert = require('node:assert/strict');
const test = require('node:test');

function createSupabaseMock() {
  const tables = {
    visitor_accounts: [],
    visitor_sessions: [],
    admin_accounts: [],
    admin_sessions: []
  };
  let nextId = 1;

  function jsonResponse(status, value) {
    return new Response(status === 204 ? null : JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function relatedSession(table, row, relation) {
    const accountTable = relation === 'admin_accounts' ? 'admin_accounts' : 'visitor_accounts';
    const foreignKey = relation === 'admin_accounts' ? 'admin_id' : 'visitor_id';
    const account = tables[accountTable].find((item) => item.id === row[foreignKey]);
    return { ...row, [relation]: account };
  }

  return {
    tables,
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/rpc/create_initial_admin')) {
        if (tables.admin_accounts.length) {
          return jsonResponse(409, { code: 'P0001', message: 'Initial admin setup is already complete.' });
        }
        const values = JSON.parse(init.body);
        const admin = {
          id: nextId++,
          username: values.p_username,
          display_name: values.p_display_name,
          email: values.p_email,
          phone: values.p_phone,
          password_salt: values.p_password_salt,
          password_hash: values.p_password_hash
        };
        tables.admin_accounts.push(admin);
        return jsonResponse(200, [admin]);
      }

      const table = url.pathname.split('/').pop();
      const rows = tables[table];
      if (!rows) return jsonResponse(404, { message: 'Unknown table' });
      const params = url.searchParams;

      if (init.method === 'POST') {
        const incoming = JSON.parse(init.body);
        for (const value of incoming) {
          if (table === 'visitor_accounts'
            && rows.some((row) => row.email === value.email)) {
            return jsonResponse(409, { code: '23505', message: 'Email already exists' });
          }
          if (table === 'admin_accounts'
            && (rows.some((row) => row.email === value.email)
              || rows.some((row) => row.username === value.username))) {
            return jsonResponse(409, { code: '23505', message: 'Admin already exists' });
          }
        }
        const inserted = incoming.map((value) => ({ id: nextId++, ...value }));
        rows.push(...inserted);
        return jsonResponse(201, inserted);
      }

      if (init.method === 'DELETE') {
        const tokenHash = params.get('token_hash')?.slice(3);
        const remaining = rows.filter((row) => row.token_hash !== tokenHash);
        rows.splice(0, rows.length, ...remaining);
        return jsonResponse(204, null);
      }

      let selected = [...rows];
      for (const [key, filter] of params) {
        if (key === 'select' || key === 'order' || key === 'limit') continue;
        if (filter.startsWith('eq.')) {
          selected = selected.filter((row) => String(row[key]) === filter.slice(3));
        } else if (filter.startsWith('gt.')) {
          selected = selected.filter((row) => row[key] > filter.slice(3));
        }
      }
      const select = params.get('select') || '';
      if (table === 'visitor_sessions' && select.includes('visitor_accounts!inner')) {
        selected = selected.map((row) => relatedSession(table, row, 'visitor_accounts'));
      } else if (table === 'admin_sessions' && select.includes('admin_accounts!inner')) {
        selected = selected.map((row) => relatedSession(table, row, 'admin_accounts'));
      }
      if (params.has('limit')) selected = selected.slice(0, Number(params.get('limit')));
      if (params.has('order')) selected.sort((left, right) => left.id - right.id);
      return jsonResponse(200, selected);
    }
  };
}

test('Netlify API supports visitor and admin auth with persistent-store semantics', async () => {
  const { createHandler } = await import('../netlify/functions/api.mjs');
  const mock = createSupabaseMock();
  const handler = createHandler({
    env: (name) => ({
      SUPABASE_URL: 'https://supabase.example.test',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      ADMIN_SETUP_TOKEN: 'test-admin-setup-token',
      NODE_ENV: 'production'
    })[name],
    fetchImpl: mock.fetch
  });
  const request = (path, { method = 'GET', body, cookie, csrf } = {}) => handler(new Request(
    `https://bloodbank.example.test${path}`,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
  ));
  const cookieValue = (response) => response.headers.get('set-cookie').split(';')[0];

  const signup = await request('/api/register', {
    method: 'POST',
    body: {
      displayName: 'Demo Visitor',
      email: 'demo@example.org',
      password: 'Strong-Demo-Password-123!'
    }
  });
  assert.equal(signup.status, 201);
  assert.match(signup.headers.get('set-cookie'), /HttpOnly/);
  assert.match(signup.headers.get('set-cookie'), /Secure/);
  const signupResult = await signup.json();
  const visitorCookie = cookieValue(signup);

  const visitorSession = await request('/api/visitor-session', { cookie: visitorCookie });
  assert.equal((await visitorSession.json()).user.email, 'demo@example.org');

  const visitorLogin = await request('/api/visitor-login', {
    method: 'POST',
    body: { email: 'demo@example.org', password: 'Strong-Demo-Password-123!' }
  });
  assert.equal(visitorLogin.status, 200);
  const visitorLoginCookie = cookieValue(visitorLogin);
  assert.equal(
    (await (await request('/api/visitor-session', { cookie: visitorLoginCookie })).json()).user.email,
    'demo@example.org'
  );

  const duplicateSignup = await request('/.netlify/functions/api?endpoint=register', {
    method: 'POST',
    body: {
      displayName: 'Duplicate Visitor',
      email: 'DEMO@example.org',
      password: 'Other-Strong-Password-123!'
    }
  });
  assert.equal(duplicateSignup.status, 409);

  const oversizedSignup = await request('/api/register', {
    method: 'POST',
    body: {
      displayName: 'x'.repeat(17_000),
      email: 'large@example.org',
      password: 'Strong-Demo-Password-123!'
    }
  });
  assert.equal(oversizedSignup.status, 413);

  const initialAdmin = await request('/api/setup', {
    method: 'POST',
    body: {
      setupToken: 'test-admin-setup-token',
      username: 'admin.one',
      displayName: 'Primary Admin',
      email: 'admin@example.org',
      phone: '+91 98765 43210',
      password: 'Strong-Admin-Password-123!'
    }
  });
  assert.equal(initialAdmin.status, 201);
  const adminResult = await initialAdmin.json();
  const adminCookie = cookieValue(initialAdmin);

  const adminLogin = await request('/api/login', {
    method: 'POST',
    body: { username: 'admin.one', password: 'Strong-Admin-Password-123!' }
  });
  assert.equal(adminLogin.status, 200);
  const adminLoginCookie = cookieValue(adminLogin);
  assert.equal((await (await request('/api/session', { cookie: adminLoginCookie })).json()).user.username, 'admin.one');

  const createdAdmin = await request('/api/admins', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminResult.csrfToken,
    body: {
      username: 'admin.two',
      displayName: 'Second Admin',
      email: 'second-admin@example.org',
      phone: '+91 98765 43211',
      password: 'Another-Admin-Password-123!'
    }
  });
  assert.equal(createdAdmin.status, 201);
  assert.equal((await createdAdmin.json()).user.displayName, 'Second Admin');

  const directory = await request('/api/admin-profiles');
  assert.equal((await directory.json()).admins.length, 2);

  const failedAdminLogout = await request('/api/logout', {
    method: 'POST',
    cookie: adminCookie,
    csrf: 'invalid'
  });
  assert.equal(failedAdminLogout.status, 403);

  const adminLogout = await request('/api/logout', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminResult.csrfToken
  });
  assert.equal(adminLogout.status, 200);

  const visitorLogout = await request('/api/visitor-logout', {
    method: 'POST',
    cookie: visitorCookie,
    csrf: signupResult.csrfToken
  });
  assert.equal(visitorLogout.status, 200);

  const afterLogout = await request('/api/visitor-session', { cookie: visitorCookie });
  assert.equal(afterLogout.status, 401);
});
