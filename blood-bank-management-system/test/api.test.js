'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../server');

async function startDemo(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bbms-json-test-'));
  const instance = createApp({ dataDirectory: directory, secureCookies: true });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (instance.server.listening) {
      await new Promise((resolve, reject) => instance.server.close((error) => error ? reject(error) : resolve()));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  const json = (route, { method = 'GET', body, cookie, csrf } = {}) => fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });
  const login = await json('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' }
  });
  assert.equal(login.status, 200);
  return {
    instance,
    directory,
    json,
    cookie: login.headers.get('set-cookie').split(';')[0],
    csrf: (await login.json()).csrfToken
  };
}

test('demo login, sessions, and protected pages work', async (t) => {
  const { json, cookie, csrf } = await startDemo(t);

  const anonymousHome = await json('/');
  assert.equal(anonymousHome.status, 302);
  assert.equal(anonymousHome.headers.get('location'), '/login.html');
  const anonymousLoginPage = await json('/login.html');
  assert.equal(anonymousLoginPage.status, 200);
  assert.match(await anonymousLoginPage.text(), /Demo access credentials/);
  const legacyLoginPage = await json('/Login.html');
  assert.equal(legacyLoginPage.status, 302);
  assert.equal(legacyLoginPage.headers.get('location'), '/login.html');

  const invalid = await json('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'incorrect' }
  });
  assert.equal(invalid.status, 401);

  const protectedPage = await json('/dashboard.html');
  assert.equal(protectedPage.status, 302);
  assert.equal(protectedPage.headers.get('location'), '/login.html');

  const dashboard = await json('/api/dashboard', { cookie });
  assert.equal(dashboard.status, 200);
  assert.deepEqual((await dashboard.json()).stats, {
    totalDonors: 15,
    totalDonations: 10,
    availableUnits: 49,
    totalRequests: 8,
    pendingRequests: 3,
    completedRequests: 3
  });

  const home = await json('/', { cookie });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/Index.html');
  const mainWebsite = await json('/Index.html', { cookie });
  assert.equal(mainWebsite.status, 200);
  assert.match(await mainWebsite.text(), /Welcome to Make a Blood Relation/);
  const privateServerSource = await json('/server.js', { cookie });
  assert.equal(privateServerSource.status, 404);

  const missingCsrf = await json('/api/donors', {
    method: 'POST',
    cookie,
    body: { fullName: 'Unauthorized Example' }
  });
  assert.equal(missingCsrf.status, 403);

  const logout = await json('/api/auth/logout', { method: 'POST', cookie, csrf, body: {} });
  assert.equal(logout.status, 200);
  const noSession = await json('/api/auth/session', { cookie });
  assert.equal(noSession.status, 401);
});

test('donor CRUD validates, generates IDs, and persists JSON', async (t) => {
  const { json, cookie, csrf, directory } = await startDemo(t);
  const donorInput = {
    fullName: 'Demo Test Donor',
    age: '28',
    gender: 'Female',
    bloodGroup: 'AB-',
    phone: '+91 90000 02000',
    email: 'new.donor@example.org',
    address: '7 Sample Lane',
    city: 'Navi Mumbai',
    state: 'Maharashtra',
    pincode: '400703',
    lastDonationDate: '',
    availabilityStatus: 'Available'
  };
  const invalid = await json('/api/donors', {
    method: 'POST', cookie, csrf, body: { ...donorInput, age: '16' }
  });
  assert.equal(invalid.status, 400);

  const created = await json('/api/donors', { method: 'POST', cookie, csrf, body: donorInput });
  assert.equal(created.status, 201);
  const donor = await created.json();
  assert.equal(donor.id, 'DNR-0016');
  assert.equal(donor.registrationDate, new Date().toISOString().slice(0, 10));

  const updated = await json(`/api/donors/${donor.id}`, {
    method: 'PATCH', cookie, csrf, body: { city: 'Thane', availabilityStatus: 'Temporarily unavailable' }
  });
  assert.equal((await updated.json()).city, 'Thane');

  const duplicate = await json('/api/donors', {
    method: 'POST', cookie, csrf, body: { ...donorInput, fullName: 'Duplicate', phone: '+91 90000 02001' }
  });
  assert.equal(duplicate.status, 409);

  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'donors.json'), 'utf8'));
  assert.equal(persisted.find((item) => item.id === donor.id).availabilityStatus, 'Temporarily unavailable');

  const removed = await json(`/api/donors/${donor.id}`, { method: 'DELETE', cookie, csrf, body: {} });
  assert.equal(removed.status, 200);
});

