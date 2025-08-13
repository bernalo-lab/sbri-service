// index.js — SBRI API (ESM) — v8.33 backend status + CORS

import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/sbri";
const DB_NAME = process.env.DB_NAME || undefined; // if omitted, taken from URI
const PRIMARY_PROFILE_COLL =
  process.env.SBRI_PROFILE_COLL || "sbri_business_profiles";
const FALLBACK_PROFILE_COLLS = ["profiles", "companies", "company_profiles"];

// Allow from your site(s) + localhost by default; override with ALLOWED_ORIGINS if needed.
const DEFAULT_ORIGINS = [
  "https://insuresandbox.com",
  "https://www.insuresandbox.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
];
const ALLOWED = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);

// Strong CORS for browsers
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl/postman
      if (ALLOWED.includes(origin)) return cb(null, true);
      return cb(null, false); // block others by default
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 86400,
  })
);

// Ensure error responses also include CORS
app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

// ---------- DB helpers ----------
let client, db;

const base = "/api/sbri";

const pick = (obj, path) =>
  path
    .split(".")
    .reduce((a, k) => (a && a[k] !== undefined ? a[k] : undefined), obj);

function coalesceStatus(doc) {
  if (!doc) return null;
  const candidates = [
    "status", // sbri_business_profiles.status (preferred)
    "company_status",
    "companyStatus",
    "data.status",
    "company.status",
  ];
  for (const p of candidates) {
    const v = pick(doc, p);
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return null;
}

function normaliseProfile(doc) {
  if (!doc) return null;

  const status = coalesceStatus(doc);
  const prettyStatus = status
    ? status[0].toUpperCase() + status.slice(1).toLowerCase()
    : null;

  const sic_codes = Array.isArray(doc.sic_codes)
    ? doc.sic_codes
    : [doc.sic_code, doc.sic, doc.sicCodes].filter(Boolean).flat();

  const region = doc.region || (doc.registered_office_address?.locality ?? null);

  return {
    ...doc,
    status: prettyStatus ?? status ?? null, // canonical field for UI
    sic_codes,
    region,
  };
}

async function loadProfileByNumber(companyNumber) {
  // 1) preferred collection first
  try {
    const primary = await db
      .collection(PRIMARY_PROFILE_COLL)
      .findOne({ company_number: companyNumber });
    if (primary) return { doc: primary, source: PRIMARY_PROFILE_COLL };
  } catch {}
  // 2) fallbacks
  for (const coll of FALLBACK_PROFILE_COLLS) {
    try {
      const d = await db.collection(coll).findOne({ company_number: companyNumber });
      if (d) return { doc: d, source: coll };
    } catch {}
  }
  return { doc: null, source: null };
}

const parseIntOr = (v, f) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : f;
};
const regexInsensitive = (text) =>
  new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

// ---------- Routes ----------
app.get(`${base}/health`, async (req, res) => {
  try {
    let profiles = 0;
    try {
      profiles = await db.collection(PRIMARY_PROFILE_COLL).countDocuments();
    } catch {}
    res.json({ ok: true, counts: { profiles } });
  } catch {
    res.status(500).json({ ok: false, error: "health_failed" });
  }
});

