'use strict';

const loginForm = document.querySelector('#visitor-login-form');
const registerForm = document.querySelector('#visitor-register-form');
const statusMessage = document.querySelector('#login-status');
const showRegisterButton = document.querySelector('#show-register');
const showLoginButton = document.querySelector('#show-login');
const signupPrompt = document.querySelector('#signup-prompt');

function showStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle('admin-status-error', isError);
  statusMessage.hidden = false;
}

function setMode(mode) {
  const isRegister = mode === 'register';
  loginForm.hidden = isRegister;
  registerForm.hidden = !isRegister;
  showRegisterButton.hidden = isRegister;
  showLoginButton.hidden = !isRegister;
  signupPrompt.hidden = isRegister;
  statusMessage.hidden = true;
  document.querySelector('#login-title').textContent = isRegister ? 'Create your account' : 'Sign in to continue';
}

async function submitForm(form, endpoint) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  statusMessage.hidden = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to continue.');
    window.location.assign('/Index.html');
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

showRegisterButton.addEventListener('click', () => setMode('register'));
showLoginButton.addEventListener('click', () => setMode('login'));
loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitForm(loginForm, '/api/visitor-login');
});
registerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitForm(registerForm, '/api/register');
});

fetch('/api/visitor-session', { credentials: 'same-origin' })
  .then((response) => {
    if (response.ok) window.location.replace('/Index.html');
  })
  .catch(() => showStatus('Could not check your session. Please retry.', true));
