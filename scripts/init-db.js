/* scripts/init-db.js
 * One-shot DB init for SBRI:
 * - Creates indexes
 * - (optional) cleans existing records for a company
 * - Runs ALL seeders for that company
 *
 * Usage:
 *   node scripts/init-db.js 00000006 --reseed --variant=a
 *   node scripts/init-db.js 00000006 --clean
 *
 * Env:
 *   MONGO_URI=mongodb+srv://user:pass@cluster/dbname
 */

const { MongoClient } = require('mongodb');
const { spawnSync } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const path = require('path');

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 <companyNo> [--reseed|--clean|--variant=a]')
  .demandCommand(1)
  .option('reseed', { type: 'boolean', default: false })
  .option('clean', { type: 'boolean', default: false })
  .option('variant', { type: 'string', default: 'a' })
  .help()
  .argv;

const companyNo = String(argv._[0]);
if (!process.env.MONGO_URI) {
  console.error('MONGO_URI not set. Export it or add it to your process manager.');
  process.exit(1);
}

const INDEXES = [
  ['profiles', { company_number: 1 }],
  ['sbri_business_profiles', { company_number: 1 }],
  ['sbri_accounts', { company_number: 1 }],
  ['sbri_directors', { company_number: 1 }],
  ['sbri_director_changes', { company_number: 1 }],
  ['sbri_sector_benchmark', { company_number: 1 }],
  ['sbri_ccj_details', { company_number: 1 }],
  // include if you persist scores
  ['sbri_scores', { company_number: 1 }],
];

const ALL_COLLECTIONS_FOR_CLEAN = INDEXES.map(([name]) => name);

async function createIndexes(db) {
  for (const [col, spec] of INDEXES) {
    await db.collection(col).createIndex(spec);
    console.log(`✓ index ensured on ${col} ${JSON.stringify(spec)}`);
  }
}

async function cleanCompanyEverywhere(db, companyNo) {
  console.log(`Cleaning existing data for ${companyNo} across all SBRI collections…`);
  for (const col of ALL_COLLECTIONS_FOR_CLEAN) {
    const res = await db.collection(col).deleteMany({ company_number: companyNo });
    console.log(`- ${col}: removed ${res.deletedCount}`);
  }
  console.log('✓ Cleaned');
}

function runSeeder(script, args = []) {
  const scriptPath = path.join(__dirname, script);
  const cmdArgs = [scriptPath, ...args];
  const res = spawnSync(process.execPath, cmdArgs, { stdio: 'inherit' }); // node <script> ...
  if (res.status !== 0) {
    console.error(`Seeder failed: ${script} ${args.join(' ')}`);
    process.exit(res.status || 1);
  }
}

async function main() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(); // use DB from URI

  try {
    // 1) Indexes
    console.log('Ensuring indexes…');
    await createIndexes(db);

    // 2) Clean if requested
    if (argv.clean || argv.reseed) {
      await cleanCompanyEverywhere(db, companyNo);
    }

    // 3) Seed base -> then fill everything else
    console.log(`\nSeeding ALL data for ${companyNo} (variant ${argv.variant})…\n`);

    // base company shell
    runSeeder('./seed-company.js', [companyNo, `--variant=${argv.variant}`]);

    // in parallel-friendly order, but we’ll keep sequential for clarity/reliability
    runSeeder('./seed-accounts.js', [companyNo]);
    runSeeder('./seed-sic-region.js', [companyNo]);
    runSeeder('./seed-directors.js', [companyNo]);
    runSeeder('./seed-director-changes.js', [companyNo]);
    runSeeder('./seed-sector-benchmark.js', [companyNo]);
    runSeeder('./seed-ccj-details.js', [companyNo]);

    // optional cached score
    try {
      runSeeder('./seed-scores.js', [companyNo]);
    } catch {
      // ignore if you don't have this script
    }

    console.log('\n✓ Done. All collections populated.');
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
