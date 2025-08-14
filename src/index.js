// index.js v1.5 - Director changes
// Baseline: index_v1.3.js

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
 * Loads the most recent accounts document for a company.
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
    } catch (_) {}
  }
  return null;
}

async function loadRiskDoc(db, companyNumber) {
  const collections = ['sbri_risk_scores', 'risk_scores', 'scores'];
  for (const coll of collections) {
    try {
      const arr = await db.collection(coll)
        .find({ company_number: companyNumber })
        .sort({ updated_at: -1 })
        .limit(1)
        .toArray();
      if (arr[0]) return arr[0];
    } catch {}
  }
  return null;
}

function riskBand(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

// ----------------- New helper: Director changes loader -----------------
/**
 * Returns normalized director/officer change events for a company.
 * Tries several collection names and field shapes, normalizes to:
 * { date, type, name, role, details }
 */
async function loadDirectorChanges(db, companyNumber, { page = 1, size = 25 } = {}) {
  const candidates = [
    'officer_changes',
    'director_changes',
    'officers_changes',
    'officer_appointments',
    'appointments',
    'officers', // sometimes holds appointment/resignation history
  ];

  // Build an aggregation that:
  // 1) filters by company_number
  // 2) projects a unified event_date picking first non-null among many fields
  // 3) sorts by event_date desc
  // 4) paginates
  const dateCoalesce = (fields) => {
    // Chains $ifNull for a list of fields
    return fields.reduceRight((acc, f) => ({ $ifNull: [ `$${f}`, acc ] }), null);
  };

  const dateFields = [
    'effective_date', 'event_date', 'change_date', 'date',
    'appointed_on', 'appointment_date',
    'resigned_on', 'resignation_date',
    'notified_on', 'updated_at', 'created_at'
  ];

  for (const coll of candidates) {
    try {
      const pipeline = [
        { $match: { company_number: String(companyNumber) } },
        {
          $project: {
            raw: '$$ROOT',
            event_date: dateCoalesce(dateFields),
            // pass-throughs for normalization
            change_type: 1,
            action: 1,
            type: 1,
            officer_name: 1,
            name: 1,
            person_name: 1,
            officer: 1,
            role: 1,
            officer_role: 1,
            position: 1,
            details: 1,
            description: 1,
            text: 1,
          }
        },
        { $sort: { event_date: -1 } },
        { $skip: Math.max(0, (page - 1) * size) },
        { $limit: Math.min(100, size) }
      ];

      const arr = await db.collection(coll).aggregate(pipeline).toArray();
      if (!arr || arr.length === 0) continue;

      const normalized = arr.map(doc => {
        const r = doc.raw || doc;
        const date = doc.event_date || r.effective_date || r.event_date || r.change_date || r.date ||
                     r.appointed_on || r.appointment_date || r.resigned_on || r.resignation_date ||
                     r.notified_on || r.updated_at || r.created_at || null;

        // Derive type where possible
        const explicitType = r.change_type || r.type || r.action || null;
        let inferred = explicitType ? String(explicitType) : '';
        const str = JSON.stringify(r).toLowerCase();

        if (!inferred) {
          if (r.resigned_on || /resign/.test(str)) inferred = 'Resigned';
          else if (r.appointed_on || /appoint/.test(str)) inferred = 'Appointed';
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
          type: inferred ? String(inferred).replace(/\b\w/g, c => c.toUpperCase()) : null,
          name,
          role,
          details
        };
      });

      return normalized;
    } catch (_) {
      // collection might not exist or pipeline incompatible; try next
    }
  }
  return [];
}

// ----------------- Endpoints -----------------
app.get('/api/sbri/health', async (req, res) => {
  const profilesCount = await db.collection('profiles').countDocuments();
  res.json({ status: 'ok', profiles: profilesCount });
});

// Search by company name
app.get('/api/sbri/search', async (req, res) => {
  const name = String(req.query.name || '');
  if (!name) return res.json([]);
  const items = await db.collection('profiles')
    .find({ company_name: { $regex: name, $options: 'i' } })
    .limit(50)
    .toArray();
  res.json(items);
});

// Single company profile
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
  } catch (e) {
    res.status(500).json({ error: 'profile_lookup_failed' });
  }
});

// Filings (paged)
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

// NEW: Director changes (paged)
app.get('/api/sbri/company/:number/director-changes', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const size = Math.min(100, Number(req.query.size || 25));
    const items = await loadDirectorChanges(db, String(req.params.number), { page, size });
    res.json({ page, size, items });
  } catch (e) {
    res.status(500).json({ error: 'director_changes_failed' });
  }
});

// Sector benchmark by SIC
app.get('/api/sbri/sector/:sic', async (req, res) => {
  const doc = await db.collection('sector_stats')
    .findOne({ sic_code: req.params.sic });
  res.json(doc || {});
});

// Insolvency notices
app.get('/api/sbri/insolvency/:number', async (req, res) => {
  const items = await db.collection('insolvency_notices')
    .find({ company_number: req.params.number })
    .sort({ notice_date: -1 })
    .limit(50)
    .toArray();
  res.json({ items });
});

// "Full" company view
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

// Scored
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
        .find({ company_number: n })
        .sort({ updated_at: -1 })
        .limit(1)
        .toArray();
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
      sector = await db.collection('sector_stats')
        .findOne({ sic_code: sic, region: profile.region }) ||
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

    return res.json({ profile, risk: { score, level, reasons } });
  } catch (e) {
    res.status(500).json({ error: 'profile_scored_failed' });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`SBRI service running on port ${process.env.PORT || 3000}`);
});
