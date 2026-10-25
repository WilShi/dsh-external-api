export class TokenRateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #buckets = new Map<string, { startedAt: number; count: number }>()

  constructor(limit: number, windowMs = 60_000) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  consume(tokenId: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    let bucket = this.#buckets.get(tokenId)
    if (bucket === undefined || now - bucket.startedAt >= this.#windowMs) {
      bucket = { startedAt: now, count: 0 }
      this.#buckets.set(tokenId, bucket)
    }
    bucket.count += 1
    if (bucket.count <= this.#limit) return { allowed: true }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + this.#windowMs - now) / 1000)),
    }
  }
}
