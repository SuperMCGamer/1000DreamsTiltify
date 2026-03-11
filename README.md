# Friday the Herteenth – Charity Livestream Overlay

An OBS browser overlay + live admin dashboard for a charity event. Powered by
Node.js, Express, Socket.io, SQLite, and the Tiltify V5 API.

---

## Features

- **Overlay** (`/overlay`) – 500×250 px browser source for OBS
  - Rotating logos and slides in sync (8-second crossfade)
  - Live donation total updated in real time
  - Queued donation alerts (sound + name + amount, 5 s each)
- **Admin dashboard** (`/admin`)
  - Donations appear only *after* the alert has played (no spoilers)
  - "Read" checkboxes synced across all open admin tabs
  - Hidden developer panel for simulating donations
- **Tiltify integration** – polls the V5 API every 10 seconds
- **Persistent storage** – SQLite so donations survive server restarts
- **Deployable on Render** – free tier compatible

---

## Quick Start (local)

### 1. Install dependencies

```bash
npm install
```

> `better-sqlite3` compiles a small native addon. You need a C++ build toolchain
> (`build-essential` on Linux, Xcode Command Line Tools on macOS).

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your values (see [Environment Variables](#environment-variables) below).

### 3. Add your media files

| Folder | Purpose |
|---|---|
| `public/logos/` | Partner / sponsor logos shown in the top half of the overlay |
| `public/slides/` | Promo / info images shown in the bottom half of the overlay |
| `public/assets/donation.mp3` | Sound played when a donation alert fires |

Supported image formats: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.svg`

Files are scanned automatically – no code changes needed.

### 4. Start the server

```bash
npm start
```

Or with auto-restart during development:

```bash
npm run dev
```

The terminal will print:

```
🎗  Friday the Herteenth server running on port 3000
   Overlay : http://localhost:3000/overlay
   Admin   : http://localhost:3000/admin
```

---

## Environment Variables

Create a `.env` file in the project root (copy from `.env.example`):

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default `3000`; Render sets this automatically) |
| `TILTIFY_CLIENT_ID` | Yes | OAuth app client ID from Tiltify Developer settings |
| `TILTIFY_CLIENT_SECRET` | Yes | OAuth app client secret |
| `TILTIFY_CAMPAIGN_ID` | Yes | Numeric ID of your Tiltify campaign |
| `POLL_INTERVAL_MS` | No | How often to poll Tiltify in ms (default `10000`) |

### Where to find your Tiltify credentials

1. Log in to [dashboard.tiltify.com](https://dashboard.tiltify.com/)
2. Go to **Your account → Integrations → Applications**
3. Create a new application – copy the **Client ID** and **Client Secret**
4. Your **Campaign ID** is in the URL when you open your campaign:
   `https://dashboard.tiltify.com/@you/campaigns/12345` → ID is `12345`

---

## Deploying on Render

### First deploy

1. Push this repo to GitHub (or GitLab).
2. Go to [render.com](https://render.com/) → **New → Web Service**.
3. Connect your repository.
4. Configure the service:

   | Setting | Value |
   |---|---|
   | **Environment** | `Node` |
   | **Build command** | `npm install` |
   | **Start command** | `npm start` |
   | **Instance type** | Free (or higher for uptime guarantee) |

5. Under **Environment Variables**, add all variables from your `.env` file.
6. Click **Create Web Service**.

### Persistent disk (important!)

The SQLite database lives in `./data/donations.db`. Render's free tier uses an
ephemeral filesystem – the file is lost on redeploys.

To persist donations across deploys:

1. Add a **Render Disk** (Render dashboard → your service → **Disks**).
2. Set mount path to `/opt/render/project/src/data`.
3. The database file will survive restarts and deploys.

Alternatively, if you are comfortable with it, you can swap `better-sqlite3`
for a hosted Postgres database; the data layer in `server.js` is isolated
enough to make this a small change.

---

## OBS Browser Source Setup

1. In OBS, add a new **Browser Source**.
2. Enter the URL of your deployed server (or `http://localhost:3000` for local):

   ```
   https://your-app.onrender.com/overlay
   ```

3. Set:
   - **Width**: `500`
   - **Height**: `250`
   - **Custom CSS**: *(leave blank)*

4. Enable **"Shutdown source when not visible"** – optional but reduces CPU.

The overlay has a transparent background by default so it layers cleanly over
your stream.

---

## Adding Logos and Slides

Drop image files directly into the folders:

```
public/logos/   ← partner logos, charity branding, etc.
public/slides/  ← info cards, sponsor slides, countdown graphics, etc.
```

- Files are served alphabetically, so prefix with `01_`, `02_`, … to control order.
- The server rescans these folders on every `/api/media` request, so you can
  add files while the server is running and they will appear at the next rotation.
- Both the logo area and slide area advance on the **same 8-second timer** so
  they stay in sync.

---

## Developer: Simulating Donations

1. Open `/admin` in your browser.
2. Scroll to the bottom and click **Advanced ▾**.
3. Enter a donor name and amount, then click **Send Donation**.

The donation goes through the exact same path as a real Tiltify donation:
- Alert plays on every open overlay instance
- Donation appears in the admin list only after the alert finishes

---

## Project Structure

```
/
├── server.js               Main Express + Socket.io server
├── package.json
├── .env.example            Template for environment variables
├── .gitignore
├── README.md
├── data/
│   └── donations.db        SQLite database (auto-created at startup)
└── public/
    ├── overlay/
    │   ├── index.html
    │   ├── overlay.css
    │   └── overlay.js
    ├── admin/
    │   ├── index.html
    │   ├── admin.css
    │   └── admin.js
    ├── assets/
    │   └── donation.mp3    ← add your own sound file here
    ├── logos/              ← drop logo images here
    └── slides/             ← drop slide images here
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| HTTP server | Express 4 |
| Realtime | Socket.io 4 |
| Database | SQLite via `better-sqlite3` |
| Frontend | Vanilla HTML / CSS / JS |
| Font | Poppins (Google Fonts) |
| Donations API | Tiltify V5 |
