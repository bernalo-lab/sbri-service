// scripts/seed-director-changes.js (ESM)
import 'dotenv/config';
import mongoose from 'mongoose';
import DirectorChange from '../models/DirectorChange.js';

const MONGO_URI = process.env.MONGO_URI;
const TEST_CN = process.argv[2] || '01234567';

async function run() {
  if (!MONGO_URI) {
    console.error('Missing MONGO_URI in .env');
  }
  await mongoose.connect(MONGO_URI);

  // ensure appears in Search
  await mongoose.connection.collection('profiles').updateOne(
    { company_number: TEST_CN },
    { $set: { company_number: TEST_CN, company_name: 'SBRI Test Co Ltd', region: 'London', sic_codes: ['62020'], status: 'Active' } },
    { upsert: true }
  );

  const docs = [
    { company_number: TEST_CN, event_date: new Date('2025-03-15'), change_type: 'Appointed', officer_name: 'Alice Smith', officer_role: 'Director', details: 'Appointed as director', source: 'Seeder' },
    { company_number: TEST_CN, event_date: new Date('2025-07-02'), change_type: 'Resigned',  officer_name: 'Bob Jones',   officer_role: 'Director', details: 'Resigned from board', source: 'Seeder' },
    { company_number: TEST_CN, event_date: new Date('2025-01-20'), change_type: 'RoleChanged', officer_name: 'Carol White', officer_role: 'Company Secretary', details: 'Role changed to Company Secretary', source: 'Seeder' },
  ];

  for (const d of docs) {
    await DirectorChange.updateOne(
      { company_number: d.company_number, officer_name: d.officer_name, event_date: d.event_date, change_type: d.change_type },
      { $setOnInsert: d },
      { upsert: true }
    );
  }

  console.log(`✓ Seeded director_changes for ${TEST_CN}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
