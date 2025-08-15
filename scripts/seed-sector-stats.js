/**
 * Seed a sector_stats row (lookup data by SIC + region + period).
 * Version: 1.1
 *
 * Usage (explicit SIC/region):
 *   node scripts/seed-sector-stats.js --sic=62020 --region=London --period=2024Q4 --avg=0.10 --fail=0.018 --size=1432
 *
 * Usage (read SIC/region from a company profile):
 *   node scripts/seed-sector-stats.js --from-company=00000006 --period=2024Q4 --avg=0.10 --fail=0.018 --size=1432
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* -------- tiny arg parser (no deps) -------- */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v === undefined ? true : v;
    } else {
      out._.push(a);
    }
  }
  return out;
}
const args = parseArgs(process.argv);

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI not set. Add it to .env or your environment.');
  process.exit(1);
}

const client = new MongoClient(process.env.MONGO_URI);

const ensureSectorStatsIndex = async (db) => {
  const name = 'sic_region_period';
  try {
    await db.collection('sector_stats')
      .createIndex({ sic_code: 1, region: 1, period: 1 }, { name, unique: true });
  } catch (e) {
    // ignore conflicts if index already exists with same options
    if (e?.code !== 86) throw e;
  }
};

const getSicAndRegionFromCompany = async (db, companyNo) => {
  const prof =
    (await db.collection('profiles').findOne({ company_number: companyNo })) ||
    (await db.collection('sbri_business_profiles').findOne({ company_number: companyNo }));
  if (!prof) throw new Error(`No profile found for company ${companyNo}. Seed company first.`);
  const sic = Array.isArray(prof.sic_codes) && prof.sic_codes.length
    ? String(prof.sic_codes[0])
    : (prof.sic_code ? String(prof.sic_code) : null);
  const region = prof.region || prof.registered_office_region || null;
  if (!sic || !region) {
    throw new Error(`Missing SIC/region for ${companyNo}. Ensure seed-sic-region has populated these fields.`);
  }
  return { sic, region };
};

(async () => {
  const fromCompany = args['from-company'] || args.company || null;

  // Inputs
  let sic = args.sic ? String(args.sic) : null;
  let region = args.region ? String(args.region) : null;
  const period = String(args.period || '').trim();
  const avg_margin = args.avg !== undefined ? Number(args.avg) : undefined;
  const failure_rate = args.fail !== undefined ? Number(args.fail) : undefined;
  const sample_size = args.size !== undefined ? Number(args.size) : undefined;

  if (!period || avg_margin === undefined || failure_rate === undefined || sample_size === undefined) {
    console.error(
      'Usage:\n' +
      '  node scripts/seed-sector-stats.js --sic=62020 --region=London --period=2024Q4 --avg=0.10 --fail=0.018 --size=1432\n' +
      '  OR\n' +
      '  node scripts/seed-sector-stats.js --from-company=00000006 --period=2024Q4 --avg=0.10 --fail=0.018 --size=1432'
    );
    process.exit(1);
  }

  try {
    await client.connect();
    const db = client.db();

    // If not provided explicitly, read from the company profile
    if ((!sic || !region) && fromCompany) {
      const meta = await getSicAndRegionFromCompany(db, String(fromCompany));
      sic = meta.sic;
      region = meta.region;
    }

    if (!sic || !region) {
      throw new Error('SIC and region are required (either pass them directly or use --from-company).');
    }

    // Ensure composite index exists
    await ensureSectorStatsIndex(db);

    // Upsert the row
    const filter = { sic_code: sic, region, period };
    const doc = {
      sic_code: sic,
      region,
      period,
      avg_margin,
      failure_rate,
      sample_size,
      updated_at: new Date(),
    };

    await db.collection('sector_stats').updateOne(
      filter,
      { $set: doc, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );

    console.log(`✓ Upserted sector_stats: ${sic} / ${region} / ${period}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await client.close();
  }
})();
