import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type {
  AuthenticatedToken,
  ExternalApiScope,
  ExternalApiTokenRecord,
} from './contracts.ts'
import { ALL_EXTERNAL_API_SCOPES } from './contracts.ts'

const MAX_BEARER_LENGTH = 512

export class AuthenticationError extends Error {
  readonly code: 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'SCOPE_REQUIRED' | 'ORIGIN_FORBIDDEN'

  constructor(code: AuthenticationError['code']) {
    super(code)
    this.name = 'AuthenticationError'
    this.code = code
  }
}

export interface IssuedToken {
  readonly secret: string
  readonly record: ExternalApiTokenRecord
}

export function hashBearerToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function issueBearerToken(
  name: string,
  options: Partial<Pick<ExternalApiTokenRecord, 'scopes' | 'allowedWorkspaceIds' | 'allowedAgentPresets' | 'allowedOrigins'>> = {},
): IssuedToken {
  const id = randomUUID()
  const secret = `dshx_${randomBytes(32).toString('base64url')}`
  return {
    secret,
    record: {
      id,
      name,
      digest: hashBearerToken(secret),
      prefix: `${secret.slice(0, 12)}…`,
      scopes: [...(options.scopes ?? ALL_EXTERNAL_API_SCOPES)],
      allowedWorkspaceIds: [...(options.allowedWorkspaceIds ?? [])],
      allowedAgentPresets: [...(options.allowedAgentPresets ?? [])],
      allowedOrigins: [...(options.allowedOrigins ?? [])],
      createdAt: new Date().toISOString(),
    },
  }
}

/** Authenticates every candidate in constant work with respect to its position. */
export class TokenAuthenticator {
  readonly #records: readonly ExternalApiTokenRecord[]
  readonly #digests: readonly Buffer[]
  readonly #lastUsedAt = new Map<string, string>()

  constructor(records: readonly ExternalApiTokenRecord[]) {
    this.#records = [...records]
    this.#digests = records.map(record => Buffer.from(record.digest, 'hex'))
  }

  authenticate(header: string | string[] | undefined): AuthenticatedToken {
    if (Array.isArray(header) || typeof header !== 'string') throw new AuthenticationError('AUTH_REQUIRED')
    const match = /^Bearer ([A-Za-z0-9_-]{32,512})$/u.exec(header)
    if (match === null || match[1]!.length > MAX_BEARER_LENGTH) throw new AuthenticationError('AUTH_INVALID')

    const presented = createHash('sha256').update(match[1]!, 'utf8').digest()
    let matchedIndex = -1
    for (let index = 0; index < this.#digests.length; index += 1) {
      const candidate = this.#digests[index]!
      const matches = candidate.byteLength === presented.byteLength && timingSafeEqual(candidate, presented)
      if (matches) matchedIndex = index
    }
    const record = matchedIndex < 0 ? undefined : this.#records[matchedIndex]
    if (record === undefined) throw new AuthenticationError('AUTH_INVALID')
    this.#lastUsedAt.set(record.id, new Date().toISOString())
    return {
      id: record.id,
      name: record.name,
      scopes: new Set(record.scopes),
      allowedWorkspaceIds: new Set(record.allowedWorkspaceIds),
      allowedAgentPresets: new Set(record.allowedAgentPresets),
      allowedOrigins: new Set(record.allowedOrigins),
    }
  }

  lastUsedAt(tokenId: string): string | undefined {
    return this.#lastUsedAt.get(tokenId)
  }
}

export function requireScope(token: AuthenticatedToken, scope: ExternalApiScope): void {
  if (!token.scopes.has(scope)) throw new AuthenticationError('SCOPE_REQUIRED')
}

export function isAllowed(set: ReadonlySet<string>, value: string): boolean {
  return set.has('*') || set.has(value)
}