app.get(`${base}/search`, async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!name) return res.json([]);

  const rx = regexInsensitive(name);
  const limit = parseIntOr(req.query.limit, 10) || 10;

  const out = [];
  async function pushFrom(collName) {
    try {
      const cur = db
        .collection(collName)
        .find({ company_name: rx })
        .project({
          _id: 0,
          company_number: 1,
          company_name: 1,
          region: 1,
          sic_codes: 1,
          registered_office_address: 1,
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

  res.json(out.map(normaliseProfile));
});

app.get(`${base}/company/:number`, async (req, res) => {
  try {
    const n = String(req.params.number);
    const { doc } = await loadProfileByNumber(n);
    res.json(normaliseProfile(doc) || {});
  } catch {
    res.status(500).json({ error: "profile_lookup_failed" });
  }
});

// Optional scored endpoint (kept for UI toggle)
app.get(`${base}/company/:number/scored`, async (req, res) => {
  try {
    const n = String(req.params.number);
    const { doc } = await loadProfileByNumber(n);
    const profile = normaliseProfile(doc);

    let riskDoc = null;
    try {
      const arr = await db
        .collection("sbri_risk_scores")
        .find({ company_number: n })
        .sort({ updated_at: -1 })
        .limit(1)
        .toArray();
      riskDoc = arr[0] || null;
    } catch {}
    const risk = riskDoc
      ? {
          score: Number(riskDoc.score),
          reasons: Array.isArray(riskDoc.reasons) ? riskDoc.reasons : [],
        }
      : null;

    res.json({ profile, risk });
  } catch {
    res.status(500).json({ error: "profile_scored_failed" });
  }
});

app.get(`${base}/company/:number/filings`, async (req, res) => {
  try {
    const n = String(req.params.number);
    const page = Math.max(parseIntOr(req.query.page, 1), 1);
    const size = Math.min(Math.max(parseIntOr(req.query.size, 25), 1), 100);

    const collNames = ["sbri_filings", "company_filings", "filings"];
    let items = [];
    for (const cn of collNames) {
      try {
        const cur = db
          .collection(cn)
          .find({ company_number: n })
          .sort({ filing_date: -1 })
          .skip((page - 1) * size)
          .limit(size);
        items = await cur.toArray();
        if (items.length || (await db.collection(cn).countDocuments({ company_number: n })) > 0) break;
      } catch {}
    }

    res.json({ page, size, items });
  } catch {
    res.status(500).json({ error: "filings_failed" });
  }
});

app.get(`${base}/sector/:sic`, async (req, res) => {
  try {
    const sic = String(req.params.sic);
    const region = String(req.query.region || "London");

    const collNames = ["sbri_sector_stats", "sector_stats", "sectors"];
    let doc = null;
    for (const cn of collNames) {
      try {
        doc = await db.collection(cn).findOne({ sic_code: sic, region });
        if (!doc) doc = await db.collection(cn).findOne({ sic_code: sic });
        if (doc) break;
      } catch {}
    }
    if (!doc) return res.json({});

    const out = {
      sic_code: doc.sic_code || sic,
      region: doc.region || region,
      avg_margin: doc.avg_margin ?? doc.average_margin ?? null,
      failure_rate: doc.failure_rate ?? doc.default_rate ?? null,
      sample_size: doc.sample_size ?? doc.n ?? null,
      period: doc.period || doc.year || null,
    };
    res.json(out);
  } catch {
    res.status(500).json({ error: "sector_failed" });
  }
});

app.get(`${base}/company/:number/full`, async (req, res) => {
  try {
    const n = String(req.params.number);
    const { doc } = await loadProfileByNumber(n);
    const profile = normaliseProfile(doc);

    let latest = null;
    try {
      const docs = await db
        .collection("financial_accounts")
        .find({ company_number: n })
        .sort({ period_end: -1 })
        .limit(1)
        .toArray();
      latest = docs[0] || null;
    } catch {}

    res.json({ company_number: n, profile, latest_accounts: latest });
  } catch {
    res.status(500).json({ error: "profile_full_failed" });
  }
});

// ---------- Boot ----------
async function main() {
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME); // if undefined, parsed from URI
    console.log("[SBRI] Connected to MongoDB");

    try {
      await db
        .collection(PRIMARY_PROFILE_COLL)
        .createIndex({ company_number: 1 }, { unique: true });
    } catch {}

    app.listen(PORT, () => {
      console.log(`[SBRI] API listening on :${PORT}`);
      console.log(`[SBRI] Primary profile collection: ${PRIMARY_PROFILE_COLL}`);
      console.log(`[SBRI] Allowed origins: ${ALLOWED.join(", ")}`);
    });
  } catch (e) {
    console.error("[SBRI] Failed to start server:", e);
    process.exit(1);
  }
}
main();
