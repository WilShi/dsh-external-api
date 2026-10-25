import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { issueBearerToken, type IssuedToken } from '../src/auth.js'
import { ExternalApiController } from '../src/controller.js'
import type { ExternalApiServer } from '../src/listener.js'
import {
  closeHttpServer,
  createFakeHost,
  externalConfig,
  jsonRequest,
  muxFrame,
  occupyExternalApiPort,
  rpcOk,
  startHarness,
  waitUntil,
} from './integration-helpers.js'

const runningServers: ExternalApiServer[] = []
const runningControllers: ExternalApiController[] = []
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(server => server.stop()))
  await Promise.all(runningControllers.splice(0).map(controller => controller.stop()))
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

interface AcknowledgedItem<T> {
  readonly value: T
  readonly acknowledged: () => void
}

/**
 * Single-subscriber test stream. An emit resolves only after the consumer asks
 * for its next item, which means EventPump has finished handling the prior one.
 */
class AcknowledgedChannel<T> {
  readonly #items: AcknowledgedItem<T>[] = []
  #wake: (() => void) | undefined

  stream(signal: AbortSignal): AsyncIterable<T> {
    const owner = this
    return {
      async *[Symbol.asyncIterator]() {
        const wakeOnAbort = () => owner.#wake?.()
        signal.addEventListener('abort', wakeOnAbort, { once: true })
        try {
          while (!signal.aborted) {
            if (owner.#items.length === 0) {
              await new Promise<void>((resolve) => { owner.#wake = resolve })
              owner.#wake = undefined
            }
            if (signal.aborted) break
            const item = owner.#items.shift()
            if (item === undefined) continue
            yield item.value
            item.acknowledged()
          }
        } finally {
          signal.removeEventListener('abort', wakeOnAbort)
        }
      },
    }
  }

  emitAndWait(value: T): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#items.push({ value, acknowledged: resolve })
      this.#wake?.()
    })
  }
}

async function createSession(
  harness: { readonly baseUrl: string; readonly token: IssuedToken },
): Promise<string> {
  const response = await jsonRequest(harness, '/api/v1/sessions', { method: 'POST', body: {} })
  expect(response.response.status, response.text).toBe(201)
  return response.body.session.id as string
}

async function createRun(
  harness: { readonly baseUrl: string; readonly token: IssuedToken },
  sessionId: string,
): Promise<string> {
  const response = await jsonRequest(harness, `/api/v1/sessions/${encodeURIComponent(sessionId)}/runs`, {
    method: 'POST',
    body: { input: 'race regression prompt' },
  })
  expect(response.response.status, response.text).toBe(202)
  return response.body.run.id as string
}

function sessionEvent(sessionId: string, event: Record<string, unknown>) {
  return muxFrame({ type: 'session/event', sessionId, event })
}

function turnStart(turn: number): Record<string, unknown> {
  return { type: 'turn/start', seq: turn * 10, time: Date.now(), data: { turn } }
}

function userMessage(turn: number, rpcId: string): Record<string, unknown> {
  return {
    type: 'user/message',
    seq: turn * 10 + 1,
    time: Date.now(),
    data: {
      id: `user-${String(turn)}`,
      role: 'user',
      source: { kind: 'user', rpcId },
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
    },
  }
}

function assistantChunk(turn: number, text: string): Record<string, unknown> {
  return {
    type: 'assistant/chunk',
    seq: turn * 10 + 2,
    time: Date.now(),
    data: { turn, step: 0, chunk: { type: 'text-delta', text } },
  }
}

function assistantMessage(turn: number, text: string): Record<string, unknown> {
  return {
    type: 'assistant/message',
    seq: turn * 10 + 3,
    time: Date.now(),
    data: {
      turn,
      step: 0,
      message: { content: [{ type: 'text', text }] },
    },
  }
}

function turnEnd(turn: number): Record<string, unknown> {
  return {
    type: 'turn/end',
    seq: turn * 10 + 4,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  }
}

