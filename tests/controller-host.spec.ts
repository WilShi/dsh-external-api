import { describe, expect, it, vi } from 'vitest'
import { createControllerExternalApiHost } from '../src/controller-host.js'

function fixture() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const on = vi.fn((event: string, listener: (...args: any[]) => void) => {
    const bucket = listeners.get(event) ?? new Set()
    bucket.add(listener)
    listeners.set(event, bucket)
    return () => { bucket.delete(listener) }
  })
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  const sessionController = {
    list: vi.fn(async () => ({
      items: [{
        sessionId: 'session-a',
        updatedAt: 1,
        running: false,
        blank: false,
        projections: {
          asOfSeq: 4,
          values: {
            modelSelection: {
              lastUsed: { provider: 'old', model: 'old-model' },
              next: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
            },
          },
        },
      }],
    })),
    create: vi.fn(async (request: Record<string, unknown>) => ({
      sessionId: request.sessionId,
      agentPreset: request.agentPreset,
    })),
    inspect: vi.fn(async () => ({ events: [{ seq: 0 }, { seq: 4 }] })),
    page: vi.fn(async () => ({
      records: [{ event: { type: 'user/message', seq: 4, time: 5, data: { content: [] } } }],
      hasMore: true,
    })),
    modelCatalog: vi.fn(async () => ({
      default: { provider: 'default', model: 'default-model' },
      routableProviders: ['provider-a'],
      groups: [{ id: 'provider-a', name: 'Provider A', models: [] }],
      failures: [],
    })),
    prompt: vi.fn(async () => ({ accepted: true as const })),
    cancel: vi.fn(() => ({ accepted: true as const })),
  }
  const workspaceController = {
    follow: vi.fn(async function* () {
      yield {
        type: 'baseline',
        value: {
          items: [{ workspaceId: 'workspace-a', title: 'A' }],
          archivedSessionIds: ['archived-a'],
        },
      }
    }),
  }
  const agentPresets = {
    remoteExportList: vi.fn(async () => ({ presets: [{ id: 'standard' }], authorable: true })),
  }
  const sessionSkillCatalog = {
    list: vi.fn(async () => ({ skills: [{ name: 'review', description: 'Review', modelInvocable: true }] })),
  }
  const ctx = { on, sessionController, workspaceController, agentPresets, sessionSkillCatalog }
  return { ctx, emit, sessionController, workspaceController, agentPresets, sessionSkillCatalog }
}

