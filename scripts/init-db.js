/* scripts/init-db.js
 * Version: 1.3
 * One-shot DB init for SBRI:
 * - Ensures indexes (with correct uniqueness per collection)
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

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') }); // adjust path if needed

import { MongoClient } from 'mongodb';
import { spawnSync } from 'child_process';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

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

/** Desired indexes per collection (set unique where it should be one row per company). */
const INDEXES = [
  // one row per company
  { col: 'profiles',               spec: { company_number: 1 }, opts: { name: 'company_number_1', unique: true } },
  { col: 'sbri_business_profiles', spec: { company_number: 1 }, opts: { name: 'company_number_1', unique: true } },

  // many rows per company
  { col: 'sbri_accounts',          spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
  { col: 'sbri_directors',         spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
  { col: 'sbri_director_changes',  spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
  { col: 'sbri_sector_benchmark',  spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
  { col: 'sbri_ccj_details',       spec: { company_number: 1 }, opts: { name: 'company_number_1' } },

  // change to unique:true if you store one score per company
  // If you store snapshots you may want non-unique; if single row per company, set unique: true
  { col: 'sbri_scores',            spec: { company_number: 1 }, opts: { name: 'company_number_1' } },
];

const ALL_COLLECTIONS_FOR_CLEAN = INDEXES.map(x => x.col);

// before (problematic on your machine):
// const indexNameFromSpec = (spec) =>
//   Object.entries(spec).map(([k, v]) => `${k}_${v}`).join('_');

// after (no destructuring):
const indexNameFromSpec = (spec) => {
  return Object.keys(spec).map((k) => `${k}_${spec[k]}`).join('_');
};
