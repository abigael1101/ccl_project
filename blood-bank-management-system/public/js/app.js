'use strict';

(() => {
  const navItems = [
    { key: 'dashboard', label: 'Dashboard', href: '/dashboard.html', icon: 'fa-table-columns' },
    { key: 'donors', label: 'Donor management', href: '/donors.html', icon: 'fa-users' },
    { key: 'add-donor', label: 'Add donor', href: '/add-donor.html', icon: 'fa-user-plus' },
    { key: 'donations', label: 'Donation records', href: '/donations.html', icon: 'fa-hand-holding-droplet' },
    { key: 'inventory', label: 'Blood inventory', href: '/inventory.html', icon: 'fa-boxes-stacked' },
    { key: 'requests', label: 'Blood requests', href: '/requests.html', icon: 'fa-file-medical' }
  ];
  const root = document.querySelector('#application');
  const content = document.querySelector('#app-content');
  const page = content.dataset.page;
  const pageNames = {
    dashboard: ['Dashboard', 'Overview of blood bank activity and available stock.'],
    donors: ['Donor management', 'Find, review and manage your registered donor records.'],
    'add-donor': ['Add donor', 'Register a donor in the demonstration database.'],
    donations: ['Donation records', 'Record donations and review collection history.'],
    inventory: ['Blood inventory', 'Monitor blood stock and record stock movements.'],
    requests: ['Blood requests', 'Review requests and fulfill them against available stock.']
  };
  const [title] = pageNames[page] || pageNames.dashboard;
  const contentMarkup = content.innerHTML;
  const activeKey = page === 'add-donor' ? 'donors' : page;

  root.innerHTML = `
    <aside id="sidebar" class="sidebar">
      <a class="brand" href="/Index.html">
        <span class="brand-icon"><i class="fa-solid fa-droplet"></i></span>
        <span><span class="brand-name">REDLINE</span><span class="brand-caption">Blood bank admin</span></span>
      </a>
      <div class="nav-caption">Workspace</div>
      <nav class="sidebar-nav" aria-label="Main navigation">
        ${navItems.map((item) => `<a class="nav-link ${item.key === activeKey ? 'active' : ''}" href="${item.href}" ${item.key === activeKey ? 'aria-current="page"' : ''}><i class="fa-solid ${item.icon}"></i><span>${item.label}</span></a>`).join('')}
      </nav>
      <div class="sidebar-bottom">
        <div class="demo-note"><strong><i class="fa-solid fa-flask"></i> Demo environment</strong>All records are fictional and stored locally in JSON files.</div>
        <div class="sidebar-user"><span class="avatar" data-avatar>A</span><span><span class="sidebar-user-name" data-admin-name>Administrator</span><span class="sidebar-user-role">System administrator</span></span></div>
      </div>
    </aside>
    <section class="main-panel">
      <header class="topbar">
        <div class="topbar-left">
          <button id="mobile-menu" class="icon-button mobile-menu" type="button" aria-label="Open navigation"><i class="fa-solid fa-bars"></i></button>
          <div><div class="page-label">${title}</div><div class="topbar-date" id="current-date"></div></div>
        </div>
        <div class="topbar-actions">
          <a class="icon-button" href="/requests.html" aria-label="View blood requests"><i class="fa-regular fa-bell"></i></a>
          <div class="topbar-user"><span class="avatar" data-avatar>A</span><span class="topbar-user-copy"><strong data-admin-name>Administrator</strong><span>Admin</span></span></div>
          <button id="logout-button" class="icon-button" type="button" aria-label="Sign out"><i class="fa-solid fa-arrow-right-from-bracket"></i></button>
        </div>
      </header>
      <main class="content-area" id="page-content">
        ${contentMarkup}
      </main>
    </section>
    <div id="toast-region" class="toast-region" aria-live="polite"></div>
    <dialog id="record-dialog" class="modal"><div class="modal-header"><h2 id="dialog-title"></h2><button class="action-icon" id="dialog-close" type="button" aria-label="Close dialog"><i class="fa-solid fa-xmark"></i></button></div><div id="dialog-body" class="modal-body"></div></dialog>
  `;

  const date = document.querySelector('#current-date');
  date.textContent = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
  document.querySelector('#mobile-menu').addEventListener('click', () => document.querySelector('#sidebar').classList.toggle('open'));
  document.querySelector('#dialog-close').addEventListener('click', () => document.querySelector('#record-dialog').close());

  function toast(message, type = 'success') {
    const region = document.querySelector('#toast-region');
    const item = document.createElement('div');
    item.className = `toast ${type === 'error' ? 'error' : ''}`;
    item.innerHTML = `<i class="fa-solid ${type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i><span></span>`;
    item.querySelector('span').textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 4000);
  }

  async function api(url, options = {}) {
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = window.BBMS.csrfToken;
    const response = await fetch(url, {
      ...options,
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined || typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    });
    if (response.status === 401) {
      window.location.replace('/login.html');
      throw new Error('Your session expired. Sign in again.');
    }
    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    return result;
  }

  function dialog(titleText, bodyMarkup, onSubmit) {
    const modal = document.querySelector('#record-dialog');
    document.querySelector('#dialog-title').textContent = titleText;
    const body = document.querySelector('#dialog-body');
    body.innerHTML = bodyMarkup;
    if (onSubmit) {
      body.querySelector('form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = event.currentTarget.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
          await onSubmit(new FormData(event.currentTarget));
          modal.close();
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          submit.disabled = false;
        }
      });
    }
    modal.showModal();
  }

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  const helpers = {
    csrfToken: '',
    api,
    toast,
    dialog,
    escape,
    dateToday: () => new Date().toISOString().slice(0, 10),
    formatDate: (value) => value ? new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : '—',
    statusClass: (status) => String(status || '').toLowerCase().replaceAll(' ', '-'),
    csvLink: (type) => `/api/export/${type}`,
    confirmDelete: (label) => window.confirm(`Delete ${label}? This action cannot be undone.`)
  };
  window.BBMS = helpers;

  document.querySelector('#logout-button').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
      window.location.replace('/login.html');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  api('/api/auth/session').then((session) => {
    helpers.csrfToken = session.csrfToken;
    const name = session.user.displayName || session.user.username;
    document.querySelectorAll('[data-admin-name]').forEach((element) => { element.textContent = name; });
    document.querySelectorAll('[data-avatar]').forEach((element) => { element.textContent = name.slice(0, 1).toUpperCase(); });
    document.dispatchEvent(new CustomEvent('bbms:ready', { detail: { page } }));
  }).catch((error) => {
    if (!error.message.includes('session expired')) toast(error.message, 'error');
  });
})();
