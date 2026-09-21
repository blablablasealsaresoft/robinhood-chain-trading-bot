/** Minimal in-memory fixed-window rate limiter. Per-process, not distributed — sufficient
 * for a single Hub instance; a multi-instance deployment would need a shared store. */
export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>()
  constructor(private windowMs: number, private max: number) {}
  /** Returns true if the call is allowed (and records it); false if the limit is exceeded. */
  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key)
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now })
      return true
    }
    if (entry.count >= this.max) return false
    entry.count++
    return true
  }
  /** Periodic cleanup so the map doesn't grow unboundedly across process lifetime. */
  sweep(now = Date.now()) {
    for (const [key, entry] of this.hits) if (now - entry.windowStart >= this.windowMs * 4) this.hits.delete(key)
  }
}
