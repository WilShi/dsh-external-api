import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { SessionSkillCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import type {
  ExternalApiHost,
  RpcRequestLike,
  RpcResponseLike,
} from './contracts.ts'

/** Services owned by the rc.2 Host controller plane. */
interface SessionEventLike {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
  readonly time?: number
}

type AssistantStreamFrameLike =
  | {
    readonly type: 'start'
    readonly attemptId: string
    readonly turn: number
    readonly step: number
  }
  | {
    readonly type: 'chunk'
    readonly attemptId: string
    readonly time: number
    readonly chunk: unknown
  }
  | {
    readonly type: 'end'
    readonly attemptId: string
  }

interface AgentLike {
  readonly session: { readonly id: string }
}

interface EventOptions {
  readonly global?: boolean
}

export interface ExternalApiControllerContext {
  readonly sessionController: SessionController
  readonly workspaceController: WorkspaceController
  readonly agentPresets: AgentPresets
  readonly sessionSkillCatalog: SessionSkillCatalog
  on(event: 'session/event', listener: (session: { readonly id: string }, event: SessionEventLike) => void, options?: EventOptions): () => void
  on(event: 'agent/assistant-stream', listener: (payload: { readonly agent: AgentLike; readonly frame: AssistantStreamFrameLike }) => void, options?: EventOptions): () => void
  on(event: 'agent/disposed', listener: (payload: { readonly agent: AgentLike }) => void, options?: EventOptions): () => void
  on(event: 'api-session/error', listener: (sessionId: string, message: string) => void, options?: EventOptions): () => void
  on(event: 'api-session/removed', listener: (sessionId: string) => void, options?: EventOptions): () => void
}

/**
 * Adapt the rc.2 in-process Controller APIs to the narrow host port used by
 * the external HTTP server.  No browser Remote or legacy ApiProxy is involved.
 */
export function createControllerExternalApiHost(ctx: ExternalApiControllerContext): ExternalApiHost {
  const sessions: ExternalApiHost['sessions'] = {
    list: request => respond(request, signal => ctx.sessionController.list(request.payload, signal)),
    create: request => respond(request, () => ctx.sessionController.create(request.payload as never)),
    history: request => respond(request, async (signal) => {
      const { sessionId, beforeSeq, maxMessages } = request.payload
      const inspected = await ctx.sessionController.inspect(sessionId as never, signal)
      const throughSeq = inspected.events.at(-1)?.seq ?? -1
      if (throughSeq < 0) return { events: [], hasMore: false }
      const page = await ctx.sessionController.page({
        address: { kind: 'session', sessionId: sessionId as never },
        throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(maxMessages === undefined ? {} : { maxMessages }),
      }, signal)
      return { events: [...page.records], hasMore: page.hasMore }
    }),
    models: request => respond(request, async (signal) => {
      const [listed, catalog] = await Promise.all([
        ctx.sessionController.list({}, signal),
        ctx.sessionController.modelCatalog(),
      ])
      const summary = listed.items.find(item => item.sessionId === request.payload.sessionId)
      if (summary === undefined) throw controllerError('session/not-found')
      const current = selectionFromSummary(summary) ?? catalog.default
      return {
        current,
        routable: catalog.routableProviders.includes(current.provider),
        groups: [...catalog.groups],
        failures: [...catalog.failures],
      }
    }),
    prompt: request => respond(request, signal => ctx.sessionController.prompt({
      requestId: request.rpcId as never,
      ...request.payload,
      sessionId: request.payload.sessionId as never,
    }, signal)),
    cancel: request => respond(request, () => Promise.resolve(ctx.sessionController.cancel({
      sessionId: request.payload.sessionId as never,
    }))),
  }

  return {
    sessions,
    workspace: {
      list: request => respond(request, signal => workspaceBaseline(ctx.workspaceController, signal)),
    },
    agentPresets: {
      list: request => respond(request, async () => ({
        ...await ctx.agentPresets.remoteExportList(),
        // Kept only in this package-private shape for compatibility with the
        // pre-rc.2 adapter.  The public HTTP projection never exposed it.
        hasDocument: false,
      })),
    },
    skills: {
      list: request => respond(request, signal => ctx.sessionSkillCatalog.list({
        sessionId: request.payload.sessionId as never,
      }, signal)),
    },
    events: {
      mux: (request, signal) => muxEvents(ctx, request.rpcId, signal),
      host: (request, signal) => hostEvents(ctx, request.rpcId, signal),
    },
  }
}

async function workspaceBaseline(
  controller: WorkspaceController,
  signal: AbortSignal,
): Promise<{ items: unknown[]; archivedSessionIds: string[] }> {
  const local = new AbortController()
  const relayAbort = (): void => { local.abort(signal.reason) }
  signal.addEventListener('abort', relayAbort, { once: true })
  const iterator = controller.follow(local.signal)[Symbol.asyncIterator]()
  try {
    const next = await iterator.next()
    if (next.done || next.value.type !== 'baseline') {
      throw controllerError('gateway/internal')
    }
    return {
      items: [...next.value.value.items],
      archivedSessionIds: [...next.value.value.archivedSessionIds],
    }
  } finally {
    local.abort()
    signal.removeEventListener('abort', relayAbort)
    await iterator.return?.()
  }
}

function selectionFromSummary(summary: unknown): {
  provider: string
  model: string
  reasoningEffort?: string
} | undefined {
  if (!isRecord(summary) || !isRecord(summary.projections) || !isRecord(summary.projections.values)) return undefined
  const projection = summary.projections.values.modelSelection
  if (!isRecord(projection)) return undefined
  return selection(projection.next) ?? selection(projection.lastUsed)
}

function selection(value: unknown): {
  provider: string
  model: string
  reasoningEffort?: string
} | undefined {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
  }
}

