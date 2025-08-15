/**
 * scripts/seed-sic-region.js
 * Set a company's SIC + region on profiles (and sbri_business_profiles if present).
 *
 * Usage:
 *   node scripts/seed-sic-region.js 00000006 --sic=62020 --region=London
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v === undefined ? true : v;
    } else out._.push(a);
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  const companyNo = String(args._[0] || '').trim();
  const sic = args.sic ? String(args.sic) : null;
  const region = args.region ? String(args.region) : null;

  if (!companyNo || !sic || !region) {
    console.error('Usage: node scripts/seed-sic-region.js <companyNo> --sic=CODE --region=Region');
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();

  try {
    const prof = await db.collection('profiles').findOne({ company_number: companyNo });
    if (!prof) {
      throw new Error(`No profile found for ${companyNo}. Run seed-company first.`);
    }

    // set on profiles
    await db.collection('profiles').updateOne(
      { company_number: companyNo },
      { $set: { region, sic_codes: [sic], sic_code: sic, updated_at: new Date() } }
    );

    // set on business_profiles if it exists
    const hasBP = await db.listCollections({ name: 'sbri_business_profiles' }).hasNext();
    if (hasBP) {
      await db.collection('sbri_business_profiles').updateOne(
        { company_number: companyNo },
        { $set: { region, sic_codes: [sic], sic_code: sic, updated_at: new Date() } }
      );
    }

    console.log(`✓ Set SIC/region for ${companyNo}: ${sic} / ${region}`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await client.close();
  }
})();
