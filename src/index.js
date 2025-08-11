import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const db = client.db();

app.get('/api/sbri/health', async (req, res) => {
  const profilesCount = await db.collection('profiles').countDocuments();
  res.json({ status: 'ok', profiles: profilesCount });
});

// Search by company name (uses the 'profiles' collection you seeded)
app.get('/api/sbri/search', async (req, res) => {
  const name = String(req.query.name || '');
  if (!name) return res.json([]);
  const items = await db.collection('profiles')
    .find({ company_name: { $regex: name, $options: 'i' } })
    .limit(50)
    .toArray();
  res.json(items);
});

// Optional: fetch one company by number
app.get('/api/sbri/company/:number', async (req, res) => {
  const doc = await db.collection('profiles')
    .findOne({ company_number: req.params.number });
  res.json(doc || {});
});


app.listen(process.env.PORT || 3000, () => {
  console.log(`SBRI service running on port ${process.env.PORT || 3000}`);
});
