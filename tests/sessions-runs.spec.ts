import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { issueBearerToken } from '../src/auth.js'
import type { ExternalApiServer } from '../src/listener.js'
import {
  createFakeHost,
  jsonRequest,
  muxFrame,
  rpcFailure,
  startHarness,
  waitUntil,
} from './integration-helpers.js'

const running: ExternalApiServer[] = []
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.stop()))
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createSession(harness: Awaited<ReturnType<typeof startHarness>>, body: Record<string, unknown> = {}) {
  const result = await jsonRequest(harness, '/api/v1/sessions', { method: 'POST', body })
  expect(result.response.status).toBe(201)
  expect(result.body.session.id).toMatch(/^external-/u)
  return result.body.session as { id: string; agentPreset?: string }
}

async function startRun(
  harness: Awaited<ReturnType<typeof startHarness>>,
  sessionId: string,
  input = 'hello',
  token?: string,
) {
  return jsonRequest(harness, `/api/v1/sessions/${encodeURIComponent(sessionId)}/runs`, {
    method: 'POST',
    ...(token === undefined ? {} : { token }),
    body: { input },
  })
}

describe('external API session ownership', () => {
  it('lists and reads only sessions owned by the calling token', async () => {
    const tokenA = issueBearerToken('caller-a')
    const tokenB = issueBearerToken('caller-b')
    const harness = await startHarness({ token: tokenA, tokens: [tokenA.record, tokenB.record] })
    running.push(harness.server)
    const session = await createSession(harness)
    harness.fake.state.sessions.set('desktop-session', {
      sessionId: 'desktop-session', updatedAt: Date.now(), running: false, blank: false,
    })
    harness.fake.state.histories.set(session.id, [{
      type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'owned' }] },
    }])

    const ownerList = await jsonRequest(harness, '/api/v1/sessions')
    expect(ownerList.body.items.map((item: { id: string }) => item.id)).toEqual([session.id])
    expect(ownerList.text).not.toContain('desktop-session')

    const otherList = await jsonRequest(harness, '/api/v1/sessions', { token: tokenB.secret })
    expect(otherList.body).toEqual({ items: [] })
    const otherRead = await jsonRequest(harness, `/api/v1/sessions/${session.id}/messages`, { token: tokenB.secret })
    expect(otherRead.response.status).toBe(404)
    expect(otherRead.body.error).toMatchObject({ code: 'NOT_FOUND' })
    expect(harness.fake.calls.history).not.toHaveBeenCalled()
  })

  it('preserves token ownership across a server restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-external-api-restart-'))
    temporaryRoots.push(root)
    const ownershipFile = join(root, 'ownership.json')
    const tokenA = issueBearerToken('caller-a')
    const tokenB = issueBearerToken('caller-b')
    const fake = createFakeHost()
    const first = await startHarness({ token: tokenA, tokens: [tokenA.record, tokenB.record], ownershipFile, fake })
    running.push(first.server)
    const session = await createSession(first)
    await first.server.stop()

    const restarted = await startHarness({ token: tokenA, tokens: [tokenA.record, tokenB.record], ownershipFile, fake })
    running.push(restarted.server)
    const owner = await jsonRequest(restarted, '/api/v1/sessions')
    expect(owner.body.items).toEqual([expect.objectContaining({ id: session.id })])
    const other = await jsonRequest(restarted, '/api/v1/sessions', { token: tokenB.secret })
    expect(other.body.items).toEqual([])
  })

  it('releases a preclaimed id if DSH rejects session creation', async () => {
    const token = issueBearerToken('workspace caller', { allowedWorkspaceIds: ['*'] })
    const harness = await startHarness({ token })
    running.push(harness.server)
    harness.fake.calls.create.mockImplementationOnce(async request => (
      rpcFailure(request, 'workspace-not-found', 'C:\\private\\workspace') as never
    ))

    const rejected = await jsonRequest(harness, '/api/v1/sessions', {
      method: 'POST', body: { workspaceId: 'missing-workspace' },
    })

    expect(rejected.response.status).toBe(422)
    expect(rejected.body.error).toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
    expect(rejected.text).not.toContain('C:\\private')
    expect(harness.server.ownership.sessionsFor(harness.token.record.id).size).toBe(0)
  })
})

