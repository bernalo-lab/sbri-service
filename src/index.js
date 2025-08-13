// index.js — SBRI service v1.2 (Latest Accounts fix + Status injector)
// Baseline: index_v1.1.js

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

/**
 * Injects business status from sbri_business_profiles into an existing profile object
 * (kept from v1.1)
 */
async function injectBusinessStatus(db, companyNumber, profileObj) {
  try {
    const doc = await db.collection('sbri_business_profiles')
      .findOne({ company_number: companyNumber }, { projection: { status: 1 } });
    const s = doc && doc.status ? String(doc.status).trim() : null;
    if (s && !profileObj.status) {
      profileObj.status = s[0].toUpperCase() + s.slice(1).toLowerCase();
    }
  } catch (_) {}
  return profileObj;
}

/**
 * Loads the most recent accounts document for a company from the first
 * available collection. We keep names broad in case your data sits in a
 * slightly different collection in other environments.
 */
async function loadLatestAccounts(db, companyNumber) {
  const candidates = [
    'financial_accounts',
    'sbri_financial_accounts',
    'company_accounts',
    'accounts'
  ];
  for (const coll of candidates) {
    try {
      const arr = await db.collection(coll)
        .find({ company_number: companyNumber })
        .sort({ period_end: -1, periodEnd: -1, year: -1 })
        .limit(1)
        .toArray();
      if (arr && arr[0]) return arr[0];
    } catch (_) { /* collection may not exist; skip */ }
  }
  return null;
}

// ----------------- Endpoints -----------------

app.get('/api/sbri/health', async (req, res) => {
  const profilesCount = await db.collection('profiles').countDocuments();
  res.json({ status: 'ok', profiles: profilesCount });
});

// Search by company name (uses the 'profiles' collection you seeded)
app.get('/api/sbri/search', async (req, res) => {
  const name = String(req.query.name || '');
  if (!name) return res.json([]);
  const items = await db.collection('profiles')
    .find({ company_name: { $regex: name, $options: 'i' } })
    .limit(50)
    .toArray();
  res.json(items);
});

// Single company profile — now includes `latest_accounts` on the profile object
app.get('/api/sbri/company/:number', async (req, res) => {
  try {
    const n = String(req.params.number);
    const base = await db.collection('profiles').findOne({ company_number: n }) || {};
    const withStatus = await injectBusinessStatus(db, n, base);

    // NEW in v1.2: attach latest_accounts so the UI can read it directly
    if (!withStatus.latest_accounts) {
      const latest = await loadLatestAccounts(db, n);
      if (latest) withStatus.latest_accounts = latest;
    }

    res.json(withStatus);
  } catch (e) {
    res.status(500).json({ error: 'profile_lookup_failed' });
  }
});

// ----- Filings (paged) -----
app.get('/api/sbri/company/:number/filings', async (req, res) => {
  const n = req.params.number;
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(100, Number(req.query.size || 25));
  const items = await db.collection('filings')
    .find({ company_number: n })
    .sort({ filing_date: -1 })
    .skip((page - 1) * size)
    .limit(size)
    .toArray();
  res.json({ page, size, items });
});

// ----- Sector benchmark by SIC -----
app.get('/api/sbri/sector/:sic', async (req, res) => {
  const doc = await db.collection('sector_stats')
    .findOne({ sic_code: req.params.sic });
  res.json(doc || {});
});

// ----- Insolvency notices for a company -----
app.get('/api/sbri/insolvency/:number', async (req, res) => {
  const items = await db.collection('insolvency_notices')
    .find({ company_number: req.params.number })
    .sort({ notice_date: -1 })
    .limit(50)
    .toArray();
  res.json({ items });
});

// ----- "Full" company view used by the UI (unchanged shape; uses same loader) -----
app.get('/api/sbri/company/:number/full', async (req, res) => {
  try {
    const n = String(req.params.number);
    const base = await db.collection('profiles').findOne({ company_number: n }) || {};
    const profile = await injectBusinessStatus(db, n, base);

    const latest = await loadLatestAccounts(db, n);

    res.json({ company_number: n, profile, latest_accounts: latest || null });
  } catch (e) {
    res.status(500).json({ error: 'profile_full_failed' });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`SBRI service running on port ${process.env.PORT || 3000}`);
});
