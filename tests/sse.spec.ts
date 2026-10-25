import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { issueBearerToken } from '../src/auth.js'
import type { ExternalApiServer } from '../src/listener.js'
import { jsonRequest, muxFrame, startHarness, waitUntil } from './integration-helpers.js'

const running: ExternalApiServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.stop()))
})

interface SseEvent {
  id?: number
  type?: string
  data?: Record<string, unknown>
}

function parseSse(text: string): SseEvent[] {
  return text.split('\n\n').flatMap((block) => {
    const event: SseEvent = {}
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) event.id = Number(line.slice(4))
      else if (line.startsWith('event: ')) event.type = line.slice(7)
      else if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6)) as Record<string, unknown>
    }
    return event.type === undefined ? [] : [event]
  })
}

async function createSessionAndRun(harness: Awaited<ReturnType<typeof startHarness>>) {
  const sessionResponse = await jsonRequest(harness, '/api/v1/sessions', { method: 'POST', body: {} })
  const sessionId = sessionResponse.body.session.id as string
  const runResponse = await jsonRequest(harness, `/api/v1/sessions/${sessionId}/runs`, {
    method: 'POST', body: { input: 'hello' },
  })
  expect(runResponse.response.status, runResponse.text).toBe(202)
  await waitUntil(() => harness.fake.mux.streamCount === 1)
  const promptRequest = harness.fake.calls.prompt.mock.calls.at(-1)?.[0]
  expect(promptRequest?.rpcId).toEqual(expect.any(String))
  const turn = harness.fake.calls.prompt.mock.calls.length
  const time = Date.now()
  harness.fake.mux.emit(muxFrame({
    type: 'session/event', sessionId,
    event: { type: 'turn/start', seq: turn * 10, time, data: { turn } },
  }))
  harness.fake.mux.emit(muxFrame({
    type: 'session/event', sessionId,
    event: {
      type: 'user/message',
      seq: turn * 10 + 1,
      time,
      data: {
        id: `user-${String(turn)}`,
        role: 'user',
        source: { kind: 'user', rpcId: promptRequest!.rpcId },
        content: [{ type: 'text', text: 'hello' }],
      },
    },
  }))
  const runId = runResponse.body.run.id as string
  await waitUntil(() => harness.server.runs.getOwned(harness.token.record.id, runId)?.status === 'running')
  return { sessionId, runId, turn }
}

