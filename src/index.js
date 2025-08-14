// index.js — SBRI service v1.6.2
// Baseline preserved. Adds CCJ endpoint: GET /api/sbri/company/:number/ccj

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

/* --- helpers kept from your baseline --- */
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

async function loadLatestAccounts(db, companyNumber) {
  const candidates = ['financial_accounts','sbri_financial_accounts','company_accounts','accounts'];
  for (const coll of candidates) {
    try {
      const arr = await db.collection(coll)
        .find({ company_number: companyNumber })
        .sort({ period_end: -1, periodEnd: -1, year: -1 })
        .limit(1)
        .toArray();
      if (arr && arr[0]) return arr[0];
    } catch (_) {}
  }
  return null;
}

/* --- Director changes with date range + summary (baseline) --- */
function coalesceDateStage() {
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
              { $ifNull: ['$change_type',''] }, ' ',
              { $ifNull: ['$type',''] }, ' ',
              { $ifNull: ['$action',''] }, ' ',
              { $ifNull: ['$description',''] }, ' ',
              { $ifNull: ['$text',''] }
            ]
          }
        }
      }
    }
  };
}
function dateRangeMatchStage(from, to) {
  if (!from && !to) return null;
  const cond = {};
  if (from) cond.$gte = from;
  if (to) cond.$lte = to;
  return { $match: { event_date: cond } };
}
function parseDateParam(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
async function loadDirectorChanges(db, companyNumber, { page = 1, size = 25, from, to } = {}) {
  const collections = [
    'officer_changes',
    'director_changes',
    'officers_changes',
    'officer_appointments',
    'appointments',
    'officers'
  ];

  const fromD = parseDateParam(from);
  const toD   = parseDateParam(to);

  for (const coll of collections) {
    try {
      const pre = [{ $match: { company_number: String(companyNumber) } }, coalesceDateStage()];
      const range = dateRangeMatchStage(fromD, toD);
      if (range) pre.push(range);

      const listPipeline = [
        ...pre,
        { $sort: { event_date: -1 } },
        { $skip: Math.max(0, (page - 1) * size) },
        { $limit: Math.min(100, size) },
        { $addFields: { raw: '$$ROOT' } }
      ];
      const arr = await db.collection(coll).aggregate(listPipeline).toArray();
      if (!arr || arr.length === 0) continue;

      const summaryPipeline = [
        ...pre,
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            appoint_fields: {
              $sum: {
                $cond: [
                  { $or: [ { $ifNull: ['$appointed_on', false] }, { $ifNull: ['$appointment_date', false] } ] },
                  1, 0
                ]
              }
            },
            resign_fields: {
              $sum: {
                $cond: [
                  { $or: [ { $ifNull: ['$resigned_on', false] }, { $ifNull: ['$resignation_date', false] } ] },
                  1, 0
                ]
              }
            },
            appoint_text: {
              $sum: {
                $cond: [
                  { $regexMatch: { input: '$type_text', regex: /appoint/i } },
                  1, 0
                ]
              }
            },
            resign_text: {
              $sum: {
                $cond: [
                  { $regexMatch: { input: '$type_text', regex: /resign/i } },
                  1, 0
                ]
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            total: 1,
            appointments: { $max: ['$appoint_fields', '$appoint_text'] },
            resignations: { $max: ['$resign_fields', '$resign_text'] }
          }
        }
      ];
      const sumDoc = await db.collection(coll).aggregate(summaryPipeline).toArray();
      const s = sumDoc[0] || { total: 0, appointments: 0, resignations: 0 };
      s.other = Math.max(0, (s.total || 0) - (s.appointments || 0) - (s.resignations || 0));

      const normalized = arr.map(doc => {
        const r = doc.raw || doc;
        const date = doc.event_date || r.effective_date || r.event_date || r.change_date || r.date ||
                     r.appointed_on || r.appointment_date || r.resigned_on || r.resignation_date ||
                     r.notified_on || r.updated_at || r.created_at || null;
        const explicitType = r.change_type || r.type || r.action || null;
        let inferred = explicitType ? String(explicitType) : '';
        const blob = (doc.type_text || '').toLowerCase();
        if (!inferred) {
          if (/resign/.test(blob)) inferred = 'Resigned';
          else if (/appoint/.test(blob)) inferred = 'Appointed';
        }
        const name =
          r.officer_name || r.name || r.person_name ||
          (r.officer && (r.officer.name || r.officer.person_name)) || null;
        const role = r.role || r.officer_role || r.position || null;
        const details =
          r.details || r.description || r.text ||
          (r.officer && (r.officer.details || r.officer.description)) || null;

        return {
          date,
          type: inferred ? inferred.replace(/\b\w/g, c => c.toUpperCase()) : null,
          name,
          role,
          details
        };
      });

      const countPipeline = [...pre, { $count: 'n' }];
      const countDoc = await db.collection(coll).aggregate(countPipeline).toArray();
      const totalDocs = countDoc[0]?.n || normalized.length;

      return { items: normalized, total: totalDocs, summary: s };
    } catch (_) {}
  }
  return { items: [], total: 0, summary: { total: 0, appointments: 0, resignations: 0, other: 0 } };
}

/* --- endpoints (baseline preserved) --- */
app.get('/api/sbri/health', async (_req, res) => {
  const profilesCount = await db.collection('profiles').countDocuments();
  res.json({ status: 'ok', profiles: profilesCount });
});

app.get('/api/sbri/search', async (req, res) => {
  const name = String(req.query.name || '');
  if (!name) return res.json([]);
  const items = await db.collection('profiles')
    .find({ company_name: { $regex: name, $options: 'i' } })
    .limit(50).toArray();
  res.json(items);
});

app.get('/api/sbri/company/:number', async (req, res) => {
  try {
    const n = String(req.params.number);
    const base = await db.collection('profiles').findOne({ company_number: n }) || {};
    const withStatus = await injectBusinessStatus(db, n, base);
    if (!withStatus.latest_accounts) {
      const latest = await loadLatestAccounts(db, n);
      if (latest) withStatus.latest_accounts = latest;
    }
    res.json(withStatus);
  } catch {
    res.status(500).json({ error: 'profile_lookup_failed' });
  }
});

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

// Director changes (baseline + range)
app.get('/api/sbri/company/:number/director-changes', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const size = Math.min(100, Number(req.query.size || 25));
    const from = req.query.from ? String(req.query.from) : null;
    const to   = req.query.to   ? String(req.query.to)   : null;

    const result = await loadDirectorChanges(db, String(req.params.number), { page, size, from, to });
    res.json({ page, size, ...result });
  } catch {
    res.status(500).json({ error: 'director_changes_failed' });
  }
});

