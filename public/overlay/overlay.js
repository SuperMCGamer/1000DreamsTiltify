// ──────────────────────────────────────────────────────────────────────────────
// Friday the Herteenth – Overlay Script
//
// Responsibilities:
//   1. Fetch media lists (logos / slides) and rotate them in sync every 8 s.
//   2. Show the live donation total (updated via Socket.io).
//   3. Queue incoming donation alerts and play them sequentially.
//   4. After each alert, tell the server it's done so admin can see it.
// ──────────────────────────────────────────────────────────────────────────────

const socket = io();

// ── State ──────────────────────────────────────────────────────────────────────

let logos        = [];  // filenames from /logos
let slides       = [];  // filenames from /slides
let mediaIndex   = 0;   // shared index so logos & slides advance together

let alertQueue   = [];  // pending donation alert objects
let alertPlaying = false;

// ── DOM refs ───────────────────────────────────────────────────────────────────

const totalText    = document.getElementById('total-text');
const normalContent = document.getElementById('normal-content');
const alertPanel   = document.getElementById('alert-panel');
const alertUsername = document.getElementById('alert-username');
const alertAmount  = document.getElementById('alert-amount');
const donationSound = document.getElementById('donation-sound');

// Crossfade image pairs
const logoBox  = document.getElementById('logo-box');
const slideBox = document.getElementById('slide-box');

// ── Crossfade helper ───────────────────────────────────────────────────────────
// `box`    – the .crossfade-box div containing two .cf-img elements
// `newSrc` – URL of the image to fade in
//
// We swap "active" between the two stacked images so the old one fades out
// while the new one fades in via CSS `transition: opacity 0.8s ease`.

function crossfade(box, newSrc) {
  if (!newSrc) return;
  const [imgA, imgB] = box.querySelectorAll('.cf-img');
  const active   = box.querySelector('.cf-img.cf-active'); // may be null on first call
  const inactive = active === imgA ? imgB : imgA;

  inactive.src = newSrc;

  // Wait for the new image to load before triggering the fade so we never
  // show a broken-image placeholder (#6 – guard against null active on first call).
  inactive.onload = () => {
    inactive.classList.add('cf-active');
    if (active) active.classList.remove('cf-active');
  };
  inactive.onerror = () => {
    // Image missing – keep the current one showing.
  };
}

// ── Media rotation ─────────────────────────────────────────────────────────────
// Logos and slides share the same index counter so they always advance together.

function advanceMedia() {
  if (logos.length === 0 && slides.length === 0) return;

  mediaIndex++;

  // Skip crossfade when there is only one image – fading to the same src
  // causes a visible opacity flutter with no real content change (#8).
  if (logos.length > 1) {
    crossfade(logoBox, `/logos/${logos[mediaIndex % logos.length]}`);
  }

  if (slides.length > 1) {
    crossfade(slideBox, `/slides/${slides[mediaIndex % slides.length]}`);
  }
}

async function loadMedia() {
  try {
    const res  = await fetch('/api/media');
    const data = await res.json();
    logos  = data.logos  || [];
    slides = data.slides || [];

    // Load the first image in each category, but only show it after it loads
    // to avoid a broken-image flash on startup (#6).
    if (logos.length > 0) {
      const imgA = document.getElementById('logo-a');
      imgA.onload = () => imgA.classList.add('cf-active');
      imgA.src = `/logos/${logos[0]}`;
    }
    if (slides.length > 0) {
      const imgA = document.getElementById('slide-a');
      imgA.onload = () => imgA.classList.add('cf-active');
      imgA.src = `/slides/${slides[0]}`;
    }
  } catch (err) {
    console.warn('Could not load media list:', err);
  }
}

// 8-second rotation timer (logos and slides advance together)
setInterval(advanceMedia, 8000);

// ── Donation total ─────────────────────────────────────────────────────────────

function setTotal(amount) {
  totalText.textContent = `$${Math.round(amount)} raised for 1,000 Dreams`;
}

async function loadTotal() {
  try {
    const res  = await fetch('/api/total');
    const data = await res.json();
    setTotal(data.total);
  } catch (err) {
    console.warn('Could not load total:', err);
  }
}

// Server pushes a new total whenever a donation is queued.
socket.on('total:update', ({ total }) => setTotal(total));

// ── Alert queue ────────────────────────────────────────────────────────────────
// Donations arrive as `donation:alert` events from the server.
// We queue them and play one at a time so they never overlap.

socket.on('donation:alert', (donation) => {
  alertQueue.push(donation);
  if (!alertPlaying) processNextAlert();
});

function processNextAlert() {
  if (alertQueue.length === 0) {
    alertPlaying = false;
    return;
  }
  alertPlaying = true;
  playAlert(alertQueue.shift());
}

function playAlert(donation) {
  // Populate the alert panel.
  alertUsername.textContent = donation.username;
  alertAmount.textContent   = `$${Math.round(donation.amount)}`;

  // Try to play the donation sound.
  // OBS CEF blocks autoplay by default — the host must enable
  // "Allow audio autoplay" in the browser source properties.
  // We warn to the console instead of swallowing silently (#5).
  donationSound.currentTime = 0;
  donationSound.play().catch((err) => {
    console.warn('[overlay] Audio autoplay blocked:', err.message,
      '→ Enable "Allow audio autoplay" in OBS browser source settings.');
  });

  // Fade out normal content, fade in alert panel.
  normalContent.classList.add('fading');
  alertPanel.classList.add('visible');

  // After 5 seconds dismiss the alert.
  setTimeout(() => {
    alertPanel.classList.remove('visible');
    normalContent.classList.remove('fading');

    // Tell the server this alert is done so it can reveal the donation
    // to the admin dashboard.
    socket.emit('alert:complete', { id: donation.id });

    // Wait for the CSS fade-out to finish before playing the next alert.
    setTimeout(processNextAlert, 600);
  }, 5000);
}

// ── Initialise ─────────────────────────────────────────────────────────────────

loadMedia();
loadTotal();
