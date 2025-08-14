import 'dotenv/config';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

const company_number = "00000006";

// minimal demo data
await db.collection('financial_accounts').deleteMany({ company_number });
await db.collection('financial_accounts').insertOne({
  company_number, period_start: "2023-01-01", period_end: "2023-12-31",
  turnover: 1350000, profit: 130000, assets: 900000, liabilities: 320000, employees: 14
});

await db.collection('filings').deleteMany({ company_number });
await db.collection('filings').insertMany([
  { company_number, transaction_id: "t1", filing_date: "2024-10-31", category: "accounts",
    description: "Total exemption full accounts made up to 2024-03-31" },
  { company_number, transaction_id: "t2", filing_date: "2024-06-10", category: "confirmation-statement",
    description: "Confirmation statement made on 2024-06-01" }
]);

await db.collection('sector_stats').deleteMany({ sic_code: "62020" });
await db.collection('sector_stats').insertOne({
  sic_code: "62020", region: "London", avg_margin: 0.10, failure_rate: 0.018, sample_size: 1432, period: "2024Q4"
});

await db.collection('insolvency_notices').deleteMany({ company_number });
await db.collection('insolvency_notices').insertOne({
  company_number, notice_date: "2023-08-15", notice_type: "Winding-up order (example)", url: "https://www.thegazette.co.uk/"
});

console.log("Extended seed done.");
await client.close();