async function respond<TRequest, TValue>(
  request: RpcRequestLike<TRequest>,
  operation: (signal: AbortSignal) => Promise<TValue>,
): Promise<RpcResponseLike<TValue>> {
  try {
    const signal = new AbortController().signal
    return { rpcId: request.rpcId, result: { ok: true, value: await operation(signal) } }
  } catch (error: unknown) {
    return {
      rpcId: request.rpcId,
      result: {
        ok: false,
        error: {
          code: compatibilityErrorCode(remoteErrorCode(error)),
          message: 'The Harness controller rejected the operation.',
        },
      },
    }
  }
}

function compatibilityErrorCode(code: string | undefined): string {
  switch (code) {
    case 'session/not-found': return 'session-not-found'
    case 'session/agent-busy': return 'agent-busy'
    case 'workspace/not-found': return 'workspace-not-found'
    case 'session/workspace-attach-failed': return 'workspace-not-found'
    case 'agent-preset/not-found': return 'agent-preset-not-found'
    case 'agent-preset/invalid': return 'agent-preset-invalid'
    case 'session/invalid-time-zone': return 'invalid-time-zone'
    default: return code ?? 'internal'
  }
}

function remoteErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || error.isDSHRemoteError !== true || typeof error.code !== 'string') return undefined
  return error.code
}

function controllerError(code: string): Error & { readonly isDSHRemoteError: true; readonly code: string } {
  return Object.assign(new Error(code), { isDSHRemoteError: true as const, code })
}

function muxEvents(
  ctx: ExternalApiControllerContext,
  rpcId: string,
  signal: AbortSignal,
): AsyncIterable<RpcRequestLike<unknown>> {
  return eventStream(signal, (publish) => {
    const attempts = new Map<string, { turn: number; step: number }>()
    const disposeSession = ctx.on('session/event', (session, event) => {
      const sessionId = String(session.id)
      publish({ rpcId, payload: { type: 'session/event', sessionId, event } })
      if (event.type === 'approval/asked') {
        publish({ rpcId, payload: { type: 'approval/requested', sessionId } })
      } else if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
        publish({
          rpcId,
          payload: { type: 'question/requested', sessionId, turn: event.data.turn },
        })
      }
    }, { global: true })
    const disposeAssistant = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const sessionId = String(agent.session.id)
      const key = `${sessionId}\0${String(frame.attemptId)}`
      if (frame.type === 'start') {
        attempts.set(key, { turn: frame.turn, step: frame.step })
        return
      }
      if (frame.type === 'end') {
        attempts.delete(key)
        return
      }
      const position = attempts.get(key)
      if (position === undefined) return
      publish({
        rpcId,
        payload: {
          type: 'session/event',
          sessionId,
          event: {
            type: 'assistant/chunk',
            time: frame.time,
            data: { ...position, chunk: frame.chunk },
          },
        },
      })
    }, { global: true })
    const disposeAgent = ctx.on('agent/disposed', ({ agent }) => {
      const prefix = `${String(agent.session.id)}\0`
      for (const key of attempts.keys()) if (key.startsWith(prefix)) attempts.delete(key)
    }, { global: true })
    return () => {
      disposeAgent()
      disposeAssistant()
      disposeSession()
      attempts.clear()
    }
  })
}

function hostEvents(
  ctx: ExternalApiControllerContext,
  rpcId: string,
  signal: AbortSignal,
): AsyncIterable<RpcRequestLike<unknown>> {
  return eventStream(signal, (publish) => {
    const disposeError = ctx.on('api-session/error', (sessionId) => {
      publish({ rpcId, payload: { type: 'host/agent-error', sessionId: String(sessionId) } })
    })
    const disposeRemoved = ctx.on('api-session/removed', (sessionId) => {
      publish({ rpcId, payload: { type: 'host/session-removed', sessionId: String(sessionId) } })
    })
    return () => {
      disposeRemoved()
      disposeError()
    }
  })
}

function eventStream<T>(
  signal: AbortSignal,
  install: (publish: (value: T) => void) => () => void,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      signal.throwIfAborted()
      const pending: T[] = []
      let wake: (() => void) | undefined
      const dispose = install((value) => {
        if (signal.aborted) return
        pending.push(value)
        const resume = wake
        wake = undefined
        resume?.()
      })
      const onAbort = (): void => {
        const resume = wake
        wake = undefined
        resume?.()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        while (!signal.aborted) {
          const value = pending.shift()
          if (value !== undefined) {
            yield value
            continue
          }
          await new Promise<void>((resolve) => { wake = resolve })
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        dispose()
      }
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
