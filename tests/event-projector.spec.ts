import { describe, expect, it } from 'vitest'
import {
  projectHistoryEvent,
  projectedEventHasForbiddenData,
  projectMuxPayload,
  projectSessionEvent,
} from '../src/event-projector.js'

const secretMarkers = {
  arguments: '{"path":"C:\\\\private","apiKey":"secret-key"}',
  result: 'raw-tool-result-secret',
  reasoning: 'private chain of thought',
  systemPrompt: 'private system prompt',
}

describe('external event projection', () => {
  it('maps only public run lifecycle states and replaces failure details', () => {
    expect(projectSessionEvent({ type: 'turn/start', data: { systemPrompt: secretMarkers.systemPrompt } }))
      .toEqual([{ type: 'run.started', data: {} }])
    expect(projectSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed', detail: 'private' } } }))
      .toEqual([{ type: 'run.completed', data: { finishReason: 'completed' } }])
    expect(projectSessionEvent({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }))
      .toEqual([{ type: 'run.completed', data: { finishReason: 'max_tokens' } }])
    expect(projectSessionEvent({ type: 'turn/end', data: { reason: { kind: 'provider-error', message: 'api key leaked' } } }))
      .toEqual([{ type: 'run.failed', data: { code: 'RUN_FAILED', message: 'The run did not complete.' } }])
  })

  it('passes visible assistant text but drops reasoning chunks and private content blocks', () => {
    expect(projectSessionEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'public answer', reasoning: secretMarkers.reasoning } },
    })).toEqual([{ type: 'message.delta', data: { delta: 'public answer' } }])
    expect(projectSessionEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'reasoning-delta', text: secretMarkers.reasoning } },
    })).toEqual([])

    const projected = projectSessionEvent({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: secretMarkers.reasoning },
            { type: 'text', text: 'visible ' },
            { type: 'image', data: 'private-image-bytes' },
            { type: 'text', text: 'answer' },
          ],
        },
      },
    })
    expect(projected).toEqual([{
      type: 'message.completed',
      data: { role: 'assistant', content: 'visible answer' },
    }])
    expect(JSON.stringify(projected)).not.toContain(secretMarkers.reasoning)
    expect(JSON.stringify(projected)).not.toContain('private-image-bytes')
  })

  it('reduces tool activity to a validated name and outcome without arguments or results', () => {
    const call = projectSessionEvent({
      type: 'tool/call',
      data: { name: 'filesystem.read', arguments: secretMarkers.arguments },
    })
    const result = projectSessionEvent({
      type: 'tool/result',
      data: {
        message: { name: 'filesystem.read', content: [{ type: 'text', text: secretMarkers.result }] },
        error: { stack: 'C:\\private\\server.ts:1' },
      },
    })

    expect(call).toEqual([{ type: 'tool.started', data: { name: 'filesystem.read' } }])
    expect(result).toEqual([{ type: 'tool.completed', data: { name: 'filesystem.read', outcome: 'error' } }])
    expect(JSON.stringify([call, result])).not.toContain(secretMarkers.arguments)
    expect(JSON.stringify([call, result])).not.toContain(secretMarkers.result)
    expect(projectSessionEvent({ type: 'tool/call', data: { name: 'bad\nname', arguments: 'x' } })).toEqual([])
  })

  it('projects history from user-authored and assistant messages only', () => {
    const user = projectHistoryEvent({
      type: 'user/message',
      seq: 1,
      time: Date.parse('2026-09-08T00:00:00.000Z'),
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'question' }, { type: 'reasoning', text: secretMarkers.reasoning }],
      },
    })
    expect(user).toMatchObject({ role: 'user', content: 'question', seq: 1 })

    for (const source of ['system', 'agent-instructions', 'tool']) {
      expect(projectHistoryEvent({
        type: 'user/message',
        seq: 2,
        time: 1,
        data: { source: { kind: source }, content: [{ type: 'text', text: secretMarkers.systemPrompt }] },
      })).toBeUndefined()
    }

    const assistant = projectHistoryEvent({
      type: 'assistant/message',
      seq: 3,
      time: 2,
      data: { message: { content: [{ type: 'reasoning', text: secretMarkers.reasoning }, { type: 'text', text: 'answer' }] } },
    })
    expect(assistant).toMatchObject({ role: 'assistant', content: 'answer' })
    expect(JSON.stringify([user, assistant])).not.toContain(secretMarkers.reasoning)
    expect(JSON.stringify([user, assistant])).not.toContain(secretMarkers.systemPrompt)
  })

  it('projects tool history as metadata only and never copies its result body', () => {
    const projected = projectHistoryEvent({
      type: 'tool/result',
      seq: 4,
      time: 3,
      data: {
        message: { name: 'search.query', content: [{ type: 'text', text: secretMarkers.result }] },
        error: undefined,
      },
    })

    expect(projected).toMatchObject({ role: 'tool', toolName: 'search.query', outcome: 'ok', content: '' })
    expect(JSON.stringify(projected)).not.toContain(secretMarkers.result)
  })

  it('fails closed for malformed events and mux payloads', () => {
    expect(projectSessionEvent(null)).toEqual([])
    expect(projectSessionEvent({ type: 'plugin/private', data: { apiKey: 'secret' } })).toEqual([])
    expect(projectHistoryEvent({ type: 'assistant/message', seq: 1.2, time: 1, data: {} })).toBeUndefined()
    expect(projectHistoryEvent({ type: 'assistant/message', seq: 1, time: Number.NaN, data: {} })).toBeUndefined()
    expect(projectMuxPayload({ type: 'session/queue', sessionId: 'session-a', items: [] })).toBeUndefined()
    expect(projectMuxPayload({ type: 'session/event', sessionId: '', event: {} })).toBeUndefined()
    expect(projectMuxPayload({
      type: 'session/event',
      sessionId: 'session-a',
      event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'x' } } },
      view: { rawArguments: secretMarkers.arguments },
    })).toEqual({
      sessionId: 'session-a',
      event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'x' } } },
    })
  })

  it.each([
    { args: secretMarkers.arguments },
    { arguments: secretMarkers.arguments },
    { result: secretMarkers.result },
    { output: secretMarkers.result },
    { reasoning: secretMarkers.reasoning },
    { system_prompt: secretMarkers.systemPrompt },
    { apiKey: 'secret-key' },
    { token: 'secret-token' },
    { password: 'secret-password' },
    { nested: [{ secret: 'secret-value' }] },
  ])('detects forbidden projected data recursively: %j', (data) => {
    expect(projectedEventHasForbiddenData({
      id: 1,
      type: 'test',
      createdAt: '2026-09-08T00:00:00.000Z',
      data,
    })).toBe(true)
  })
})
