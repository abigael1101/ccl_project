'use strict';

document.addEventListener('bbms:ready', async ({ detail }) => {
  const { api, dialog, escape, formatDate, toast, confirmDelete } = window.BBMS;
  const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  const availabilityOptions = ['Available', 'Unavailable', 'Temporarily unavailable'];

  function donorFields(donor = {}) {
    const groups = bloodGroups.map((group) => `<option ${donor.bloodGroup === group ? 'selected' : ''}>${group}</option>`).join('');
    const genders = ['Female', 'Male', 'Non-binary', 'Prefer not to say'].map((gender) => `<option ${donor.gender === gender ? 'selected' : ''}>${gender}</option>`).join('');
    const availability = availabilityOptions.map((status) => `<option ${donor.availabilityStatus === status ? 'selected' : ''}>${status}</option>`).join('');
    const field = (label, name, value, type = 'text', required = true, attrs = '') => `
      <div class="form-field"><label>${label}${required ? ' *' : ''}</label><input class="field" name="${name}" type="${type}" value="${escape(value || '')}" ${required ? 'required' : ''} ${attrs}></div>`;
    return `
      <div class="form-grid">
        ${field('Full name', 'fullName', donor.fullName, 'text', true, 'maxlength="100"')}
        ${field('Age', 'age', donor.age, 'number', true, 'min="18" max="65"')}
        <div class="form-field"><label>Gender *</label><select class="select" name="gender" required><option value="">Select gender</option>${genders}</select></div>
        <div class="form-field"><label>Blood group *</label><select class="select" name="bloodGroup" required><option value="">Select blood group</option>${groups}</select></div>
        ${field('Phone number', 'phone', donor.phone, 'tel', true, 'maxlength="32"')}
        ${field('Email address', 'email', donor.email, 'email', true, 'maxlength="254"')}
        ${field('Address', 'address', donor.address, 'text', true, 'maxlength="160"')}
        ${field('City', 'city', donor.city, 'text', true, 'maxlength="80"')}
        ${field('State', 'state', donor.state, 'text', true, 'maxlength="80"')}
        ${field('Pincode', 'pincode', donor.pincode, 'text', true, 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"')}
        ${field('Last donation date', 'lastDonationDate', donor.lastDonationDate, 'date', false)}
        <div class="form-field"><label>Availability *</label><select class="select" name="availabilityStatus" required>${availability}</select></div>
      </div>
      <div class="form-footer"><button class="button secondary" type="button" data-cancel>Cancel</button><button class="button" type="submit">Save donor</button></div>`;
  }

  if (detail.page === 'add-donor') {
    const form = document.querySelector('#add-donor-form');
    form.lastDonationDate.max = window.BBMS.dateToday();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const donor = await api('/api/donors', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
        toast(`Donor ${donor.id} registered successfully.`);
        form.reset();
        window.setTimeout(() => { window.location.assign('/donors.html'); }, 650);
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
    return;
  }

  if (detail.page !== 'donors') return;

  const pageSize = 8;
  let donors = [];
  let currentPage = 1;
  let sortKey = 'registrationDate';
  let sortDirection = 'desc';
  const search = document.querySelector('#donor-search');
  const bloodFilter = document.querySelector('#blood-filter');
  const cityFilter = document.querySelector('#city-filter');
  const availabilityFilter = document.querySelector('#availability-filter');
  const table = document.querySelector('#donor-table');
  const pagination = document.querySelector('#donor-pagination');
  const count = document.querySelector('#donor-count');

  function updateFilters() {
    const selectedCity = cityFilter.value;
    cityFilter.innerHTML = '<option value="">All cities</option>' + [...new Set(donors.map((donor) => donor.city))].sort().map((city) => `<option value="${escape(city)}">${escape(city)}</option>`).join('');
    cityFilter.value = selectedCity;
  }

  function detailDialog(donor) {
    const fields = [
      ['Donor ID', donor.id], ['Full name', donor.fullName], ['Age', donor.age], ['Gender', donor.gender],
      ['Blood group', donor.bloodGroup], ['Phone', donor.phone], ['Email', donor.email], ['Address', `${donor.address}, ${donor.city}, ${donor.state} ${donor.pincode}`],
      ['Last donation', donor.lastDonationDate ? formatDate(donor.lastDonationDate) : 'Not recorded'], ['Availability', donor.availabilityStatus], ['Registered', formatDate(donor.registrationDate)]
    ];
    dialog(`Donor profile · ${donor.id}`, `<div class="modal-detail">${fields.map(([label, value]) => `<div class="modal-detail-item"><span>${label}</span><strong>${escape(value)}</strong></div>`).join('')}</div>`);
  }

  function editDialog(donor) {
    dialog(`Edit donor · ${donor.id}`, `<form id="edit-donor-form">${donorFields(donor)}</form>`, async (formData) => {
      await api(`/api/donors/${encodeURIComponent(donor.id)}`, { method: 'PATCH', body: Object.fromEntries(formData) });
      toast('Donor information updated.');
      await loadDonors();
    });
    document.querySelector('[data-cancel]').addEventListener('click', () => document.querySelector('#record-dialog').close());
    document.querySelector('input[name="lastDonationDate"]').max = window.BBMS.dateToday();
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const filtered = donors.filter((donor) => {
      const matchesSearch = `${donor.fullName} ${donor.id}`.toLowerCase().includes(query);
      return matchesSearch
        && (!bloodFilter.value || donor.bloodGroup === bloodFilter.value)
        && (!cityFilter.value || donor.city === cityFilter.value)
        && (!availabilityFilter.value || donor.availabilityStatus === availabilityFilter.value);
    }).sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey])) * (sortDirection === 'asc' ? 1 : -1));
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    currentPage = Math.min(currentPage, pageCount);
    const shown = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    count.textContent = `${filtered.length} donor${filtered.length === 1 ? '' : 's'} found`;
    table.innerHTML = shown.length ? `<table class="data-table">
      <thead><tr><th data-sort="id">Donor ID</th><th data-sort="fullName">Donor name</th><th data-sort="bloodGroup">Blood group</th><th data-sort="age">Age</th><th>Phone number</th><th data-sort="city">City</th><th data-sort="lastDonationDate">Last donation</th><th data-sort="availabilityStatus">Availability</th><th>Actions</th></tr></thead>
      <tbody>${shown.map((donor) => `<tr>
        <td><span class="table-primary">${escape(donor.id)}</span></td>
        <td><span class="table-primary">${escape(donor.fullName)}</span><span class="table-muted">${escape(donor.email)}</span></td>
        <td><span class="blood-badge" style="display:inline-grid;width:30px;height:30px">${escape(donor.bloodGroup)}</span></td>
        <td>${donor.age}</td><td>${escape(donor.phone)}</td><td>${escape(donor.city)}</td>
        <td>${donor.lastDonationDate ? formatDate(donor.lastDonationDate) : '—'}</td>
        <td><span class="status ${donor.availabilityStatus === 'Available' ? 'available' : 'unavailable'}">${escape(donor.availabilityStatus)}</span></td>
        <td><div class="table-actions"><button class="action-icon" data-action="view" data-id="${escape(donor.id)}" aria-label="View donor"><i class="fa-regular fa-eye"></i></button><button class="action-icon" data-action="edit" data-id="${escape(donor.id)}" aria-label="Edit donor"><i class="fa-regular fa-pen-to-square"></i></button><button class="action-icon delete" data-action="delete" data-id="${escape(donor.id)}" aria-label="Delete donor"><i class="fa-regular fa-trash-can"></i></button></div></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty-state"><i class="fa-solid fa-users"></i>No donors match these filters.</div>';
    pagination.innerHTML = `<span>Showing ${filtered.length ? (currentPage - 1) * pageSize + 1 : 0}–${Math.min(currentPage * pageSize, filtered.length)} of ${filtered.length}</span><span class="button-row"><button class="button secondary small" data-page="-1" ${currentPage === 1 ? 'disabled' : ''}>Previous</button><span>Page ${currentPage} of ${pageCount}</span><button class="button secondary small" data-page="1" ${currentPage === pageCount ? 'disabled' : ''}>Next</button></span>`;
  }

  async function loadDonors() {
    donors = await api('/api/donors');
    updateFilters();
    render();
  }

  [search, bloodFilter, cityFilter, availabilityFilter].forEach((input) => input.addEventListener('input', () => { currentPage = 1; render(); }));
  table.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]');
    if (action) {
      const donor = donors.find((item) => item.id === action.dataset.id);
      if (!donor) return;
      if (action.dataset.action === 'view') detailDialog(donor);
      if (action.dataset.action === 'edit') editDialog(donor);
      if (action.dataset.action === 'delete' && confirmDelete(`donor ${donor.fullName}`)) {
        try {
          await api(`/api/donors/${encodeURIComponent(donor.id)}`, { method: 'DELETE', body: {} });
          toast('Donor record deleted.');
          await loadDonors();
        } catch (error) { toast(error.message, 'error'); }
      }
    }
    const sort = event.target.closest('[data-sort]');
    if (sort) {
      sortDirection = sortKey === sort.dataset.sort && sortDirection === 'asc' ? 'desc' : 'asc';
      sortKey = sort.dataset.sort;
      render();
    }
  });
  pagination.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (button && !button.disabled) { currentPage += Number(button.dataset.page); render(); }
  });

  try {
    bloodFilter.innerHTML += bloodGroups.map((group) => `<option>${group}</option>`).join('');
    await loadDonors();
  } catch (error) { toast(error.message, 'error'); }
});
