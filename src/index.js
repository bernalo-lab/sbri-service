// index.js — SBRI API (v8.33 backend status fix)
// ------------------------------------------------

const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/sbri';
const DB_NAME = process.env.DB_NAME || undefined; // if omitted, taken from URI
const PRIMARY_PROFILE_COLL = process.env.SBRI_PROFILE_COLL || 'sbri_business_profiles';
const FALLBACK_PROFILE_COLLS = ['profiles', 'companies', 'company_profiles'];

// Allow from your site(s) + localhost by default; override with ALLOWED_ORIGINS if you like.
const DEFAULT_ORIGINS = [
  'https://insuresandbox.com',
  'https://www.insuresandbox.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000'
];
const ALLOWED = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);

// Strong CORS for browsers
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);             // curl/postman
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);                          // block others by default
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 86400
}));

// Ensure error responses also include CORS (Express + cors() generally does this)
app.use((req, res, next) => {
  res.setHeader('Vary', 'Origin');
  next();
});

// ---------- DB ----------
let client, db;

function pick(obj, path) {
  return path.split('.').reduce((a, k) => (a && a[k] !== undefined) ? a[k] : undefined, obj);
}

function coalesceStatus(doc) {
  if (!doc) return null;
  const candidates = [
    'status',            // sbri_business_profiles.status (preferred)
    'company_status',
    'companyStatus',
    'data.status',
    'company.status'
  ];
  for (const p of candidates) {
    const v = pick(doc, p);
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
  }
  return null;
}

function normaliseProfile(doc) {
  if (!doc) return null;

  // status
  const status = coalesceStatus(doc);
  const prettyStatus = status ? (status[0].toUpperCase() + status.slice(1).toLowerCase()) : null;

  // sic codes
  const sic_codes = Array.isArray(doc.sic_codes)
    ? doc.sic_codes
    : [doc.sic_code, doc.sic, doc.sicCodes].filter(Boolean).flat();

  // region
  const region = doc.region || (doc.registered_office_address?.locality ?? null);

  return {
    ...doc,
    status: prettyStatus ?? status ?? null,
    sic_codes,
    region
  };
}

async function loadProfileByNumber(companyNumber) {
  // 1) Preferred collection first (sbri_business_profiles)
  try {
    const primary = await db.collection(PRIMARY_PROFILE_COLL).findOne({ company_number: companyNumber });
    if (primary) return { doc: primary, source: PRIMARY_PROFILE_COLL };
  } catch (e) {
    // ignore if collection missing
  }
  // 2) fallbacks
  for (const coll of FALLBACK_PROFILE_COLLS) {
    try {
      const d = await db.collection(coll).findOne({ company_number: companyNumber });
      if (d) return { doc: d, source: coll };
    } catch {}
  }
  return { doc: null, source: null };
}

// ---------- Helpers ----------
function parseIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function regexInsensitive(text) {
  // Escape special regex chars and make case-insensitive search
  const escaped = String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

// ---------- Routes (prefix: /api/sbri) ----------
const base = '/api/sbri';

// Health: quick count + service ok
app.get(`${base}/health`, async (req, res) => {
  try {
    const coll = db.collection(PRIMARY_PROFILE_COLL);
    let profiles = 0;
    try { profiles = await coll.countDocuments(); } catch {}
    res.json({ ok: true, counts: { profiles } });
  } catch (e) {
    // Still respond with JSON (so browser CORS is happy)
    res.status(500).json({ ok: false, error: 'health_failed' });
  }
});

// Search by company name (limited fields)
app.get(`${base}/search`, async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.json([]);

  const rx = regexInsensitive(name);
  const limit = parseIntOr(req.query.limit, 10) || 10;

  // Search in preferred profile collection first, then fallbacks if empty
  const out = [];
  async function pushFrom(collName) {
    try {
      const cur = db.collection(collName)
        .find({ company_name: rx })
        .project({
          _id: 0,
          company_number: 1,
          company_name: 1,
          region: 1,
          sic_codes: 1,
          registered_office_address: 1
        })
        .limit(limit);
      const docs = await cur.toArray();
      out.push(...docs);
    } catch {}
  }

  await pushFrom(PRIMARY_PROFILE_COLL);
  if (out.length === 0) {
    for (const coll of FALLBACK_PROFILE_COLLS) {
      await pushFrom(coll);
      if (out.length) break;
    }
  }

  // Normalise results just like profile
  const norm = out.map(normaliseProfile);
  res.json(norm);
});