describe('token revocation races', () => {
  it('drops a host read result when its token is removed while session.list is pending', async () => {
    const fake = createFakeHost()
    const harness = await startHarness({ fake })
    runningServers.push(harness.server)
    const sessionId = await createSession(harness)
    const enteredList = deferred<void>()
    const releaseList = deferred<void>()
    fake.calls.list.mockImplementationOnce(async (request) => {
      enteredList.resolve()
      await releaseList.promise
      return rpcOk(request, { items: [...fake.state.sessions.values()] })
    })

    const pending = jsonRequest(harness, '/api/v1/sessions')
    await enteredList.promise
    harness.server.updateConfig(externalConfig([]))
    releaseList.resolve()

    const result = await pending
    expect(result.response.status).toBe(401)
    expect(result.body.error).toMatchObject({ code: 'TOKEN_REVOKED' })
    expect(result.body).not.toHaveProperty('items')
    expect(result.text).not.toContain(sessionId)
  })

  it('invalidates a request paused in session.list before it can create or prompt a run', async () => {
    const fake = createFakeHost()
    const harness = await startHarness({ fake })
    runningServers.push(harness.server)
    const sessionId = await createSession(harness)
    const enteredList = deferred<void>()
    const releaseList = deferred<void>()
    fake.calls.list.mockImplementationOnce(async (request) => {
      enteredList.resolve()
      await releaseList.promise
      return rpcOk(request, { items: [...fake.state.sessions.values()] })
    })
    const createRunSpy = vi.spyOn(harness.server.runs, 'create')

    const pending = jsonRequest(harness, `/api/v1/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: 'POST',
      body: { input: 'must be revoked before prompt' },
    })
    await enteredList.promise

    harness.server.updateConfig(externalConfig([]))
    const revocation = harness.server.revokeToken(harness.token.record.id)
    releaseList.resolve()

    const result = await pending
    await revocation
    expect(result.response.status).toBe(401)
    expect(result.body.error).toMatchObject({ code: 'TOKEN_REVOKED' })
    expect(fake.calls.prompt).not.toHaveBeenCalled()
    expect(createRunSpy).not.toHaveBeenCalled()
    expect(harness.server.runs.activeCount()).toBe(0)
  })

  it('settles a revoked run immediately even when the host cancel call never returns', async () => {
    const fake = createFakeHost()
    const harness = await startHarness({ fake })
    runningServers.push(harness.server)
    const sessionId = await createSession(harness)
    const runId = await createRun(harness, sessionId)
    fake.calls.cancel.mockImplementationOnce(async () => new Promise<never>(() => {}))

    const outcome = await Promise.race([
      harness.server.revokeToken(harness.token.record.id).then(() => 'revoked' as const),
      delay(500, 'timed-out' as const),
    ])

    expect(outcome).toBe('revoked')
    expect(fake.calls.cancel).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId } }))
    expect(harness.server.runs.getOwned(harness.token.record.id, runId)).toMatchObject({
      status: 'failed',
      error: { code: 'TOKEN_REVOKED', message: 'The token used for this run was revoked.' },
    })
  })
})

describe('prompt-to-turn correlation', () => {
  it('ignores a complete unrelated turn and projects only the turn carrying the prompt rpcId', async () => {
    const fake = createFakeHost()
    const acknowledgedMux = new AcknowledgedChannel<{ rpcId: string; payload: unknown }>()
    fake.calls.muxStream.mockImplementation((_request, signal) => acknowledgedMux.stream(signal))
    const harness = await startHarness({ fake })
    runningServers.push(harness.server)
    await waitUntil(() => fake.calls.muxStream.mock.calls.length === 1)
    const sessionId = await createSession(harness)
    const runId = await createRun(harness, sessionId)
    const promptRequest = fake.calls.prompt.mock.calls[0]?.[0]
    expect(promptRequest?.rpcId).toEqual(expect.any(String))

    const emit = (event: Record<string, unknown>) => acknowledgedMux.emitAndWait(sessionEvent(sessionId, event))
    await emit(turnStart(1))
    await emit(userMessage(1, 'desktop-unrelated-rpc'))
    await emit(assistantChunk(1, 'UNRELATED-TURN-DELTA'))
    await emit(assistantMessage(1, 'UNRELATED-TURN-ANSWER'))
    await emit(turnEnd(1))

    expect(harness.server.runs.getOwned(harness.token.record.id, runId)).toMatchObject({ status: 'queued' })

    await emit(turnStart(2))
    await emit(userMessage(2, promptRequest!.rpcId))
    expect(harness.server.runs.getOwned(harness.token.record.id, runId)).toMatchObject({ status: 'running' })
    await emit(assistantChunk(2, 'MATCHED-TURN-DELTA'))
    await emit(assistantMessage(2, 'MATCHED-TURN-ANSWER'))
    await emit(turnEnd(2))

    expect(harness.server.runs.getOwned(harness.token.record.id, runId)).toMatchObject({
      status: 'completed',
      finishReason: 'completed',
    })
    const response = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${harness.token.secret}` },
    })
    const text = await response.text()
    expect(text).not.toContain('UNRELATED-TURN')
    expect(text).toContain('MATCHED-TURN-DELTA')
    expect(text).toContain('MATCHED-TURN-ANSWER')
    expect([...text.matchAll(/^event: (.+)$/gmu)].map(match => match[1])).toEqual([
      'run.queued',
      'run.started',
      'message.delta',
      'message.completed',
      'run.completed',
    ])
  })
})

