const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const geoip = require('geoip-lite'); // npm install geoip-lite

const app = express();
const PORT = process.env.PORT || 3086;
const DB_FILE = path.join(__dirname, 'clicks.json');

// TESTING ONLY: set DISABLE_PRESS_LIMIT=true in the environment to allow
// unlimited presses per token. Never set this in production — it turns
// off the entire "one press per day" enforcement.
const DISABLE_PRESS_LIMIT = process.env.DISABLE_PRESS_LIMIT === 'true';

// Restrict CORS to your own domain(s). Add your Vercel domain(s) here.
const ALLOWED_ORIGINS = [
    'https://86.yourdomain.com',
    'https://project-86-live.vercel.app',
    'http://localhost:3000'
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json());

/* ==========================================
   DATABASE (JSON file for now)

   NOTE: for real production traffic, swap this
   for SQLite or Postgres. A single JSON file will
   not hold up well much beyond a few requests/sec,
   even with the write-lock below.
========================================== */

function getDb() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = { total: 0, countries: {}, tokens: {} };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData));
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        // Corrupted file — do not wipe silently, fail loudly instead.
        throw new Error('Database file is corrupted: ' + e.message);
    }
}

function saveDb(data) {
    // Write to a temp file first, then rename — avoids leaving a
    // half-written (corrupted) clicks.json if the process crashes mid-write.
    const tmpFile = DB_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, DB_FILE);
}

/* ==========================================
   WRITE LOCK

   Express handles requests concurrently, so two
   /api/press calls can interleave and lose an
   increment. This queues writes one at a time.
========================================== */

let writeQueue = Promise.resolve();

function withWriteLock(fn) {
    const result = writeQueue.then(fn);
    // Swallow errors here so one failed write doesn't jam the whole queue —
    // the caller still gets the rejection via `result`.
    writeQueue = result.catch(() => {});
    return result;
}

/* ==========================================
   TODAY (UTC) — the actual one-press boundary.
   The frontend's localStorage check is just a
   convenience; this is the real rule.
========================================== */

function todayUTC() {
    return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/* ==========================================
   COUNTRY LOOKUP

   Prefers a proxy-supplied header (Cloudflare/Vercel),
   falls back to geoip-lite on the raw IP so this also
   works on a bare DigitalOcean droplet.
========================================== */

function resolveCountry(req) {
    const headerCountry =
        req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'];

    if (headerCountry) {
        return headerCountry.toUpperCase();
    }

    const ip =
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress ||
        '';

    const lookup = geoip.lookup(ip);
    return lookup && lookup.country ? lookup.country : 'UN';
}

/* ==========================================
   GET /api/stats
========================================== */

app.get('/api/stats', (req, res) => {
    try {
        const db = getDb();
        res.json({
            total: db.total,
            countries: db.countries
        });
    } catch (e) {
        res.status(500).json({ error: 'Could not read stats.' });
    }
});

/* ==========================================
   GET /api/world
========================================== */

app.get('/api/world', (req, res) => {
    try {
        const db = getDb();
        const countries = db.countries || {};
        const countryCount = Object.keys(countries).length;

        const topCountries = Object.entries(countries)
            .map(([code, count]) => ({ code, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        res.json({
            total: db.total,
            topCountries,
            countryCount
        });
    } catch (e) {
        res.status(500).json({ error: 'Could not read world stats.' });
    }
});

/* ==========================================
   GET /api/status?token=...

   Lets the frontend know, on page load, whether
   this token has already pressed today — without
   registering a press. Used to lock the button
   immediately instead of only finding out via a
   409 after the click animation has already played.
========================================== */

app.get('/api/status', (req, res) => {

    const token = req.query.token;

    if (!token || typeof token !== 'string' || token.length < 16) {
        return res.status(400).json({ error: 'Missing or invalid token.' });
    }

    try {
        const db = getDb();
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const today = todayUTC();

        const pressedToday = !DISABLE_PRESS_LIMIT && db.tokens[tokenHash] === today;

        res.json({
            pressedToday,
            total: db.total
        });
    } catch (e) {
        res.status(500).json({ error: 'Could not read status.' });
    }
});

/* ==========================================
   POST /api/press

   Requires a `token` in the body — a random,
   non-identifying string the client generates once
   and stores locally. The server enforces the actual
   one-press-per-day rule against that token, since the
   frontend's localStorage check alone can be bypassed
   by anyone calling this endpoint directly.
========================================== */

app.post('/api/press', async (req, res) => {

    const { token } = req.body;

    if (!token || typeof token !== 'string' || token.length < 16) {
        return res.status(400).json({ error: 'Missing or invalid token.' });
    }

    // Hash the token before storing — we never need the raw value again,
    // and this keeps stored data non-reversible.
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const today = todayUTC();

    try {
        const result = await withWriteLock(() => {

            const db = getDb();

            if (!DISABLE_PRESS_LIMIT && db.tokens[tokenHash] === today) {
                return { alreadyPressed: true, db };
            }

            const country = resolveCountry(req);

            db.total += 1;
            db.countries[country] = (db.countries[country] || 0) + 1;
            db.tokens[tokenHash] = today;

            saveDb(db);

            return { alreadyPressed: false, db, country };
        });

        if (result.alreadyPressed) {
            return res.status(409).json({
                error: 'Already pressed today.',
                total: result.db.total
            });
        }

        res.json({
            success: true,
            total: result.db.total,
            yourCountry: result.country,
            countries: result.db.countries
        });

    } catch (e) {
        res.status(500).json({ error: 'Could not register press.' });
    }
});

app.listen(PORT, () => {
    console.log(`Project 86 Server running on port ${PORT}`);
});
