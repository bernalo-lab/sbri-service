/* scripts/init-db.js
 * Version: 1.6
 * Ensures indexes (with correct uniqueness), optionally cleans a company first,
 * then seeds all collections. Supports --with-sector-stats bootstrap.
 *
 * Examples:
 *   node scripts/init-db.js 00000006 --clean
 *   node scripts/init-db.js 00000006 --reseed --variant=a --with-sector-stats
 *   node scripts/init-db.js 00000006 --with-sector-stats --period=2024Q4 --avg=0.10 --fail=0.018 --size=1432
 *   node scripts/init-db.js 00000006 --with-sector-stats --sic=62020 --region=London
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { spawnSync } from 'child_process';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 <companyNo> [--reseed|--clean|--variant=a|--quiet|--with-sector-stats|--period=YYYYQn|--avg=0.1|--fail=0.02|--size=1234|--sic=CODE|--region=Region]')
  .demandCommand(1)
  .option('reseed', { type: 'boolean', default: false })
  .option('clean',  { type: 'boolean', default: false })
  .option('variant',{ type: 'string',  default: 'a' })
  .option('quiet',  { type: 'boolean', default: false })
  .option('with-sector-stats', { type: 'boolean', default: false })
  .option('period', { type: 'string' })
  .option('avg',    { type: 'number' })
  .option('fail',   { type: 'number' })
  .option('size',   { type: 'number' })
  .option('sic',    { type: 'string' })
  .option('region', { type: 'string' })
  .help()
  .argv;

const companyNo = String(argv._[0]);
if (!process.env.MONGO_URI) {
  console.error('MONGO_URI not set. Add it to .env or export it before running.');
  process.exit(1);
}

/** Indexes (unique where one row per company). */
const INDEXES = [
  // one row per company
  { col: 'profiles',               spec: { company_number: 1 }, opts: { name: 'company_number_1', unique: true } },
  { col: 'sbri_business_profiles', spec: { company_number: 1 }, opts: { name: 'company_number_1', unique: true } },

  // shared lookup (NOT per-company)
  { col: 'sector_stats',           spec: { sic_code: 1, region: 1, period: 1 }, opts: { name: 'sic_region_period', unique: true } },

  // many rows per company
  { col: 'sbri_accounts',          spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
  { col: 'sbri_directors',         spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
  { col: 'sbri_director_changes',  spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
  { col: 'sbri_sector_benchmark',  spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
  { col: 'sbri_ccj_details',       spec: { company_number: 1 }, opts: { name: 'company_number_1' } },

  // change to unique:true if you store one score per company
  { col: 'sbri_scores',            spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
];

// all collections we attempt to clean by company_number (sector_stats included safely; filter matches nothing)
const ALL_COLLECTIONS_FOR_CLEAN = INDEXES.map(x => x.col);

// helper(s)
const indexNameFromSpec = (spec) => Object.keys(spec).map(k => `${k}_${spec[k]}`).join('_');

async function createIndexes(db) {
  for (const { col, spec, opts } of INDEXES) {
    const name = opts?.name || indexNameFromSpec(spec);
    try {
      await db.collection(col).createIndex(spec, opts);
      if (!argv.quiet) console.log(`✓ index ensured on ${col} ${JSON.stringify(spec)}${opts?.unique ? ' (unique)' : ''}`);
    } catch (e) {
      // existing index with same name but different options
      if (e?.code === 86 || e?.codeName === 'IndexKeySpecsConflict' || e?.codeName === 'IndexOptionsConflict') {
        if (!argv.quiet) console.log(`↻ ${col}: "${name}" exists with different options; dropping & recreating…`);
        try { await db.collection(col).dropIndex(name); } catch {}
        await db.collection(col).createIndex(spec, opts);
        if (!argv.quiet) console.log(`✓ ${col}: "${name}" reset`);
      } else if (e?.code === 11000) {
        // duplicate key while building a unique index -> caller should have cleaned first
        console.error(`✗ Duplicate data prevented building index on ${col}. Clean duplicates then retry.`);
        throw e;
      } else {
        throw e;
      }
    }
  }
}

async function cleanCompanyEverywhere(db, companyNo) {
  console.log(`[clean] Removing company_number=${companyNo} across collections…`);
  for (const col of ALL_COLLECTIONS_FOR_CLEAN) {
    const res = await db.collection(col).deleteMany({ company_number: companyNo });
    console.log(`- ${col}: removed ${res.deletedCount}`);
  }
  console.log('✓ Clean complete');
}

function resolveSeeder(basename) {
  // Try .js, .mjs, .cjs in that order
  const attempts = [`${basename}.js`, `${basename}.mjs`, `${basename}.cjs`]
    .map(f => path.join(__dirname, f));
  const found = attempts.find(f => fs.existsSync(f));
  return found || null;
}

function runSeeder(basename, args = []) {
  const scriptPath = resolveSeeder(basename);
  if (!scriptPath) {
    if (!argv.quiet) console.log(`(skip) ${basename} not found`);
    return;
  }
  if (!argv.quiet) console.log(`→ ${path.basename(scriptPath)} ${args.join(' ')}`);
  const res = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit', env: process.env });
  if (res.status !== 0) {
    console.error(`Seeder failed: ${basename} ${args.join(' ')}`);
    process.exit(res.status || 1);
  }
}

// current quarter like "2025Q3"
function currentQuarter() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}Q${q}`;
}

async function ensureSectorStatsIfMissing(db, companyNo) {
  // determine SIC/region: CLI overrides > profile
  let sic = argv.sic;
  let region = argv.region;

  if (!sic || !region) {
    const prof =
      (await db.collection('profiles').findOne({ company_number: companyNo })) ||
      (await db.collection('sbri_business_profiles').findOne({ company_number: companyNo }));
    if (prof) {
      if (!sic) {
        sic = Array.isArray(prof.sic_codes) && prof.sic_codes.length
          ? String(prof.sic_codes[0])
          : (prof.sic_code ? String(prof.sic_code) : undefined);
      }
      if (!region) region = prof.region || prof.registered_office_region;
    }
  }

  if (!sic || !region) {
    console.log(`(skip) --with-sector-stats requested but SIC/region not available. Provide --sic and --region.`);
    return;
  }

  const period = argv.period || currentQuarter();
  const exists = await db.collection('sector_stats').findOne({ sic_code: sic, region, period });
  if (exists) {
    if (!argv.quiet) console.log(`sector_stats already exists for ${sic}/${region}/${period} → skipping.`);
    return;
  }

  // defaults if not provided
  const avg  = (typeof argv.avg  === 'number') ? argv.avg  : 0.10;
  const fail = (typeof argv.fail === 'number') ? argv.fail : 0.018;
  const size = (typeof argv.size === 'number') ? argv.size : 1432;

  // use your seeder to upsert
  const args = [`--period=${period}`, `--avg=${avg}`, `--fail=${fail}`, `--size=${size}`];

  // pass either explicit sic/region or let seeder read from profile
  if (argv.sic || argv.region) {
    args.push(`--sic=${sic}`, `--region=${region}`);
  } else {
    args.push(`--from-company=${companyNo}`);
  }

  runSeeder('seed-sector-stats', args);
}

async function main() {
  console.log(`[init-db] company=${companyNo} mode=${argv.clean ? 'clean' : (argv.reseed ? 'reseed' : 'init')} variant=${argv.variant}${argv['with-sector-stats'] ? ' +with-sector-stats' : ''}`);
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(); // DB from URI

  try {
    // v1.6: CLEAN FIRST to avoid duplicate-key failures during unique index builds
    if (argv.clean || argv.reseed) {
      await cleanCompanyEverywhere(db, companyNo);
    }

    if (!argv.quiet) console.log('Ensuring indexes…');
    await createIndexes(db);

    if (!argv.clean) {
      console.log('Seeding…');

      // base company + extended details
      runSeeder('seed-company', [companyNo, `--variant=${argv.variant}`]);
      runSeeder('seed-extended', [companyNo]);

      // optionally ensure sector_stats exists for company's SIC/region (+period)
      if (argv['with-sector-stats']) {
        await ensureSectorStatsIfMissing(db, companyNo);
      }

      // remaining per-company seeders
      runSeeder('seed-director-changes', [companyNo]);
      runSeeder('seed-sector-benchmark', [companyNo]);
      runSeeder('seed-ccj-details', [companyNo]); // optional
      runSeeder('seed-scores', [companyNo]);      // optional

      console.log('✓ Seed complete');
    }
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
