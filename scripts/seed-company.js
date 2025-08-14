// scripts/seed-company.js (ESM header)
import 'dotenv/config';
import mongoose from 'mongoose';
import DirectorChange from '../models/DirectorChange.js';

// ...rest of the file unchanged...


const MONGO_URI = process.env.MONGO_URI;

// -------- CLI args --------
//   npm run seed:company
//   npm run seed:company -- 01234567 "Acme Widgets Ltd" --variant=manufacturing-midlands
//   npm run seed:company -- 01234567 "Acme Widgets Ltd" --variant=retail-northwest --clean
//   npm run seed:company -- 01234567 "Acme Widgets Ltd" --clean-only
const raw = process.argv.slice(2);
let CN = raw[0] && !raw[0].startsWith('--') ? raw[0] : '00000006';
let NAME = raw[1] && !raw[1].startsWith('--') ? raw[1] : 'SBRI Test Co Ltd';
const flags = raw.filter(a => String(a).startsWith('--'));
const getFlag = (k, d=null) => (flags.find(f => f.startsWith(`--${k}=`)) || '').split('=').slice(1).join('') || d;
const hasFlag = (k) => flags.includes(`--${k}`);

const VARIANT = getFlag('variant', 'tech-london');
const CLEAN = hasFlag('clean');
const CLEAN_ONLY = hasFlag('clean-only');

// -------- Variant presets (now include incorporation_date + address) --------
const VARIANTS = {
  'tech-london': {
    sic: '62020',
    region: 'London',
    incorporation_date: '2016-04-18',
    address: {
      address_line_1: '1 Tech Lane',
      address_line_2: 'Farringdon',
      postal_code: 'EC1A 1AA',
      country: 'United Kingdom'
    },
    sector: { avg_margin: 0.10, failure_rate: 0.018, sample_size: 1432, period: '2024Q4' },
    accounts: { baseTurnover: 1100000, growth: 0.12, margin: 0.12, employees: 12 },
    insolvency: null,
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
    address: {
      address_line_1: '42 Foundry Road',
      address_line_2: 'Jewellery Quarter',
      postal_code: 'B1 1AA',
      country: 'United Kingdom'
    },
    sector: { avg_margin: 0.075, failure_rate: 0.032, sample_size: 987, period: '2024Q4' },
    accounts: { baseTurnover: 2400000, growth: 0.05, margin: 0.08, employees: 45 },
    insolvency: { date: '2023-08-15', type: 'Winding-up order (example)', url: 'https://www.thegazette.co.uk/' },
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
    address: {
      address_line_1: '77 High Street',
      address_line_2: 'City Centre',
      postal_code: 'M1 1AE',
      country: 'United Kingdom'
    },
    sector: { avg_margin: 0.045, failure_rate: 0.041, sample_size: 2210, period: '2024Q4' },
    accounts: { baseTurnover: 900000, growth: -0.03, margin: 0.03, employees: 8 },
    insolvency: null,
    directors: [
      ['2025-05-01','Appointed','Grace Lee','Director','New board appointment'],
      ['2025-04-12','Other','Hao Chen',null,'PSC statement filed']
    ],
    filings: (cn) => ([
      { company_number: cn, transaction_id: 'r1', filing_date: '2025-01-31', category: 'accounts', description: 'Micro-entity accounts made up to 2024-10-31' },
      { company_number: cn, transaction_id: 'r2', filing_date: '2024-10-10', category: 'confirmation-statement', description: 'Confirmation statement filed' }
    ])
  },
  'construction-southeast': {
    sic: '41202',
    region: 'South East',
    incorporation_date: '2012-06-01',
    address: {
      address_line_1: '5 Construction Way',
      address_line_2: 'Reading',
      postal_code: 'RG1 1AA',
      country: 'United Kingdom'
    },
    sector: { avg_margin: 0.09, failure_rate: 0.055, sample_size: 650, period: '2024Q4' },
    accounts: { baseTurnover: 1800000, growth: 0.08, margin: 0.10, employees: 22 },
    insolvency: { date: '2022-12-12', type: 'Administration (historic example)', url: 'https://www.thegazette.co.uk/' },
    directors: [
      ['2024-12-10','Resigned','Ivan Novak','Director','Resigned'],
      ['2024-12-15','Appointed','Julia Hart','Director','Appointed']
    ],
    filings: (cn) => ([
      { company_number: cn, transaction_id: 'c1', filing_date: '2024-11-30', category: 'accounts', description: 'Abridged accounts up to 2024-05-31' },
      { company_number: cn, transaction_id: 'c2', filing_date: '2024-06-20', category: 'capital', description: 'Statement of capital' }
    ])
  },
  'hospitality-scotland': {
    sic: '56101',
    region: 'Scotland',
    incorporation_date: '2015-03-23',
    address: {
      address_line_1: '12 Princes Street',
      address_line_2: 'New Town',
      postal_code: 'EH1 1AA',
      country: 'United Kingdom'
    },
    sector: { avg_margin: 0.06, failure_rate: 0.062, sample_size: 1331, period: '2024Q4' },
    accounts: { baseTurnover: 750000, growth: 0.04, margin: 0.05, employees: 16 },
    insolvency: null,
    directors: [
      ['2025-03-01','RoleChanged','Karen O’Neill','Managing Director','Promoted to MD']
    ],
    filings: (cn) => ([
      { company_number: cn, transaction_id: 'h1', filing_date: '2025-02-14', category: 'accounts', description: 'Unaudited abridged accounts up to 2024-09-30' }
    ])
  }
};

