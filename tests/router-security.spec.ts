import { afterEach, describe, expect, it } from 'vitest'
import { issueBearerToken } from '../src/auth.js'
import type { ExternalApiServer } from '../src/listener.js'
import { jsonRequest, rawHttpRequest, startHarness } from './integration-helpers.js'

const running: ExternalApiServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.stop()))
})

describe('external API authentication and route isolation', () => {
  it('rejects missing, malformed, and unknown bearer credentials without reflecting them', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const unknownSecret = `dshx_${'x'.repeat(43)}`

    const missing = await jsonRequest(harness, '/api/v1/capabilities', { token: null })
    expect(missing.response.status).toBe(401)
    expect(missing.body.error).toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(missing.response.headers.get('www-authenticate')).toMatch(/^Bearer\b/u)

    const malformed = await fetch(`${harness.baseUrl}/api/v1/capabilities`, {
      headers: { authorization: 'Basic abcdefghijklmnopqrstuvwxyz' },
    })
    expect(malformed.status).toBe(401)
    expect(await malformed.text()).not.toContain('abcdefghijklmnopqrstuvwxyz')

    const unknown = await jsonRequest(harness, '/api/v1/capabilities', { token: unknownSecret })
    expect(unknown.response.status).toBe(401)
    expect(unknown.body.error).toMatchObject({ code: 'AUTH_INVALID' })
    expect(unknown.text).not.toContain(unknownSecret)
    expect(unknown.text).not.toContain(harness.token.record.digest)
  })

  it('never accepts credentials in the URL', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const response = await jsonRequest(
      harness,
      `/api/v1/capabilities?access_token=${encodeURIComponent(harness.token.secret)}`,
      { token: null },
    )

    expect(response.response.status).toBe(401)
    expect(response.text).not.toContain(harness.token.secret)
  })

  it('enforces route scopes before invoking DSH', async () => {
    const reader = issueBearerToken('reader', { scopes: ['sessions:read'] })
    const harness = await startHarness({ token: reader })
    running.push(harness.server)

    const list = await jsonRequest(harness, '/api/v1/sessions')
    expect(list.response.status).toBe(200)
    const capabilities = await jsonRequest(harness, '/api/v1/capabilities')
    expect(capabilities.response.status).toBe(403)
    expect(capabilities.body.error).toMatchObject({ code: 'SCOPE_REQUIRED' })
    const create = await jsonRequest(harness, '/api/v1/sessions', { method: 'POST', body: {} })
    expect(create.response.status).toBe(403)
    expect(harness.fake.calls.create).not.toHaveBeenCalled()
  })

  it.each([
    '/api/session.list',
    '/api/respond',
    '/mcp-manager',
    '/settings',
    '/external-api-admin/status',
    '/api/v1/settings',
    '/api/v1/credentials',
    '/api/v1/terminal',
    '/api/v1/no-such-route',
  ])('returns a uniform 404 for an unexposed core route: %s', async (path) => {
    const harness = await startHarness()
    running.push(harness.server)

    const result = await jsonRequest(harness, path)

    expect(result.response.status).toBe(404)
    expect(result.body.error).toMatchObject({ code: 'NOT_FOUND' })
    expect(result.text).not.toMatch(/mcp|setting|credential|terminal|rpc/i)
    expect(harness.fake.calls.create).not.toHaveBeenCalled()
    expect(harness.fake.calls.prompt).not.toHaveBeenCalled()
  })

  it('advertises only the stable, deliberately restricted capability surface', async () => {
    const harness = await startHarness()
    running.push(harness.server)

    const result = await jsonRequest(harness, '/api/v1/capabilities')

    expect(result.response.status).toBe(200)
    expect(result.body).toMatchObject({
      apiVersion: 'v1',
      transport: { http: true, sse: true },
      features: {
        sessions: true,
        messageHistory: true,
        runs: true,
        cancellation: true,
        eventReplay: true,
        rawRpc: false,
        rawTools: false,
        slashCommands: false,
        filesystemPaths: false,
      },
    })
    expect(JSON.stringify(result.body)).not.toMatch(/apiKey|credential|systemPrompt|baseURL/u)
  })
})

