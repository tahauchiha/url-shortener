import { randomUUID } from "crypto";
import type Redis from "ioredis";
import type { Request, Response, NextFunction } from "express";

// Runs atomically inside Redis, so concurrent requests can't race.
const SCRIPT = `
local key    = KEYS[1]
local window = tonumber(ARGV[1])   -- ms
local limit  = tonumber(ARGV[2])
local member = ARGV[3]

local t   = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryMs = window - (now - tonumber(oldest[2]))
  return {0, retryMs}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, limit - count - 1}
`;

export function slidingWindowLimiter(
  redis: Redis,
  opts: { limit: number; windowMs: number; prefix?: string }
) {
  const { limit, windowMs, prefix = "rl" } = opts;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `${prefix}:${req.ip}`;
      const [allowed, extra] = (await redis.eval(
        SCRIPT, 1, key, windowMs, limit, randomUUID()
      )) as [number, number];

      res.setHeader("X-RateLimit-Limit", limit);

      if (!allowed) {
        const retryAfter = Math.max(1, Math.ceil(extra / 1000));
        res.setHeader("Retry-After", retryAfter);
        res.setHeader("X-RateLimit-Remaining", 0);
        return res.status(429).json({ error: "Too many requests", retryAfterSeconds: retryAfter });
      }

      res.setHeader("X-RateLimit-Remaining", extra);
      next();
    } catch (err) {
      // Fail open: if Redis is down, don't take the whole API down with it
      console.error("rate limiter error", err);
      next();
    }
  };
}