describe('external API owned-session discovery', () => {
  it('returns the projected models for an owned session and forwards its id to DSH', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)
    harness.fake.state.models.set(session.id, {
      current: {
        provider: 'exampleai',
        model: 'saas-model',
        reasoningEffort: 'high',
        apiKey: 'must-not-leak',
      },
      routable: true,
      groups: [{
        id: 'exampleai',
        name: 'Example AI',
        models: [{
          id: 'saas-model',
          name: 'SaaS Model',
          description: 'General-purpose model',
          apiKey: 'must-not-leak',
        }],
      }],
      failures: [{ provider: 'private-provider', message: 'must-not-leak' }],
    })

    const result = await jsonRequest(
      harness,
      `/api/v1/models?sessionId=${encodeURIComponent(session.id)}`,
    )

    expect(result.response.status, result.text).toBe(200)
    expect(result.body).toEqual({
      current: { provider: 'exampleai', model: 'saas-model', reasoningEffort: 'high' },
      routable: true,
      providers: [{
        id: 'exampleai',
        name: 'Example AI',
        models: [{ id: 'saas-model', name: 'SaaS Model', description: 'General-purpose model' }],
      }],
    })
    expect(result.text).not.toContain('must-not-leak')
    expect(harness.fake.calls.models).toHaveBeenCalledTimes(1)
    expect(harness.fake.calls.models).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sessionId: session.id },
    }))
  })

  it('returns the projected skills for an owned session and forwards its id to DSH', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)
    harness.fake.state.skills = [{
      name: 'web-search',
      description: 'Search trusted sources',
      modelInvocable: true,
      path: 'C:\\private\\skills\\web-search',
    }]

    const result = await jsonRequest(
      harness,
      `/api/v1/skills?sessionId=${encodeURIComponent(session.id)}`,
    )

    expect(result.response.status, result.text).toBe(200)
    expect(result.body).toEqual({
      items: [{ name: 'web-search', description: 'Search trusted sources', modelInvocable: true }],
    })
    expect(result.text).not.toContain('C:\\private')
    expect(harness.fake.calls.skillList).toHaveBeenCalledTimes(1)
    expect(harness.fake.calls.skillList).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sessionId: session.id },
    }))
  })
})

describe('external API message projection', () => {
  it('removes system messages, reasoning, tool arguments/results, views, and internal metadata', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)
    const markers = {
      system: 'SYSTEM-PROMPT-SECRET',
      reasoning: 'PRIVATE-CHAIN-OF-THOUGHT',
      args: 'TOOL-ARGUMENT-SECRET',
      result: 'TOOL-RESULT-SECRET',
      view: 'PRESENTER-VIEW-SECRET',
    }
    harness.fake.state.histories.set(session.id, [
      {
        type: 'user/message', seq: 1, time: 1,
        data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: markers.system }] },
      },
      {
        type: 'user/message', seq: 2, time: 2,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] },
      },
      {
        type: 'tool/call', seq: 3, time: 3,
        data: { name: 'filesystem.read', arguments: markers.args },
      },
      {
        type: 'tool/result', seq: 4, time: 4,
        data: { message: { name: 'filesystem.read', content: [{ type: 'text', text: markers.result }] } },
      },
      {
        type: 'assistant/message', seq: 5, time: 5,
        data: { message: { content: [{ type: 'reasoning', text: markers.reasoning }, { type: 'text', text: 'answer' }] } },
      },
    ])
    harness.fake.calls.history.mockImplementationOnce(async request => ({
      rpcId: request.rpcId,
      result: {
        ok: true as const,
        value: {
          events: (harness.fake.state.histories.get(session.id) ?? []).map(event => ({
            event,
            view: { rawArguments: markers.view },
          })),
          hasMore: false,
        },
      },
    }))

    const result = await jsonRequest(harness, `/api/v1/sessions/${session.id}/messages`)

    expect(result.response.status).toBe(200)
    expect(result.body.items).toEqual([
      expect.objectContaining({ role: 'user', content: 'question', seq: 2 }),
      expect.objectContaining({ role: 'tool', content: '', toolName: 'filesystem.read', outcome: 'ok', seq: 4 }),
      expect.objectContaining({ role: 'assistant', content: 'answer', seq: 5 }),
    ])
    for (const marker of Object.values(markers)) expect(result.text).not.toContain(marker)
  })

  it('bounds history pagination and rejects duplicate or unknown query fields', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)

    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=1&limit=2', 'unknown=true', 'beforeSeq=-1']) {
      const result = await jsonRequest(harness, `/api/v1/sessions/${session.id}/messages?${query}`)
      expect(result.response.status, query).toBe(400)
      expect(result.body.error.code, query).toBe('INVALID_QUERY')
    }
  })
})

