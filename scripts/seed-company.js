// scripts/seed-company.js
// Version 1.5 — adds sector_stats + sbri_sic_thresholds seeding and SIC threshold overrides
import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;

/*
Usage:
  node scripts/seed-company.js 00000007 --name="NEWCO TEST LTD"
  node scripts/seed-company.js 00000006 "SBRI Test Co Ltd" --variant=tech-london
  node scripts/seed-company.js 00000006 --name="EXAMPLE LTD" --sic=62020 --region=London
  node scripts/seed-company.js 00000006 --clean
  node scripts/seed-company.js 00000006 --clean-only
  # NEW: SIC threshold overrides (score scale 0–100, higher = higher risk)
  node scripts/seed-company.js 00000006 --sic=62020 --sic-high=65 --sic-medium=35
*/

const raw = process.argv.slice(2);

// positional args
let CN   = raw[0] && !raw[0].startsWith('--') ? String(raw[0]) : '00000006';
let NAME = raw[1] && !raw[1].startsWith('--') ? String(raw[1]) : 'SBRI Test Co Ltd';

// flags
const flags   = raw.filter(a => String(a).startsWith('--'));
const getFlag = (k, d=null) => (flags.find(f => f.startsWith(`--${k}=`)) || '').split('=').slice(1).join('') || d;
const hasFlag = (k) => flags.includes(`--${k}`);

const VARIANT    = getFlag('variant', 'tech-london');
const CLEAN      = hasFlag('clean');
const CLEAN_ONLY = hasFlag('clean-only');

// NEW: explicit overrides
const NAME_FLAG    = getFlag('name', getFlag('company-name', null));
const SIC_FLAG     = getFlag('sic', null);
const REGION_FLAG  = getFlag('region', null);
const SIC_HIGH_RAW = getFlag('sic-high', null);
const SIC_MED_RAW  = getFlag('sic-medium', null);

// If --name is supplied, it wins over positional
if (NAME_FLAG) NAME = String(NAME_FLAG);

// Default per-SIC thresholds (higher score = higher risk)
// 'high' => score >= high → High risk
// 'medium' => score >= medium → Medium risk, else Low
const DEFAULT_THRESHOLDS = {
  '62020': { high: 65, medium: 35 }, // IT consulting often healthier margins
  '28290': { high: 75, medium: 45 }, // Manufacturing more volatile
  '47190': { high: 70, medium: 40 }, // Retail mid-high risk
  default: { high: 70, medium: 40 }
};

const VARIANTS = {
  'tech-london': {
    sic: '62020',
    region: 'London',
    incorporation_date: '2016-04-18',
    address: { address_line_1: '1 Tech Lane', address_line_2: 'Farringdon', postal_code: 'EC1A 1AA', country: 'United Kingdom' },
    sector: { avg_margin: 0.12, failure_rate: 0.018, sample_size: 1432, period: '2024Q4' },
    accounts: { baseTurnover: 1100000, growth: 0.12, margin: 0.12, employees: 12 },
    insolvency: null,
    ccj: [
      { judgment_date: '2023-06-12', amount: 950, court: 'County Court Business Centre', case_number: 'TL123456', status: 'satisfied', satisfied_date: '2023-08-01' }
    ],
    directors: [
      ['2025-03-15','Appointed','Alice Smith','Director','Appointed as director'],
      ['2025-07-02','Resigned','Bob Jones','Director','Resigned from board'],
      ['2025-01-20','RoleChanged','Carol White','Company Secretary','Role changed to Company Secretary']
    ],
    filings: (cn) => ([
      { company_number: cn, transaction_id: 't1', filing_date: '2024-10-31', category: 'accounts', description: 'Total exemption full accounts made up to 2024-03-31' },
      { company_number: cn, transaction_id: 't2', filing_date: '2024-06-10', category: 'confirmation-statement', description: 'Confirmation statement made on 2024-06-01' }
    ])
  },
  'manufacturing-midlands': {
    sic: '28290',
    region: 'West Midlands',
    incorporation_date: '2010-09-07',
    address: { address_line_1: '42 Foundry Road', address_line_2: 'Jewellery Quarter', postal_code: 'B1 1AA', country: 'United Kingdom' },
    sector: { avg_margin: 0.08, failure_rate: 0.032, sample_size: 987, period: '2024Q4' },
    accounts: { baseTurnover: 2400000, growth: 0.05, margin: 0.08, employees: 45 },
    insolvency: { date: '2023-08-15', type: 'Winding-up order (example)', url: 'https://www.thegazette.co.uk/' },
    ccj: [
      { judgment_date: '2024-11-20', amount: 4820, court: 'Birmingham County Court', case_number: 'BM445566', status: 'open' },
      { judgment_date: '2023-03-03', amount: 1200, court: 'County Court Business Centre', case_number: 'TL654321', status: 'satisfied', satisfied_date: '2023-05-10' }
    ],
    directors: [
      ['2025-02-10','Appointed','Diane Patel','Operations Director','New operations director'],
      ['2024-11-05','Appointed','Ethan Brown','Finance Director','Appointed FD'],
      ['2024-09-25','Resigned','Farah Khan','Director','Resigned after tenure']
    ],
    filings: (cn) => ([
      { company_number: cn, transaction_id: 'm1', filing_date: '2024-12-31', category: 'accounts', description: 'Full accounts made up to 2024-06-30' },
      { company_number: cn, transaction_id: 'm2', filing_date: '2024-07-15', category: 'change-registered-office-address', description: 'Registered office address changed' }
    ])
  },
  'retail-northwest': {
    sic: '47190',
    region: 'North West',
    incorporation_date: '2018-02-12',
    address: { address_line_1: '77 High Street', address_line_2: 'City Centre', postal_code: 'M1 1AE', country: 'United Kingdom' },
    sector: { avg_margin: 0.03, failure_rate: 0.041, sample_size: 2210, period: '2024Q4' },
    accounts: { baseTurnover: 900000, growth: -0.03, margin: 0.03, employees: 8 },
    insolvency: null,
    ccj: [],
    directors: [
      ['2025-05-01','Appointed','Grace Lee','Director','New board appointment'],
      ['2025-04-12','Other','Hao Chen',null,'PSC statement filed']
    ],
    filings: (cn) => ([
      { company_number: cn, transaction_id: 'r1', filing_date: '2025-01-31', category: 'accounts', description: 'Micro-entity accounts made up to 2024-10-31' },
      { company_number: cn, transaction_id: 'r2', filing_date: '2024-10-10', category: 'confirmation-statement', description: 'Confirmation statement filed' }
    ])
  }
};

