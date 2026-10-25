import { createServer as createHttpServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { issueBearerToken } from '../src/auth.js'
import { EXTERNAL_API_BIND_HOST } from '../src/contracts.js'
import { createExternalApiServer, type ExternalApiServer } from '../src/listener.js'
import {
  closeHttpServer,
  createFakeHost,
  externalConfig,
  jsonRequest,
  occupyExternalApiPort,
  startHarness,
  waitUntil,
} from './integration-helpers.js'

const running: ExternalApiServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.stop()))
})

describe('external API listener lifecycle', () => {
  it('does not bind a port or start event pumps while disabled', async () => {
    const fake = createFakeHost()
    const token = issueBearerToken('disabled')
    const server = createExternalApiServer({
      config: externalConfig([token.record], { enabled: false, port: 43120 }),
      host: fake.hostApi,
    })
    running.push(server)

    await expect(server.start()).resolves.toBeUndefined()
    expect(server.state).toBe('stopped')
    expect(server.address()).toBeUndefined()
    expect(fake.calls.muxStream).not.toHaveBeenCalled()
    expect(fake.calls.hostStream).not.toHaveBeenCalled()

    const probe = createHttpServer()
    await expect(new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen({ host: EXTERNAL_API_BIND_HOST, port: 43120, exclusive: true }, () => resolve())
    })).resolves.toBeUndefined()
    await closeHttpServer(probe)
  })

  it('binds all IPv4 interfaces, keeps a usable loopback URL, and makes start idempotent', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const first = harness.server.address()

    expect(first).toMatchObject({ host: '0.0.0.0' })
    expect(first?.port).toBeGreaterThan(0)
    expect(first?.url).toBe(`http://127.0.0.1:${String(first?.port)}`)
    await expect(harness.server.start()).resolves.toEqual(first)
    await waitUntil(() => harness.fake.calls.muxStream.mock.calls.length === 1)
    expect(harness.fake.calls.hostStream).toHaveBeenCalledTimes(1)

    const lanAddress = Object.values(networkInterfaces())
      .flatMap(entries => entries ?? [])
      .find(entry => entry.family === 'IPv4' && !entry.internal)?.address
    if (lanAddress !== undefined) {
      const health = await fetch(`http://${lanAddress}:${String(first?.port)}/api/v1/health`, {
        signal: AbortSignal.timeout(5_000),
      })
      expect(health.status).toBe(200)
    }
  })

  it('reports a port conflict without leaving a partial listener or pump', async () => {
    const occupied = await occupyExternalApiPort()
    const fake = createFakeHost()
    const token = issueBearerToken('conflict')
    const server = createExternalApiServer({
      config: externalConfig([token.record], { port: occupied.port }),
      host: fake.hostApi,
    })
    running.push(server)
    try {
      await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(server.state).toBe('error')
      expect(server.errorCode).toBe('PORT_IN_USE')
      expect(server.address()).toBeUndefined()
      expect(fake.calls.muxStream).not.toHaveBeenCalled()
      expect(fake.calls.hostStream).not.toHaveBeenCalled()
    } finally {
      await closeHttpServer(occupied.server)
    }
  })

  it('closes its port and event pumps on stop, and stop is idempotent', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const port = harness.server.address()?.port
    expect(port).toBeDefined()
    await waitUntil(() => harness.fake.mux.streamCount === 1 && harness.fake.host.streamCount === 1)

    await harness.server.stop()
    expect(harness.server.state).toBe('stopped')
    expect(harness.server.address()).toBeUndefined()
    await expect(harness.server.stop()).resolves.toBeUndefined()

    const replacement = createHttpServer()
    await expect(new Promise<void>((resolve, reject) => {
      replacement.once('error', reject)
      replacement.listen({ host: EXTERNAL_API_BIND_HOST, port, exclusive: true }, () => resolve())
    })).resolves.toBeUndefined()
    await closeHttpServer(replacement)
  })

  it('serves a public health check with hardened headers but protects every business route', async () => {
    const harness = await startHarness()
    running.push(harness.server)

    const health = await jsonRequest(harness, '/api/v1/health', { token: null })
    expect(health.response.status).toBe(200)
    expect(health.body).toEqual({ status: 'ok', service: 'dsh-external-api', version: 'v1' })
    expect(health.response.headers.get('cache-control')).toBe('no-store')
    expect(health.response.headers.get('x-content-type-options')).toBe('nosniff')

    const head = await fetch(`${harness.baseUrl}/api/v1/health`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('cache-control')).toBe('no-store')

    const protectedRoute = await jsonRequest(harness, '/api/v1/capabilities', { token: null })
    expect(protectedRoute.response.status).toBe(401)
    expect(protectedRoute.body.error).toMatchObject({ code: 'AUTH_REQUIRED' })
  })
})
