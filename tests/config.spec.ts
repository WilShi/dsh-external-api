import { describe, expect, it } from 'vitest'
import { hashBearerToken } from '../src/auth.js'
import {
  Config,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_EXTERNAL_API_PORT,
  DEFAULT_MAX_CONCURRENT_RUNS_GLOBAL,
  DEFAULT_MAX_CONCURRENT_RUNS_PER_TOKEN,
  legacyConcurrencyUpgrade,
  publicConfig,
  validateExternalApiConfig,
} from '../src/config.js'
import { ALL_EXTERNAL_API_SCOPES, type ExternalApiConfig, type ExternalApiTokenRecord } from '../src/contracts.js'

function token(overrides: Partial<ExternalApiTokenRecord> = {}): ExternalApiTokenRecord {
  return {
    id: 'token-a',
    name: 'automation',
    digest: hashBearerToken('dshx_fixture_token_long_enough_000000000000000'),
    prefix: 'dshx_fixture…',
    scopes: [...ALL_EXTERNAL_API_SCOPES],
    allowedWorkspaceIds: ['*'],
    allowedAgentPresets: ['*'],
    allowedOrigins: [],
    createdAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  }
}

function config(overrides: Partial<ExternalApiConfig> = {}): ExternalApiConfig {
  return {
    enabled: false,
    port: DEFAULT_EXTERNAL_API_PORT,
    allowedOrigins: [],
    requestBodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
    rateLimitPerMinute: 120,
    maxSseConnectionsPerToken: 4,
    maxConcurrentRunsPerToken: DEFAULT_MAX_CONCURRENT_RUNS_PER_TOKEN,
    maxConcurrentRunsGlobal: DEFAULT_MAX_CONCURRENT_RUNS_GLOBAL,
    eventBufferSize: 256,
    tokens: [],
    ...overrides,
  }
}

describe('external API configuration', () => {
  it('is opt-in, loopback-oriented, and bounded by default', () => {
    const resolved = Config({} as never)

    expect(resolved).toMatchObject({
      enabled: false,
      port: DEFAULT_EXTERNAL_API_PORT,
      allowedOrigins: [],
      requestBodyLimitBytes: 256 * 1024,
      rateLimitPerMinute: 120,
      maxSseConnectionsPerToken: 4,
      maxConcurrentRunsPerToken: 10,
      maxConcurrentRunsGlobal: 20,
      eventBufferSize: 256,
      tokens: [],
    })
  })

  it('upgrades only the exact legacy 2/4 concurrency defaults', () => {
    expect(legacyConcurrencyUpgrade(config({
      maxConcurrentRunsPerToken: 2,
      maxConcurrentRunsGlobal: 4,
    }))).toEqual({
      maxConcurrentRunsPerToken: 10,
      maxConcurrentRunsGlobal: 20,
    })
    expect(legacyConcurrencyUpgrade(config({
      maxConcurrentRunsPerToken: 2,
      maxConcurrentRunsGlobal: 8,
    }))).toBeUndefined()
    expect(legacyConcurrencyUpgrade(config())).toBeUndefined()
  })

  it.each([1023, 65_536, 1.5, Number.NaN])('rejects an unsafe port: %s', (port) => {
    expect(() => Config({ port } as never)).toThrow()
  })

  it('rejects malformed digests, duplicate token identities, and duplicate scopes', () => {
    expect(() => validateExternalApiConfig(config({ tokens: [token({ digest: 'plaintext-secret' })] })))
      .toThrow(/invalid SHA-256 digest/u)
    expect(() => validateExternalApiConfig(config({
      tokens: [token(), token({ name: 'duplicate id', digest: hashBearerToken('different secret') })],
    }))).toThrow(/duplicate external API token id/u)
    expect(() => validateExternalApiConfig(config({
      tokens: [token({ scopes: ['sessions:read', 'sessions:read'] })],
    }))).toThrow(/duplicate scopes/u)
  })

  it.each([
    'not-an-origin',
    'ftp://example.test',
    'https://user:password@example.test',
    'https://example.test/path',
    'https://example.test/?query=secret',
    'https://example.test/#fragment',
    'https://EXAMPLE.test',
  ])('rejects a non-normalized or unsafe origin: %s', (origin) => {
    expect(() => validateExternalApiConfig(config({ allowedOrigins: [origin] }))).toThrow()
  })

  it('validates both global and per-token origin allowlists', () => {
    expect(() => validateExternalApiConfig(config({
      allowedOrigins: ['https://app.example.test', 'http://127.0.0.1:3000'],
      tokens: [token({ allowedOrigins: ['http://127.0.0.1:3000'] })],
    }))).not.toThrow()

    expect(() => validateExternalApiConfig(config({
      tokens: [token({ allowedOrigins: ['https://app.example.test', 'https://app.example.test'] })],
    }))).toThrow(/duplicates/u)
  })

  it('never publishes token records or internal request controls', () => {
    const secretMarker = hashBearerToken('must-not-be-public')
    const published = publicConfig(config({
      enabled: true,
      allowedOrigins: ['https://app.example.test'],
      tokens: [token({ digest: secretMarker })],
    }))

    expect(published).toEqual({
      enabled: true,
      port: DEFAULT_EXTERNAL_API_PORT,
      allowedOrigins: ['https://app.example.test'],
    })
    expect(JSON.stringify(published)).not.toContain(secretMarker)
    expect(published).not.toHaveProperty('tokens')
    expect(published).not.toHaveProperty('requestBodyLimitBytes')
  })
})
