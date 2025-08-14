// index.js — SBRI service v1.7
// Adds CCJ endpoint + safe, minimal deps + keeps search/profile/filings/director changes/scored

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ---- DB ----
if (!process.env.MONGO_URI) {
  console.error('❌ MONGO_URI not set');
  process.exit(1);
}
const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

// ---- Helpers ----
const ok = (res, data) => res.json(data);
const fail = (res, code, http = 500) => res.status(http).json({ error: code });
const parseNum = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
const toDate = (v) => v ? new Date(v) : null;

// Try getting a best-effort "status" or event date from many possible fields in change docs.
function directorChangeNormalizeStage() {
  const fields = [
    'effective_date','event_date','change_date','date',
    'appointed_on','appointment_date',
    'resigned_on','resignation_date',
    'notified_on','updated_at','created_at'
  ];
  const eventDateExpr = fields.reduceRight((acc, f) => ({ $ifNull: [ `$${f}`, acc ] }), null);
  return {
    $set: {
      event_date: eventDateExpr,
      type_text: {
        $trim: {
          input: {
            $concat: [
              { $ifNull: ['$type', ''] }, ' ',
              { $ifNull: ['$change_type', ''] }, ' ',
              { $ifNull: ['$action', ''] }
            ]
          }
        }
      }
    }
  };
}

// ---- Health ----
app.get('/api/health', (_req, res) => ok(res, { ok: true, service: 'sbri', version: 'v1.7' }));

// ---- Search by company name (profiles text index recommended) ----
app.get('/api/sbri/search', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return ok(res, []);
    const col = db.collection('profiles');
    // Ensure index exists (idempotent)
    await col.createIndex({ company_name: 'text' });

    const q = [{ company_name: { $regex: name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }];
    const rows = await col.find({ $or: q })
      .project({ company_number: 1, company_name: 1, status: 1, jurisdiction: 1 })
      .limit(50)
      .toArray();

    ok(res, rows);
  } catch (e) {
    console.error(e);
    fail(res, 'search_failed');
  }
});

// ---- Company profile (joins basic + sbri business profile if present) ----
app.get('/api/sbri/company/:number/profile', async (req, res) => {
  try {
    const n = String(req.params.number);
    const profiles = db.collection('profiles');
    const sbri = db.collection('sbri_business_profiles');
    const fin = db.collection('financial_accounts');

    const [profile, sbriDoc, lastFin] = await Promise.all([
      profiles.findOne({ company_number: n }),
      sbri.findOne({ company_number: n }),
      fin.find({ company_number: n }).sort({ period_end: -1 }).limit(1).next()
    ]);

    if (!profile) return fail(res, 'profile_not_found', 404);

    ok(res, {
      profile: {
        company_number: profile.company_number,
        company_name: profile.company_name,
        status: profile.status || 'unknown',
        incorporation_date: profile.incorporation_date || profile.incorporated_on || null,
        address: profile.address || profile.registered_office_address || null,
        sic: profile.sic || profile.sic_codes || null,
      },
      sbri: sbriDoc || null,
      latest_accounts: lastFin || null
    });
  } catch (e) {
    console.error(e);
    fail(res, 'profile_fetch_failed');
  }
});

// ---- Filing history ----
app.get('/api/sbri/company/:number/filings', async (req, res) => {
  try {
    const n = String(req.params.number);
    const col = db.collection('filings');
    const items = await col.find({ company_number: n })
      .sort({ filing_date: -1 })
      .limit(200)
      .toArray();
    ok(res, items);
  } catch (e) {
    console.error(e);
    fail(res, 'filings_fetch_failed');
  }
});

