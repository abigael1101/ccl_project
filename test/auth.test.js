'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
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

  const invalidProfile = await postJson('/api/setup', {
    setupToken: 'test-only-setup-token',
    displayName: 'Primary Admin',
    username: 'admin.one',
    email: 'not-an-email',
    phone: 'nope',
    password: 'Strong-Test-Password-123!'
  });
  assert.equal(invalidProfile.status, 400);

  const initialSetup = await postJson('/api/setup', {
    setupToken: 'test-only-setup-token',
    displayName: 'Primary Admin',
    username: 'admin.one',
    email: 'primary@example.org',
    phone: '+91 98765 43210',
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
  assert.equal(firstSession.user.email, 'primary@example.org');
  assert.equal(firstSession.user.phone, '+91 98765 43210');

  const setupComplete = await fetch(`${baseUrl}/api/setup-state`);
  assert.deepEqual(await setupComplete.json(), { setupRequired: false });

  const rejectedAccountCreation = await postJson('/api/admins', {
    username: 'admin.two',
    email: 'second@example.org',
    phone: '+91 98765 43211',
    password: 'Another-Strong-Password-123!'
  });
  assert.equal(rejectedAccountCreation.status, 401);

  const badCsrf = await postJson('/api/admins', {
    username: 'admin.two',
    email: 'second@example.org',
    phone: '+91 98765 43211',
    password: 'Another-Strong-Password-123!'
  }, { cookie: firstCookie, csrf: 'invalid' });
  assert.equal(badCsrf.status, 403);

  const newAdmin = await postJson('/api/admins', {
    displayName: 'Second Admin',
    username: 'admin.two',
    email: 'second@example.org',
    phone: '+91 98765 43211',
    password: 'Another-Strong-Password-123!'
  }, { cookie: firstCookie, csrf: firstSession.csrfToken });
  assert.equal(newAdmin.status, 201);
  const secondAdmin = (await newAdmin.json()).user;
  assert.equal(secondAdmin.username, 'admin.two');
  assert.equal(secondAdmin.displayName, 'Second Admin');
  assert.equal(secondAdmin.email, 'second@example.org');
  assert.equal(secondAdmin.phone, '+91 98765 43211');
  assert.equal(Object.hasOwn(secondAdmin, 'password'), false);

  const publicProfiles = await fetch(`${baseUrl}/api/admin-profiles`);
  assert.equal(publicProfiles.status, 200);
  const listedAdmins = (await publicProfiles.json()).admins;
  assert.equal(listedAdmins.length, 2);
  assert.equal(listedAdmins[1].email, 'second@example.org');
  assert.equal(listedAdmins[1].phone, '+91 98765 43211');
  assert.equal(Object.hasOwn(listedAdmins[1], 'password_hash'), false);

  const weakPassword = await postJson('/api/admins', {
    username: 'admin.three',
    email: 'third@example.org',
    phone: '+91 98765 43212',
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
  const accountProfile = (await loggedInProfile.json()).user;
  assert.equal(accountProfile.displayName, 'Second Admin');
  assert.equal(accountProfile.email, 'second@example.org');
  assert.equal(accountProfile.phone, '+91 98765 43211');

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

test('existing admin databases migrate to include public profile fields', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mbr-admin-migration-test-'));
  const databasePath = path.join(directory, 'admin.sqlite');
  const oldDatabase = new DatabaseSync(databasePath);
  oldDatabase.exec(`
    CREATE TABLE admins (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  oldDatabase.prepare(`
    INSERT INTO admins (username, display_name, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('legacy.admin', 'Legacy Admin', 'legacy-salt', 'legacy-hash', Date.now());
  oldDatabase.close();

  const app = createApp({
    databasePath,
    root: path.resolve(__dirname, '..'),
    secureCookies: false,
    setupToken: 'test-only-setup-token'
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/admin-profiles`);
  assert.equal(response.status, 200);
  const [legacyAdmin] = (await response.json()).admins;
  assert.equal(legacyAdmin.username, 'legacy.admin');
  assert.equal(legacyAdmin.email, '');
  assert.equal(legacyAdmin.phone, '');
});

test('visitor registration and login are required to access website pages', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mbr-visitor-test-'));
  const app = createApp({
    databasePath: path.join(directory, 'demo.sqlite'),
    root: path.resolve(__dirname, '..'),
    secureCookies: false
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const postJson = (endpoint, body, options = {}) => fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {})
    },
    body: JSON.stringify(body)
  });

  const protectedPage = await fetch(`${baseUrl}/Index.html`, { redirect: 'manual' });
  assert.equal(protectedPage.status, 302);
  assert.equal(protectedPage.headers.get('location'), '/Login.html');

  const loginPage = await fetch(`${baseUrl}/Login.html`);
  assert.equal(loginPage.status, 200);

  const invalidRegistration = await postJson('/api/register', {
    displayName: 'Demo Visitor',
    email: 'not-an-email',
    password: 'Strong-Demo-Password-123!'
  });
  assert.equal(invalidRegistration.status, 400);

  const registration = await postJson('/api/register', {
    displayName: 'Demo Visitor',
    email: 'demo@example.org',
    password: 'Strong-Demo-Password-123!'
  });
  assert.equal(registration.status, 201);
  const registeredUser = await registration.json();
  const visitorCookie = registration.headers.get('set-cookie').split(';')[0];
  assert.equal(registeredUser.user.displayName, 'Demo Visitor');
  assert.equal(registeredUser.user.email, 'demo@example.org');
  assert.match(registration.headers.get('set-cookie'), /HttpOnly/);

  const accessiblePage = await fetch(`${baseUrl}/Index.html`, {
    headers: { Cookie: visitorCookie }
  });
  assert.equal(accessiblePage.status, 200);

  const duplicateRegistration = await postJson('/api/register', {
    displayName: 'Second Visitor',
    email: 'DEMO@example.org',
    password: 'Another-Demo-Password-456!'
  });
  assert.equal(duplicateRegistration.status, 409);

  const badLogin = await postJson('/api/visitor-login', {
    email: 'demo@example.org',
    password: 'incorrect-password'
  });
  assert.equal(badLogin.status, 401);

  const login = await postJson('/api/visitor-login', {
    email: 'demo@example.org',
    password: 'Strong-Demo-Password-123!'
  });
  assert.equal(login.status, 200);
  const loginResult = await login.json();
  const loginCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(loginResult.user.displayName, 'Demo Visitor');

  const logoutWithoutCsrf = await postJson('/api/visitor-logout', {}, { cookie: loginCookie });
  assert.equal(logoutWithoutCsrf.status, 403);

  const logout = await postJson('/api/visitor-logout', {}, {
    cookie: loginCookie,
    csrf: loginResult.csrfToken
  });
  assert.equal(logout.status, 200);

  const pageAfterLogout = await fetch(`${baseUrl}/Index.html`, { redirect: 'manual' });
  assert.equal(pageAfterLogout.status, 302);
});
