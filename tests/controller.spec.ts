import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { issueBearerToken } from '../src/auth.js'
import { ExternalApiController } from '../src/controller.js'
import {
  createFakeHost,
  externalConfig,
  jsonRequest,
} from './integration-helpers.js'

const controllers: ExternalApiController[] = []
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.stop()))
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('external API live controller', () => {
  it('revokes removed tokens before replacing the listener and clears their durable ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-external-api-controller-'))
    temporaryRoots.push(root)
    const token = issueBearerToken('revoked caller')
    const fake = createFakeHost()
    const initial = externalConfig([token.record])
    const controller = new ExternalApiController({
      host: fake.hostApi,
      config: initial,
      ownershipFile: join(root, 'ownership.json'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    controllers.push(controller)
    await controller.configure(initial)
    const initialStatus = controller.status()
    expect(initialStatus).toMatchObject({ state: 'running', host: '0.0.0.0' })
    expect(initialStatus.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    const url = initialStatus.url
    expect(url).toBeDefined()
    const harness = { baseUrl: url as string, token }

    const sessionResponse = await jsonRequest(harness, '/api/v1/sessions', { method: 'POST', body: {} })
    const sessionId = sessionResponse.body.session.id as string
    const runResponse = await jsonRequest(harness, `/api/v1/sessions/${sessionId}/runs`, {
      method: 'POST', body: { input: 'long-running task' },
    })
    expect(runResponse.response.status).toBe(202)
    const runId = runResponse.body.run.id as string

    const withoutToken = externalConfig([], { port: initial.port })
    await controller.configure(withoutToken)
    expect(fake.calls.cancel).toHaveBeenCalledTimes(1)
    expect(fake.calls.cancel).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId } }))
    expect(controller.runs.getOwned(token.record.id, runId)).toMatchObject({
      status: 'failed',
      error: { code: 'TOKEN_REVOKED' },
    })

    expect(controller.ownership.ownerOf(sessionId)).toBeUndefined()
    const rejected = await jsonRequest({ baseUrl: controller.status().url as string, token }, '/api/v1/sessions')
    expect(rejected.response.status).toBe(401)
  })

  it('keeps a working listener alive and reports the failed target port when a live move conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-external-api-controller-'))
    temporaryRoots.push(root)
    const token = issueBearerToken('caller')
    const fake = createFakeHost()
    const initial = externalConfig([token.record])
    const controller = new ExternalApiController({
      host: fake.hostApi,
      config: initial,
      ownershipFile: join(root, 'ownership.json'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    controllers.push(controller)
    await controller.configure(initial)
    expect(controller.status()).toMatchObject({ state: 'running', host: '0.0.0.0' })
    const originalUrl = controller.status().url as string
    expect(originalUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)

    const { occupyExternalApiPort, closeHttpServer } = await import('./integration-helpers.js')
    const occupied = await occupyExternalApiPort()
    try {
      await controller.configure(externalConfig([token.record], { port: occupied.port }))
      expect(controller.status()).toMatchObject({ state: 'running', url: originalUrl, error: 'PORT_IN_USE' })
      const health = await jsonRequest({ baseUrl: originalUrl, token }, '/api/v1/health', { token: null })
      expect(health.response.status).toBe(200)
    } finally {
      await closeHttpServer(occupied.server)
    }
  })

})