// ---- Director changes (paged + optional from/to filter + small summary) ----
app.get('/api/sbri/company/:number/director-changes', async (req, res) => {
  try {
    const n = String(req.params.number);
    const page = Math.max(1, parseNum(req.query.page, 1));
    const size = Math.min(100, parseNum(req.query.size, 25));
    const from = toDate(req.query.from);
    const to = toDate(req.query.to);

    const col = db.collection('director_changes');

    const match = { company_number: n };
    if (from || to) {
      match.$expr = {
        $and: [
          { $gte: [ { $ifNull: ['$event_date', '$date'] }, from || new Date('1900-01-01') ] },
          { $lte: [ { $ifNull: ['$event_date', '$date'] }, to || new Date('2999-12-31') ] }
        ]
      };
    }

    const pipeline = [
      { $match: match },
      directorChangeNormalizeStage(),
      { $sort: { event_date: -1 } },
      { $facet: {
          total: [{ $count: 'n' }],
          items: [{ $skip: (page - 1) * size }, { $limit: size }]
      }}
    ];
    const agg = await col.aggregate(pipeline).toArray();
    const { total = [], items = [] } = agg[0] || {};
    const totalCount = total[0]?.n || 0;
    ok(res, { page, size, total: totalCount, items });
  } catch (e) {
    console.error(e);
    fail(res, 'director_changes_failed');
  }
});

// ---- Simple scored endpoint (kept lightweight; hook for CCJ impact if needed) ----
app.get('/api/sbri/company/:number/scored', async (req, res) => {
  try {
    const n = String(req.params.number);
    const profiles = db.collection('profiles');
    const sbri = db.collection('sbri_business_profiles');

    const [profile, sbriDoc] = await Promise.all([
      profiles.findOne({ company_number: n }),
      sbri.findOne({ company_number: n })
    ]);
    if (!profile) return fail(res, 'profile_not_found', 404);

    const margin = sbriDoc?.sector?.avg_margin ?? 0.06;
    const failure = sbriDoc?.sector?.failure_rate ?? 0.04;

    // Simple illustrative score (0-100)
    let score = 70 + (margin * 100 - 6) - (failure * 100);
    score = Math.max(1, Math.min(99, Math.round(score)));

    let level = 'medium';
    if (score >= 75) level = 'low';
    if (score <= 45) level = 'high';

    const reasons = [
      `Gross margin ~ ${(margin * 100).toFixed(1)}%`,
      `Sector failure ~ ${(failure * 100).toFixed(1)}%`,
      level === 'high' ? 'High risk band' : level === 'medium' ? 'Medium risk band' : 'Low risk band'
    ];

    ok(res, { profile, risk: { score, level, reasons } });
  } catch (e) {
    console.error(e);
    fail(res, 'profile_scored_failed');
  }
});

// ---- NEW: CCJ endpoint (paged + summary) ----
app.get('/api/sbri/company/:number/ccj', async (req, res) => {
  try {
    const n = String(req.params.number);
    const page = Math.max(1, parseNum(req.query.page, 1));
    const size = Math.min(100, parseNum(req.query.size, 25));

    const col = db.collection('sbri_ccj_details');

    const items = await col.find({ company_number: n })
      .sort({ judgment_date: -1 })
      .skip((page - 1) * size)
      .limit(size)
      .toArray();

    const summaryAgg = await col.aggregate([
      { $match: { company_number: n } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          total_amount: { $sum: { $ifNull: ['$amount', 0] } },
          unsatisfied: {
            $sum: {
              $cond: [
                { $in: [{ $toLower: { $ifNull: ['$status', ''] } }, ['open','unsatisfied','outstanding']] },
                1, 0
              ]
            }
          },
          latest_judgment_date: { $max: '$judgment_date' }
        }
      },
      { $project: { _id: 0 } }
    ]).toArray();

    const summary = summaryAgg[0] || { total: 0, total_amount: 0, unsatisfied: 0, latest_judgment_date: null };

    ok(res, { page, size, summary, items });
  } catch (e) {
    console.error(e);
    fail(res, 'ccj_fetch_failed');
  }
});

// ---- Boot ----
app.listen(process.env.PORT || 3000, () => {
  console.log(`SBRI service running on port ${process.env.PORT || 3000}`);
});
