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

app.listen(process.env.PORT || 3000, () => {
  console.log(`SBRI service running on port ${process.env.PORT || 3000}`);
});
