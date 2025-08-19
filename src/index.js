// index.js — SBRI service v1.8.1 (Live‑Data Pilot)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Support for older Node
const fetch = globalThis.fetch;

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

/* --------- helpers: SIC normalization --------- */
function uniq(arr){ return Array.from(new Set(arr)); }
function normalizeSicArray(obj = {}) {
  const buckets = [];
  const pushMaybe = v => { if (v != null && v !== '') buckets.push(String(v)); };

  if (Array.isArray(obj.sic_codes)) buckets.push(...obj.sic_codes.map(String));
  if (Array.isArray(obj.SICCodes))  buckets.push(...obj.SICCodes.map(String));

  [
    obj.sic, obj.SIC, obj.sic_code, obj.SICCode,
    obj.primary_sic, obj.sic_codes_text, obj.industry_codes
  ].forEach(pushMaybe);

  if (obj.company?.sic_codes) buckets.push(...[].concat(obj.company.sic_codes));

  const split = buckets.flatMap(s => String(s).split(/[,\s/;|]+/).filter(Boolean));
  const codes = split.map(s => s.trim()).filter(s => /^\d{4,5}$/.test(s));
  return uniq(codes);
}
function attachNormalizedSIC(doc = {}) {
  const sicCodes = normalizeSicArray(doc);
  if (sicCodes.length) doc.sic_codes = sicCodes;
  return doc;
}

/* --- helpers (baseline) --- */
async function injectBusinessStatus(db, companyNumber, profileObj) {
  try {
    const doc = await db.collection('sbri_business_profiles')
      .findOne({ company_number: companyNumber }, { projection: { status: 1 } });
    const s = doc && doc.status ? String(doc.status).trim() : null;
    if (s && !profileObj.status) {
      profileObj.status = s[0].toUpperCase() + s.slice(1).toLowerCase();
    }
  } catch {}
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
    } catch {}
  }
  return null;
}

/* --- director changes helpers (baseline) --- */
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
    } catch {}
  }
  return { items: [], total: 0, summary: { total: 0, appointments: 0, resignations: 0, other: 0 } };
}

/* --- SIC thresholds helpers --- */
const DEFAULT_THRESHOLDS = { high: 70, medium: 40 };
function classifyRiskWithThresholds(score, thr = DEFAULT_THRESHOLDS) {
  const high = Number(thr?.high ?? 70);
  const med  = Number(thr?.medium ?? 40);
  if (score >= high) return 'high';
  if (score >= med)  return 'medium';
  return 'low';
}
async function loadSicThresholds(sic, region) {
  if (!sic) return null;
  const col = db.collection('sbri_sic_thresholds');
  const byRegion = region ? await col.findOne({ sic_code: sic, region }) : null;
  if (byRegion && byRegion.thresholds) return byRegion;
  const generic = await col.findOne({ sic_code: sic, region: null }) || await col.findOne({ sic_code: sic });
  return generic || null;
}

