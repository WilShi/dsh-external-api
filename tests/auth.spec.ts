import { describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  hashBearerToken,
  isAllowed,
  issueBearerToken,
  requireScope,
  TokenAuthenticator,
} from '../src/auth.js'
import { ALL_EXTERNAL_API_SCOPES, type AuthenticatedToken } from '../src/contracts.js'

describe('external API bearer authentication', () => {
  it('issues a high-entropy secret but stores only its digest and display prefix', () => {
    const issued = issueBearerToken('automation')

    expect(issued.secret).toMatch(/^dshx_[A-Za-z0-9_-]{43}$/u)
    expect(issued.record.digest).toBe(hashBearerToken(issued.secret))
    expect(issued.record.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(issued.record.prefix).not.toBe(issued.secret)
    expect(JSON.stringify(issued.record)).not.toContain(issued.secret)
    expect(issued.record.scopes).toEqual(ALL_EXTERNAL_API_SCOPES)
  })

  it('authenticates the full secret and records use without exposing it', () => {
    const issued = issueBearerToken('caller')
    const authenticator = new TokenAuthenticator([issued.record])

    const authenticated = authenticator.authenticate(`Bearer ${issued.secret}`)

    expect(authenticated).toMatchObject({ id: issued.record.id, name: 'caller' })
    expect([...authenticated.scopes]).toEqual(ALL_EXTERNAL_API_SCOPES)
    expect(authenticator.lastUsedAt(issued.record.id)).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(JSON.stringify(authenticated)).not.toContain(issued.secret)
  })

  it.each([
    ['missing header', undefined, 'AUTH_REQUIRED'],
    ['duplicate header', ['Bearer one', 'Bearer two'], 'AUTH_REQUIRED'],
    ['basic auth', 'Basic abcdefghijklmnopqrstuvwxyz123456', 'AUTH_INVALID'],
    ['lowercase scheme', 'bearer abcdefghijklmnopqrstuvwxyz123456', 'AUTH_INVALID'],
    ['whitespace variation', 'Bearer  abcdefghijklmnopqrstuvwxyz123456', 'AUTH_INVALID'],
    ['short token', 'Bearer too-short', 'AUTH_INVALID'],
    ['unknown token', `Bearer dshx_${'x'.repeat(43)}`, 'AUTH_INVALID'],
    ['oversized token', `Bearer ${'x'.repeat(513)}`, 'AUTH_INVALID'],
  ] as const)('rejects %s without marking any token as used', (_label, header, expectedCode) => {
    const issued = issueBearerToken('caller')
    const authenticator = new TokenAuthenticator([issued.record])

    const candidate: string | string[] | undefined = typeof header === 'string' || header === undefined
      ? header
      : [...header]
    expect(() => authenticator.authenticate(candidate)).toThrowError(
      expect.objectContaining({ name: 'AuthenticationError', code: expectedCode }),
    )
    expect(authenticator.lastUsedAt(issued.record.id)).toBeUndefined()
  })

  it('does not accept the non-secret display prefix as a credential', () => {
    const issued = issueBearerToken('caller')
    const authenticator = new TokenAuthenticator([issued.record])

    expect(() => authenticator.authenticate(`Bearer ${issued.record.prefix}`))
      .toThrowError(expect.objectContaining({ code: 'AUTH_INVALID' }))
  })

  it('enforces scopes and exact allowlists with an explicit wildcard', () => {
    const token: AuthenticatedToken = {
      id: 'reader',
      name: 'reader',
      scopes: new Set(['sessions:read']),
      allowedWorkspaceIds: new Set(['workspace-a']),
      allowedAgentPresets: new Set(['safe-preset']),
      allowedOrigins: new Set(),
    }

    expect(() => requireScope(token, 'sessions:read')).not.toThrow()
    expect(() => requireScope(token, 'sessions:write')).toThrowError(
      expect.objectContaining<Partial<AuthenticationError>>({ code: 'SCOPE_REQUIRED' }),
    )
    expect(isAllowed(token.allowedWorkspaceIds, 'workspace-a')).toBe(true)
    expect(isAllowed(token.allowedWorkspaceIds, 'workspace-b')).toBe(false)
    expect(isAllowed(new Set(['*']), 'any-untrusted-id')).toBe(true)
  })
})