describe('external API run admission and cancellation', () => {
  it('accepts the messages alias and starts a queued run with the documented payload', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)

    const result = await jsonRequest(
      harness,
      `/api/v1/sessions/${encodeURIComponent(session.id)}/messages`,
      {
        method: 'POST',
        body: { input: 'continue the analysis', clientTimeZone: 'Asia/Shanghai' },
      },
    )

    expect(result.response.status, result.text).toBe(202)
    expect(result.body.run).toMatchObject({ sessionId: session.id, status: 'queued' })
    expect(result.body.eventsUrl).toBe(`/api/v1/runs/${result.body.run.id as string}/events`)
    expect(harness.fake.calls.prompt).toHaveBeenCalledTimes(1)
    expect(harness.fake.calls.prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        sessionId: session.id,
        mode: 'queue',
        content: [{ type: 'text', text: 'continue the analysis' }],
        clientTimeZone: 'Asia/Shanghai',
      },
    }))
  })

  it('rejects an invalid quick response before creating or claiming a session', async () => {
    const harness = await startHarness()
    running.push(harness.server)

    const result = await jsonRequest(harness, '/api/v1/responses', {
      method: 'POST', body: { input: '   /status' },
    })

    expect(result.response.status).toBe(400)
    expect(result.body.error).toMatchObject({ code: 'SLASH_COMMAND_FORBIDDEN' })
    expect(harness.fake.calls.create).not.toHaveBeenCalled()
    expect(harness.fake.calls.prompt).not.toHaveBeenCalled()
    expect(harness.server.ownership.sessionsFor(harness.token.record.id).size).toBe(0)
  })

  it('does not silently ignore run-only fields on the session creation route', async () => {
    const harness = await startHarness()
    running.push(harness.server)

    const result = await jsonRequest(harness, '/api/v1/sessions', {
      method: 'POST', body: { input: 'this must not be discarded' },
    })

    expect(result.response.status).toBe(400)
    expect(result.body.error).toMatchObject({ code: 'UNKNOWN_FIELD' })
    expect(harness.fake.calls.create).not.toHaveBeenCalled()
  })

  it.each(['/status', ' /status', '\t/help', '\r\n/agent secret'])('rejects slash-command input before DSH sees it: %j', async (input) => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)

    const result = await startRun(harness, session.id, input)

    expect(result.response.status).toBe(400)
    expect(result.body.error).toMatchObject({ code: 'SLASH_COMMAND_FORBIDDEN' })
    expect(harness.fake.calls.prompt).not.toHaveBeenCalled()
  })

  it('uses queue mode and permits only one in-flight run for a session', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)

    const first = await startRun(harness, session.id, 'hello')
    expect(first.response.status, first.text).toBe(202)
    expect(first.body.run).toMatchObject({ sessionId: session.id, status: 'queued' })
    expect(harness.fake.calls.prompt).toHaveBeenCalledWith(expect.objectContaining({
      payload: { sessionId: session.id, mode: 'queue', content: [{ type: 'text', text: 'hello' }] },
    }))

    const second = await startRun(harness, session.id, 'must not queue')
    expect(second.response.status).toBe(409)
    expect(second.body.error).toMatchObject({ code: 'SESSION_BUSY' })
    expect(harness.fake.calls.prompt).toHaveBeenCalledTimes(1)
  })

  it('settles a rejected prompt so the session is not permanently locked', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)
    const privateHostError = 'provider failed with apiKey=private-secret'
    harness.fake.calls.prompt.mockImplementationOnce(async request => (
      rpcFailure(request, 'internal', privateHostError) as never
    ))

    const rejected = await startRun(harness, session.id, 'first')
    expect(rejected.response.status).toBe(502)
    expect(rejected.text).not.toContain(privateHostError)
    expect(harness.server.runs.activeForSession(session.id)).toBeUndefined()

    const retry = await startRun(harness, session.id, 'second')
    expect(retry.response.status).toBe(202)
    expect(harness.fake.calls.prompt).toHaveBeenCalledTimes(2)
  })

  it('cancels only an active run owned by the caller', async () => {
    const tokenA = issueBearerToken('caller-a')
    const tokenB = issueBearerToken('caller-b')
    const harness = await startHarness({ token: tokenA, tokens: [tokenA.record, tokenB.record] })
    running.push(harness.server)
    const session = await createSession(harness)
    const started = await startRun(harness, session.id)
    const runId = started.body.run.id as string

    const foreign = await jsonRequest(harness, `/api/v1/runs/${runId}/cancel`, {
      method: 'POST', token: tokenB.secret, body: {},
    })
    const unknown = await jsonRequest(harness, '/api/v1/runs/unknown-run/cancel', {
      method: 'POST', token: tokenB.secret, body: {},
    })
    expect(foreign.response.status).toBe(unknown.response.status)
    expect(foreign.body.error.code).toBe(unknown.body.error.code)
    expect(harness.fake.calls.cancel).not.toHaveBeenCalled()

    const own = await jsonRequest(harness, `/api/v1/runs/${runId}/cancel`, { method: 'POST', body: {} })
    expect(own.response.status).toBe(202)
    expect(own.body.run).toMatchObject({ id: runId, sessionId: session.id, status: 'cancelling' })
    expect(harness.fake.calls.cancel).toHaveBeenCalledTimes(1)
    expect(harness.fake.calls.cancel).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: session.id } }))
  })

  it('does not cancel a terminal run', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const session = await createSession(harness)
    const started = await startRun(harness, session.id)
    const runId = started.body.run.id as string
    await waitUntil(() => harness.fake.mux.streamCount === 1)
    const promptRpcId = harness.fake.calls.prompt.mock.calls[0]![0].rpcId
    const turn = 1
    harness.fake.mux.emit(muxFrame({
      type: 'session/event', sessionId: session.id,
      event: { type: 'turn/start', seq: 1, time: Date.now(), data: { turn } },
    }))
    harness.fake.mux.emit(muxFrame({
      type: 'session/event', sessionId: session.id,
      event: {
        type: 'user/message',
        seq: 2,
        time: Date.now(),
        data: {
          id: 'terminal-run-user',
          role: 'user',
          source: { kind: 'user', rpcId: promptRpcId },
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    }))
    harness.fake.mux.emit(muxFrame({
      type: 'session/event', sessionId: session.id,
      event: { type: 'turn/end', seq: 3, time: Date.now(), data: { turn, reason: { kind: 'completed' } } },
    }))
    await waitUntil(() => harness.server.runs.getOwned(harness.token.record.id, runId)?.status === 'completed')

    const result = await jsonRequest(harness, `/api/v1/runs/${runId}/cancel`, { method: 'POST', body: {} })
    expect(result.response.status).toBe(409)
    expect(harness.fake.calls.cancel).not.toHaveBeenCalled()
  })
})