test('donations, manual inventory changes, and completed requests update stock together', async (t) => {
  const { json, cookie, csrf, directory } = await startDemo(t);

  const donation = await json('/api/donations', {
    method: 'POST', cookie, csrf,
    body: {
      donorId: 'DNR-0002',
      units: '2',
      donationDate: new Date().toISOString().slice(0, 10),
      location: 'Demo blood drive',
      remarks: 'Test donation'
    }
  });
  assert.equal(donation.status, 201);
  const addedDonation = await donation.json();
  assert.equal(addedDonation.bloodGroup, 'A+');

  let inventory = await (await json('/api/inventory', { cookie })).json();
  let stock = inventory.items.find((item) => item.bloodGroup === 'A+');
  assert.equal(stock.availableUnits, 12);
  assert.equal(stock.totalDonations, 5);

  const issue = await json('/api/inventory/A+/adjust', {
    method: 'POST', cookie, csrf, body: { kind: 'issue', units: 3, note: 'Demo manual issue' }
  });
  assert.equal((await issue.json()).availableUnits, 9);
  const insufficientIssue = await json('/api/inventory/A+/adjust', {
    method: 'POST', cookie, csrf, body: { kind: 'issue', units: 100, note: 'Too many' }
  });
  assert.equal(insufficientIssue.status, 409);

  const completeRequest = await json('/api/requests/REQ-0008', {
    method: 'PATCH', cookie, csrf, body: { status: 'Completed' }
  });
  assert.equal((await completeRequest.json()).status, 'Completed');
  inventory = await (await json('/api/inventory', { cookie })).json();
  assert.equal(inventory.items.find((item) => item.bloodGroup === 'AB+').availableUnits, 5);
  assert.ok(inventory.history.some((entry) => entry.note.includes('REQ-0008')));

  const impossibleRequest = await json('/api/requests', {
    method: 'POST', cookie, csrf,
    body: {
      patientName: 'Demo Patient',
      hospitalName: 'Example Hospital',
      bloodGroup: 'O-',
      units: 20,
      contactNumber: '+91 90000 02020',
      requestDate: new Date().toISOString().slice(0, 10),
      priority: 'Urgent'
    }
  });
  assert.equal(impossibleRequest.status, 201);
  const createdRequest = await impossibleRequest.json();
  const cannotFulfill = await json(`/api/requests/${createdRequest.id}`, {
    method: 'PATCH', cookie, csrf, body: { status: 'Completed' }
  });
  assert.equal(cannotFulfill.status, 409);

  const donations = JSON.parse(fs.readFileSync(path.join(directory, 'donations.json'), 'utf8'));
  const savedStock = JSON.parse(fs.readFileSync(path.join(directory, 'inventory.json'), 'utf8'));
  assert.ok(donations.some((item) => item.id === addedDonation.id));
  assert.equal(savedStock.items.find((item) => item.bloodGroup === 'A+').availableUnits, 9);
});

test('donation edits and deletes adjust stock and CSV export is available', async (t) => {
  const { json, cookie, csrf } = await startDemo(t);
  const edited = await json('/api/donations/DON-0002', {
    method: 'PATCH', cookie, csrf, body: { units: 2, remarks: 'Updated demo entry' }
  });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).units, 2);
  let inventory = await (await json('/api/inventory', { cookie })).json();
  assert.equal(inventory.items.find((item) => item.bloodGroup === 'A+').availableUnits, 11);

  const deleted = await json('/api/donations/DON-0002', { method: 'DELETE', cookie, csrf, body: {} });
  assert.equal(deleted.status, 200);
  inventory = await (await json('/api/inventory', { cookie })).json();
  assert.equal(inventory.items.find((item) => item.bloodGroup === 'A+').availableUnits, 9);

  const moved = await json('/api/donations/DON-0005', {
    method: 'PATCH', cookie, csrf, body: { donorId: 'DNR-0004' }
  });
  assert.equal((await moved.json()).bloodGroup, 'AB+');
  inventory = await (await json('/api/inventory', { cookie })).json();
  assert.equal(inventory.items.find((item) => item.bloodGroup === 'O-').availableUnits, 4);
  assert.equal(inventory.items.find((item) => item.bloodGroup === 'AB+').availableUnits, 7);
  assert.ok(inventory.history.some((entry) => entry.note === 'Donation DON-0005 moved out' && entry.change === -1));
  assert.ok(inventory.history.some((entry) => entry.note === 'Donation DON-0005 moved in' && entry.change === 1));
  assert.equal(new Set(inventory.history.map((entry) => entry.id)).size, inventory.history.length);

  const csv = await json('/api/export/donors', { cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /DNR-0001/);
});

test('requests support approval, edits, rejection and deletion; stock adjustments are serialized', async (t) => {
  const { json, cookie, csrf } = await startDemo(t);
  const today = new Date().toISOString().slice(0, 10);
  const created = await json('/api/requests', {
    method: 'POST', cookie, csrf,
    body: {
      patientName: 'Demo Patient Two',
      hospitalName: 'Fictional Health Centre',
      bloodGroup: 'AB+',
      units: 1,
      contactNumber: '+91 90000 03001',
      requestDate: today,
      priority: 'Normal'
    }
  });
  assert.equal(created.status, 201);
  const request = await created.json();

  const approved = await json(`/api/requests/${request.id}`, {
    method: 'PATCH', cookie, csrf, body: { status: 'Approved', priority: 'High' }
  });
  assert.equal((await approved.json()).status, 'Approved');

  const rejected = await json(`/api/requests/${request.id}`, {
    method: 'PATCH', cookie, csrf, body: { status: 'Rejected' }
  });
  assert.equal((await rejected.json()).status, 'Rejected');

  const deleted = await json(`/api/requests/${request.id}`, { method: 'DELETE', cookie, csrf, body: {} });
  assert.equal(deleted.status, 200);

  const adds = await Promise.all([
    json('/api/inventory/A+/adjust', {
      method: 'POST', cookie, csrf, body: { kind: 'add', units: 2, note: 'Concurrent test addition A' }
    }),
    json('/api/inventory/A+/adjust', {
      method: 'POST', cookie, csrf, body: { kind: 'add', units: 3, note: 'Concurrent test addition B' }
    })
  ]);
  assert.deepEqual(adds.map((response) => response.status), [200, 200]);
  const inventory = await (await json('/api/inventory', { cookie })).json();
  assert.equal(inventory.items.find((item) => item.bloodGroup === 'A+').availableUnits, 15);
});
