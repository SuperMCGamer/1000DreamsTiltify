// ──────────────────────────────────────────────────────────────────────────────
// Friday the Herteenth – Admin Dashboard Script
//
// Responsibilities:
//   1. Load all already-revealed donations on page load.
//   2. Listen for new `donation:revealed` events and prepend rows in realtime.
//   3. Sync "read" checkboxes across all open admin tabs via Socket.io.
//   4. Show a developer panel for simulating donations.
// ──────────────────────────────────────────────────────────────────────────────

const socket = io();

// ── DOM refs ───────────────────────────────────────────────────────────────────

const donationsList   = document.getElementById('donations-list');
const donationsSection = document.getElementById('donations-section');
const adminTotal      = document.getElementById('admin-total');
const hideReadBtn     = document.getElementById('hide-read-btn');
const paginationEl    = document.getElementById('pagination');
const prevBtn         = document.getElementById('prev-btn');
const nextBtn         = document.getElementById('next-btn');
const pageInfo        = document.getElementById('page-info');

// Tracks IDs already rendered so the HTTP load and a concurrent socket event
// for the same donation don't produce duplicate rows (#3).
const renderedIds = new Set();

// ── Pagination state ───────────────────────────────────────────────────────────

const PAGE_SIZE  = 50;
let currentPage  = 1;
let totalPages   = 1;

// ── Hide-read toggle (persisted per browser via localStorage) ─────────────────

let hideRead = localStorage.getItem('hideRead') === 'true';

function applyHideRead() {
  donationsSection.classList.toggle('hide-read', hideRead);
  hideReadBtn.classList.toggle('active', hideRead);
  hideReadBtn.textContent = hideRead ? 'Show read' : 'Hide read';
}

hideReadBtn.addEventListener('click', () => {
  hideRead = !hideRead;
  localStorage.setItem('hideRead', hideRead);
  applyHideRead();
});

applyHideRead();

// ── Utility: escape HTML so donor names can't inject markup ───────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Utility: format a SQLite datetime string for display ──────────────────────

function formatTime(isoStr) {
  if (!isoStr) return '—';
  // SQLite stores `datetime('now')` in UTC without a Z suffix, so add it.
  const d = new Date(isoStr.includes('Z') ? isoStr : isoStr + 'Z');
  if (isNaN(d)) return isoStr;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Build a donation row element ───────────────────────────────────────────────

function buildRow(donation) {
  const row = document.createElement('div');
  row.className = 'donation-row' + (donation.read ? ' is-read' : '');
  row.dataset.id = donation.id;

  row.innerHTML = `
    <div class="donor-name-wrap">
      <span class="donor-name">${esc(donation.username)}</span>
      ${donation.comment ? `<span class="donor-comment">${esc(donation.comment)}</span>` : ''}
    </div>
    <span class="donor-amount">$${Math.round(donation.amount).toLocaleString('en-US')}</span>
    <span class="donor-time">${formatTime(donation.created_at)}</span>
    <label class="read-label read-cell">
      <input
        type="checkbox"
        class="read-checkbox"
        ${donation.read ? 'checked' : ''}
        aria-label="Mark as read"
      />
      Read
    </label>
  `;

  // When the checkbox changes, PATCH the server so all admin pages sync.
  row.querySelector('.read-checkbox').addEventListener('change', (e) => {
    fetch(`/api/donations/${donation.id}/read`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ read: e.target.checked }),
    }).catch(console.error);
  });

  return row;
}

// ── Prepend a row (live socket events – always at top of current view) ────────

function prependRow(donation) {
  // Guard against HTTP-load / socket-event race (#3).
  if (renderedIds.has(donation.id)) return;
  renderedIds.add(donation.id);

  // New live donations only prepend when viewing page 1.
  // On deeper pages the row will appear when the user navigates back to page 1.
  if (currentPage !== 1) return;

  const placeholder = document.getElementById('empty-msg');
  if (placeholder) placeholder.remove();

  donationsList.insertBefore(buildRow(donation), donationsList.firstChild);
}

// ── Update total display ───────────────────────────────────────────────────────

function setTotal(amount) {
  adminTotal.textContent = `$${Math.round(amount).toLocaleString('en-US')}`;
}

// ── Pagination controls ────────────────────────────────────────────────────────

function updatePagination() {
  paginationEl.style.display = totalPages > 1 ? 'flex' : 'none';
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
  pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
}

prevBtn.addEventListener('click', () => { if (currentPage > 1)           loadPage(currentPage - 1); });
nextBtn.addEventListener('click', () => { if (currentPage < totalPages)  loadPage(currentPage + 1); });

// ── Load a page of donations from the server ───────────────────────────────────

async function loadPage(page = 1) {
  try {
    const [donRes, totRes] = await Promise.all([
      fetch(`/api/donations?page=${page}&limit=${PAGE_SIZE}`),
      fetch('/api/total'),
    ]);
    const { donations, pages } = await donRes.json();
    const { total } = await totRes.json();

    donationsList.innerHTML = '';
    renderedIds.clear();
    currentPage = page;
    totalPages  = pages;
    updatePagination();

    if (donations.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-msg';
      p.id = 'empty-msg';
      p.textContent = 'Waiting for donations…';
      donationsList.appendChild(p);
    } else {
      for (const d of donations) {
        renderedIds.add(d.id);
        donationsList.appendChild(buildRow(d));
      }
    }

    setTotal(total);
  } catch (err) {
    console.error('Failed to load donations:', err);
  }
}

