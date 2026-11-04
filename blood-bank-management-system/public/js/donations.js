'use strict';

document.addEventListener('bbms:ready', async ({ detail }) => {
  if (detail.page !== 'donations') return;
  const { api, dialog, escape, formatDate, toast, confirmDelete } = window.BBMS;
  const form = document.querySelector('#donation-form');
  const donorSelect = document.querySelector('#donorId');
  const dateInput = document.querySelector('#donationDate');
  const search = document.querySelector('#donation-search');
  const table = document.querySelector('#donation-table');
  const pagination = document.querySelector('#donation-pagination');
  const count = document.querySelector('#donation-count');
  const pageSize = 8;
  let donors = [];
  let donations = [];
  let page = 1;

  function donorOptions(selected = '') {
    return `<option value="">Choose donor</option>${donors.map((donor) => `<option value="${escape(donor.id)}" ${selected === donor.id ? 'selected' : ''}>${escape(donor.fullName)} · ${escape(donor.id)} · ${escape(donor.bloodGroup)}</option>`).join('')}`;
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const filtered = donations.filter((item) => `${item.id} ${item.donorName} ${item.donorId} ${item.bloodGroup} ${item.location}`.toLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.min(page, pages);
    const shown = filtered.slice((page - 1) * pageSize, page * pageSize);
    count.textContent = `${filtered.length} donation record${filtered.length === 1 ? '' : 's'}`;
    table.innerHTML = shown.length ? `<table class="data-table"><thead><tr><th>Donation ID</th><th>Donor</th><th>Blood group</th><th>Units</th><th>Date</th><th>Location</th><th>Remarks</th><th>Actions</th></tr></thead><tbody>${shown.map((item) => `<tr>
      <td><span class="table-primary">${escape(item.id)}</span></td><td><span class="table-primary">${escape(item.donorName)}</span><span class="table-muted">${escape(item.donorId)}</span></td>
      <td><span class="blood-badge" style="display:inline-grid;width:30px;height:30px">${escape(item.bloodGroup)}</span></td><td>${item.units}</td><td>${formatDate(item.donationDate)}</td><td>${escape(item.location)}</td><td>${escape(item.remarks || '—')}</td>
      <td><div class="table-actions"><button class="action-icon" data-action="edit" data-id="${escape(item.id)}" aria-label="Edit donation"><i class="fa-regular fa-pen-to-square"></i></button><button class="action-icon delete" data-action="delete" data-id="${escape(item.id)}" aria-label="Delete donation"><i class="fa-regular fa-trash-can"></i></button></div></td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty-state"><i class="fa-solid fa-droplet"></i>No donation records match your search.</div>';
    pagination.innerHTML = `<span>Showing ${filtered.length ? (page - 1) * pageSize + 1 : 0}–${Math.min(page * pageSize, filtered.length)} of ${filtered.length}</span><span class="button-row"><button class="button secondary small" data-page="-1" ${page === 1 ? 'disabled' : ''}>Previous</button><span>Page ${page} of ${pages}</span><button class="button secondary small" data-page="1" ${page === pages ? 'disabled' : ''}>Next</button></span>`;
  }

  async function load() {
    [donors, donations] = await Promise.all([api('/api/donors'), api('/api/donations')]);
    donorSelect.innerHTML = donorOptions();
    render();
  }

  function editRecord(record) {
    dialog(`Edit donation · ${record.id}`, `<form id="edit-donation-form" class="form-grid">
      <div class="form-field full"><label>Donor *</label><select class="select" name="donorId" required>${donorOptions(record.donorId)}</select></div>
      <div class="form-field"><label>Units donated *</label><input class="field" name="units" type="number" min="1" max="5" value="${record.units}" required></div>
      <div class="form-field"><label>Donation date *</label><input class="field" name="donationDate" type="date" value="${escape(record.donationDate)}" max="${window.BBMS.dateToday()}" required></div>
      <div class="form-field full"><label>Donation location *</label><input class="field" name="location" value="${escape(record.location)}" maxlength="120" required></div>
      <div class="form-field full"><label>Remarks</label><textarea class="textarea" name="remarks" maxlength="500">${escape(record.remarks || '')}</textarea></div>
      <div class="form-field full"><div class="form-footer"><button class="button secondary" type="button" data-cancel>Cancel</button><button class="button" type="submit">Save changes</button></div></div>
    </form>`, async (formData) => {
      await api(`/api/donations/${encodeURIComponent(record.id)}`, { method: 'PATCH', body: Object.fromEntries(formData) });
      toast('Donation record updated and stock adjusted.');
      await load();
    });
    document.querySelector('[data-cancel]').addEventListener('click', () => document.querySelector('#record-dialog').close());
  }

  dateInput.value = window.BBMS.dateToday();
  dateInput.max = window.BBMS.dateToday();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const donation = await api('/api/donations', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      toast(`Donation ${donation.id} saved. Inventory has been updated.`);
      form.reset();
      dateInput.value = window.BBMS.dateToday();
      await load();
    } catch (error) { toast(error.message, 'error'); }
    finally { submit.disabled = false; }
  });
  search.addEventListener('input', () => { page = 1; render(); });
  pagination.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (button && !button.disabled) { page += Number(button.dataset.page); render(); }
  });
  table.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const record = donations.find((item) => item.id === button.dataset.id);
    if (!record) return;
    if (button.dataset.action === 'edit') editRecord(record);
    if (button.dataset.action === 'delete' && confirmDelete(`donation ${record.id}`)) {
      try {
        await api(`/api/donations/${encodeURIComponent(record.id)}`, { method: 'DELETE', body: {} });
        toast('Donation record deleted and inventory adjusted.');
        await load();
      } catch (error) { toast(error.message, 'error'); }
    }
  });

  try { await load(); }
  catch (error) { toast(error.message, 'error'); }
});
