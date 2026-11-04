'use strict';

const form = document.querySelector('#login-form');
const errorMessage = document.querySelector('#login-error');
const submitButton = document.querySelector('#login-submit');
const passwordInput = document.querySelector('#password');
const passwordToggle = document.querySelector('#password-toggle');

passwordToggle.addEventListener('click', () => {
  const showing = passwordInput.type === 'text';
  passwordInput.type = showing ? 'password' : 'text';
  passwordToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  passwordToggle.innerHTML = `<i class="fa-regular ${showing ? 'fa-eye' : 'fa-eye-slash'}"></i>`;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.hidden = true;
  submitButton.disabled = true;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
    window.location.assign('/Index.html');
  } catch (error) {
    errorMessage.textContent = error.message || 'The login service is unavailable. Start the project server and try again.';
    errorMessage.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});
