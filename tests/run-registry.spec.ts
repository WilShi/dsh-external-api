import { describe, expect, it, vi } from 'vitest'
import { EventCursorError, RunConflictError, RunRegistry } from '../src/run-registry.js'

function registry(options: { eventBufferSize?: number; maxTerminalRuns?: number; ids?: string[] } = {}) {
  const ids = [...(options.ids ?? ['run-1', 'run-2', 'run-3'])]
  return new RunRegistry({
    ...(options.eventBufferSize === undefined ? {} : { eventBufferSize: options.eventBufferSize }),
    ...(options.maxTerminalRuns === undefined ? {} : { maxTerminalRuns: options.maxTerminalRuns }),
    idFactory: () => ids.shift() ?? 'run-extra',
    now: () => new Date('2026-09-08T01:02:03.000Z'),
  })
}

describe('external run registry', () => {
  it('creates one active run per session and hides it from other tokens', () => {
    const runs = registry()
    const created = runs.create('token-a', 'session-a')

    expect(created).toEqual({
      id: 'run-1',
      sessionId: 'session-a',
      status: 'queued',
      createdAt: '2026-09-08T01:02:03.000Z',
    })
    expect(runs.getOwned('token-a', 'run-1')).toEqual(created)
    expect(runs.getOwned('token-b', 'run-1')).toBeUndefined()
    expect(() => runs.create('token-b', 'session-a')).toThrowError(
      expect.objectContaining<Partial<RunConflictError>>({ activeRunId: 'run-1' }),
    )
  })

  it('tracks lifecycle events, releases the session at terminal state, and replays by cursor', () => {
    const runs = registry()
    runs.create('token-a', 'session-a')
    runs.appendForSession('session-a', { type: 'run.started', data: {} })
    runs.appendForSession('session-a', { type: 'message.delta', data: { delta: 'hello' } })
    runs.appendForSession('session-a', { type: 'run.completed', data: { finishReason: 'max_tokens' } })

    expect(runs.getOwned('token-a', 'run-1')).toMatchObject({
      status: 'completed',
      finishReason: 'max_tokens',
      startedAt: '2026-09-08T01:02:03.000Z',
      completedAt: '2026-09-08T01:02:03.000Z',
    })
    expect(runs.activeForSession('session-a')).toBeUndefined()
    expect(runs.subscribe('token-a', 'run-1', 1, vi.fn())).toMatchObject({
      terminal: true,
      replay: [
        expect.objectContaining({ id: 2, type: 'run.started' }),
        expect.objectContaining({ id: 3, type: 'message.delta', data: { delta: 'hello' } }),
        expect.objectContaining({ id: 4, type: 'run.completed', data: { finishReason: 'max_tokens' } }),
      ],
    })

    expect(runs.create('token-b', 'session-a').id).toBe('run-2')
  })

  it('allows cancellation only for the owner and emits cancelling once', () => {
    const runs = registry()
    runs.create('token-a', 'session-a')

    expect(runs.requestCancel('token-b', 'run-1')).toBeUndefined()
    expect(runs.requestCancel('token-a', 'run-1')).toMatchObject({ status: 'cancelling' })
    expect(runs.requestCancel('token-a', 'run-1')).toMatchObject({ status: 'cancelling' })
    const beforeSettlement = runs.subscribe('token-a', 'run-1', undefined, vi.fn())
    expect(beforeSettlement?.replay.map(event => event.type)).toEqual(['run.queued', 'run.cancelling'])

    runs.appendForSession('session-a', { type: 'run.cancelled', data: { finishReason: 'cancelled' } })
    expect(runs.getOwned('token-a', 'run-1')).toMatchObject({ status: 'cancelled', finishReason: 'cancelled' })
    expect(runs.requestCancel('token-a', 'run-1')).toBeUndefined()
  })

  it('streams live events until terminal settlement and supports unsubscribe', () => {
    const runs = registry()
    runs.create('token-a', 'session-a')
    const listener = vi.fn()
    const subscription = runs.subscribe('token-a', 'run-1', 1, listener)
    expect(subscription).toMatchObject({ replay: [], terminal: false })

    runs.appendForSession('session-a', { type: 'message.delta', data: { delta: 'a' } })
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2, type: 'message.delta' }))
    subscription?.unsubscribe()
    runs.appendForSession('session-a', { type: 'message.delta', data: { delta: 'b' } })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('bounds the replay buffer and distinguishes expired from invalid cursors', () => {
    const runs = registry({ eventBufferSize: 2 })
    runs.create('token-a', 'session-a')
    runs.appendForSession('session-a', { type: 'run.started', data: {} })
    runs.appendForSession('session-a', { type: 'message.delta', data: { delta: 'a' } })
    runs.appendForSession('session-a', { type: 'message.delta', data: { delta: 'b' } })

    expect(runs.subscribe('token-a', 'run-1', undefined, vi.fn())?.replay.map(event => event.id)).toEqual([3, 4])
    expect(() => runs.subscribe('token-a', 'run-1', 1, vi.fn())).toThrowError(
      expect.objectContaining<Partial<EventCursorError>>({ code: 'EVENT_CURSOR_EXPIRED' }),
    )
    for (const cursor of [-1, 1.5, 5]) {
      expect(() => runs.subscribe('token-a', 'run-1', cursor, vi.fn())).toThrowError(
        expect.objectContaining<Partial<EventCursorError>>({ code: 'EVENT_CURSOR_INVALID' }),
      )
    }
  })

  it('evicts only the oldest terminal run when retention is exceeded', () => {
    const runs = registry({ maxTerminalRuns: 1 })
    runs.create('token-a', 'session-a')
    runs.appendForSession('session-a', { type: 'run.completed', data: {} })
    runs.create('token-a', 'session-b')
    runs.appendForSession('session-b', { type: 'run.failed', data: {} })

    expect(runs.getOwned('token-a', 'run-1')).toBeUndefined()
    expect(runs.getOwned('token-a', 'run-2')).toMatchObject({ status: 'failed' })
  })
})
