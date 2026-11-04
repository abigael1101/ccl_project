'use strict';

document.addEventListener('bbms:ready', async ({ detail }) => {
  if (detail.page !== 'requests') return;
  const { api, dialog, escape, formatDate, toast, confirmDelete } = window.BBMS;
  const form = document.querySelector('#request-form');
  const dateInput = document.querySelector('#requestDate');
  const search = document.querySelector('#request-search');
  const bloodFilter = document.querySelector('#request-blood-filter');
  const statusFilter = document.querySelector('#request-status-filter');
  const table = document.querySelector('#request-table');
  const pagination = document.querySelector('#request-pagination');
  const count = document.querySelector('#request-count');
  const pageSize = 8;
  let requests = [];
  let page = 1;

  function render() {
    const query = search.value.trim().toLowerCase();
    const filtered = requests.filter((request) =>
      `${request.id} ${request.patientName} ${request.hospitalName}`.toLowerCase().includes(query)
      && (!bloodFilter.value || request.bloodGroup === bloodFilter.value)
      && (!statusFilter.value || request.status === statusFilter.value));
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pageCount);
    const shown = filtered.slice((page - 1) * pageSize, page * pageSize);
    count.textContent = `${filtered.length} request${filtered.length === 1 ? '' : 's'} found`;
    table.innerHTML = shown.length ? `<table class="data-table"><thead><tr><th>Request ID</th><th>Patient / hospital</th><th>Blood group</th><th>Units</th><th>Requested</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead><tbody>${shown.map((request) => {
      const actions = request.status === 'Completed'
        ? '<span class="data-label">Fulfilled</span>'
        : `<div class="table-actions">
            ${request.status !== 'Approved' ? `<button class="button secondary small" data-action="approve" data-id="${escape(request.id)}">Approve</button>` : `<button class="button subtle small" data-action="complete" data-id="${escape(request.id)}">Fulfill</button>`}
            ${request.status !== 'Rejected' ? `<button class="action-icon" data-action="reject" data-id="${escape(request.id)}" aria-label="Reject request"><i class="fa-solid fa-ban"></i></button>` : ''}
            <button class="action-icon" data-action="edit" data-id="${escape(request.id)}" aria-label="Edit request"><i class="fa-regular fa-pen-to-square"></i></button>
            <button class="action-icon delete" data-action="delete" data-id="${escape(request.id)}" aria-label="Delete request"><i class="fa-regular fa-trash-can"></i></button>
          </div>`;
      return `<tr><td><span class="table-primary">${escape(request.id)}</span></td><td><span class="table-primary">${escape(request.patientName)}</span><span class="table-muted">${escape(request.hospitalName)} · ${escape(request.contactNumber)}</span></td><td><span class="blood-badge" style="display:inline-grid;width:30px;height:30px">${escape(request.bloodGroup)}</span></td><td>${request.units}</td><td>${formatDate(request.requestDate)}</td><td><span class="status ${window.BBMS.statusClass(request.priority)}">${escape(request.priority)}</span></td><td><span class="status ${window.BBMS.statusClass(request.status)}">${escape(request.status)}</span></td><td>${actions}</td></tr>`;
    }).join('')}</tbody></table>` : '<div class="empty-state"><i class="fa-solid fa-file-medical"></i>No requests match your filters.</div>';
    pagination.innerHTML = `<span>Showing ${filtered.length ? (page - 1) * pageSize + 1 : 0}–${Math.min(page * pageSize, filtered.length)} of ${filtered.length}</span><span class="button-row"><button class="button secondary small" data-page="-1" ${page === 1 ? 'disabled' : ''}>Previous</button><span>Page ${page} of ${pageCount}</span><button class="button secondary small" data-page="1" ${page === pageCount ? 'disabled' : ''}>Next</button></span>`;
  }

  async function load() {
    requests = await api('/api/requests');
    render();
  }

  function editRequest(request) {
    const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
    const options = (values, selected) => values.map((value) => `<option ${value === selected ? 'selected' : ''}>${value}</option>`).join('');
    dialog(`Edit request · ${request.id}`, `<form id="edit-request-form" class="form-grid">
      <div class="form-field"><label>Patient name *</label><input class="field" name="patientName" value="${escape(request.patientName)}" maxlength="100" required></div>
      <div class="form-field"><label>Hospital name *</label><input class="field" name="hospitalName" value="${escape(request.hospitalName)}" maxlength="120" required></div>
      <div class="form-field"><label>Blood group *</label><select class="select" name="bloodGroup">${options(bloodGroups, request.bloodGroup)}</select></div>
      <div class="form-field"><label>Units required *</label><input class="field" name="units" type="number" min="1" max="20" value="${request.units}" required></div>
      <div class="form-field"><label>Contact number *</label><input class="field" name="contactNumber" value="${escape(request.contactNumber)}" maxlength="32" required></div>
      <div class="form-field"><label>Request date *</label><input class="field" name="requestDate" type="date" value="${escape(request.requestDate)}" max="${window.BBMS.dateToday()}" required></div>
      <div class="form-field"><label>Priority *</label><select class="select" name="priority">${options(['Normal', 'High', 'Urgent'], request.priority)}</select></div>
      <div class="form-field"><label>Status *</label><select class="select" name="status">${options(['Pending', 'Approved', 'Rejected'], request.status)}</select></div>
      <div class="form-field full"><div class="form-footer"><button class="button secondary" type="button" data-cancel>Cancel</button><button class="button" type="submit">Save changes</button></div></div>
    </form>`, async (formData) => {
      await api(`/api/requests/${encodeURIComponent(request.id)}`, { method: 'PATCH', body: Object.fromEntries(formData) });
      toast('Blood request updated.');
      await load();
    });
    document.querySelector('[data-cancel]').addEventListener('click', () => document.querySelector('#record-dialog').close());
  }

  dateInput.value = window.BBMS.dateToday();
  dateInput.max = window.BBMS.dateToday();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const request = await api('/api/requests', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      toast(`Request ${request.id} added.`);
      form.reset();
      dateInput.value = window.BBMS.dateToday();
      await load();
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  [search, bloodFilter, statusFilter].forEach((input) => input.addEventListener('input', () => { page = 1; render(); }));
  pagination.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (button && !button.disabled) { page += Number(button.dataset.page); render(); }
  });
  table.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const request = requests.find((item) => item.id === button.dataset.id);
    if (!request) return;
    const action = button.dataset.action;
    if (action === 'edit') editRequest(request);
    if (action === 'delete' && confirmDelete(`request ${request.id}`)) {
      try {
        await api(`/api/requests/${encodeURIComponent(request.id)}`, { method: 'DELETE', body: {} });
        toast('Blood request deleted.');
        await load();
      } catch (error) { toast(error.message, 'error'); }
    }
    if (action === 'approve' || action === 'reject') {
      const status = action === 'approve' ? 'Approved' : 'Rejected';
      try {
        await api(`/api/requests/${encodeURIComponent(request.id)}`, { method: 'PATCH', body: { status } });
        toast(`Request ${status.toLowerCase()}.`);
        await load();
      } catch (error) { toast(error.message, 'error'); }
    }
    if (action === 'complete' && window.confirm(`Fulfill ${request.id} and issue ${request.units} ${request.bloodGroup} unit${request.units === 1 ? '' : 's'} from inventory?`)) {
      try {
        await api(`/api/requests/${encodeURIComponent(request.id)}`, { method: 'PATCH', body: { status: 'Completed' } });
        toast(`Request ${request.id} fulfilled. Inventory has been updated.`);
        await load();
      } catch (error) { toast(error.message, 'error'); }
    }
  });

  try { await load(); }
  catch (error) { toast(error.message, 'error'); }
});
