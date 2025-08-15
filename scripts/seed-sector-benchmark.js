/**
 * scripts/seed-sector-benchmark.js
 * Version 1.1
 * Creates/updates a per-company benchmark row using sector_stats (lookup by SIC + region).
 *
 * Usage: node scripts/seed-sector-benchmark.js 00000006
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

async function main() {
  const companyNo = String(process.argv[2] || '').trim();
  if (!companyNo) {
    console.error('Usage: node scripts/seed-sector-benchmark.js <companyNo>');
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
    // 1) Get company meta (SIC + region) from profiles (or sbri_business_profiles)
    const profile =
      (await db.collection('profiles').findOne({ company_number: companyNo })) ||
      (await db.collection('sbri_business_profiles').findOne({ company_number: companyNo }));

    if (!profile) {
      throw new Error(`No profile found for ${companyNo}. Seed company first.`);
    }

    // Expect fields like: profile.sic_codes (array) and profile.region (string)
    const sic = Array.isArray(profile.sic_codes) && profile.sic_codes.length
      ? String(profile.sic_codes[0])
      : (profile.sic_code ? String(profile.sic_code) : null);

    const region = profile.region || profile.registered_office_region || null;

    if (!sic || !region) {
      throw new Error(
        `Missing SIC/region for ${companyNo}. Ensure seed-sic-region.js populated sic_codes[] and region.`
      );
    }

    // 2) Pull latest sector stat for that SIC + region
    //    (Assumes sector_stats has: sic_code, region, period, avg_margin, failure_rate, sample_size)
    const latest = await db.collection('sector_stats')
      .find({ sic_code: sic, region })
      .sort({ period: -1 })      // assumes sortable period like "2024Q4" or ISO date; adjust if needed
      .limit(1)
      .next();

    if (!latest) {
      throw new Error(`No sector_stats found for SIC ${sic} in ${region}. Seed sector_stats first.`);
    }

    // 3) Upsert per-company benchmark
    const doc = {
      company_number: companyNo,
      sic_code: sic,
      region,
      period: latest.period,
      avg_margin: latest.avg_margin,
      failure_rate: latest.failure_rate,
      sample_size: latest.sample_size,
      updated_at: new Date()
    };

    await db.collection('sbri_sector_benchmark').updateOne(
      { company_number: companyNo },
      { $set: doc, $setOnInsert: { created_at: new Date() } },
      { upsert: true }
    );

    console.log(`✓ Sector benchmark seeded for ${companyNo} (${sic} / ${region} / ${latest.period})`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