describe('external API SSE projection and replay', () => {
  it('emits only stable, redacted events and never forwards raw mux payloads', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    await waitUntil(() => harness.fake.mux.streamCount === 1)
    const { sessionId, runId, turn } = await createSessionAndRun(harness)
    const markers = {
      system: 'SYSTEM-PROMPT-SECRET',
      reasoning: 'PRIVATE-CHAIN-OF-THOUGHT',
      args: 'TOOL-ARGUMENT-SECRET',
      result: 'TOOL-RESULT-SECRET',
      view: 'PRESENTER-VIEW-SECRET',
    }

    const emit = (event: unknown, view?: unknown) => harness.fake.mux.emit(muxFrame({
      type: 'session/event', sessionId, event, ...(view === undefined ? {} : { view }),
    }))
    emit({ type: 'assistant/chunk', data: { turn, step: 0, chunk: { type: 'reasoning-delta', text: markers.reasoning } } })
    emit({ type: 'assistant/chunk', data: { turn, step: 0, chunk: { type: 'text-delta', text: 'visible delta' } } })
    emit({ type: 'tool/call', data: { turn, step: 0, callId: 'call-1', name: 'search.query', arguments: markers.args } }, { raw: markers.view })
    emit({
      type: 'tool/result',
      data: { turn, step: 0, message: { name: 'search.query', content: [{ type: 'text', text: markers.result }] } },
    })
    emit({
      type: 'assistant/message',
      data: { turn, step: 0, message: { content: [{ type: 'reasoning', text: markers.reasoning }, { type: 'text', text: 'visible answer' }] } },
    })
    emit({ type: 'turn/end', data: { turn, reason: { kind: 'completed', detail: markers.system } } })
    await waitUntil(() => harness.server.runs.getOwned(harness.token.record.id, runId)?.status === 'completed')

    const response = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${harness.token.secret}` },
    })
    const text = await response.text()
    const events = parseSse(text)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(events.map(event => event.type)).toEqual([
      'run.queued',
      'run.started',
      'message.delta',
      'tool.started',
      'tool.completed',
      'message.completed',
      'run.completed',
    ])
    expect(events.map(event => event.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(events.find(event => event.type === 'message.delta')?.data).toEqual({ delta: 'visible delta' })
    expect(events.find(event => event.type === 'message.completed')?.data).toEqual({ role: 'assistant', content: 'visible answer' })
    for (const marker of Object.values(markers)) expect(text).not.toContain(marker)
    expect(harness.fake.calls.muxStream).toHaveBeenCalledTimes(1)
  })

  it('resumes strictly after Last-Event-ID and rejects invalid cursors', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    await waitUntil(() => harness.fake.mux.streamCount === 1)
    const { sessionId, runId, turn } = await createSessionAndRun(harness)
    for (const text of ['one', 'two', 'three']) {
      harness.fake.mux.emit(muxFrame({
        type: 'session/event', sessionId,
        event: { type: 'assistant/chunk', data: { turn, step: 0, chunk: { type: 'text-delta', text } } },
      }))
    }
    harness.fake.mux.emit(muxFrame({
      type: 'session/event', sessionId,
      event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    }))
    await waitUntil(() => harness.server.runs.getOwned(harness.token.record.id, runId)?.status === 'completed')

    const resumed = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${harness.token.secret}`, 'last-event-id': '2' },
    })
    expect(parseSse(await resumed.text()).map(event => event.id)).toEqual([3, 4, 5, 6])

    for (const cursor of ['-1', '1.5', 'not-a-number', '999']) {
      const invalid = await jsonRequest(harness, `/api/v1/runs/${runId}/events`, {
        headers: { 'last-event-id': cursor },
      })
      expect(invalid.response.status, cursor).toBe(400)
      expect(invalid.body.error.code, cursor).toMatch(/INVALID_QUERY|EVENT_CURSOR_INVALID/u)
    }
  })

  it('returns an explicit error when a replay cursor has fallen out of the bounded buffer', async () => {
    const harness = await startHarness({ config: { eventBufferSize: 16 } })
    running.push(harness.server)
    await waitUntil(() => harness.fake.mux.streamCount === 1)
    const { sessionId, runId, turn } = await createSessionAndRun(harness)
    for (let index = 0; index < 20; index += 1) {
      harness.fake.mux.emit(muxFrame({
        type: 'session/event', sessionId,
        event: { type: 'assistant/chunk', data: { turn, step: 0, chunk: { type: 'text-delta', text: String(index) } } },
      }))
    }
    harness.fake.mux.emit(muxFrame({
      type: 'session/event', sessionId,
      event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    }))
    await waitUntil(() => harness.server.runs.getOwned(harness.token.record.id, runId)?.status === 'completed')

    const expired = await jsonRequest(harness, `/api/v1/runs/${runId}/events`, {
      headers: { 'last-event-id': '1' },
    })
    expect(expired.response.status).toBe(409)
    expect(expired.body.error).toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' })
  })

  it('hides a run and its event stream from every other token', async () => {
    const tokenA = issueBearerToken('caller-a')
    const tokenB = issueBearerToken('caller-b')
    const harness = await startHarness({ token: tokenA, tokens: [tokenA.record, tokenB.record] })
    running.push(harness.server)
    const { runId } = await createSessionAndRun(harness)

    const ownerView = await jsonRequest(harness, `/api/v1/runs/${runId}`)
    expect(ownerView.response.status).toBe(200)
    const foreignView = await jsonRequest(harness, `/api/v1/runs/${runId}`, { token: tokenB.secret })
    const foreignEvents = await jsonRequest(harness, `/api/v1/runs/${runId}/events`, { token: tokenB.secret })
    expect(foreignView.response.status).toBe(404)
    expect(foreignEvents.response.status).toBe(404)
  })

  it('keeps a live subscription attached, enforces its per-token limit, then releases it on abort', async () => {
    const harness = await startHarness({ config: { maxSseConnectionsPerToken: 1 } })
    running.push(harness.server)
    await waitUntil(() => harness.fake.mux.streamCount === 1)
    const { sessionId, runId, turn } = await createSessionAndRun(harness)
    const controller = new AbortController()
    const first = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/events`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${harness.token.secret}` },
    })
    expect(first.status).toBe(200)

    const second = await jsonRequest(harness, `/api/v1/runs/${runId}/events`)
    expect(second.response.status).toBe(429)
    expect(second.body.error).toMatchObject({ code: 'SSE_LIMIT_REACHED' })

    const reader = first.body?.getReader()
    expect(reader).toBeDefined()
    // Consume the retry/replay prefix before publishing a live frame.
    await reader?.read()
    harness.fake.mux.emit(muxFrame({
      type: 'session/event', sessionId,
      event: { type: 'assistant/chunk', data: { turn, step: 0, chunk: { type: 'text-delta', text: 'live' } } },
    }))
    const live = await Promise.race([
      reader?.read(),
      delay(1_000).then(() => { throw new Error('live SSE event was not delivered') }),
    ])
    expect(new TextDecoder().decode(live?.value)).toContain('"delta":"live"')

    controller.abort()
    await reader?.cancel().catch(() => undefined)
    await delay(20)
    const reopened = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/events`, {
      signal: AbortSignal.timeout(1_000),
      headers: { authorization: `Bearer ${harness.token.secret}`, 'last-event-id': '2' },
    })
    expect(reopened.status).toBe(200)
    await reopened.body?.cancel()
  })

  it('turns interaction requests and host failures into generic terminal failures', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    await waitUntil(() => harness.fake.mux.streamCount === 1 && harness.fake.host.streamCount === 1)
    const first = await createSessionAndRun(harness)
    harness.fake.mux.emit(muxFrame({
      type: 'approval/requested',
      sessionId: first.sessionId,
      turn: first.turn,
      approvalId: 'approval-1',
      toolName: 'dangerous.tool',
      reason: 'PRIVATE-APPROVAL-DETAIL',
    }))
    await waitUntil(() => harness.server.runs.getOwned(harness.token.record.id, first.runId)?.status === 'failed')
    expect(harness.fake.calls.cancel).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: first.sessionId } }))
    const firstEvents = await fetch(`${harness.baseUrl}/api/v1/runs/${first.runId}/events`, {
      headers: { authorization: `Bearer ${harness.token.secret}` },
    })
    expect(await firstEvents.text()).not.toContain('PRIVATE-APPROVAL-DETAIL')

    const second = await createSessionAndRun(harness)
    harness.fake.host.emit(muxFrame({
      type: 'host/agent-error', sessionId: second.sessionId, turn: second.turn, message: 'apiKey=PRIVATE-HOST-ERROR',
    }))
    await waitUntil(() => harness.server.runs.getOwned(harness.token.record.id, second.runId)?.status === 'failed')
    const secondEvents = await fetch(`${harness.baseUrl}/api/v1/runs/${second.runId}/events`, {
      headers: { authorization: `Bearer ${harness.token.secret}` },
    })
    const text = await secondEvents.text()
    expect(text).toContain('AGENT_FAILED')
    expect(text).not.toContain('PRIVATE-HOST-ERROR')
  })

  it('cancels active work and closes it with a sanitized event when a token is revoked', async () => {
    const harness = await startHarness()
    running.push(harness.server)
    const { sessionId, runId } = await createSessionAndRun(harness)

    await harness.server.revokeToken(harness.token.record.id)

    expect(harness.fake.calls.cancel).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId } }))
    expect(harness.server.runs.getOwned(harness.token.record.id, runId)).toMatchObject({
      status: 'failed',
      error: { code: 'TOKEN_REVOKED', message: 'The token used for this run was revoked.' },
    })
    const response = await fetch(`${harness.baseUrl}/api/v1/runs/${runId}/events`, {
      headers: { authorization: `Bearer ${harness.token.secret}` },
    })
    const text = await response.text()
    expect(text).toContain('TOKEN_REVOKED')
    expect(text).not.toMatch(/apiKey|systemPrompt|reasoning|arguments/u)
  })
})
