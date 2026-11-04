'use strict';

document.addEventListener('bbms:ready', async () => {
  const { api, escape, formatDate, statusClass, toast } = window.BBMS;
  const statsNode = document.querySelector('#dashboard-stats');
  try {
    const data = await api('/api/dashboard');
    const cards = [
      ['Registered donors', data.stats.totalDonors, 'fa-users', '', 'All active donor profiles'],
      ['Blood donations', data.stats.totalDonations, 'fa-hand-holding-droplet', 'green', 'Recorded donation sessions'],
      ['Available blood units', data.stats.availableUnits, 'fa-boxes-stacked', 'red', 'Across all blood groups'],
      ['Blood requests', data.stats.totalRequests, 'fa-file-medical', 'blue', 'Patient requests on record'],
      ['Pending requests', data.stats.pendingRequests, 'fa-hourglass-half', 'orange', 'Awaiting administrator review'],
      ['Completed requests', data.stats.completedRequests, 'fa-circle-check', 'green', 'Fulfilled from available stock']
    ];
    statsNode.innerHTML = cards.map(([label, value, icon, tone, meta]) => `
      <article class="stat-card"><div><div class="stat-label">${label}</div><div class="stat-value">${value.toLocaleString()}</div><div class="stat-meta">${meta}</div></div>
        <span class="stat-icon ${tone}"><i class="fa-solid ${icon}"></i></span></article>
    `).join('');

    const chartNode = document.querySelector('#blood-chart');
    if (window.Chart) {
      new Chart(chartNode, {
        type: 'bar',
        data: {
          labels: data.bloodGroups.map((item) => item.bloodGroup),
          datasets: [
            { label: 'Available units', data: data.bloodGroups.map((item) => item.availableUnits), backgroundColor: '#c6283d', borderRadius: 5, maxBarThickness: 26 },
            { label: 'Registered donors', data: data.bloodGroups.map((item) => item.donorCount), backgroundColor: '#f0b5bf', borderRadius: 5, maxBarThickness: 26 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 9, usePointStyle: true, pointStyle: 'circle', font: { size: 10 } } } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#888793', font: { size: 10 } } },
            y: { beginAtZero: true, grid: { color: '#f1eff3' }, ticks: { precision: 0, color: '#888793', font: { size: 10 } } }
          }
        }
      });
    } else {
      chartNode.parentElement.innerHTML = `<div class="stock-pills">${data.bloodGroups.map((item) => `<div class="stock-pill"><strong>${escape(item.bloodGroup)}</strong><span>${item.availableUnits} units · ${item.donorCount} donors</span></div>`).join('')}</div>`;
    }

    const notificationItems = [];
    if (data.stats.pendingRequests) notificationItems.push(`<div class="notice"><i class="fa-solid fa-clock"></i><span><strong>${data.stats.pendingRequests} request${data.stats.pendingRequests === 1 ? '' : 's'} pending</strong><br>Review new requests to coordinate a response.</span></div>`);
    if (data.lowStock.length) notificationItems.push(`<div class="notice"><i class="fa-solid fa-triangle-exclamation"></i><span><strong>Low or critical stock</strong><br>${data.lowStock.map(escape).join(', ')} need attention.</span></div>`);
    document.querySelector('#notifications-list').innerHTML = notificationItems.join('') || '<div class="empty-state"><i class="fa-regular fa-circle-check"></i>Everything looks up to date.</div>';

    document.querySelector('#recent-donors').innerHTML = `<table class="data-table"><thead><tr><th>Donor</th><th>Blood group</th><th>City</th><th>Registered</th></tr></thead><tbody>${data.recentDonors.map((donor) => `<tr><td><span class="table-primary">${escape(donor.fullName)}</span><span class="table-muted">${escape(donor.id)}</span></td><td><span class="blood-badge" style="display:inline-grid;width:30px;height:30px">${escape(donor.bloodGroup)}</span></td><td>${escape(donor.city)}</td><td>${formatDate(donor.registrationDate)}</td></tr>`).join('')}</tbody></table>`;
    document.querySelector('#recent-requests').innerHTML = `<table class="data-table"><thead><tr><th>Patient / hospital</th><th>Blood group</th><th>Priority</th><th>Status</th></tr></thead><tbody>${data.recentRequests.map((request) => `<tr><td><span class="table-primary">${escape(request.patientName)}</span><span class="table-muted">${escape(request.hospitalName)}</span></td><td>${escape(request.bloodGroup)} · ${request.units} unit${request.units === 1 ? '' : 's'}</td><td><span class="status ${statusClass(request.priority)}">${escape(request.priority)}</span></td><td><span class="status ${statusClass(request.status)}">${escape(request.status)}</span></td></tr>`).join('')}</tbody></table>`;
  } catch (error) {
    statsNode.innerHTML = '<div class="empty-state">Dashboard information could not be loaded.</div>';
    toast(error.message, 'error');
  }
});
