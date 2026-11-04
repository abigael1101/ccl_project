'use strict';

async function getSession(endpoint) {
  const response = await fetch(endpoint, { credentials: 'same-origin' });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error('Unable to verify your sign-in.');
  return response.json();
}

async function addVisitorNavigation() {
  const navigation = document.querySelector('.navbar-nav, .nav');
  if (!navigation) return;

  try {
    let session = await getSession('/api/auth/session');
    let logoutEndpoint = '/api/auth/logout';
    let isAdmin = Boolean(session);

    if (!session) {
      session = await getSession('/api/session');
      logoutEndpoint = '/api/logout';
      isAdmin = Boolean(session);
    }

    if (!session) {
      session = await getSession('/api/visitor-session');
      logoutEndpoint = '/api/visitor-logout';
    }

    if (!session) {
      window.location.replace('/login.html');
      return;
    }

    const { user, csrfToken } = session;
    if (isAdmin) {
      document.querySelectorAll('a[href]').forEach((link) => {
        if (link.getAttribute('href')?.toLowerCase() === 'admin.html') {
          link.href = '/dashboard.html';
          link.textContent = 'Admin Dashboard';
        }
      });

      if (!navigation.querySelector('a[href="/dashboard.html"]')) {
        const dashboard = document.createElement('li');
        dashboard.className = 'nav-item';
        const dashboardLink = document.createElement('a');
        dashboardLink.className = 'nav-link';
        dashboardLink.href = '/dashboard.html';
        dashboardLink.textContent = 'Admin Dashboard';
        dashboard.append(dashboardLink);
        navigation.append(dashboard);
      }
    }

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
        const logoutResponse = await fetch(logoutEndpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
          },
          body: ['api/logout', 'api/auth/logout'].some((path) => logoutEndpoint.endsWith(path)) ? '{}' : undefined
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
