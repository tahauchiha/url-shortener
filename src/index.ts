import path from "path";
import { slidingWindowLimiter } from "./rateLimiter";
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
app.set("trust proxy", true); // for req.ip to work behind a reverse proxy
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));
const body = z.object({
  url: z.string().url(),
  alias: z.string().regex(/^[a-zA-Z0-9_-]{3,16}$/).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

const RESERVED = new Set(["api", "health", "admin"]);
// 5 creates per minute per IP, low on purpose so it's easy to test
app.post("/api/shorten", slidingWindowLimiter(redis, { limit: 100, windowMs: 60_000 }));
app.post("/api/shorten", async (req, res) => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }
  const { url, alias, expiresInDays } = parsed.data;

  if (alias && RESERVED.has(alias.toLowerCase())) {
    return res.status(400).json({ error: "Alias is reserved" });
  }

  const id = await allocator.nextId();
  const code = alias ?? encode(id);
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86_400_000)
    : null;

  try {
    await pool.query(
      "INSERT INTO urls (id, short_code, long_url, expires_at) VALUES ($1, $2, $3, $4)",
      [id.toString(), code, url, expiresAt]
    );
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Alias already taken" });
    }
    throw err;
  }
  await redis.del(`url:${code}`);
  res.status(201).json({
    shortCode: code,
    shortUrl: `${process.env.BASE_URL ?? "http://localhost:3000"}/${code}`,
    expiresAt,
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function recordClick(code: string, referrer?: string, userAgent?: string) {
  // Fire and forget: the redirect never waits for this insert
  pool
    .query(
      "INSERT INTO clicks (short_code, referrer, user_agent) VALUES ($1, $2, $3)",
      [code, referrer ?? null, userAgent ?? null]
    )
    .catch((err) => console.error("click insert failed", err));
}

// Runs for every GET /:code, records only successful redirects
app.get("/:code", (req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode === 302) {
      recordClick(req.params.code, req.get("referer"), req.get("user-agent"));
    }
  });
  next();
});
app.get("/:code", async (req, res) => {
  const { code } = req.params;
  if (process.env.DISABLE_CACHE === "1") {
    try {
      const { rows } = await pool.query(
        "SELECT long_url FROM urls WHERE short_code = $1 AND (expires_at IS NULL OR expires_at > now())",
        [code]
      );
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      return res.redirect(302, rows[0].long_url);
    } catch (err) {
      console.error("no-cache path error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }  
  const cached = await redis.get(`url:${code}`);
  if (cached === "__NOTFOUND__") return res.status(404).json({ error: "Not found" });
  if (cached) return res.redirect(302, cached);

  // Only one request per code rebuilds the cache; others wait and re-read it
  const lockKey = `lock:${code}`;
  const gotLock = await redis.set(lockKey, "1", "EX", 5, "NX");

  if (!gotLock) {
    for (let i = 0; i < 10; i++) {
      await sleep(50);
      const again = await redis.get(`url:${code}`);
      if (again === "__NOTFOUND__") return res.status(404).json({ error: "Not found" });
      if (again) return res.redirect(302, again);
    }
    // lock holder was slow; fall through and query the DB ourselves
  }

  try {
    //console.log("DB hit", code); // temporary, remove after testing
    //console.log("hit", process.env.HOSTNAME);
    const { rows } = await pool.query(
      "SELECT long_url, expires_at FROM urls WHERE short_code = $1 AND (expires_at IS NULL OR expires_at > now())",
      [code]
    );

    if (!rows.length) {
      await redis.set(`url:${code}`, "__NOTFOUND__", "EX", 60);
      return res.status(404).json({ error: "Not found" });
    }

    const row = rows[0];
    let ttl = 3600;
    if (row.expires_at) {
      const secondsLeft = Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000);
      ttl = Math.min(ttl, secondsLeft);
    }
    if (ttl > 0) await redis.set(`url:${code}`, row.long_url, "EX", ttl);
    res.redirect(302, row.long_url);
  } finally {
    if (gotLock) await redis.del(lockKey);
  }
});

app.get("/api/stats/:code", async (req, res) => {
  const { code } = req.params;

  const [total, perDay, referrers] = await Promise.all([
    pool.query("SELECT count(*)::int AS n FROM clicks WHERE short_code = $1", [code]),
    pool.query(
      `SELECT date_trunc('day', clicked_at)::date AS day, count(*)::int AS clicks
       FROM clicks
       WHERE short_code = $1 AND clicked_at > now() - interval '30 days'
       GROUP BY day ORDER BY day`,
      [code]
    ),
    pool.query(
      `SELECT coalesce(referrer, 'direct') AS referrer, count(*)::int AS clicks
       FROM clicks WHERE short_code = $1
       GROUP BY 1 ORDER BY clicks DESC LIMIT 5`,
      [code]
    ),
  ]);

  res.json({
    shortCode: code,
    totalClicks: total.rows[0].n,
    clicksPerDay: perDay.rows,
    topReferrers: referrers.rows,
  });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON" });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
app.listen(3000, () => console.log("Listening on :3000"));