# Design decisions

## ID generation
Postgres sequence stepping by 1000. Each app instance leases a block and
serves IDs from memory. Chosen over hashing (needs collision checks) and a
per-request counter (hot spot under load). Trade-off: unused IDs are lost on
restart, which is harmless with ~3.5 trillion 7-character codes.

## Uniqueness
Enforced by the database unique constraint (catching error 23505), not by
check-then-insert, which would race under concurrent requests.

## Redirect status
302, not 301. A 301 is cached by browsers, so repeat clicks would never
reach the server and analytics would undercount.

## Caching
Cache-aside with Redis and a 1-hour TTL, capped at the link's expiry so
expired links never keep redirecting from cache.

## Negative caching
Misses are cached as a sentinel value for 60 seconds so repeated requests
for nonexistent codes don't reach Postgres. The key is deleted when a link
is created, so a new alias works immediately.

## Cache stampede protection
On a cache miss, a request takes a short Redis lock (SET NX with 5s expiry).
Only the lock holder queries Postgres; others poll the cache for up to 500ms,
then fall back to the DB. The lock expiry prevents a crashed holder from
blocking others. Trade-off: slight added latency for waiters on cold keys.

## Rate limiting
Sliding window log per client IP using a Redis sorted set, evaluated in a
Lua script so check-and-add is atomic. Time is read from Redis (TIME) to
avoid clock skew between app instances. Chosen over Fixed Window, which
allows up to 2x the limit across a window boundary. Trade-off: memory is
O(requests in window) per client; Token Bucket or a sliding-window counter
would use less. The limiter fails open if Redis is unavailable.