function pickVariant(key) { return VARIANTS[key] || VARIANTS['tech-london']; }

// -------- Helpers --------
async function upsert(col, filter, doc) {
  return col.updateOne(filter, { $set: doc }, { upsert: true });
}
function mkDate(s) { return new Date(s); }
function makeAccountsDocs(cn, cfg) {
  const periods = [2022, 2023, 2024];
  const docs = [];
  let turnover = cfg.baseTurnover;
  for (const year of periods) {
    const profit = Math.round(turnover * cfg.margin);
    const assets = Math.round(turnover * 0.6);
    const liabilities = Math.round(assets * 0.35);
    const employees = Math.max(1, Math.round(cfg.employees * Math.pow(1 + (cfg.growth || 0.02), year - periods[0])));
    docs.push({
      company_number: cn,
      period_start: new Date(`${year}-01-01`),
      period_end:   new Date(`${year}-12-31`),
      turnover, profit, assets, liabilities, employees
    });
    turnover = Math.round(turnover * (1 + cfg.growth));
  }
  return docs;
}
async function cleanCompany(db, cn) {
  const cols = ['profiles','sbri_business_profiles','financial_accounts','filings','insolvency_notices','director_changes'];
  for (const c of cols) await db.collection(c).deleteMany({ company_number: cn });
}

// -------- Main --------
async function run() {
  if (!MONGO_URI) { console.error('Missing MONGO_URI in .env'); process.exit(1); }

  const variant = pickVariant(VARIANT);
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  if (CLEAN || CLEAN_ONLY) {
    console.log(`Cleaning existing data for ${CN}…`);
    await cleanCompany(db, CN);
    console.log('✓ Cleaned');
    if (CLEAN_ONLY) return mongoose.disconnect();
  }

  // profiles (include status)
  await upsert(
    db.collection('profiles'),
    { company_number: CN },
    {
      company_number: CN,
      company_name: NAME,
      region: variant.region,
      sic_codes: [variant.sic],
      status: 'Active'
    }
  );

  // sbri_business_profiles (now variant-driven incorporation_date + address)
  const roa = {
    address_line_1: variant.address?.address_line_1 || '1 Example Street',
    address_line_2: variant.address?.address_line_2 ?? null,
    locality: variant.region,
    postal_code: variant.address?.postal_code || 'EC1A 1AA',
    country: variant.address?.country || 'United Kingdom'
  };

  await upsert(
    db.collection('sbri_business_profiles'),
    { company_number: CN },
    {
      company_number: CN,
      company_name: NAME,
      status: 'active', // lower-case for compatibility
      incorporation_date: mkDate(variant.incorporation_date || '1980-01-01'),
      sic_codes: [variant.sic],
      registered_office_address: roa,
      region: variant.region
    }
  );

  await db.collection('sbri_business_profiles').createIndex({ company_number: 1 }, { unique: true });
  await db.collection('sbri_business_profiles').createIndex({ company_name: 'text' });

  // sector_stats (by sic + region)
  await upsert(
    db.collection('sector_stats'),
    { sic_code: variant.sic, region: variant.region },
    { sic_code: variant.sic, region: variant.region, ...variant.sector }
  );

  // financial_accounts (3 periods)
  const facct = db.collection('financial_accounts');
  for (const d of makeAccountsDocs(CN, variant.accounts)) {
    await upsert(facct, { company_number: CN, period_end: d.period_end }, d);
  }

  // filings
  const filingsCol = db.collection('filings');
  for (const f of variant.filings(CN)) {
    await upsert(
      filingsCol,
      { company_number: f.company_number, transaction_id: f.transaction_id },
      { ...f, filing_date: mkDate(f.filing_date) }
    );
  }

  // insolvency_notices (optional)
  if (variant.insolvency) {
    await upsert(
      db.collection('insolvency_notices'),
      { company_number: CN, notice_date: mkDate(variant.insolvency.date), notice_type: variant.insolvency.type },
      { company_number: CN, notice_date: mkDate(variant.insolvency.date), notice_type: variant.insolvency.type, url: variant.insolvency.url }
    );
  }

  // director_changes
  for (const [date, type, name, role, details] of variant.directors) {
    const d = {
      company_number: CN,
      event_date: mkDate(date),
      change_type: ['Appointed','Resigned','RoleChanged'].includes(type) ? type : 'Other',
      officer_name: name,
      officer_role: role || null,
      details: details || null,
      source: 'Seeder'
    };
    await DirectorChange.updateOne(
      { company_number: CN, officer_name: d.officer_name, event_date: d.event_date, change_type: d.change_type },
      { $setOnInsert: d },
      { upsert: true }
    );
  }

  // Indexes (idempotent)
  await db.collection('financial_accounts').createIndex({ company_number: 1, period_end: -1 });
  await db.collection('filings').createIndex({ company_number: 1, filing_date: -1 });
  await db.collection('insolvency_notices').createIndex({ company_number: 1, notice_date: -1 });
  await db.collection('profiles').createIndex({ company_name: 'text' });
  await DirectorChange.syncIndexes();

  console.log(`✓ Seeded ${CN} (${NAME}) with variant "${VARIANT}"`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
