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

// Optional: fetch one company by number
app.get('/api/sbri/company/:number', async (req, res) => {
  const doc = await db.collection('profiles')
    .findOne({ company_number: req.params.number });
  res.json(doc || {});
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

// ----- "Full" company view used by the UI (profile + latest accounts quick look) -----
app.get('/api/sbri/company/:number/full', async (req, res) => {
  const n = req.params.number;
  const profile = await db.collection('profiles').findOne({ company_number: n });
  const latest = await db.collection('financial_accounts')
    .find({ company_number: n })
    .sort({ period_end: -1 })
    .limit(1)
    .toArray();
  res.json({
    company_number: n,
    profile,
    latest_accounts: latest[0] || null
  });
});


app.listen(process.env.PORT || 3000, () => {
  console.log(`SBRI service running on port ${process.env.PORT || 3000}`);
});