describe('listener replacement continuity', () => {
  it('stops subscriptions while disabled, recreates them on enable, and keeps them across a port move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-external-api-enable-cycle-'))
    temporaryRoots.push(root)
    const token = issueBearerToken('enable-cycle caller')
    const fake = createFakeHost()
    const initial = externalConfig([token.record])
    const controller = new ExternalApiController({
      host: fake.hostApi,
      config: initial,
      ownershipFile: join(root, 'ownership.json'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    runningControllers.push(controller)

    await controller.configure(initial)
    await waitUntil(() => fake.calls.muxStream.mock.calls.length === 1 && fake.calls.hostStream.mock.calls.length === 1)
    const firstMuxSignal = fake.calls.muxStream.mock.calls[0]![1]
    const firstHostSignal = fake.calls.hostStream.mock.calls[0]![1]
    expect(firstMuxSignal.aborted).toBe(false)
    expect(firstHostSignal.aborted).toBe(false)

    await controller.configure(externalConfig([token.record], { enabled: false }))
    expect(controller.status().state).toBe('stopped')
    expect(firstMuxSignal.aborted).toBe(true)
    expect(firstHostSignal.aborted).toBe(true)
    expect(fake.calls.muxStream).toHaveBeenCalledTimes(1)
    expect(fake.calls.hostStream).toHaveBeenCalledTimes(1)

    await controller.configure(initial)
    await waitUntil(() => fake.calls.muxStream.mock.calls.length === 2 && fake.calls.hostStream.mock.calls.length === 2)
    const secondMuxSignal = fake.calls.muxStream.mock.calls[1]![1]
    const secondHostSignal = fake.calls.hostStream.mock.calls[1]![1]
    expect(secondMuxSignal.aborted).toBe(false)
    expect(secondHostSignal.aborted).toBe(false)

    const harness = { baseUrl: controller.status().url as string, token }
    const sessionId = await createSession(harness)
    const runId = await createRun(harness, sessionId)
    const promptRpcId = fake.calls.prompt.mock.calls.at(-1)![0].rpcId
    fake.mux.emit(sessionEvent(sessionId, turnStart(11)))
    fake.mux.emit(sessionEvent(sessionId, userMessage(11, promptRpcId)))
    fake.mux.emit(sessionEvent(sessionId, turnEnd(11)))
    await waitUntil(() => controller.runs.getOwned(token.record.id, runId)?.status === 'completed')

    const reservation = await occupyExternalApiPort()
    const targetPort = reservation.port
    await closeHttpServer(reservation.server)
    await controller.configure(externalConfig([token.record], { port: targetPort }))

    expect(controller.status()).toMatchObject({ state: 'running', port: targetPort })
    expect(fake.calls.muxStream).toHaveBeenCalledTimes(2)
    expect(fake.calls.hostStream).toHaveBeenCalledTimes(2)
    expect(secondMuxSignal.aborted).toBe(false)
    expect(secondHostSignal.aborted).toBe(false)
  })

  it('keeps one event subscription and cannot lose a terminal event at the port handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-external-api-handoff-'))
    temporaryRoots.push(root)
    const token = issueBearerToken('handoff caller')
    const fake = createFakeHost()
    const releaseAbortedPump = deferred<void>()
    const observedPumpAbort = deferred<void>()
    const originalMuxStream = fake.mux.stream.bind(fake.mux)
    fake.calls.muxStream.mockImplementation((_request, signal) => ({
      async *[Symbol.asyncIterator]() {
        try {
          yield* originalMuxStream(signal)
        } finally {
          if (signal.aborted) {
            observedPumpAbort.resolve()
            await releaseAbortedPump.promise
          }
        }
      },
    }))
    const initial = externalConfig([token.record])
    const controller = new ExternalApiController({
      host: fake.hostApi,
      config: initial,
      ownershipFile: join(root, 'ownership.json'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    runningControllers.push(controller)
    await controller.configure(initial)
    await waitUntil(() => fake.calls.muxStream.mock.calls.length === 1)
    const harness = { baseUrl: controller.status().url as string, token }
    const sessionId = await createSession(harness)
    const runId = await createRun(harness, sessionId)
    const promptRpcId = fake.calls.prompt.mock.calls[0]![0].rpcId
    fake.mux.emit(sessionEvent(sessionId, turnStart(7)))
    fake.mux.emit(sessionEvent(sessionId, userMessage(7, promptRpcId)))
    await waitUntil(() => controller.runs.getOwned(token.record.id, runId)?.status === 'running')

    const reservation = await occupyExternalApiPort()
    const targetPort = reservation.port
    await closeHttpServer(reservation.server)
    const moving = controller.configure(externalConfig([token.record], { port: targetPort }))

    try {
      await waitForHealth(`http://127.0.0.1:${String(targetPort)}/api/v1/health`)
      await Promise.race([observedPumpAbort.promise, moving])
      fake.mux.emit(sessionEvent(sessionId, turnEnd(7)))
    } finally {
      // Releases the deliberately stalled old implementation. In the fixed
      // design the controller-owned pump is never aborted during this move.
      releaseAbortedPump.resolve()
    }
    await moving

    await waitUntil(() => controller.runs.getOwned(token.record.id, runId)?.status === 'completed')
    expect(fake.calls.muxStream).toHaveBeenCalledTimes(1)
    expect(fake.calls.hostStream).toHaveBeenCalledTimes(1)
  })
})