/* -------------------- LIVE DATA PROXY (Companies House) -------------------- */
const CH_BASE = 'https://api.company-information.service.gov.uk';
const CH_KEY  = process.env.CH_API_KEY || '';
const RAW_ALLOW = (process.env.CH_ALLOWLIST || '').split(/[,\s]+/).filter(Boolean);
const ALLOW_SET = new Set(RAW_ALLOW.map(s => s.trim()));
const RATE_PER_MIN = Number(process.env.CH_RATE_PER_MIN || 60);
let tokens = RATE_PER_MIN;
let lastRefill = Date.now();
function takeToken() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 60000;
  if (elapsed >= 1) {
    tokens = RATE_PER_MIN;
    lastRefill = now;
  }
  if (tokens <= 0) return false;
  tokens -= 1;
  return true;
}
function ensureAllowed(number) {
  if (!ALLOW_SET.size) return false;
  return ALLOW_SET.has(String(number));
}
async function chFetch(path) {
  if (!CH_KEY) throw new Error('missing_ch_api_key');
  if (!takeToken()) {
    const err = new Error('rate_limited');
    err.code = 429;
    throw err;
  }
  const res = await fetch(`${CH_BASE}${path}`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${CH_KEY}:`).toString('base64')
    }
  });
  if (!res.ok) {
    const text = await res.text();
    const e = new Error(`ch_${res.status}`);
    e.status = res.status;
    e.body = text.slice(0, 500);
    throw e;
  }
  return res.json();
}
function mapCHSearchItem(x = {}) {
  return {
    company_number: x.company_number,
    company_name: x.title,
    registered_office_address: {
      locality: x.address_snippet || ''
    },
    sic_codes: (x.sic_codes || [])
  };
}
function mapCHCompanyProfile(x = {}) {
  return {
    company_number: x.company_number,
    company_name: x.company_name,
    status: x.company_status,
    registered_office_address: x.registered_office_address || {},
    sic_codes: x.sic_codes || [],
    region: x.registered_office_address?.locality || null,
    accounts: {
      latest: {
        made_up_to: x.accounts?.last_accounts?.made_up_to || null,
        next_due: x.accounts?.next_due || null
      }
    }
  };
}
function mapCHFilings(x = {}) {
  const items = Array.isArray(x.items) ? x.items : [];
  return {
    items: items.map(it => ({
      date: it.date,
      filing_date: it.date,
      category: it.category,
      description: it.description || it.type || ''
    }))
  };
}
function mapCHOfficers(x = {}) {
  const items = Array.isArray(x.items) ? x.items : [];
  const mapped = items.map(it => ({
    date: it.appointed_on || it.resigned_on || it.notified_on || it.date_of_birth || it.updated_at || null,
    type: it.resigned_on ? 'Resigned' : 'Appointed',
    name: it.name,
    role: it.officer_role,
    details: it.nationality || it.occupation || ''
  }));
  const summary = {
    total: mapped.length,
    appointments: mapped.filter(m => m.type === 'Appointed').length,
    resignations: mapped.filter(m => m.type === 'Resigned').length,
    other: 0
  };
  return { items: mapped, summary };
}

app.get('/api/live/allow-list', (req, res) => {
  res.json({ allowed: Array.from(ALLOW_SET).sort() });
});
app.get('/api/live/search', async (req, res) => {
  try {
    const q = String(req.query.name || '');
    if (!q) return res.json([]);
    const data = await chFetch(`/search/companies?q=${encodeURIComponent(q)}&items_per_page=25`);
    const items = (data.items || []).map(mapCHSearchItem);
    res.json(items);
  } catch (e) {
    const code = e.code === 429 || e.status === 429 ? 429 : 500;
    res.status(code).json({ error: 'live_search_failed', detail: e.message, body: e.body || null });
  }
});
app.get('/api/live/company/:number', async (req, res) => {
  try {
    const n = String(req.params.number);
    if (!ensureAllowed(n)) return res.status(403).json({ error: 'not_allow_listed' });
    const data = await chFetch(`/company/${encodeURIComponent(n)}`);
    res.json(attachNormalizedSIC(mapCHCompanyProfile(data)));
  } catch (e) {
    const code = e.code === 429 || e.status === 429 ? 429 : 500;
    res.status(code).json({ error: 'live_company_failed', detail: e.message, body: e.body || null });
  }
});
app.get('/api/live/company/:number/filings', async (req, res) => {
  try {
    const n = String(req.params.number);
    if (!ensureAllowed(n)) return res.status(403).json({ error: 'not_allow_listed' });
    const page = Math.max(1, Number(req.query.page || 1));
    const size = Math.min(100, Number(req.query.size || 25));
    const data = await chFetch(`/company/${encodeURIComponent(n)}/filing-history?items_per_page=${size}&start_index=${(page-1)*size}`);
    res.json(mapCHFilings(data));
  } catch (e) {
    const code = e.code === 429 || e.status === 429 ? 429 : 500;
    res.status(code).json({ error: 'live_filings_failed', detail: e.message, body: e.body || null });
  }
});
app.get('/api/live/company/:number/officers', async (req, res) => {
  try {
    const n = String(req.params.number);
    if (!ensureAllowed(n)) return res.status(403).json({ error: 'not_allow_listed' });
    const data = await chFetch(`/company/${encodeURIComponent(n)}/officers?items_per_page=100`);
    res.json(mapCHOfficers(data));
  } catch (e) {
    const code = e.code === 429 || e.status === 429 ? 429 : 500;
    res.status(code).json({ error: 'live_officers_failed', detail: e.message, body: e.body || null });
  }
});

/* -------------------- EXISTING SBRI (test data) -------------------- */
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
  res.json(items.map(attachNormalizedSIC));
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
    try {
      const bp = await db.collection('sbri_business_profiles').findOne({ company_number: n });
      const merged = { ...withStatus, ...(bp || {}) };
      withStatus.sic_codes = normalizeSicArray(merged);
    } catch {}
    attachNormalizedSIC(withStatus);
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
app.get('/api/sbri/sector-bulk', async (req, res) => {
  try {
    const codes = String(req.query.codes || '').split(/[,\s]+/).filter(Boolean);
    if (!codes.length) return res.json([]);
    const region = req.query.region ? String(req.query.region) : null;
    const q = region ? { sic_code: { $in: codes }, region } : { sic_code: { $in: codes } };
    const items = await db.collection('sector_stats').find(q).toArray();
    res.json(items);
  } catch {
    res.status(500).json({ error: 'sector_bulk_failed' });
  }
});
app.get('/api/sbri/sic-thresholds/:sic', async (req, res) => {
  try {
    const sic = String(req.params.sic);
    const region = req.query.region ? String(req.query.region) : null;
    const doc = await loadSicThresholds(sic, region);
    if (!doc) return res.json({ sic_code: sic, region: region || null, thresholds: DEFAULT_THRESHOLDS, source: 'default' });
    res.json({
      sic_code: doc.sic_code,
      region: doc.region ?? null,
      thresholds: doc.thresholds || DEFAULT_THRESHOLDS,
      note: doc.note || null,
      updated_at: doc.updated_at || null,
      source: 'db'
    });
  } catch {
    res.status(500).json({ error: 'sic_thresholds_failed' });
  }
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
    try {
      const bp = await db.collection('sbri_business_profiles').findOne({ company_number: n });
      const merged = { ...profile, ...(bp || {}) };
      profile.sic_codes = normalizeSicArray(merged);
    } catch {}
    attachNormalizedSIC(profile);

    let stored = null;
    try {
      const arr = await db.collection('sbri_risk_scores')
        .find({ company_number: n }).sort({ updated_at: -1 }).limit(1).toArray();
      stored = arr[0] || null;
    } catch {}

    let score, reasons;
    if (stored) {
      score = Number(stored.score);
      reasons = Array.isArray(stored.reasons) ? stored.reasons : [];
    } else {
      const t = Number(profile.latest_accounts?.turnover) || 0;
      const p = Number(profile.latest_accounts?.profit) || 0;
      const margin = t > 0 ? p / t : 0;
      const primarySic = (profile.sic_codes || [])[0];
      let sector = null;
      try {
        sector = await db.collection('sector_stats').findOne({ sic_code: primarySic, region: profile.region }) ||
                 await db.collection('sector_stats').findOne({ sic_code: primarySic });
      } catch {}
      const rawFail = sector?.failure_rate ?? 0;
      const failRate = rawFail > 1 ? rawFail / 100 : rawFail;
      const marginPenalty = margin >= 0.15 ? 0 : (margin <= 0 ? 1 : (0.15 - margin) / 0.15);
      const failurePenalty = Math.max(0, Math.min(1, failRate));
      const scoreFloat = 100 * (0.65 * marginPenalty + 0.35 * failurePenalty);
      score = Math.max(0, Math.min(100, Math.round(scoreFloat)));
      const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
      reasons = [
        `Gross margin ~ ${(margin * 100).toFixed(1)}%`,
        `Sector failure ~ ${(failurePenalty * 100).toFixed(1)}%`,
        level === 'high' ? 'High risk band' : level === 'medium' ? 'Medium risk band' : 'Low risk band'
      ];
    }

    const primarySic = (profile.sic_codes || [])[0] || null;
    const thrDoc = await loadSicThresholds(primarySic, profile.region);
    const thresholds = thrDoc?.thresholds || DEFAULT_THRESHOLDS;
    const industryBand = classifyRiskWithThresholds(score, thresholds);
    const legacyBand = classifyRiskWithThresholds(score, DEFAULT_THRESHOLDS);

    let sectors = [];
    if (Array.isArray(profile.sic_codes) && profile.sic_codes.length) {
      const q = profile.region
        ? { sic_code: { $in: profile.sic_codes }, region: profile.region }
        : { sic_code: { $in: profile.sic_codes } };
      sectors = await db.collection('sector_stats').find(q).toArray();
    }

    res.json({
      profile,
      risk: { score, level: legacyBand, industry_band: industryBand, thresholds, reasons },
      industry: { sic_code: primarySic, region: thrDoc?.region ?? profile.region ?? null, thresholds_source: thrDoc ? 'db' : 'default' },
      sectors
    });
  } catch {
    res.status(500).json({ error: 'profile_scored_failed' });
  }
});
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
  } catch {
    res.status(500).json({ error: 'ccj_fetch_failed' });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`SBRI service running on port ${process.env.PORT || 3000} (v1.8.0 Live‑Data Pilot)`);
});
