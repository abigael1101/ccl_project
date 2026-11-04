'use strict';

const authPanel = document.querySelector('#admin-auth-panel');
const setupForm = document.querySelector('#admin-setup-form');
const loginForm = document.querySelector('#admin-login-form');
const accountForm = document.querySelector('#admin-create-form');
const accountPanel = document.querySelector('#admin-create-panel');
const profile = document.querySelector('#signed-in-profile');
const statusMessage = document.querySelector('#admin-status');
const directory = document.querySelector('#admin-directory');
const directoryStatus = document.querySelector('#admin-directory-status');
let csrfToken = '';

function showStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle('admin-status-error', isError);
  statusMessage.hidden = false;
}

function displayProfile(user) {
  authPanel.hidden = true;
  profile.hidden = false;
  accountPanel.hidden = false;
  document.querySelector('#profile-name').textContent = user.displayName;
  document.querySelector('#profile-username').textContent = `@${user.username}`;
  document.querySelector('#profile-role').textContent = user.role;
  document.querySelector('#profile-email').textContent = user.email;
  document.querySelector('#profile-phone').textContent = user.phone;
}

function renderAdminDirectory(admins) {
  directory.replaceChildren();
  for (const admin of admins) {
    const card = document.createElement('article');
    card.className = 'admin-directory-card';

    const title = document.createElement('h3');
    title.textContent = admin.displayName;
    card.append(title);

    const username = document.createElement('p');
    username.textContent = `@${admin.username}`;
    card.append(username);

    if (admin.email) {
      const email = document.createElement('a');
      email.href = `mailto:${admin.email}`;
      email.textContent = admin.email;
      card.append(email);
    } else {
      const email = document.createElement('p');
      email.textContent = 'Email not provided';
      card.append(email);
    }

    if (admin.phone) {
      const phone = document.createElement('a');
      phone.href = `tel:${admin.phone.replace(/[^\d+]/g, '')}`;
      phone.textContent = admin.phone;
      card.append(phone);
    } else {
      const phone = document.createElement('p');
      phone.textContent = 'Phone not provided';
      card.append(phone);
    }

    directory.append(card);
  }
  directoryStatus.hidden = admins.length > 0;
  if (admins.length === 0) directoryStatus.textContent = 'No administrator profiles have been created yet.';
}

async function refreshAdminDirectory() {
  const result = await apiRequest('/api/admin-profiles');
  renderAdminDirectory(result.admins);
}

async function apiRequest(url, { method = 'GET', body, csrf = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = csrfToken;

  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 204) return null;
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The login service is unavailable. Start the Node server to use admin accounts.');
  }
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

function handleForm(form, callback) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    statusMessage.hidden = true;
    try {
      await callback(new FormData(form));
      form.reset();
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      submitButton.disabled = false;
    }
  });
}

handleForm(setupForm, async (data) => {
  const result = await apiRequest('/api/setup', {
    method: 'POST',
    body: {
      setupToken: data.get('setupToken'),
      displayName: data.get('displayName'),
      username: data.get('username'),
      email: data.get('email'),
      phone: data.get('phone'),
      password: data.get('password')
    }
  });
  csrfToken = result.csrfToken;
  displayProfile(result.user);
  await refreshAdminDirectory();
  showStatus('Initial administrator account created.');
});

handleForm(loginForm, async (data) => {
  const result = await apiRequest('/api/login', {
    method: 'POST',
    body: { username: data.get('username'), password: data.get('password') }
  });
  csrfToken = result.csrfToken;
  displayProfile(result.user);
  showStatus('Signed in.');
});

handleForm(accountForm, async (data) => {
  const result = await apiRequest('/api/admins', {
    method: 'POST',
    csrf: true,
    body: {
      displayName: data.get('displayName'),
      username: data.get('username'),
      email: data.get('email'),
      phone: data.get('phone'),
      password: data.get('password')
    }
  });
  await refreshAdminDirectory();
  showStatus(`Administrator account created for ${result.user.displayName}.`);
});

document.querySelector('#admin-logout').addEventListener('click', async () => {
  try {
    await apiRequest('/api/logout', { method: 'POST', csrf: true });
    csrfToken = '';
    profile.hidden = true;
    accountPanel.hidden = true;
    authPanel.hidden = false;
    loginForm.hidden = false;
    setupForm.hidden = true;
    showStatus('You have signed out.');
  } catch (error) {
    showStatus(error.message, true);
  }
});

async function initializeAdminProfile() {
  try {
    await refreshAdminDirectory();
  } catch (error) {
    directory.replaceChildren();
    directoryStatus.textContent = `Admin profiles could not be loaded: ${error.message}`;
    directoryStatus.hidden = false;
  }

  try {
    const result = await apiRequest('/api/session');
    csrfToken = result.csrfToken;
    displayProfile(result.user);
    return;
  } catch (error) {
    if (!error.message.includes('not signed in')) {
      showStatus(error.message, true);
      return;
    }
  }

  try {
    const result = await apiRequest('/api/setup-state');
    accountPanel.hidden = true;
    setupForm.hidden = !result.setupRequired;
    loginForm.hidden = result.setupRequired;
    document.querySelector('#setup-help').hidden = !result.setupRequired;
  } catch (error) {
    showStatus(`Login service unavailable: ${error.message}`, true);
    accountPanel.hidden = true;
    loginForm.hidden = true;
  }
}

initializeAdminProfile();