describe('rc.2 controller host adapter', () => {
  it('maps session, workspace, preset and skill calls without a browser RPC proxy', async () => {
    const f = fixture()
    const host = createControllerExternalApiHost(f.ctx as never)

    expect((await host.sessions.list({ rpcId: 'list', payload: {} })).result).toEqual({
      ok: true,
      value: expect.objectContaining({ items: expect.any(Array) }),
    })
    expect((await host.sessions.history({
      rpcId: 'history',
      payload: { sessionId: 'session-a', beforeSeq: 4, maxMessages: 20 },
    })).result).toEqual({
      ok: true,
      value: { events: expect.any(Array), hasMore: true },
    })
    expect(f.sessionController.page).toHaveBeenCalledWith(expect.objectContaining({
      address: { kind: 'session', sessionId: 'session-a' },
      throughSeq: 4,
      beforeSeq: 4,
      maxMessages: 20,
    }), expect.any(AbortSignal))

    const models = await host.sessions.models({ rpcId: 'models', payload: { sessionId: 'session-a' } })
    expect(models.result).toEqual({
      ok: true,
      value: expect.objectContaining({
        current: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
        routable: true,
      }),
    })

    await host.sessions.prompt({
      rpcId: 'prompt-request-id',
      payload: { sessionId: 'session-a', mode: 'queue', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(f.sessionController.prompt).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'prompt-request-id',
      sessionId: 'session-a',
    }), expect.any(AbortSignal))

    expect((await host.workspace.list({ rpcId: 'workspace', payload: {} })).result).toEqual({
      ok: true,
      value: { items: [{ workspaceId: 'workspace-a', title: 'A' }], archivedSessionIds: ['archived-a'] },
    })
    expect((await host.agentPresets.list({ rpcId: 'presets', payload: {} })).result).toEqual({
      ok: true,
      value: { presets: [{ id: 'standard' }], authorable: true, hasDocument: false },
    })
    expect((await host.skills.list({ rpcId: 'skills', payload: { sessionId: 'session-a' } })).result).toEqual({
      ok: true,
      value: { skills: [{ name: 'review', description: 'Review', modelInvocable: true }] },
    })
  })

  it('translates rc.2 RemoteError codes to the stable external API taxonomy', async () => {
    const f = fixture()
    f.sessionController.create.mockRejectedValueOnce(Object.assign(new Error('private path'), {
      isDSHRemoteError: true,
      code: 'agent-preset/not-found',
    }))
    const host = createControllerExternalApiHost(f.ctx as never)
    const response = await host.sessions.create({
      rpcId: 'create',
      payload: { sessionId: 'session-a', agentPreset: 'missing' },
    })
    expect(response).toEqual({
      rpcId: 'create',
      result: {
        ok: false,
        error: {
          code: 'agent-preset-not-found',
          message: 'The Harness controller rejected the operation.',
        },
      },
    })
  })

  it('bridges durable and transient rc.2 events into the existing run-event stream', async () => {
    const f = fixture()
    const host = createControllerExternalApiHost(f.ctx as never)
    const abort = new AbortController()
    const iterator = host.events.mux({ rpcId: 'events', payload: {} }, abort.signal)[Symbol.asyncIterator]()

    const durable = iterator.next()
    await Promise.resolve()
    f.emit('session/event', { id: 'session-a' }, {
      type: 'turn/start', data: { turn: 3 }, time: 10,
    })
    expect(await durable).toEqual({
      done: false,
      value: {
        rpcId: 'events',
        payload: expect.objectContaining({ type: 'session/event', sessionId: 'session-a' }),
      },
    })

    const delta = iterator.next()
    f.emit('agent/assistant-stream', {
      agent: { session: { id: 'session-a' } },
      frame: { type: 'start', attemptId: 'attempt-a', turn: 3, step: 1 },
    })
    f.emit('agent/assistant-stream', {
      agent: { session: { id: 'session-a' } },
      frame: { type: 'chunk', attemptId: 'attempt-a', time: 11, chunk: { type: 'text-delta', text: 'hi' } },
    })
    expect(await delta).toEqual({
      done: false,
      value: {
        rpcId: 'events',
        payload: {
          type: 'session/event',
          sessionId: 'session-a',
          event: {
            type: 'assistant/chunk',
            time: 11,
            data: { turn: 3, step: 1, chunk: { type: 'text-delta', text: 'hi' } },
          },
        },
      },
    })

    abort.abort()
    await iterator.return?.()
  })

  it('projects interaction and host lifecycle signals needed by run safety', async () => {
    const f = fixture()
    const host = createControllerExternalApiHost(f.ctx as never)
    const muxAbort = new AbortController()
    const mux = host.events.mux({ rpcId: 'mux', payload: {} }, muxAbort.signal)[Symbol.asyncIterator]()
    const first = mux.next()
    await Promise.resolve()
    f.emit('session/event', { id: 'session-a' }, { type: 'approval/asked', data: {} })
    await first // durable event precedes the derived interaction notification
    expect((await mux.next()).value).toEqual({
      rpcId: 'mux',
      payload: { type: 'approval/requested', sessionId: 'session-a' },
    })

    const hostAbort = new AbortController()
    const lifecycle = host.events.host({ rpcId: 'host', payload: {} }, hostAbort.signal)[Symbol.asyncIterator]()
    const failure = lifecycle.next()
    await Promise.resolve()
    f.emit('api-session/error', 'session-a', 'private failure')
    expect((await failure).value).toEqual({
      rpcId: 'host',
      payload: { type: 'host/agent-error', sessionId: 'session-a' },
    })

    muxAbort.abort()
    hostAbort.abort()
    await mux.return?.()
    await lifecycle.return?.()
  })
})
