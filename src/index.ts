import { IdAllocator } from "./idAllocator";
import express from "express";
import { Pool } from "pg";
import Redis from "ioredis";
import { z } from "zod";
import { encode } from "./base62";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://app:app@localhost:5432/shortener",
});
const allocator = new IdAllocator(pool);
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const app = express();
app.use(express.json());

const body = z.object({ url: z.string().url() });

app.post("/api/shorten", async (req, res) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid URL" });

  const id = await allocator.nextId();
  const code = encode(id);

  await pool.query(
    "INSERT INTO urls (id, short_code, long_url) VALUES ($1, $2, $3)",
    [id.toString(), code, parsed.data.url]
  );
  res.status(201).json({ shortCode: code, shortUrl: `http://localhost:3000/${code}` });
});

app.get("/:code", async (req, res) => {
  const { code } = req.params;

  const cached = await redis.get(`url:${code}`);          // 1. try cache
  if (cached) return res.redirect(302, cached);

  const { rows } = await pool.query(                       // 2. miss: go to DB
    "SELECT long_url FROM urls WHERE short_code = $1 AND (expires_at IS NULL OR expires_at > now())",
    [code]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  await redis.set(`url:${code}`, rows[0].long_url, "EX", 3600); // 3. fill cache
  res.redirect(302, rows[0].long_url);
});

app.listen(3000, () => console.log("Listening on :3000"));