// ── Socket.io: new donation revealed ──────────────────────────────────────────
// Fires after the overlay finishes playing the alert for this donation.

socket.on('donation:revealed', (donation) => {
  prependRow(donation);
});

// ── Socket.io: read state synced ──────────────────────────────────────────────
// When any admin tab toggles a checkbox the server re-broadcasts to all tabs.

socket.on('donation:read', ({ id, read }) => {
  const row      = donationsList.querySelector(`.donation-row[data-id="${id}"]`);
  const checkbox = donationsList.querySelector(`.donation-row[data-id="${id}"] .read-checkbox`);
  if (!row || !checkbox) return;

  checkbox.checked = read;
  row.classList.toggle('is-read', read);
});

// ── Socket.io: total update ────────────────────────────────────────────────────

socket.on('total:update', ({ total }) => setTotal(total));

// ── Socket.io: donations reset ────────────────────────────────────────────────
// Fired when the reset endpoint deletes simulated donations; clear the list
// and re-fetch so all open admin tabs stay in sync.

socket.on('donations:reset', () => {
  loadPage(1);
});

// ── Developer panel ────────────────────────────────────────────────────────────

const advancedBtn  = document.getElementById('advanced-btn');
const devPanel     = document.getElementById('dev-panel');
const simBtn       = document.getElementById('sim-btn');
const simUsername  = document.getElementById('sim-username');
const simAmount    = document.getElementById('sim-amount');
const simComment   = document.getElementById('sim-comment');
const devNote      = document.getElementById('dev-note');
const resetBtn     = document.getElementById('reset-btn');
const resetNote    = document.getElementById('reset-note');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const statusCampaign = document.getElementById('status-campaign');

advancedBtn.addEventListener('click', () => {
  const open = devPanel.classList.toggle('open');
  advancedBtn.textContent = open ? 'Advanced ▴' : 'Advanced ▾';
});

// ── Tiltify status polling ────────────────────────────────────────────────────

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const { tiltify } = await res.json();

    if (!tiltify.configured) {
      statusDot.className = 'status-dot dot-warn';
      statusText.textContent = 'Not configured – add Tiltify env vars';
      statusCampaign.textContent = '';
    } else if (tiltify.connected) {
      const ago = tiltify.lastPoll
        ? Math.round((Date.now() - new Date(tiltify.lastPoll)) / 1000)
        : null;
      statusDot.className = 'status-dot dot-ok';
      statusText.textContent = `Connected${ago !== null ? ` · polled ${ago}s ago` : ''}`;
      statusCampaign.textContent = `Campaign ID: ${tiltify.campaignId}`;
    } else {
      statusDot.className = 'status-dot dot-err';
      statusText.textContent = `Error: ${tiltify.lastError || 'unknown'}`;
      statusCampaign.textContent = tiltify.campaignId ? `Campaign ID: ${tiltify.campaignId}` : '';
    }
  } catch {
    statusDot.className = 'status-dot dot-err';
    statusText.textContent = 'Cannot reach server';
  }
}

pollStatus();
setInterval(pollStatus, 5000);

// ── Simulate donation ─────────────────────────────────────────────────────────

simBtn.addEventListener('click', async () => {
  const username = simUsername.value.trim();
  const amount   = parseFloat(simAmount.value);

  if (!username)      { devNote.textContent = '⚠ Enter a donor name.'; return; }
  if (!amount || amount <= 0) { devNote.textContent = '⚠ Enter a valid amount.'; return; }

  simBtn.disabled = true;
  devNote.textContent = 'Sending…';

  const comment = simComment.value.trim();

  try {
    const res = await fetch('/api/donations/simulate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, amount, comment }),
    });
    if (!res.ok) throw new Error(await res.text());

    devNote.textContent = `✓ Queued "$${Math.round(amount)}" from "${username}" – alert playing on overlay.`;
    simUsername.value = '';
    simAmount.value   = '';
    simComment.value  = '';
  } catch (err) {
    devNote.textContent = `✗ Error: ${err.message}`;
  } finally {
    simBtn.disabled = false;
  }
});

// ── Reset simulated donations ─────────────────────────────────────────────────

resetBtn.addEventListener('click', async () => {
  if (!confirm('Remove all simulated donations? Real Tiltify donations will be kept.')) return;

  resetBtn.disabled = true;
  resetNote.textContent = 'Resetting…';

  try {
    const res  = await fetch('/api/donations/reset', { method: 'POST' });
    const data = await res.json();
    resetNote.textContent = `✓ Removed ${data.deleted} simulated donation(s).`;
  } catch (err) {
    resetNote.textContent = `✗ Error: ${err.message}`;
  } finally {
    resetBtn.disabled = false;
  }
});

// ── Init ───────────────────────────────────────────────────────────────────────

loadPage(1);
