import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();
const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

await db.collection('profiles').insertOne({
  company_number: '00000006',
  company_name: 'EXAMPLE LTD',
  sic_codes: ['62020'],
  region: 'London'
});

console.log('Sample data inserted.');
process.exit(0);
