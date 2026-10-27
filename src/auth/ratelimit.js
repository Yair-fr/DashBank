// In-memory sliding-window failure counter. Resets on restart (fine for a single-user local app).
export function createRateLimiter({ max = 5, windowMs = 15 * 60 * 1000, now = () => Date.now(), maxKeys = 10_000 } = {}) {
  const hits = new Map(); // key -> failure timestamps (ms)

  const live = (key) => {
    const list = hits.get(key);
    if (!list) return [];
    const cutoff = now() - windowMs;
    const kept = list.filter((t) => t > cutoff);
    if (kept.length) hits.set(key, kept); else hits.delete(key);
    return kept;
  };

  return {
    /** ms until the key may try again; 0 when not blocked. */
    blocked(key) {
      const list = live(key);
      return list.length >= max ? Math.max(1, list[list.length - max] + windowMs - now()) : 0;
    },
    fail(key) {
      const list = live(key);
      list.push(now());
      hits.delete(key);
      hits.set(key, list);
      // Map keeps insertion order: evict the least recently failed keys first.
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    },
    reset(key) {
      hits.delete(key);
    },
    size: () => hits.size,
  };
}
