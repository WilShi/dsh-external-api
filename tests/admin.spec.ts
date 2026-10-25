import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createAdminHandler } from '../src/admin.js'
import { issueBearerToken } from '../src/auth.js'
import {
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_EXTERNAL_API_PORT,
  DEFAULT_MAX_CONCURRENT_RUNS_GLOBAL,
  DEFAULT_MAX_CONCURRENT_RUNS_PER_TOKEN,
} from '../src/config.js'
import type { ExternalApiConfig } from '../src/contracts.js'

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

function request(method: string, path: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
  Object.assign(stream, {
    method,
    url: path,
    headers: {
      host: '127.0.0.1:43210',
      ...(method === 'GET' || method === 'HEAD' ? {} : { origin: 'http://127.0.0.1:43210' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  return stream
}

function response(): ServerResponse & { body: string; headers: Map<string, string> } {
  const headers = new Map<string, string>()
  const target = {
    statusCode: 200,
    body: '',
    writableEnded: false,
    headersSent: false,
    destroyed: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
      return target
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) target.body += chunk.toString()
      target.writableEnded = true
      target.headersSent = true
      return target
    },
    destroy() { target.destroyed = true },
    headers,
  }
  return target as unknown as ServerResponse & { body: string; headers: Map<string, string> }
}

function harness(initial = config()) {
  let current = initial
  const settings = {
    get: vi.fn(() => current),
    update: vi.fn(async (patch: Partial<ExternalApiConfig>) => { current = { ...current, ...patch } }),
  }
  const controller = {
    status: vi.fn(() => ({ state: 'stopped', host: '0.0.0.0', port: current.port })),
    configure: vi.fn(async () => undefined),
    revokeToken: vi.fn(async () => undefined),
  }
  const handler = createAdminHandler({
    host: '127.0.0.1',
    port: 43210,
    settings,
    controller: controller as never,
  })
  async function call(method: string, path: string, body?: unknown) {
    const res = response()
    await handler(request(method, path, body), res)
    return { response: res, body: res.body === '' ? undefined : JSON.parse(res.body) as any }
  }
  return { call, settings, controller, current: () => current }
}

describe('external API loopback administration', () => {
  it('returns the new bearer secret once and persists only its digest', async () => {
    const admin = harness()

    const created = await admin.call('POST', '/external-api-admin/tokens', {
      name: ' Data job ',
      allowedWorkspaceIds: ['*'],
      allowedAgentPresets: [],
    })
    expect(created.response.statusCode).toBe(201)
    expect(created.body.ok).toBe(true)
    expect(created.body.secret).toMatch(/^dshx_[A-Za-z0-9_-]{43}$/u)
    expect(created.body.token).toMatchObject({
      name: 'Data job',
      allowedWorkspaceIds: ['*'],
      allowedAgentPresets: [],
    })
    expect(created.body.token).not.toHaveProperty('digest')
    const diskFacingRecord = admin.current().tokens[0]!
    expect(diskFacingRecord.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(diskFacingRecord)).not.toContain(created.body.secret)
    expect(admin.controller.configure).toHaveBeenCalledTimes(1)

    const listed = await admin.call('GET', '/external-api-admin/tokens')
    expect(listed.response.statusCode).toBe(200)
    expect(listed.body.tokens).toEqual([created.body.token])
    expect(listed.response.body).not.toContain(created.body.secret)
    expect(listed.response.body).not.toContain(diskFacingRecord.digest)
  })

  it('never returns a secret or digest for pre-existing tokens', async () => {
    const issued = issueBearerToken('existing')
    const admin = harness(config({ tokens: [issued.record] }))

    const listed = await admin.call('GET', '/external-api-admin/tokens')

    expect(listed.body.tokens).toEqual([{
      id: issued.record.id,
      name: issued.record.name,
      prefix: issued.record.prefix,
      scopes: issued.record.scopes,
      allowedWorkspaceIds: issued.record.allowedWorkspaceIds,
      allowedAgentPresets: issued.record.allowedAgentPresets,
      createdAt: issued.record.createdAt,
    }])
    expect(listed.response.body).not.toContain(issued.secret)
    expect(listed.response.body).not.toContain(issued.record.digest)
  })

  it('validates token policy before saving and does not echo rejected data', async () => {
    const admin = harness()
    const privateMarker = 'PRIVATE-ORIGIN-PASSWORD'

    const invalid = await admin.call('POST', '/external-api-admin/tokens', {
      name: 'unsafe',
      scopes: ['credentials:write'],
      allowedOrigins: [`https://user:${privateMarker}@example.test`],
    })

    expect(invalid.response.statusCode).toBe(400)
    expect(invalid.body).toMatchObject({ ok: false, code: 'INVALID_BODY' })
    expect(invalid.response.body).not.toContain(privateMarker)
    expect(admin.settings.update).not.toHaveBeenCalled()
    expect(admin.current().tokens).toEqual([])
  })

  it('revokes a token from settings and tells the active controller to disconnect it', async () => {
    const first = issueBearerToken('first')
    const second = issueBearerToken('second')
    const admin = harness(config({ tokens: [first.record, second.record] }))

    const removed = await admin.call('DELETE', `/external-api-admin/tokens/${first.record.id}`)

    expect(removed.response.statusCode).toBe(200)
    expect(admin.current().tokens.map(token => token.id)).toEqual([second.record.id])
    expect(admin.controller.revokeToken).toHaveBeenCalledWith(first.record.id)

    const absent = await admin.call('DELETE', `/external-api-admin/tokens/${first.record.id}`)
    expect(absent.response.statusCode).toBe(404)
    expect(admin.controller.revokeToken).toHaveBeenCalledTimes(1)
  })

  it('updates only public listener settings and rejects unsafe ports and unknown controls', async () => {
    const admin = harness()
    const updated = await admin.call('PUT', '/external-api-admin/config', {
      enabled: true,
      port: 43211,
      allowedOrigins: ['https://client.example.test'],
    })
    expect(updated.response.statusCode).toBe(200)
    expect(admin.current()).toMatchObject({ enabled: true, port: 43211, allowedOrigins: ['https://client.example.test'] })
    expect(admin.controller.configure).toHaveBeenCalledTimes(1)

    for (const body of [
      { port: 80 },
      { port: 65_536 },
      { port: 43210.5 },
      { host: '0.0.0.0' },
      { tls: false },
    ]) {
      const rejected = await admin.call('PUT', '/external-api-admin/config', body)
      expect(rejected.response.statusCode, JSON.stringify(body)).toBe(400)
    }
  })

  it('requires exact loopback host and same-origin provenance for mutations', async () => {
    const admin = harness()
    const forgedHost = request('GET', '/external-api-admin/status')
    forgedHost.headers.host = 'evil.example'
    const hostResponse = response()
    await createAdminHandler({
      host: '127.0.0.1', port: 43210, settings: admin.settings, controller: admin.controller as never,
    })(forgedHost, hostResponse)
    expect(hostResponse.statusCode).toBe(421)

    const missingOrigin = request('PUT', '/external-api-admin/config', { enabled: false })
    delete missingOrigin.headers.origin
    const originResponse = response()
    await createAdminHandler({
      host: '127.0.0.1', port: 43210, settings: admin.settings, controller: admin.controller as never,
    })(missingOrigin, originResponse)
    expect(originResponse.statusCode).toBe(403)
    expect(admin.settings.update).not.toHaveBeenCalled()
  })

  it('maps settings write failures to a generic response without leaking storage details', async () => {
    const admin = harness()
    const privateMarker = 'C:\\private\\settings.json apiKey=secret'
    admin.settings.update.mockRejectedValueOnce(new Error(privateMarker))

    const failed = await admin.call('PUT', '/external-api-admin/config', { enabled: true })

    expect(failed.response.statusCode).toBe(500)
    expect(failed.body).toEqual({ ok: false, code: 'INTERNAL', hint: 'The configuration could not be updated.' })
    expect(failed.response.body).not.toContain(privateMarker)
  })
})
