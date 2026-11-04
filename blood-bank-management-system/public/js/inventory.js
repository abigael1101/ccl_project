'use strict';

document.addEventListener('bbms:ready', async ({ detail }) => {
  if (detail.page !== 'inventory') return;
  const { api, dialog, escape, toast } = window.BBMS;
  const search = document.querySelector('#inventory-search');
  const cards = document.querySelector('#inventory-cards');
  const table = document.querySelector('#inventory-table');
  let items = [];
  let history = [];

  function stockClass(status) {
    return status === 'Critical' ? 'critical' : status === 'Low' ? 'low' : 'available';
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const filtered = items.filter((item) => item.bloodGroup.toLowerCase().includes(query));
    cards.innerHTML = filtered.map((item) => `<article class="inventory-card">
      <div class="inventory-card-top"><span class="blood-badge">${escape(item.bloodGroup)}</span><span class="status ${stockClass(item.stockStatus)}">${escape(item.stockStatus)}</span></div>
      <div class="inventory-units">${item.availableUnits}</div><div class="inventory-unit-label">units available</div>
      <div class="inventory-meta"><span><strong>${item.totalDonations}</strong> donated</span><span><strong>${item.totalUnitsIssued}</strong> issued</span></div>
      <div class="button-row" style="margin-top:13px"><button class="button secondary small" data-action="add" data-group="${escape(item.bloodGroup)}"><i class="fa-solid fa-plus"></i> Add stock</button><button class="button subtle small" data-action="issue" data-group="${escape(item.bloodGroup)}"><i class="fa-solid fa-arrow-up-right-from-square"></i> Issue</button></div>
    </article>`).join('') || '<div class="empty-state">No blood groups match your search.</div>';
    table.innerHTML = `<table class="data-table"><thead><tr><th>Blood group</th><th>Available units</th><th>Total donations</th><th>Total units issued</th><th>Stock status</th></tr></thead><tbody>${filtered.map((item) => `<tr><td><span class="table-primary">${escape(item.bloodGroup)}</span></td><td>${item.availableUnits}</td><td>${item.totalDonations}</td><td>${item.totalUnitsIssued}</td><td><span class="status ${stockClass(item.stockStatus)}">${escape(item.stockStatus)}</span></td></tr>`).join('')}</tbody></table>`;
  }

  async function load() {
    const data = await api('/api/inventory');
    items = data.items;
    history = data.history;
    render();
  }

  function adjustmentDialog(group, kind) {
    const adding = kind === 'add';
    const stock = items.find((item) => item.bloodGroup === group);
    dialog(`${adding ? 'Add stock to' : 'Issue blood from'} ${group}`, `<form id="adjustment-form">
      <p class="panel-subtitle">Current availability: <strong>${stock.availableUnits} units</strong></p>
      <div class="form-field" style="margin-top:15px"><label for="adjustment-units">Units *</label><input id="adjustment-units" class="field" name="units" type="number" min="1" max="100" ${adding ? '' : `max="${stock.availableUnits}"`} required></div>
      <div class="form-field" style="margin-top:14px"><label for="adjustment-note">${adding ? 'Source / note' : 'Issue note'} *</label><input id="adjustment-note" class="field" name="note" maxlength="160" placeholder="${adding ? 'e.g. Community donation drive' : 'e.g. Hospital issue reference'}" required></div>
      <div class="form-footer"><button class="button secondary" type="button" data-cancel>Cancel</button><button class="button ${adding ? '' : 'subtle'}" type="submit">${adding ? 'Add units' : 'Issue units'}</button></div>
    </form>`, async (formData) => {
      const updated = await api(`/api/inventory/${encodeURIComponent(group)}/adjust`, {
        method: 'POST',
        body: { ...Object.fromEntries(formData), kind }
      });
      toast(`${group} inventory updated: ${updated.availableUnits} units available.`);
      await load();
    });
    document.querySelector('[data-cancel]').addEventListener('click', () => document.querySelector('#record-dialog').close());
  }

  function historyDialog() {
    const rows = history.map((entry) => {
      const removal = entry.kind === 'issue' || (entry.kind === 'adjustment' && entry.change < 0);
      return `<tr><td>${escape(entry.id)}</td><td>${escape(entry.bloodGroup)}</td><td><span class="status ${removal ? 'low' : 'available'}">${escape(entry.kind)}</span></td><td>${removal ? '−' : '+'}${Math.abs(entry.change)}</td><td>${window.BBMS.formatDate(entry.date)}</td><td>${escape(entry.note)}</td></tr>`;
    }).join('');
    dialog('Stock movement history', `<div class="table-wrap"><table class="data-table"><thead><tr><th>Movement ID</th><th>Blood group</th><th>Type</th><th>Units</th><th>Date</th><th>Note</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No stock movements have been recorded.</td></tr>'}</tbody></table></div>`);
  }

  search.addEventListener('input', render);
  cards.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button) adjustmentDialog(button.dataset.group, button.dataset.action);
  });
  document.querySelector('#history-button').addEventListener('click', historyDialog);
  try { await load(); }
  catch (error) { toast(error.message, 'error'); }
});
