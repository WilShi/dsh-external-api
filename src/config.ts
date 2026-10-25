import z from '@deepseek-ai/schemastery'
import {
  ALL_EXTERNAL_API_SCOPES,
  type ExternalApiConfig,
  type ExternalApiScope,
  type ExternalApiTokenRecord,
} from './contracts.ts'

export const DEFAULT_EXTERNAL_API_PORT = 47831
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024
export const DEFAULT_MAX_CONCURRENT_RUNS_PER_TOKEN = 10
export const DEFAULT_MAX_CONCURRENT_RUNS_GLOBAL = 20

const LEGACY_MAX_CONCURRENT_RUNS_PER_TOKEN = 2
const LEGACY_MAX_CONCURRENT_RUNS_GLOBAL = 4

const scopeSchema = z.union(ALL_EXTERNAL_API_SCOPES)

const tokenSchema: z<ExternalApiTokenRecord> = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  digest: z.string().min(64).max(64).role('secret'),
  prefix: z.string().min(1).max(32),
  scopes: z.array(scopeSchema).default([...ALL_EXTERNAL_API_SCOPES] as ExternalApiScope[]),
  allowedWorkspaceIds: z.array(z.string().min(1).max(200)).default([]),
  allowedAgentPresets: z.array(z.string().min(1).max(200)).default([]),
  allowedOrigins: z.array(z.string().min(1).max(2048)).default([]),
  createdAt: z.string().min(1).max(64),
})

export const Config: z<ExternalApiConfig> = z.object({
  enabled: z.boolean().default(false),
  port: z.number().step(1).min(1024).max(65535).default(DEFAULT_EXTERNAL_API_PORT),
  allowedOrigins: z.array(z.string().min(1).max(2048)).default([]),
  requestBodyLimitBytes: z.number().step(1).min(1024).max(1024 * 1024).default(DEFAULT_BODY_LIMIT_BYTES),
  rateLimitPerMinute: z.number().step(1).min(1).max(10_000).default(120),
  maxSseConnectionsPerToken: z.number().step(1).min(1).max(32).default(4),
  maxConcurrentRunsPerToken: z.number().step(1).min(1).max(32).default(DEFAULT_MAX_CONCURRENT_RUNS_PER_TOKEN),
  maxConcurrentRunsGlobal: z.number().step(1).min(1).max(128).default(DEFAULT_MAX_CONCURRENT_RUNS_GLOBAL),
  eventBufferSize: z.number().step(1).min(16).max(4096).default(256),
  tokens: z.array(tokenSchema).default([]),
})

export function legacyConcurrencyUpgrade(
  config: ExternalApiConfig,
): Pick<ExternalApiConfig, 'maxConcurrentRunsPerToken' | 'maxConcurrentRunsGlobal'> | undefined {
  if (config.maxConcurrentRunsPerToken !== LEGACY_MAX_CONCURRENT_RUNS_PER_TOKEN
    || config.maxConcurrentRunsGlobal !== LEGACY_MAX_CONCURRENT_RUNS_GLOBAL) return undefined
  return {
    maxConcurrentRunsPerToken: DEFAULT_MAX_CONCURRENT_RUNS_PER_TOKEN,
    maxConcurrentRunsGlobal: DEFAULT_MAX_CONCURRENT_RUNS_GLOBAL,
  }
}

export function validateExternalApiConfig(config: ExternalApiConfig): void {
  if (!Number.isSafeInteger(config.port) || (config.port !== 0 && (config.port < 1024 || config.port > 65535))) {
    throw new Error('external API port must be 0 for tests or an integer between 1024 and 65535')
  }
  if (config.tokens.length > 64) throw new Error('external API supports at most 64 tokens')
  if (config.allowedOrigins.length > 64) throw new Error('external API supports at most 64 allowed origins')
  if (config.maxConcurrentRunsPerToken > config.maxConcurrentRunsGlobal) {
    throw new Error('per-token external run limit cannot exceed the global run limit')
  }
  const tokenIds = new Set<string>()
  const digests = new Set<string>()
  for (const token of config.tokens) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/u.test(token.id)) {
      throw new Error('external API token id is invalid')
    }
    if (!/^dshx_[A-Za-z0-9_-]{1,24}…?$/u.test(token.prefix)) {
      throw new Error(`external API token ${JSON.stringify(token.id)} has an invalid display prefix`)
    }
    if (!/^[a-f0-9]{64}$/u.test(token.digest)) {
      throw new Error(`external API token ${JSON.stringify(token.id)} has an invalid SHA-256 digest`)
    }
    if (tokenIds.has(token.id)) throw new Error(`duplicate external API token id: ${token.id}`)
    if (digests.has(token.digest)) throw new Error('duplicate external API token digest')
    tokenIds.add(token.id)
    digests.add(token.digest)
    if (new Set(token.scopes).size !== token.scopes.length) {
      throw new Error(`external API token ${JSON.stringify(token.id)} has duplicate scopes`)
    }
    if (token.allowedWorkspaceIds.length > 256 || token.allowedAgentPresets.length > 256 || token.allowedOrigins.length > 64) {
      throw new Error(`external API token ${JSON.stringify(token.id)} has an oversized allowlist`)
    }
    if (new Set(token.allowedWorkspaceIds).size !== token.allowedWorkspaceIds.length
      || new Set(token.allowedAgentPresets).size !== token.allowedAgentPresets.length) {
      throw new Error(`external API token ${JSON.stringify(token.id)} has duplicate allowlist entries`)
    }
    validateOrigins(token.allowedOrigins)
    if (token.allowedOrigins.some(origin => !config.allowedOrigins.includes(origin))) {
      throw new Error(`external API token ${JSON.stringify(token.id)} contains an origin outside the server allowlist`)
    }
  }
  validateOrigins(config.allowedOrigins)
}

function validateOrigins(origins: readonly string[]): void {
  if (new Set(origins).size !== origins.length) throw new Error('external API origin allowlist contains duplicates')
  for (const origin of origins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new Error(`invalid external API origin: ${JSON.stringify(origin)}`)
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
      || parsed.origin !== origin) {
      throw new Error(`external API origins must be normalized HTTP(S) origins: ${JSON.stringify(origin)}`)
    }
  }
}

export function publicConfig(config: ExternalApiConfig): Pick<ExternalApiConfig, 'enabled' | 'port' | 'allowedOrigins'> {
  return {
    enabled: config.enabled,
    port: config.port,
    allowedOrigins: [...config.allowedOrigins],
  }
}
