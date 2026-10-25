import { describe, expect, it } from 'vitest'
import { TokenRateLimiter } from '../src/rate-limit.js'

describe('per-token rate limiter', () => {
  it('limits each token independently and reports a bounded retry interval', () => {
    const limiter = new TokenRateLimiter(2, 60_000)

    expect(limiter.consume('token-a', 1_000)).toEqual({ allowed: true })
    expect(limiter.consume('token-a', 1_001)).toEqual({ allowed: true })
    expect(limiter.consume('token-b', 1_002)).toEqual({ allowed: true })
    expect(limiter.consume('token-a', 1_003)).toEqual({ allowed: false, retryAfterSeconds: 60 })
    expect(limiter.consume('token-a', 60_999)).toEqual({ allowed: false, retryAfterSeconds: 1 })
  })

  it('resets exactly at the next fixed window', () => {
    const limiter = new TokenRateLimiter(1, 1_000)
    expect(limiter.consume('token-a', 100)).toEqual({ allowed: true })
    expect(limiter.consume('token-a', 1_099)).toEqual({ allowed: false, retryAfterSeconds: 1 })
    expect(limiter.consume('token-a', 1_100)).toEqual({ allowed: true })
  })
})