describe('external API HTTP request policy', () => {
  it('rejects a forged Host header before authentication', async () => {
    const harness = await startHarness()
    running.push(harness.server)

    const port = new URL(harness.baseUrl).port
    for (const host of ['evil.example', `localhost:${port}`, `0.0.0.0:${port}`, `192.168.99.99:${port}`]) {
      const response = await rawHttpRequest(harness.baseUrl, '/api/v1/health', { headers: { host } })
      expect(response.status, host).toBe(421)
      expect(response.body).toMatchObject({ error: { code: 'HOST_REJECTED' } })
    }
  })

  it('supports an explicit origin allowlist without reflecting rejected origins', async () => {
    const allowedOrigin = 'https://client.example.test'
    const token = issueBearerToken('browser', { allowedOrigins: [allowedOrigin] })
    const harness = await startHarness({
      token,
      config: { allowedOrigins: [allowedOrigin, 'https://other.example.test'] },
    })
    running.push(harness.server)

    const allowed = await jsonRequest(harness, '/api/v1/capabilities', {
      headers: { origin: allowedOrigin, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    })
    expect(allowed.response.status).toBe(200)
    expect(allowed.response.headers.get('access-control-allow-origin')).toBe(allowedOrigin)

    const deniedOrigin = 'https://other.example.test'
    const denied = await jsonRequest(harness, '/api/v1/capabilities', {
      headers: { origin: deniedOrigin, 'sec-fetch-site': 'cross-site' },
    })
    expect(denied.response.status).toBe(403)
    expect(denied.body.error).toMatchObject({ code: 'ORIGIN_FORBIDDEN' })
    expect(denied.response.headers.get('access-control-allow-origin')).toBe(deniedOrigin)
  })

  it('rejects cross-site and navigation requests without an allowlisted origin', async () => {
    const harness = await startHarness()
    running.push(harness.server)

    const crossSite = await jsonRequest(harness, '/api/v1/capabilities', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.response.status).toBe(403)
    expect(crossSite.body.error).toMatchObject({ code: 'FETCH_METADATA_REJECTED' })

    const navigation = await rawHttpRequest(harness.baseUrl, '/api/v1/capabilities', {
      headers: {
        authorization: `Bearer ${harness.token.secret}`,
        'sec-fetch-mode': 'navigate',
      },
    })
    expect(navigation.status).toBe(403)
  })

  it('serves a narrow unauthenticated CORS preflight', async () => {
    const origin = 'https://client.example.test'
    const harness = await startHarness({ config: { allowedOrigins: [origin] } })
    running.push(harness.server)

    const response = await fetch(`${harness.baseUrl}/api/v1/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization')

    const broad = await fetch(`${harness.baseUrl}/api/v1/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'x-private-header',
      },
    })
    expect(broad.status).toBe(405)
  })

  it('requires JSON, rejects malformed/unknown fields, and enforces the streaming body limit', async () => {
    const harness = await startHarness({ config: { requestBodyLimitBytes: 1024 } })
    running.push(harness.server)

    const wrongType = await jsonRequest(harness, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      rawBody: '{}',
    })
    expect(wrongType.response.status).toBe(415)

    const malformed = await jsonRequest(harness, '/api/v1/sessions', {
      method: 'POST',
      rawBody: '{"workspaceId":',
    })
    expect(malformed.response.status).toBe(400)
    expect(malformed.body.error).toMatchObject({ code: 'INVALID_JSON' })

    const unknown = await jsonRequest(harness, '/api/v1/sessions', {
      method: 'POST',
      body: { cwd: 'C:\\private', apiKey: 'secret' },
    })
    expect(unknown.response.status).toBe(400)
    expect(unknown.body.error).toMatchObject({ code: 'UNKNOWN_FIELD' })
    expect(unknown.text).not.toContain('C:\\private')
    expect(unknown.text).not.toContain('secret')

    const oversized = await jsonRequest(harness, '/api/v1/sessions', {
      method: 'POST',
      body: { input: 'x'.repeat(1100) },
    })
    expect(oversized.response.status).toBe(413)
    expect(oversized.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(harness.fake.calls.create).not.toHaveBeenCalled()
  })

  it('uses standard method metadata and rate-limit backoff', async () => {
    const harness = await startHarness({ config: { rateLimitPerMinute: 2 } })
    running.push(harness.server)

    const wrongMethod = await jsonRequest(harness, '/api/v1/capabilities', { method: 'POST', body: {} })
    expect(wrongMethod.response.status).toBe(405)
    expect(wrongMethod.response.headers.get('allow')).toContain('GET')

    const first = await jsonRequest(harness, '/api/v1/capabilities')
    expect(first.response.status).toBe(200)
    const limited = await jsonRequest(harness, '/api/v1/capabilities')
    expect(limited.response.status).toBe(429)
    expect(Number(limited.response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })
})

describe('external API capability allowlists', () => {
  it('filters workspaces and agents and blocks forbidden create selections', async () => {
    const token = issueBearerToken('restricted', {
      allowedWorkspaceIds: ['workspace-safe'],
      allowedAgentPresets: ['agent-safe'],
    })
    const harness = await startHarness({ token })
    running.push(harness.server)
    harness.fake.state.workspaces = [
      { workspaceId: 'workspace-safe', title: 'Safe', path: 'C:\\safe' },
      { workspaceId: 'workspace-private', title: 'Private', path: 'C:\\private' },
    ]
    harness.fake.state.agents = [
      { id: 'agent-safe', name: 'Safe agent', description: 'Allowed' },
      { id: 'agent-private', name: 'Private agent', description: 'Hidden', systemPrompt: 'secret' },
      { id: 'agent-broken', name: 'Broken', broken: { message: 'private stack' } },
    ]

    const workspaces = await jsonRequest(harness, '/api/v1/workspaces')
    expect(workspaces.body).toEqual({ items: [{ id: 'workspace-safe', name: 'Safe' }] })
    expect(workspaces.text).not.toContain('C:\\safe')
    expect(workspaces.text).not.toContain('Private')

    const agents = await jsonRequest(harness, '/api/v1/agents')
    expect(agents.body).toEqual({ items: [{ id: 'agent-safe', name: 'Safe agent', description: 'Allowed', isDefault: false }] })
    expect(agents.text).not.toContain('systemPrompt')
    expect(agents.text).not.toContain('private stack')

    const deniedWorkspace = await jsonRequest(harness, '/api/v1/sessions', {
      method: 'POST', body: { workspaceId: 'workspace-private' },
    })
    expect(deniedWorkspace.response.status).toBe(403)
    const deniedAgent = await jsonRequest(harness, '/api/v1/sessions', {
      method: 'POST', body: { agentPreset: 'agent-private' },
    })
    expect(deniedAgent.response.status).toBe(403)
    expect(harness.fake.calls.create).not.toHaveBeenCalled()
  })
})