app.get('/api/sbri/sector/:sic', async (req, res) => {
  const doc = await db.collection('sector_stats').findOne({ sic_code: req.params.sic });
  res.json(doc || {});
});

app.get('/api/sbri/insolvency/:number', async (req, res) => {
  const items = await db.collection('insolvency_notices')
    .find({ company_number: req.params.number })
    .sort({ notice_date: -1 })
    .limit(50).toArray();
  res.json({ items });
});

app.get('/api/sbri/company/:number/full', async (req, res) => {
  try {
    const n = String(req.params.number);
    const base = await db.collection('profiles').findOne({ company_number: n }) || {};
    const profile = await injectBusinessStatus(db, n, base);
    const latest = await loadLatestAccounts(db, n);
    res.json({ company_number: n, profile, latest_accounts: latest || null });
  } catch {
    res.status(500).json({ error: 'profile_full_failed' });
  }
});

app.get('/api/sbri/company/:number/scored', async (req, res) => {
  try {
    const n = String(req.params.number);
    const base = await db.collection('profiles').findOne({ company_number: n }) || {};
    const profile = await injectBusinessStatus(db, n, base);
    if (!profile.latest_accounts) {
      const latest = await loadLatestAccounts(db, n);
      if (latest) profile.latest_accounts = latest;
    }

    let stored = null;
    try {
      const arr = await db.collection('sbri_risk_scores')
        .find({ company_number: n }).sort({ updated_at: -1 }).limit(1).toArray();
      stored = arr[0] || null;
    } catch {}

    if (stored) {
      const score = Number(stored.score);
      const reasons = Array.isArray(stored.reasons) ? stored.reasons : [];
      return res.json({ profile, risk: { score, level: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low', reasons } });
    }

    const t = Number(profile.latest_accounts?.turnover) || 0;
    const p = Number(profile.latest_accounts?.profit) || 0;
    const margin = t > 0 ? p / t : 0;

    const sic = (profile.sic_codes || [])[0];
    let sector = null;
    try {
      sector = await db.collection('sector_stats').findOne({ sic_code: sic, region: profile.region }) ||
               await db.collection('sector_stats').findOne({ sic_code: sic });
    } catch {}
    const rawFail = sector?.failure_rate ?? 0;
    const failRate = rawFail > 1 ? rawFail / 100 : rawFail;

    const marginPenalty = margin >= 0.15 ? 0 : (margin <= 0 ? 1 : (0.15 - margin) / 0.15);
    const failurePenalty = Math.max(0, Math.min(1, failRate));
    const scoreFloat = 100 * (0.65 * marginPenalty + 0.35 * failurePenalty);
    const score = Math.max(0, Math.min(100, Math.round(scoreFloat)));
    const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';

    const reasons = [
      `Gross margin ~ ${(margin * 100).toFixed(1)}%`,
      `Sector failure ~ ${(failurePenalty * 100).toFixed(1)}%`,
      level === 'high' ? 'High risk band' : level === 'medium' ? 'Medium risk band' : 'Low risk band'
    ];

    res.json({ profile, risk: { score, level, reasons } });
  } catch {
    res.status(500).json({ error: 'profile_scored_failed' });
  }
});

/* --- NEW: CCJ endpoint (paged list + summary) --- */
// Collection: sbri_ccj_details
// Doc shape (suggested):
// { company_number, judgment_date: Date, amount: Number, court, case_number, status: 'open'|'unsatisfied'|'satisfied', satisfied_date: Date|null, source }
app.get('/api/sbri/company/:number/ccj', async (req, res) => {
  try {
    const n = String(req.params.number);
    const page = Math.max(1, Number(req.query.page || 1));
    const size = Math.min(100, Number(req.query.size || 25));

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

    res.json({ page, size, summary, items });
  } catch (e) {
    res.status(500).json({ error: 'ccj_fetch_failed' });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`SBRI service running on port ${process.env.PORT || 3000} (v1.6.2)`);
});