// Single company profile (normalised, with status)
app.get(`${base}/company/:number`, async (req, res) => {
  try {
    const n = String(req.params.number);
    const { doc } = await loadProfileByNumber(n);
    const out = normaliseProfile(doc);
    res.json(out || {});
  } catch (e) {
    res.status(500).json({ error: 'profile_lookup_failed' });
  }
});

// "Scored" view (optional; returns risk score if you store it)
app.get(`${base}/company/:number/scored`, async (req, res) => {
  try {
    const n = String(req.params.number);
    const { doc } = await loadProfileByNumber(n);
    const profile = normaliseProfile(doc);

    // Try to find a risk score doc (collection name is a guess; adjust if needed)
    let riskDoc = null;
    try {
      riskDoc = await db.collection('sbri_risk_scores')
        .find({ company_number: n })
        .sort({ updated_at: -1 })
        .limit(1)
        .toArray();
      riskDoc = riskDoc[0] || null;
    } catch {}

    const risk = riskDoc ? {
      score: Number(riskDoc.score),
      reasons: Array.isArray(riskDoc.reasons) ? riskDoc.reasons : []
    } : null;

    res.json({ profile, risk });
  } catch (e) {
    res.status(500).json({ error: 'profile_scored_failed' });
  }
});

// Filing history (paged)
app.get(`${base}/company/:number/filings`, async (req, res) => {
  try {
    const n = String(req.params.number);
    const page = Math.max(parseIntOr(req.query.page, 1), 1);
    const size = Math.min(Math.max(parseIntOr(req.query.size, 25), 1), 100);

    // Try likely collections in order
    const collNames = ['sbri_filings', 'company_filings', 'filings'];
    let items = [];
    for (const cn of collNames) {
      try {
        const cur = db.collection(cn)
          .find({ company_number: n })
          .sort({ filing_date: -1 })
          .skip((page - 1) * size)
          .limit(size);
        items = await cur.toArray();
        if (items.length || (await db.collection(cn).countDocuments({ company_number: n })) > 0) break;
      } catch {}
    }

    res.json({ page, size, items });
  } catch (e) {
    res.status(500).json({ error: 'filings_failed' });
  }
});

// Sector benchmark by SIC
app.get(`${base}/sector/:sic`, async (req, res) => {
  try {
    const sic = String(req.params.sic);
    // Choose a default region if your sector stats are per-region; keep London to match your screenshots
    const region = String(req.query.region || 'London');

    // Try likely sector collections
    const collNames = ['sbri_sector_stats', 'sector_stats', 'sectors'];
    let doc = null;
    for (const cn of collNames) {
      try {
        doc = await db.collection(cn).findOne({ sic_code: sic, region });
        if (!doc) doc = await db.collection(cn).findOne({ sic_code: sic }); // fallback without region
        if (doc) break;
      } catch {}
    }

    if (!doc) return res.json({});

    // Normalise a few likely fields for the UI
    const out = {
      sic_code: doc.sic_code || sic,
      region: doc.region || region,
      avg_margin: doc.avg_margin ?? doc.average_margin ?? null,
      failure_rate: doc.failure_rate ?? doc.default_rate ?? null,
      sample_size: doc.sample_size ?? doc.n ?? null,
      period: doc.period || doc.year || null
    };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'sector_failed' });
  }
});

// Full view (profile + latest accounts)
app.get(`${base}/company/:number/full`, async (req, res) => {
  try {
    const n = String(req.params.number);
    const { doc } = await loadProfileByNumber(n);
    const profile = normaliseProfile(doc);

    let latest = null;
    try {
      const docs = await db.collection('financial_accounts')
        .find({ company_number: n })
        .sort({ period_end: -1 })
        .limit(1)
        .toArray();
      latest = docs[0] || null;
    } catch {}

    res.json({ company_number: n, profile, latest_accounts: latest });
  } catch (e) {
    res.status(500).json({ error: 'profile_full_failed' });
  }
});

// ---------- Boot ----------
(async () => {
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME); // if undefined, driver chooses DB from URI
    console.log('[SBRI] Connected to MongoDB');

    // Helpful index (won’t error if exists)
    try {
      await db.collection(PRIMARY_PROFILE_COLL).createIndex({ company_number: 1 }, { unique: true });
    } catch {}

    app.listen(PORT, () => {
      console.log(`[SBRI] API listening on :${PORT}`);
      console.log(`[SBRI] Primary profile collection: ${PRIMARY_PROFILE_COLL}`);
      console.log(`[SBRI] Allowed origins: ${ALLOWED.join(', ')}`);
    });
  } catch (e) {
    console.error('[SBRI] Failed to start server:', e);
    process.exit(1);
  }
})();
