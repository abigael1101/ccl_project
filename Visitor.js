'use strict';

async function addVisitorNavigation() {
  const navigation = document.querySelector('.navbar-nav, .nav');
  if (!navigation) return;

  try {
    const response = await fetch('/api/visitor-session', { credentials: 'same-origin' });
    if (response.status === 401) {
      window.location.replace('/Login.html');
      return;
    }
    if (!response.ok) throw new Error('Unable to verify your sign-in.');

    const { user, csrfToken } = await response.json();
    const item = document.createElement('li');
    item.className = 'nav-item visitor-session-nav';

    const welcome = document.createElement('span');
    welcome.className = 'nav-link visitor-session-name';
    welcome.textContent = `Signed in: ${user.displayName}`;
    item.append(welcome);

    const logout = document.createElement('button');
    logout.className = 'nav-link visitor-logout';
    logout.type = 'button';
    logout.textContent = 'Sign out';
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      try {
        const logoutResponse = await fetch('/api/visitor-logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-CSRF-Token': csrfToken }
        });
        if (!logoutResponse.ok) {
          const result = await logoutResponse.json();
          throw new Error(result.error || 'Unable to sign out.');
        }
        window.location.assign('/Login.html');
      } catch (error) {
        logout.disabled = false;
        window.alert(error.message);
      }
    });
    item.append(logout);
    navigation.append(item);
  } catch (error) {
    console.error('Visitor session check failed:', error);
  }
}

addVisitorNavigation();
