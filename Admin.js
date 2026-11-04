'use strict';

const authPanel = document.querySelector('#admin-auth-panel');
const setupForm = document.querySelector('#admin-setup-form');
const loginForm = document.querySelector('#admin-login-form');
const accountForm = document.querySelector('#admin-create-form');
const accountPanel = document.querySelector('#admin-create-panel');
const profile = document.querySelector('#signed-in-profile');
const statusMessage = document.querySelector('#admin-status');
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
      password: data.get('password')
    }
  });
  csrfToken = result.csrfToken;
  displayProfile(result.user);
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
      password: data.get('password')
    }
  });
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
