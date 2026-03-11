// ──────────────────────────────────────────────────────────────────────────────
// Friday the Herteenth – Charity Livestream Server
// Express + Socket.io + SQLite + Tiltify polling
// ──────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const Database   = require('better-sqlite3');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ── Database setup ─────────────────────────────────────────────────────────────

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'donations.db'));

// Create the donations table if it doesn't already exist.
// `revealed` controls when admin can see the donation (after alert plays).
// `read`     is the checkbox state on the admin dashboard.
db.exec(`
  CREATE TABLE IF NOT EXISTS donations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL,
    amount     INTEGER NOT NULL,
    comment    TEXT    NOT NULL DEFAULT '',
    tiltify_id TEXT    UNIQUE,
    revealed   INTEGER NOT NULL DEFAULT 0,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: add comment column to existing databases that predate this field.
try {
  db.exec("ALTER TABLE donations ADD COLUMN comment TEXT NOT NULL DEFAULT ''");
} catch { /* column already exists – ignore */ }

// On startup, load IDs of donations we've already revealed so we don't
// double-reveal if the server restarts mid-stream.
const revealedSet = new Set(
  db.prepare('SELECT id FROM donations WHERE revealed = 1').all().map(r => r.id)
);

// ── Reveal helper (used by alert:complete AND fallback) ───────────────────────
// Centralised so both paths do the exact same work.

function autoReveal(id) {
  if (revealedSet.has(id)) return;
  revealedSet.add(id);
  db.prepare('UPDATE donations SET revealed = 1 WHERE id = ?').run(id);
  const donation = db.prepare('SELECT * FROM donations WHERE id = ?').get(id);
  if (donation) {
    io.emit('donation:revealed', donation);
    console.log(`[reveal] donation id=${id} now visible to admin`);
  }
}

// Load Tiltify donation IDs already stored so we don't re-process them.
const seenTiltifyIds = new Set(
  db.prepare('SELECT tiltify_id FROM donations WHERE tiltify_id IS NOT NULL').all().map(r => r.tiltify_id)
);

// ── Helper: current donation total ────────────────────────────────────────────

function getTotal() {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM donations').get().total;
}

// ── Media scanning ─────────────────────────────────────────────────────────────
// Reads image filenames from /public/logos and /public/slides at startup
// and again each time /api/media is requested, so you can hot-add files.

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);

function scanDir(dirPath) {
  try {
    return fs.readdirSync(dirPath)
      .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

// ── Express middleware ─────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve each SPA route by returning its index.html
app.get('/overlay', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public/overlay/index.html')));
app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public/admin/index.html')));

// ── API: media list ────────────────────────────────────────────────────────────
// Returns sorted arrays of filenames from /logos and /slides.

app.get('/api/media', (_req, res) => {
  const logos  = scanDir(path.join(__dirname, 'public/logos'));
  const slides = scanDir(path.join(__dirname, 'public/slides'));
  res.json({ logos, slides });
});

// ── API: current total ─────────────────────────────────────────────────────────

app.get('/api/total', (_req, res) => {
  res.json({ total: getTotal() });
});

// ── API: revealed donations for admin page ─────────────────────────────────────
// Only donations whose alerts have already played are visible to admins.

app.get('/api/donations', (_req, res) => {
  const donations = db
    .prepare('SELECT * FROM donations WHERE revealed = 1 ORDER BY id DESC')
    .all();
  res.json(donations);
});

// ── API: mark a donation read/unread ──────────────────────────────────────────
// Syncs the checkbox state to all connected admin clients via Socket.io.

app.patch('/api/donations/:id/read', (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const read = req.body.read ? 1 : 0;
  db.prepare('UPDATE donations SET read = ? WHERE id = ?').run(read, id);
  io.emit('donation:read', { id, read: !!read });
  res.json({ ok: true });
});

// ── API: server / Tiltify status ───────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  const { TILTIFY_CLIENT_ID, TILTIFY_CLIENT_SECRET, TILTIFY_CAMPAIGN_ID } = process.env;
  const configured = !!(TILTIFY_CLIENT_ID && TILTIFY_CLIENT_SECRET && TILTIFY_CAMPAIGN_ID);
  res.json({
    tiltify: {
      configured,
      connected:   tiltifyConnected,
      campaignId:  TILTIFY_CAMPAIGN_ID || null,
      lastPoll:    tiltifyLastPoll,
      lastError:   tiltifyLastError,
    },
  });
});

// ── API: reset simulated donations ────────────────────────────────────────────
// Deletes all donations where tiltify_id IS NULL (i.e. sent via the simulate
// panel) and broadcasts a reset event so all open admin tabs refresh.

app.post('/api/donations/reset', (_req, res) => {
  const { changes } = db.prepare('DELETE FROM donations WHERE tiltify_id IS NULL').run();

  // Rebuild revealedSet so it no longer contains IDs we just deleted.
  revealedSet.clear();
  db.prepare('SELECT id FROM donations WHERE revealed = 1').all()
    .forEach(r => revealedSet.add(r.id));

  io.emit('total:update', { total: getTotal() });
  io.emit('donations:reset');

  console.log(`[reset] Removed ${changes} simulated donation(s)`);
  res.json({ ok: true, deleted: changes });
});

// ── API: simulate a donation (dev feature) ─────────────────────────────────────
// Pushes a fake donation through the exact same queue as real ones.

app.post('/api/donations/simulate', (req, res) => {
  const { username, amount, comment } = req.body;
  if (!username || amount == null) {
    return res.status(400).json({ error: 'username and amount are required' });
  }
  const rounded = Math.round(parseFloat(amount));
  if (isNaN(rounded) || rounded <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  queueDonation({ username, amount: rounded, comment: comment || '', tiltify_id: null });
  res.json({ ok: true });
});

// ── Donation queue ─────────────────────────────────────────────────────────────
// This is the single entry point for all donations (real or simulated).
// 1. Saves the donation to SQLite with revealed=0.
// 2. Broadcasts a `donation:alert` event to all overlays.
// 3. Broadcasts `total:update` so every overlay shows the new total immediately.

function queueDonation({ username, amount, comment = '', tiltify_id }) {
  let donationId;
  try {
    const result = db
      .prepare('INSERT INTO donations (username, amount, comment, tiltify_id, revealed) VALUES (?, ?, ?, ?, 0)')
      .run(username, amount, comment || '', tiltify_id || null);
    donationId = result.lastInsertRowid;
  } catch (err) {
    // UNIQUE constraint on tiltify_id – already processed, skip silently.
    console.log(`[skip] Duplicate Tiltify donation: ${tiltify_id}`);
    return;
  }

  // Send alert to all overlays – they queue and play sequentially.
  io.emit('donation:alert', { id: donationId, username, amount });

  // Update the visible total on all overlays right away.
  io.emit('total:update', { total: getTotal() });

  console.log(`[queue] ${username} $${amount} (db id: ${donationId})`);
}

// ── Socket.io event handlers ───────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  // When an overlay finishes playing an alert it emits `alert:complete`.
  // The first overlay to emit this wins – subsequent ones are no-ops via revealedSet.
  socket.on('alert:complete', ({ id }) => {
    autoReveal(id);
  });

  socket.on('disconnect', () => {
    console.log(`[socket] disconnected: ${socket.id}`);
  });
});

// ── Stale-donation fallback (fixes #1 and #2) ─────────────────────────────────
// Covers two failure cases:
//   #1 – donation:alert was broadcast but no overlay was connected to play it.
//   #2 – server restarted; unrevealed donations from the previous run sit in DB.
//
// Every 30 s we look for donations that have been unrevealed for more than 60 s
// and force-reveal them.  60 s is long enough for any realistic alert queue
// (up to ~10 queued donations * 5.6 s each ≈ 56 s) to have finished normally.

setInterval(() => {
  const stale = db
    .prepare("SELECT * FROM donations WHERE revealed = 0 AND created_at < datetime('now', '-60 seconds')")
    .all();
  for (const d of stale) {
    console.log(`[fallback] Auto-revealing stale donation id=${d.id} (no alert:complete received)`);
    autoReveal(d.id);
  }
}, 30_000);

// ── Startup re-queue for orphaned unrevealed donations (fixes #2) ─────────────
// If the server crashed or was restarted while alerts were queued, those
// donations are in the DB with revealed=0 but won't be re-fetched from Tiltify
// (their IDs are in seenTiltifyIds).  Re-emit donation:alert for each one after
// a 6 s delay so overlay clients have time to reconnect via Socket.io first.

const orphaned = db.prepare('SELECT * FROM donations WHERE revealed = 0 ORDER BY id ASC').all();
if (orphaned.length > 0) {
  console.log(`[startup] Re-queueing ${orphaned.length} unrevealed donation(s) from previous session`);
  setTimeout(() => {
    for (const d of orphaned) {
      io.emit('donation:alert', { id: d.id, username: d.username, amount: d.amount });
    }
  }, 6000);
}

// ── Tiltify integration ────────────────────────────────────────────────────────
// Uses the Tiltify V5 API with OAuth2 client-credentials flow.
// Polls every POLL_INTERVAL_MS milliseconds (default 10 s).

let tiltifyToken       = null;
let tokenExpiry        = 0;
let pollInProgress     = false; // guard against overlapping poll calls (#4)
let tiltifyLastPoll    = null;  // ISO timestamp of last successful poll
let tiltifyConnected   = false; // true after first successful poll
let tiltifyLastError   = null;  // last error message, if any

async function getTiltifyToken() {
  if (tiltifyToken && Date.now() < tokenExpiry) return tiltifyToken;

  const res = await fetch('https://v5api.tiltify.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.TILTIFY_CLIENT_ID,
      client_secret: process.env.TILTIFY_CLIENT_SECRET,
      grant_type:    'client_credentials',
      scope:         'public',
    }),
  });

  if (!res.ok) throw new Error(`Tiltify token request failed: ${res.status}`);

  const data   = await res.json();
  tiltifyToken = data.access_token;
  // Refresh a minute before the token actually expires.
  tokenExpiry  = Date.now() + (data.expires_in - 60) * 1000;
  console.log('[tiltify] access token refreshed');
  return tiltifyToken;
}

async function pollTiltify() {
  const { TILTIFY_CLIENT_ID, TILTIFY_CLIENT_SECRET, TILTIFY_CAMPAIGN_ID } = process.env;
  if (!TILTIFY_CLIENT_ID || !TILTIFY_CLIENT_SECRET || !TILTIFY_CAMPAIGN_ID) {
    // Skip silently when credentials are not configured (e.g. local dev without .env).
    return;
  }

  // Skip if previous poll is still in flight – prevents duplicate processing
  // when Tiltify is slow and the interval fires again before we finish (#4).
  if (pollInProgress) {
    console.warn('[tiltify] previous poll still in flight, skipping this tick');
    return;
  }
  pollInProgress = true;

  try {
    const token = await getTiltifyToken();
    const res   = await fetch(
      `https://v5api.tiltify.com/api/public/campaigns/${TILTIFY_CAMPAIGN_ID}/donations`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) throw new Error(`Tiltify donations fetch failed: ${res.status}`);

    const data = await res.json();

    // The API returns newest-first; reverse so we queue in chronological order.
    const incoming = (data.data || []).filter(d => !seenTiltifyIds.has(d.id)).reverse();

    for (const donation of incoming) {
      seenTiltifyIds.add(donation.id);
      const amount   = Math.round(parseFloat(donation.amount.value));
      const username = donation.donor_name || 'Anonymous';
      const comment  = donation.donor_comment || '';
      queueDonation({ username, amount, comment, tiltify_id: donation.id });
    }

    tiltifyConnected = true;
    tiltifyLastPoll  = new Date().toISOString();
    tiltifyLastError = null;
  } catch (err) {
    tiltifyConnected = false;
    tiltifyLastError = err.message;
    console.error('[tiltify] poll error:', err.message);
  } finally {
    pollInProgress = false;
  }
}

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
setInterval(pollTiltify, POLL_INTERVAL);
pollTiltify(); // Run once immediately on startup.

// ── Start server ───────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎗  Friday the Herteenth server running on port ${PORT}`);
  console.log(`   Overlay : http://localhost:${PORT}/overlay`);
  console.log(`   Admin   : http://localhost:${PORT}/admin\n`);
});
