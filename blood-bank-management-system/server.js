'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const REQUEST_STATUSES = ['Pending', 'Approved', 'Rejected', 'Completed'];
const PRIORITIES = ['Normal', 'High', 'Urgent'];
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FILES = ['donors', 'donations', 'inventory', 'requests', 'admin', 'sessions'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class JsonDatabase {
  constructor(directory, seedDirectory = path.join(__dirname, 'data')) {
    this.directory = directory;
    this.state = {};
    this.queue = Promise.resolve();
    fs.mkdirSync(directory, { recursive: true });

    for (const name of FILES) {
      const file = path.join(directory, `${name}.json`);
      if (!fs.existsSync(file)) {
        if (name === 'sessions') {
          this.state[name] = [];
          continue;
        }
        fs.copyFileSync(path.join(seedDirectory, `${name}.json`), file);
      }
      this.state[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }

  read(name) {
    return structuredClone(this.state[name]);
  }

  transact(change) {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await change(draft);
      const changed = FILES.filter((name) => JSON.stringify(draft[name]) !== JSON.stringify(this.state[name]));
      const staged = [];

      try {
        for (const name of changed) {
          const target = path.join(this.directory, `${name}.json`);
          const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
          await fs.promises.writeFile(temporary, `${JSON.stringify(draft[name], null, 2)}\n`, { flag: 'wx' });
          staged.push({ temporary, target });
        }
        for (const file of staged) await fs.promises.rename(file.temporary, file.target);
        this.state = draft;
        return result;
      } catch (error) {
        await Promise.all(staged.map(({ temporary }) => fs.promises.rm(temporary, { force: true })));
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}

function createId(prefix, rows) {
  const max = rows.reduce((highest, row) => {
    const value = Number(row.id.slice(prefix.length + 1));
    return Number.isFinite(value) ? Math.max(highest, value) : highest;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function cleanText(value, label, maximum = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new HttpError(400, `${label} is required and must be at most ${maximum} characters.`);
  }
  return value.trim();
}

function validDate(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `Enter a valid ${label}.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `Enter a valid ${label}.`);
  }
  if (value > new Date().toISOString().slice(0, 10)) throw new HttpError(400, `${label} cannot be in the future.`);
  return value;
}

function validateDonor(data, existing = {}) {
  const fullName = cleanText(data.fullName, 'Full name', 100);
  const age = Number(data.age);
  if (!Number.isInteger(age) || age < 18 || age > 65) throw new HttpError(400, 'Donor age must be between 18 and 65.');
  const gender = cleanText(data.gender, 'Gender', 30);
  if (!['Female', 'Male', 'Non-binary', 'Prefer not to say'].includes(gender)) throw new HttpError(400, 'Choose a valid gender.');
  const bloodGroup = cleanText(data.bloodGroup, 'Blood group', 3);
  if (!BLOOD_GROUPS.includes(bloodGroup)) throw new HttpError(400, 'Choose a valid blood group.');
  const phone = cleanText(data.phone, 'Phone number', 32);
  if (!/^\+?[0-9][0-9\s().-]{6,30}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number.');
  const email = cleanText(data.email, 'Email address', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const availabilityStatus = cleanText(data.availabilityStatus, 'Availability status', 30);
  if (!['Available', 'Unavailable', 'Temporarily unavailable'].includes(availabilityStatus)) {
    throw new HttpError(400, 'Choose a valid availability status.');
  }
  const pincode = cleanText(data.pincode, 'Pincode', 6);
  if (!/^\d{6}$/.test(pincode)) throw new HttpError(400, 'Pincode must contain six digits.');

  return {
    ...existing,
    fullName,
    age,
    gender,
    bloodGroup,
    phone,
    email,
    address: cleanText(data.address, 'Address', 160),
    city: cleanText(data.city, 'City', 80),
    state: cleanText(data.state, 'State', 80),
    pincode,
    lastDonationDate: validDate(data.lastDonationDate, 'last donation date', { optional: true }),
    availabilityStatus
  };
}

function validateDonation(data, donor) {
  const units = Number(data.units);
  if (!Number.isInteger(units) || units < 1 || units > 5) throw new HttpError(400, 'Donation units must be between 1 and 5.');
  const bloodGroup = cleanText(data.bloodGroup || donor.bloodGroup, 'Blood group', 3);
  if (!BLOOD_GROUPS.includes(bloodGroup) || bloodGroup !== donor.bloodGroup) {
    throw new HttpError(400, 'The donation blood group must match the donor profile.');
  }
  return {
    donorId: donor.id,
    donorName: donor.fullName,
    bloodGroup,
    units,
    donationDate: validDate(data.donationDate, 'donation date'),
    location: cleanText(data.location, 'Donation location', 120),
    remarks: typeof data.remarks === 'string' ? data.remarks.trim().slice(0, 500) : ''
  };
}

function validateRequest(data, existing = {}) {
  const bloodGroup = cleanText(data.bloodGroup, 'Blood group', 3);
  if (!BLOOD_GROUPS.includes(bloodGroup)) throw new HttpError(400, 'Choose a valid blood group.');
  const units = Number(data.units);
  if (!Number.isInteger(units) || units < 1 || units > 20) throw new HttpError(400, 'Units required must be between 1 and 20.');
  const contactNumber = cleanText(data.contactNumber, 'Contact number', 32);
  if (!/^\+?[0-9][0-9\s().-]{6,30}$/.test(contactNumber)) throw new HttpError(400, 'Enter a valid contact number.');
  const priority = cleanText(data.priority, 'Priority', 20);
  const status = cleanText(data.status, 'Request status', 20);
  if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'Choose a valid priority.');
  if (!REQUEST_STATUSES.includes(status)) throw new HttpError(400, 'Choose a valid request status.');
  return {
    ...existing,
    patientName: cleanText(data.patientName, 'Patient name', 100),
    hospitalName: cleanText(data.hospitalName, 'Hospital name', 120),
    bloodGroup,
    units,
    contactNumber,
    requestDate: validDate(data.requestDate, 'request date'),
    priority,
    status
  };
}

function stockStatus(units) {
  if (units <= 3) return 'Critical';
  if (units <= 9) return 'Low';
  return 'Available';
}

function createApp(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory || path.join(__dirname, 'data'));
  const publicDirectory = path.resolve(options.publicDirectory || path.join(__dirname, 'public'));
  const legacyDirectory = path.resolve(options.legacyDirectory || path.join(__dirname, '..'));
  const database = new JsonDatabase(dataDirectory, options.seedDirectory);
  const app = express();
  const server = http.createServer(app);
  const loginAttempts = new Map();
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const legacyStaticFiles = new Set(fs.readdirSync(legacyDirectory).filter((name) => {
    const extension = path.extname(name).toLowerCase();
    return name !== 'server.js'
      && fs.statSync(path.join(legacyDirectory, name)).isFile()
      && ['.html', '.css', '.js', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4'].includes(extension);
  }));

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin'
    });
    next();
  });
  app.use(express.json({ limit: '24kb', strict: true }));

  function getSession(req) {
    const token = (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('bbms_session='))
      ?.slice('bbms_session='.length);
    if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = database.read('sessions').find((session) => session.tokenHash === tokenHash);
    if (!record || record.expiresAt <= Date.now()) return null;
    return { ...record, tokenHash };
  }

  function requireAuth(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    req.session = session;
    next();
  }

  function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const supplied = req.get('x-csrf-token') || '';
    const expected = Buffer.from(req.session.csrfToken);
    const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return res.status(403).json({ error: 'This request could not be verified. Reload the page and try again.' });
    }
    next();
  }

  function rateLimit(key, req) {
    const id = `${key}:${req.ip}`;
    const now = Date.now();
    let attempt = loginAttempts.get(id);
    if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) {
      attempt = { startedAt: now, count: 0 };
      loginAttempts.set(id, attempt);
    }
    attempt.count += 1;
    if (attempt.count > 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    return () => loginAttempts.delete(id);
  }

  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.get('/api/auth/session', (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'You are not signed in.' });
    res.json({ user: session.user, csrfToken: session.csrfToken });
  });

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const clearAttempts = rateLimit('admin-login', req);
    const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const admin = database.read('admin').accounts.find((account) => account.username === username);
    const salt = admin ? Buffer.from(admin.passwordSalt, 'base64url') : crypto.randomBytes(16);
    const expected = admin ? Buffer.from(admin.passwordHash, 'base64url') : hashPassword(crypto.randomBytes(32).toString('hex'), salt);
    const actual = hashPassword(password, salt);
    if (!admin || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new HttpError(401, 'Incorrect username or password.');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const user = { username: admin.username, displayName: admin.displayName, role: 'Administrator' };
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await database.transact((state) => {
      state.sessions = state.sessions.filter((session) => session.expiresAt > Date.now());
      state.sessions.push({
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        csrfToken,
        expiresAt,
        user
      });
    });
    clearAttempts();
    res.cookie('bbms_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookies,
      path: '/',
      maxAge: SESSION_TTL_MS
    });
    res.json({ user, csrfToken });
  }));

  app.post('/api/auth/logout', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
    await database.transact((state) => {
      state.sessions = state.sessions.filter((session) => session.tokenHash !== req.session.tokenHash);
    });
    res.clearCookie('bbms_session', { httpOnly: true, sameSite: 'strict', secure: secureCookies, path: '/' });
    res.json({ ok: true });
  }));

  app.use('/api', requireAuth, requireCsrf);

  app.get('/api/dashboard', (req, res) => {
    const donors = database.read('donors');
    const donations = database.read('donations');
    const inventory = database.read('inventory');
    const requests = database.read('requests');
    const unitsAvailable = inventory.items.reduce((total, item) => total + item.availableUnits, 0);
    res.json({
      stats: {
        totalDonors: donors.length,
        totalDonations: donations.length,
        availableUnits: unitsAvailable,
        totalRequests: requests.length,
        pendingRequests: requests.filter((request) => request.status === 'Pending').length,
        completedRequests: requests.filter((request) => request.status === 'Completed').length
      },
      bloodGroups: inventory.items.map((item) => ({
        bloodGroup: item.bloodGroup,
        availableUnits: item.availableUnits,
        donorCount: donors.filter((donor) => donor.bloodGroup === item.bloodGroup).length
      })),
      recentDonors: donors.toSorted((a, b) => b.registrationDate.localeCompare(a.registrationDate)).slice(0, 5),
      recentRequests: requests.toSorted((a, b) => b.requestDate.localeCompare(a.requestDate)).slice(0, 5),
      lowStock: inventory.items.filter((item) => item.availableUnits <= 9).map((item) => item.bloodGroup)
    });
  });

  app.get('/api/donors', (req, res) => res.json(database.read('donors').toSorted((a, b) => b.registrationDate.localeCompare(a.registrationDate))));
  app.post('/api/donors', asyncRoute(async (req, res) => {
    const donor = validateDonor(req.body);
    const saved = await database.transact((state) => {
      if (state.donors.some((item) => item.email.toLowerCase() === donor.email)) throw new HttpError(409, 'A donor with this email already exists.');
      const record = { id: createId('DNR', state.donors), ...donor, registrationDate: new Date().toISOString().slice(0, 10) };
      state.donors.push(record);
      return record;
    });
    res.status(201).json(saved);
  }));
  app.patch('/api/donors/:id', asyncRoute(async (req, res) => {
    const updated = await database.transact((state) => {
      const index = state.donors.findIndex((donor) => donor.id === req.params.id);
      if (index < 0) throw new HttpError(404, 'Donor not found.');
      const donor = validateDonor({ ...state.donors[index], ...req.body }, state.donors[index]);
      if (state.donors.some((item, row) => row !== index && item.email.toLowerCase() === donor.email)) {
        throw new HttpError(409, 'A donor with this email already exists.');
      }
      if (state.donations.some((item) => item.donorId === donor.id) && donor.bloodGroup !== state.donors[index].bloodGroup) {
        throw new HttpError(409, 'Blood group cannot be changed after donation records exist.');
      }
      state.donors[index] = donor;
      for (const donation of state.donations.filter((item) => item.donorId === donor.id)) {
        donation.donorName = donor.fullName;
        donation.bloodGroup = donor.bloodGroup;
      }
      return donor;
    });
    res.json(updated);
  }));
  app.delete('/api/donors/:id', asyncRoute(async (req, res) => {
    await database.transact((state) => {
      if (!state.donors.some((donor) => donor.id === req.params.id)) throw new HttpError(404, 'Donor not found.');
      if (state.donations.some((donation) => donation.donorId === req.params.id)) {
        throw new HttpError(409, 'This donor has donation history. Keep the record and change availability instead.');
      }
      state.donors = state.donors.filter((donor) => donor.id !== req.params.id);
    });
    res.json({ ok: true });
  }));

  app.get('/api/donations', (req, res) => res.json(database.read('donations').toSorted((a, b) => b.donationDate.localeCompare(a.donationDate))));
  app.post('/api/donations', asyncRoute(async (req, res) => {
    const saved = await database.transact((state) => {
      const donor = state.donors.find((item) => item.id === req.body.donorId);
      if (!donor) throw new HttpError(404, 'Select an existing donor to record a donation.');
      const donation = { id: createId('DON', state.donations), ...validateDonation(req.body, donor) };
      const stock = state.inventory.items.find((item) => item.bloodGroup === donation.bloodGroup);
      stock.availableUnits += donation.units;
      stock.totalDonations += donation.units;
      state.inventory.history.push({
        id: createId('STK', state.inventory.history),
        bloodGroup: stock.bloodGroup,
        change: donation.units,
        kind: 'donation',
        date: donation.donationDate,
        note: `Donation ${donation.id} recorded`
      });
      donor.lastDonationDate = [donor.lastDonationDate, donation.donationDate].filter(Boolean).toSorted().at(-1);
      state.donations.push(donation);
      return donation;
    });
    res.status(201).json(saved);
  }));
  app.patch('/api/donations/:id', asyncRoute(async (req, res) => {
    const updated = await database.transact((state) => {
      const index = state.donations.findIndex((donation) => donation.id === req.params.id);
      if (index < 0) throw new HttpError(404, 'Donation record not found.');
      const previous = state.donations[index];
      const donor = state.donors.find((item) => item.id === (req.body.donorId || previous.donorId));
      if (!donor) throw new HttpError(404, 'Select an existing donor to update this donation.');
      const input = { ...previous, ...req.body };
      if (req.body.donorId && !req.body.bloodGroup) input.bloodGroup = donor.bloodGroup;
      const next = { id: previous.id, ...validateDonation(input, donor) };
      const oldStock = state.inventory.items.find((item) => item.bloodGroup === previous.bloodGroup);
      const newStock = state.inventory.items.find((item) => item.bloodGroup === next.bloodGroup);
      if (oldStock !== newStock && oldStock.availableUnits < previous.units) throw new HttpError(409, 'The old blood group stock has already been issued; this donation cannot be moved.');
      if (oldStock === newStock && oldStock.availableUnits - previous.units + next.units < 0) {
        throw new HttpError(409, 'There is not enough stock to apply this donation edit.');
      }
      oldStock.availableUnits -= previous.units;
      oldStock.totalDonations -= previous.units;
      newStock.availableUnits += next.units;
      newStock.totalDonations += next.units;
      if (oldStock !== newStock) {
        state.inventory.history.push({
          id: createId('STK', state.inventory.history),
          bloodGroup: oldStock.bloodGroup,
          change: -previous.units,
          kind: 'adjustment',
          date: next.donationDate,
          note: `Donation ${next.id} moved out`
        });
        state.inventory.history.push({
          id: createId('STK', state.inventory.history),
          bloodGroup: newStock.bloodGroup,
          change: next.units,
          kind: 'adjustment',
          date: next.donationDate,
          note: `Donation ${next.id} moved in`
        });
      } else if (next.units !== previous.units) {
        state.inventory.history.push({
          id: createId('STK', state.inventory.history),
          bloodGroup: next.bloodGroup,
          change: next.units - previous.units,
          kind: 'adjustment',
          date: next.donationDate,
          note: `Donation ${next.id} updated`
        });
      }
      state.donations[index] = next;
      for (const record of state.donors) {
        const latest = state.donations.filter((item) => item.donorId === record.id)
          .map((item) => item.donationDate).toSorted().at(-1) || '';
        record.lastDonationDate = latest;
      }
      return next;
    });
    res.json(updated);
  }));
  app.delete('/api/donations/:id', asyncRoute(async (req, res) => {
    await database.transact((state) => {
      const index = state.donations.findIndex((donation) => donation.id === req.params.id);
      if (index < 0) throw new HttpError(404, 'Donation record not found.');
      const donation = state.donations[index];
      const stock = state.inventory.items.find((item) => item.bloodGroup === donation.bloodGroup);
      if (stock.availableUnits < donation.units) throw new HttpError(409, 'Some of this donation stock has been issued; the record cannot be deleted.');
      stock.availableUnits -= donation.units;
      stock.totalDonations -= donation.units;
      state.donations.splice(index, 1);
      state.inventory.history.push({
        id: createId('STK', state.inventory.history),
        bloodGroup: stock.bloodGroup,
        change: -donation.units,
        kind: 'adjustment',
        date: new Date().toISOString().slice(0, 10),
        note: `Donation ${donation.id} deleted`
      });
      const donor = state.donors.find((item) => item.id === donation.donorId);
      if (donor) donor.lastDonationDate = state.donations.filter((item) => item.donorId === donor.id).map((item) => item.donationDate).toSorted().at(-1) || '';
    });
    res.json({ ok: true });
  }));

  app.get('/api/inventory', (req, res) => {
    const inventory = database.read('inventory');
    res.json({
      items: inventory.items.map((item) => ({ ...item, stockStatus: stockStatus(item.availableUnits) })),
      history: inventory.history.toSorted((a, b) => b.date.localeCompare(a.date)).slice(0, 100)
    });
  });
  app.post('/api/inventory/:bloodGroup/adjust', asyncRoute(async (req, res) => {
    const { bloodGroup } = req.params;
    const units = Number(req.body.units);
    const kind = req.body.kind;
    const note = cleanText(req.body.note, 'Adjustment note', 160);
    if (!BLOOD_GROUPS.includes(bloodGroup)) throw new HttpError(400, 'Choose a valid blood group.');
    if (!Number.isInteger(units) || units < 1 || units > 100) throw new HttpError(400, 'Units must be between 1 and 100.');
    if (!['add', 'issue'].includes(kind)) throw new HttpError(400, 'Choose add stock or issue stock.');
    const item = await database.transact((state) => {
      const stock = state.inventory.items.find((row) => row.bloodGroup === bloodGroup);
      if (kind === 'issue' && stock.availableUnits < units) {
        throw new HttpError(409, `Only ${stock.availableUnits} units of ${bloodGroup} are available.`);
      }
      stock.availableUnits += kind === 'add' ? units : -units;
      if (kind === 'issue') stock.totalUnitsIssued += units;
      state.inventory.history.push({
        id: createId('STK', state.inventory.history),
        bloodGroup,
        change: units,
        kind,
        date: new Date().toISOString().slice(0, 10),
        note
      });
      return { ...stock, stockStatus: stockStatus(stock.availableUnits) };
    });
    res.json(item);
  }));

  app.get('/api/requests', (req, res) => res.json(database.read('requests').toSorted((a, b) => b.requestDate.localeCompare(a.requestDate))));
  app.post('/api/requests', asyncRoute(async (req, res) => {
    const saved = await database.transact((state) => {
      const request = validateRequest({ status: 'Pending', ...req.body });
      request.id = createId('REQ', state.requests);
      state.requests.push(request);
      return request;
    });
    res.status(201).json(saved);
  }));
  app.patch('/api/requests/:id', asyncRoute(async (req, res) => {
    const updated = await database.transact((state) => {
      const index = state.requests.findIndex((item) => item.id === req.params.id);
      if (index < 0) throw new HttpError(404, 'Blood request not found.');
      const previous = state.requests[index];
      if (previous.status === 'Completed') throw new HttpError(409, 'A completed request is locked because its blood units were issued.');
      const next = validateRequest({ ...previous, ...req.body }, previous);
      if (next.status === 'Completed') {
        const stock = state.inventory.items.find((item) => item.bloodGroup === next.bloodGroup);
        if (stock.availableUnits < next.units) {
          throw new HttpError(409, `Cannot fulfill this request: only ${stock.availableUnits} ${next.bloodGroup} units are available.`);
        }
        stock.availableUnits -= next.units;
        stock.totalUnitsIssued += next.units;
        state.inventory.history.push({
          id: createId('STK', state.inventory.history),
          bloodGroup: next.bloodGroup,
          change: next.units,
          kind: 'issue',
          date: new Date().toISOString().slice(0, 10),
          note: `Request ${next.id} fulfilled`
        });
      }
      state.requests[index] = next;
      return next;
    });
    res.json(updated);
  }));
  app.delete('/api/requests/:id', asyncRoute(async (req, res) => {
    await database.transact((state) => {
      const request = state.requests.find((item) => item.id === req.params.id);
      if (!request) throw new HttpError(404, 'Blood request not found.');
      if (request.status === 'Completed') throw new HttpError(409, 'Completed requests are retained in the audit history.');
      state.requests = state.requests.filter((item) => item.id !== req.params.id);
    });
    res.json({ ok: true });
  }));

  app.get('/api/export/:type', (req, res) => {
    const { type } = req.params;
    if (!['donors', 'donations', 'requests'].includes(type)) throw new HttpError(404, 'CSV export is not available for this record type.');
    const rows = database.read(type);
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = [columns.map(escape).join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\r\n');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${type}-demo.csv"`,
      'Cache-Control': 'no-store'
    }).send(csv);
  });

  app.get('/', (req, res) => res.redirect(getSession(req) ? '/Index.html' : '/login.html'));
  app.get('/Login.html', (req, res, next) => {
    if (req.path === '/Login.html') return res.redirect('/login.html');
    next();
  });
  app.get('/admin', (req, res) => res.redirect(getSession(req) ? '/dashboard.html' : '/login.html'));
  app.get('/admin/*', (req, res) => res.redirect(getSession(req) ? '/dashboard.html' : '/login.html'));
  app.use((req, res, next) => {
    if (/\.html$/i.test(req.path) && req.path.toLowerCase() !== '/login.html' && !getSession(req)) {
      return res.redirect('/login.html');
    }
    next();
  });
  app.use(express.static(publicDirectory, { index: false, fallthrough: true }));
  app.use((req, res, next) => {
    const requestedFile = decodeURIComponent(req.path.slice(1));
    if (!legacyStaticFiles.has(requestedFile)) return next();
    return express.static(legacyDirectory, { index: false, fallthrough: true })(req, res, next);
  });
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
    res.status(404).sendFile(path.join(publicDirectory, '404.html'), (error) => {
      if (error && !res.headersSent) res.status(404).send('Page not found.');
    });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    console.error('Management API error:', error);
    return res.status(500).json({ error: 'An unexpected server error occurred.' });
  });

  return { app, server, database };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const { server } = createApp();
  server.listen(port, () => {
    console.log(`Blood Bank Management System is running at http://localhost:${port}`);
    console.log('Demo data only. Login username: admin | password: admin123');
  });
}

module.exports = { createApp, BLOOD_GROUPS, stockStatus };
