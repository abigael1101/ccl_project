'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../server');

test('admin setup, sign-in, admin-only account creation, and logout', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mbr-admin-test-'));
  const app = createApp({
    databasePath: path.join(directory, 'admin.sqlite'),
    root: path.resolve(__dirname, '..'),
    secureCookies: true,
    setupToken: 'test-only-setup-token'
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const postJson = (endpoint, body, options = {}) => fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {})
    },
    body: JSON.stringify(body)
  });

  const setupState = await fetch(`${baseUrl}/api/setup-state`);
  assert.deepEqual(await setupState.json(), { setupRequired: true });

  const missingSetupToken = await postJson('/api/setup', {
    username: 'admin.one',
    password: 'Strong-Test-Password-123!'
  });
  assert.equal(missingSetupToken.status, 401);

  const initialSetup = await postJson('/api/setup', {
    setupToken: 'test-only-setup-token',
    displayName: 'Primary Admin',
    username: 'admin.one',
    password: 'Strong-Test-Password-123!'
  });
  assert.equal(initialSetup.status, 201);
  const firstSession = await initialSetup.json();
  const setCookieHeader = initialSetup.headers.get('set-cookie');
  assert.match(setCookieHeader, /HttpOnly/);
  assert.match(setCookieHeader, /SameSite=Strict/);
  assert.match(setCookieHeader, /Secure/);
  const firstCookie = setCookieHeader.split(';')[0];
  assert.equal(firstSession.user.displayName, 'Primary Admin');
  assert.equal(firstSession.user.role, 'Administrator');

  const setupComplete = await fetch(`${baseUrl}/api/setup-state`);
  assert.deepEqual(await setupComplete.json(), { setupRequired: false });

  const rejectedAccountCreation = await postJson('/api/admins', {
    username: 'admin.two',
    password: 'Another-Strong-Password-123!'
  });
  assert.equal(rejectedAccountCreation.status, 401);

  const badCsrf = await postJson('/api/admins', {
    username: 'admin.two',
    password: 'Another-Strong-Password-123!'
  }, { cookie: firstCookie, csrf: 'invalid' });
  assert.equal(badCsrf.status, 403);

  const newAdmin = await postJson('/api/admins', {
    displayName: 'Second Admin',
    username: 'admin.two',
    password: 'Another-Strong-Password-123!'
  }, { cookie: firstCookie, csrf: firstSession.csrfToken });
  assert.equal(newAdmin.status, 201);
  assert.equal((await newAdmin.json()).user.username, 'admin.two');

  const weakPassword = await postJson('/api/admins', {
    username: 'admin.three',
    password: 'short'
  }, { cookie: firstCookie, csrf: firstSession.csrfToken });
  assert.equal(weakPassword.status, 400);

  const login = await postJson('/api/login', {
    username: 'admin.two',
    password: 'Another-Strong-Password-123!'
  });
  assert.equal(login.status, 200);
  const secondSession = await login.json();
  const secondCookie = login.headers.get('set-cookie').split(';')[0];

  const loggedInProfile = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: secondCookie }
  });
  assert.equal((await loggedInProfile.json()).user.displayName, 'Second Admin');

  const logout = await postJson('/api/logout', {}, {
    cookie: secondCookie,
    csrf: secondSession.csrfToken
  });
  assert.equal(logout.status, 200);

  const loggedOutProfile = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: secondCookie }
  });
  assert.equal(loggedOutProfile.status, 401);

  const serverSource = await fetch(`${baseUrl}/server.js`);
  assert.equal(serverSource.status, 404);
});
