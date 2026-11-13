'use strict'
/*
 * CACHE — the reason the bot used to feel slow and inconsistent.
 *
 * THE PROBLEM
 * -----------
 * Every single message rebuilt the same handful of facts from Postgres:
 * settings, the group row, the sender's AXYON number, the sender's RHM role.
 * That is four round trips before a command even starts, and they were made
 * again for the *next* message a second later. On a hosted Postgres with any
 * real latency that is 40-200 ms of pure overhead per message, and it varies
 * with network weather — which is exactly why the bot was "sometimes slow,
 * sometimes fast".
 *
 * THE FIX
 * -------
 * A tiny TTL cache in front of the read paths. Settings and group rows change
 * rarely, so a short TTL is safe; every write path calls `invalidate()` so a
 * change is visible immediately rather than after the TTL.
 *
 * Deliberately NOT cached: player rows and battles. Those change on every
 * turn and a stale read would corrupt progression.
 */

const DEFAULT_TTL_MS = 30000

class TtlCache {
  constructor ({ ttlMs = DEFAULT_TTL_MS, max = 500 } = {}) {
    this.ttlMs = ttlMs
    this.max = max
    this.map = new Map()
    this.hits = 0
    this.misses = 0
  }

  get (key) {
    const hit = this.map.get(key)
    if (!hit) { this.misses++; return undefined }
    if (hit.expires <= Date.now()) { this.map.delete(key); this.misses++; return undefined }
    this.hits++
    return hit.value
  }

  set (key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) {
      /* Drop the oldest entry — Map preserves insertion order. */
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs })
    return value
  }

  /** Removes one key, or every key starting with a prefix. */
  invalidate (prefix) {
    if (prefix === undefined) { this.map.clear(); return }
    for (const key of [...this.map.keys()]) {
      if (key === prefix || key.startsWith(prefix)) this.map.delete(key)
    }
  }

  /**
   * Read-through helper. `loader` runs only on a miss, and concurrent callers
   * for the same key share one in-flight promise instead of stampeding the
   * database.
   */
  async wrap (key, loader, ttlMs = this.ttlMs) {
    const cached = this.get(key)
    if (cached !== undefined) return cached
    const inflight = this.inflight?.get(key)
    if (inflight) return inflight
    if (!this.inflight) this.inflight = new Map()
    const promise = (async () => {
      try {
        const value = await loader()
        this.set(key, value, ttlMs)
        return value
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, promise)
    return promise
  }

  stats () {
    const total = this.hits + this.misses
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? +(this.hits / total).toFixed(3) : 0
    }
  }
}

/* One shared cache for the whole process. */
const cache = new TtlCache()

module.exports = { TtlCache, cache, DEFAULT_TTL_MS }