function pickVariant(key) { return VARIANTS[key] || VARIANTS['tech-london']; }
function mkDate(s) { return s ? new Date(s) : null; }
async function upsert(col, filter, doc) { return col.updateOne(filter, { $set: doc }, { upsert: true }); }

async function cleanCompany(db, cn) {
  const cols = [
    'profiles',
    'sbri_business_profiles',
    'financial_accounts',
    'filings',
    'insolvency_notices',
    'director_changes',
    'sbri_ccj_details',
    'sector_stats',
    'sbri_sic_thresholds'
  ];
  for (const c of cols) await db.collection(c).deleteMany({ company_number: cn, ...(c==='sector_stats'||c==='sbri_sic_thresholds' ? {} : {}) });
}

async function run() {
  if (!MONGO_URI) { console.error('❌ Missing MONGO_URI'); process.exit(1); }
  const variant = pickVariant(VARIANT);

  // apply overrides if provided
  const EFFECTIVE_SIC    = (SIC_FLAG || variant.sic);
  const EFFECTIVE_REGION = (REGION_FLAG || variant.region);

  const SIC_HIGH = SIC_HIGH_RAW != null ? Number(SIC_HIGH_RAW) : (DEFAULT_THRESHOLDS[EFFECTIVE_SIC]?.high ?? DEFAULT_THRESHOLDS.default.high);
  const SIC_MED  = SIC_MED_RAW  != null ? Number(SIC_MED_RAW)  : (DEFAULT_THRESHOLDS[EFFECTIVE_SIC]?.medium ?? DEFAULT_THRESHOLDS.default.medium);

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  if (CLEAN || CLEAN_ONLY) {
    console.log(`Cleaning existing data for ${CN}…`);
    await cleanCompany(db, CN);
    console.log('✓ Cleaned');
    if (CLEAN_ONLY) { await mongoose.disconnect(); return; }
  }

  // ---- profiles ----
  await upsert(db.collection('profiles'), { company_number: CN }, {
    company_number: CN,
    company_name: NAME,
    status: 'active',
    incorporation_date: mkDate(variant.incorporation_date),
    sic: EFFECTIVE_SIC,
    sic_codes: EFFECTIVE_SIC ? [EFFECTIVE_SIC] : [],
    region: EFFECTIVE_REGION || null,
    address: variant.address,
    jurisdiction: 'uk',
    updated_at: new Date()
  });

  // ---- sbri_business_profiles ----
  await upsert(db.collection('sbri_business_profiles'), { company_number: CN }, {
    company_number: CN,
    name: NAME,
    sector: variant.sector,
    region: EFFECTIVE_REGION || variant.region || null,
    last_updated: new Date()
  });

  // ---- sector_stats (for /api/sbri/sector/:sic) ----
  if (variant.sector) {
    await upsert(
      db.collection('sector_stats'),
      { sic_code: EFFECTIVE_SIC, region: EFFECTIVE_REGION || null },
      {
        sic_code: EFFECTIVE_SIC,
        region: EFFECTIVE_REGION || null,
        avg_margin: variant.sector.avg_margin,
        failure_rate: variant.sector.failure_rate,
        sample_size: variant.sector.sample_size,
        period: variant.sector.period,
        updated_at: new Date()
      }
    );
    await db.collection('sector_stats').createIndex({ sic_code: 1, region: 1 });
  }

  // ---- sbri_sic_thresholds (industry bands per SIC/region) ----
  await upsert(
    db.collection('sbri_sic_thresholds'),
    { sic_code: EFFECTIVE_SIC, region: EFFECTIVE_REGION || null },
    {
      sic_code: EFFECTIVE_SIC,
      region: EFFECTIVE_REGION || null,
      thresholds: { high: SIC_HIGH, medium: SIC_MED },
      note: 'Seeded by seed-company v1.5',
      updated_at: new Date()
    }
  );
  await db.collection('sbri_sic_thresholds').createIndex({ sic_code: 1, region: 1 });

  // ---- financial_accounts (simple 3-year trail) ----
  const finCol = db.collection('financial_accounts');
  const sfaExists = await db.listCollections({ name: 'sbri_financial_accounts' }).hasNext();
  const sfaCol = sfaExists ? db.collection('sbri_financial_accounts') : null;

  const base = variant.accounts.baseTurnover;
  const growth = variant.accounts.growth;
  const marginRatio = variant.accounts.margin;
  const employees = variant.accounts.employees;

  const years = [2022, 2023, 2024];
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    const period_end = new Date(`${y}-03-31`);
    const turnover = Math.round(base * Math.pow(1 + growth, i));

    const profit      = Math.round(turnover * marginRatio);
    const assets      = Math.round(turnover * (0.75 + marginRatio/2));
    const liabilities = Math.round(assets * 0.55);
    const margin      = marginRatio;

    const doc = {
      company_number: CN,
      period_end,
      turnover,
      employees,
      profit,
      assets,
      liabilities,
      margin,
      gross_margin: profit,
      updated_at: new Date()
    };

    await finCol.updateOne({ company_number: CN, period_end }, { $set: doc }, { upsert: true });
    if (sfaCol) {
      await sfaCol.updateOne({ company_number: CN, period_end }, { $set: doc }, { upsert: true });
    }
  }

  // ---- filings ----
  const filings = typeof variant.filings === 'function' ? variant.filings(CN) : [];
  for (const f of filings) await upsert(db.collection('filings'), { company_number: CN, transaction_id: f.transaction_id }, f);

  // ---- insolvency (optional) ----
  if (variant.insolvency) {
    await upsert(db.collection('insolvency_notices'), { company_number: CN, notice_date: mkDate(variant.insolvency.date) }, {
      company_number: CN,
      notice_date: mkDate(variant.insolvency.date),
      type: variant.insolvency.type,
      url: variant.insolvency.url
    });
  }

  // ---- director_changes (flat docs) ----
  if (Array.isArray(variant.directors)) {
    const dc = db.collection('director_changes');
    for (const row of variant.directors) {
      const [date, action, name, role, note] = row;
      await dc.updateOne(
        { company_number: CN, person_name: name, event: action, event_date: mkDate(date) },
        {
          $set: {
            company_number: CN,
            person_name: name,
            event: action,
            role: role || null,
            note: note || null,
            event_date: mkDate(date),
            source: 'Seeder'
          }
        },
        { upsert: true }
      );
    }
  }

  // ---- CCJs ----
  if (Array.isArray(variant.ccj) && variant.ccj.length) {
    const ccjCol = db.collection('sbri_ccj_details');
    for (const c of variant.ccj) {
      await ccjCol.updateOne(
        { company_number: CN, case_number: c.case_number },
        {
          $set: {
            company_number: CN,
            judgment_date: mkDate(c.judgment_date),
            amount: Number(c.amount) || 0,
            court: c.court || null,
            case_number: c.case_number || null,
            status: (c.status || 'open').toLowerCase(),
            satisfied_date: mkDate(c.satisfied_date),
            source: 'Seeder'
          }
        },
        { upsert: true }
      );
    }
    await ccjCol.createIndex({ company_number: 1, judgment_date: -1 });
    await ccjCol.createIndex({ company_number: 1, status: 1 });
  }

  // ---- Helpful indexes ----
  await db.collection('financial_accounts').createIndex({ company_number: 1, period_end: -1 });
  await db.collection('filings').createIndex({ company_number: 1, filing_date: -1 });
  await db.collection('insolvency_notices').createIndex({ company_number: 1, notice_date: -1 });
  await db.collection('profiles').createIndex({ company_name: 'text' });
  await db.collection('director_changes').createIndex({ company_number: 1, event_date: -1 });

  console.log(`✓ Seeded ${CN} (${NAME}) with variant "${VARIANT}" [SIC=${EFFECTIVE_SIC}] [region=${EFFECTIVE_REGION || '—'}] thresholds(high=${SIC_HIGH}, medium=${SIC_MED})`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
