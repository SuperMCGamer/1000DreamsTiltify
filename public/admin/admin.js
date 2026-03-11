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

const donationsList = document.getElementById('donations-list');
const emptyMsg      = document.getElementById('empty-msg');
const adminTotal    = document.getElementById('admin-total');

// Tracks IDs already rendered so the HTTP load and a concurrent socket event
// for the same donation don't produce duplicate rows (#3).
const renderedIds = new Set();

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
    <span class="donor-name">${esc(donation.username)}</span>
    <span class="donor-amount">$${Math.round(donation.amount)}</span>
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

// ── Prepend a row (newest at top) ─────────────────────────────────────────────

function prependRow(donation) {
  // Guard against the HTTP-load / socket-event race that can deliver the same
  // donation twice during the initial page load window (#3).
  if (renderedIds.has(donation.id)) return;
  renderedIds.add(donation.id);

  // Remove "waiting" placeholder when the first row arrives.
  const placeholder = document.getElementById('empty-msg');
  if (placeholder) placeholder.remove();

  const row = buildRow(donation);
  donationsList.insertBefore(row, donationsList.firstChild);
}

// ── Update total display ───────────────────────────────────────────────────────

function setTotal(amount) {
  adminTotal.textContent = `$${Math.round(amount)}`;
}

// ── Load existing donations on page load ──────────────────────────────────────

async function loadDonations() {
  try {
    const [donRes, totRes] = await Promise.all([
      fetch('/api/donations'),
      fetch('/api/total'),
    ]);
    const donations = await donRes.json();
    const { total } = await totRes.json();

    // Already sorted newest-first by the server.
    for (const d of donations) prependRow(d);

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

// ── Developer panel ────────────────────────────────────────────────────────────

const advancedBtn = document.getElementById('advanced-btn');
const devPanel    = document.getElementById('dev-panel');
const simBtn      = document.getElementById('sim-btn');
const simUsername = document.getElementById('sim-username');
const simAmount   = document.getElementById('sim-amount');
const devNote     = document.getElementById('dev-note');

advancedBtn.addEventListener('click', () => {
  const open = devPanel.classList.toggle('open');
  advancedBtn.textContent = open ? 'Advanced ▴' : 'Advanced ▾';
});

simBtn.addEventListener('click', async () => {
  const username = simUsername.value.trim();
  const amount   = parseFloat(simAmount.value);

  if (!username)      { devNote.textContent = '⚠ Enter a donor name.'; return; }
  if (!amount || amount <= 0) { devNote.textContent = '⚠ Enter a valid amount.'; return; }

  simBtn.disabled = true;
  devNote.textContent = 'Sending…';

  try {
    const res = await fetch('/api/donations/simulate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, amount }),
    });
    if (!res.ok) throw new Error(await res.text());

    devNote.textContent = `✓ Queued "$${Math.round(amount)}" from "${username}" – alert playing on overlay.`;
    simUsername.value = '';
    simAmount.value   = '';
  } catch (err) {
    devNote.textContent = `✗ Error: ${err.message}`;
  } finally {
    simBtn.disabled = false;
  }
});

// ── Init ───────────────────────────────────────────────────────────────────────

loadDonations();