describe('redacted history pagination', () => {
  it('returns a raw-page cursor when every event in a page is filtered out', async () => {
    const fake = createFakeHost()
    const harness = await startHarness({ fake })
    runningServers.push(harness.server)
    const sessionId = await createSession(harness)
    fake.calls.history.mockImplementationOnce(async request => rpcOk(request, {
      events: [
        {
          event: {
            type: 'user/message',
            seq: 40,
            time: Date.now(),
            data: {
              source: { kind: 'agent-instructions' },
              content: [{ type: 'text', text: 'PRIVATE-SYSTEM-CONTEXT' }],
            },
          },
        },
        {
          event: {
            type: 'assistant/chunk',
            seq: 41,
            time: Date.now(),
            data: { turn: 3, step: 0, chunk: { type: 'reasoning-delta', text: 'PRIVATE-REASONING' } },
          },
        },
      ],
      hasMore: true,
    }))

    const result = await jsonRequest(harness, `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=2`)

    expect(result.response.status, result.text).toBe(200)
    expect(result.body).toEqual({ items: [], hasMore: true, nextBeforeSeq: 40 })
    expect(result.text).not.toMatch(/PRIVATE-SYSTEM-CONTEXT|PRIVATE-REASONING/u)
  })
})

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(200) })
      if (response.status === 200) return
    } catch {
      // The replacement port is expected to reject briefly while binding.
    }
    await delay(5)
  }
  throw new Error(`timed out waiting for ${url}`)
}
