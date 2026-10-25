import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthenticationError, isAllowed, requireScope, TokenAuthenticator } from './auth.ts'
import {
  EXTERNAL_API_PREFIX,
  type ExternalApiHost,
  type AuthenticatedToken,
  type ExternalApiConfig,
  type ExternalApiLogger,
  type ExternalRunView,
  type RpcResponseLike,
} from './contracts.ts'
import { projectHistoryEvent } from './event-projector.ts'
import {
  applyCors,
  applySecurityHeaders,
  assertOnlyKeys,
  handlePreflight,
  HttpError,
  isRecord,
  optionalString,
  parsePathIdentifier,
  readJsonObject,
  sendExternalError,
  sendJson,
  singleHeader,
  validateExternalRequest,
} from './http-utils.ts'
import { OwnershipStore } from './ownership-store.ts'
import { TokenRateLimiter } from './rate-limit.ts'
import { EventCursorError, isTerminal, RunConflictError, RunRegistry } from './run-registry.ts'

const MAX_PROMPT_CODE_UNITS = 65_536
const MAX_HISTORY_MESSAGES = 50
const MAX_SSE_BUFFER_BYTES = 1024 * 1024
const REVOKE_CANCEL_TIMEOUT_MS = 250

export interface ExternalApiRouterOptions {
  readonly host: ExternalApiHost
  readonly config: ExternalApiConfig
  readonly port: number
  readonly ownership: OwnershipStore
  readonly runs: RunRegistry
  readonly logger?: ExternalApiLogger
}

export interface ExternalApiHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  revokeToken(tokenId: string): Promise<void>
  updateConfig(config: ExternalApiConfig): void
  close(): void
}

class HostCallError extends Error {
  constructor(readonly rpcCode: string) {
    super(rpcCode)
    this.name = 'HostCallError'
  }
}

export function createExternalApiHandler(options: ExternalApiRouterOptions): ExternalApiHandler {
  let config = options.config
  let authenticator = new TokenAuthenticator(config.tokens)
  let limiter = new TokenRateLimiter(config.rateLimitPerMinute)
  let authGeneration = 0
  const failedAuthenticationLimiter = new TokenRateLimiter(10)
  const sseByToken = new Map<string, Set<ServerResponse>>()

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID()
    try {
      const origin = validateExternalRequest(request, options.port, config.allowedOrigins)
      applyCors(response, origin)
      if (!config.enabled) throw new HttpError(503, 'SERVICE_DISABLED', 'The external API is disabled.')
      if (request.method === 'OPTIONS') {
        handlePreflight(request, response, origin)
        return
      }
      const url = parseRequestUrl(request)
      if (url.pathname === `${EXTERNAL_API_PREFIX}/health`) {
        assertMethod(request, ['GET', 'HEAD'])
        const body = { status: 'ok', service: 'dsh-external-api', version: 'v1' }
        if (request.method === 'HEAD') {
          applySecurityHeaders(response)
          response.statusCode = 200
          response.end()
        } else sendJson(response, 200, body)
        return
      }

      let token: AuthenticatedToken
      try {
        token = authenticator.authenticate(singleHeader(request, 'authorization'))
      } catch (error) {
        if (error instanceof AuthenticationError) {
          const failedRate = failedAuthenticationLimiter.consume(request.socket.remoteAddress ?? 'unknown')
          if (!failedRate.allowed) {
            response.setHeader('retry-after', String(failedRate.retryAfterSeconds))
            throw new HttpError(429, 'AUTH_RATE_LIMITED', 'Too many failed authentication attempts.')
          }
        }
        throw error
      }
      if (origin !== undefined && token.allowedOrigins.size > 0 && !token.allowedOrigins.has(origin)) {
        throw new AuthenticationError('ORIGIN_FORBIDDEN')
      }
      const rate = limiter.consume(token.id)
      if (!rate.allowed) {
        response.setHeader('retry-after', String(rate.retryAfterSeconds))
        throw new HttpError(429, 'RATE_LIMITED', 'Too many requests.')
      }
      const leaseGeneration = authGeneration
      const assertCurrent = () => {
        if (!config.enabled || leaseGeneration !== authGeneration) {
          throw new HttpError(401, 'TOKEN_REVOKED', 'The bearer token is no longer valid.')
        }
      }
      await routeAuthenticated(request, response, url, origin, token, assertCurrent)
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      const safe = toHttpError(error)
      sendExternalError(response, safe, requestId)
      if (safe.status >= 500) options.logger?.error(`dsh-external-api: request ${requestId} failed (${safe.code})`)
    }
  }

  async function routeAuthenticated(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    origin: string | undefined,
    token: AuthenticatedToken,
    assertCurrent: () => void,
  ): Promise<void> {
    if (url.pathname === `${EXTERNAL_API_PREFIX}/capabilities`) {
      assertMethod(request, ['GET'])
      assertNoQuery(url)
      requireScope(token, 'capabilities:read')
      sendJson(response, 200, {
        apiVersion: 'v1',
        transport: { http: true, sse: true },
        scopes: [...token.scopes].sort(),
        features: {
          sessions: true,
          messageHistory: true,
          runs: true,
          cancellation: true,
          eventReplay: true,
          rawRpc: false,
          rawTools: false,
          slashCommands: false,
          filesystemPaths: false,
        },
        limits: {
          requestBodyBytes: config.requestBodyLimitBytes,
          promptCodeUnits: MAX_PROMPT_CODE_UNITS,
          historyMessages: MAX_HISTORY_MESSAGES,
        },
      })
      return
    }

    if (url.pathname === `${EXTERNAL_API_PREFIX}/workspaces`) {
      assertMethod(request, ['GET'])
      assertNoQuery(url)
      requireScope(token, 'capabilities:read')
      const value = await hostValue('workspace.list', options.host.workspace.list(rpc({})))
      assertCurrent()
      const items = Array.isArray(value.items) ? value.items : []
      sendJson(response, 200, {
        items: items.flatMap((item) => {
          if (!isRecord(item) || typeof item.workspaceId !== 'string' || typeof item.title !== 'string') return []
          if (!isAllowed(token.allowedWorkspaceIds, item.workspaceId)) return []
          return [{ id: item.workspaceId, name: item.title }]
        }),
      })
      return
    }

    if (url.pathname === `${EXTERNAL_API_PREFIX}/agents`) {
      assertMethod(request, ['GET'])
      assertNoQuery(url)
      requireScope(token, 'capabilities:read')
      const value = await hostValue('agentPreset.list', options.host.agentPresets.list(rpc({})))
      assertCurrent()
      const presets = Array.isArray(value.presets) ? value.presets : []
      sendJson(response, 200, {
        items: presets.flatMap((item) => {
          if (!isRecord(item) || typeof item.id !== 'string' || item.broken !== undefined) return []
          if (!isAllowed(token.allowedAgentPresets, item.id)) return []
          return [{
            id: item.id,
            name: typeof item.name === 'string' ? item.name : item.id,
            ...(typeof item.description === 'string' ? { description: item.description } : {}),
            isDefault: item.isDefault === true,
          }]
        }),
      })
      return
    }

    if (url.pathname === `${EXTERNAL_API_PREFIX}/models`) {
      assertMethod(request, ['GET'])
      requireScope(token, 'capabilities:read')
      const sessionId = requiredOwnedSessionQuery(url, token, options.ownership)
      const models = await hostValue('session.models', options.host.sessions.models(rpc({ sessionId })))
      assertCurrent()
      sendJson(response, 200, projectModels(models))
      return
    }

    if (url.pathname === `${EXTERNAL_API_PREFIX}/skills`) {
      assertMethod(request, ['GET'])
      requireScope(token, 'capabilities:read')
      const sessionId = requiredOwnedSessionQuery(url, token, options.ownership)
      const value = await hostValue('skill.list', options.host.skills.list(rpc({ sessionId })))
      assertCurrent()
      const skills = Array.isArray(value.skills) ? value.skills : []
      sendJson(response, 200, {
        items: skills.flatMap((skill) => {
          if (!isRecord(skill) || typeof skill.name !== 'string' || typeof skill.description !== 'string') return []
          return [{ name: skill.name, description: skill.description, modelInvocable: skill.modelInvocable === true }]
        }),
      })
      return
    }

    if (url.pathname === `${EXTERNAL_API_PREFIX}/sessions`) {
      if (request.method === 'GET') {
        assertNoQuery(url)
        requireScope(token, 'sessions:read')
        const value = await hostValue('session.list', options.host.sessions.list(rpc({})))
        assertCurrent()
        const owned = options.ownership.sessionsFor(token.id)
        sendJson(response, 200, {
          items: (Array.isArray(value.items) ? value.items : []).flatMap(item => projectSessionSummary(item, owned)),
        })
        return
      }
      if (request.method === 'POST') {
        assertNoQuery(url)
        requireScope(token, 'sessions:write')
        const body = await readJsonObject(request, config.requestBodyLimitBytes, { allowEmpty: true })
        const session = await createSession(body, token, options, assertCurrent)
        sendJson(response, 201, { session })
        return
      }
      throw methodNotAllowed(['GET', 'POST'])
    }

    if (url.pathname === `${EXTERNAL_API_PREFIX}/responses`) {
      assertMethod(request, ['POST'])
      assertNoQuery(url)
      requireScope(token, 'sessions:write')
      requireScope(token, 'runs:write')
      const body = await readJsonObject(request, config.requestBodyLimitBytes)
      assertOnlyKeys(body, ['input', 'workspaceId', 'agentPreset', 'clientTimeZone'])
      const runBody = {
        input: body.input,
        ...(body.clientTimeZone === undefined ? {} : { clientTimeZone: body.clientTimeZone }),
      }
      validateRunBody(runBody)
      const session = await createSession({
        ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
        ...(body.agentPreset === undefined ? {} : { agentPreset: body.agentPreset }),
      }, token, options, assertCurrent)
      try {
        const run = await startRun(session.id, runBody, token, options, config, assertCurrent)
        sendJson(response, 202, { session, run, eventsUrl: `${EXTERNAL_API_PREFIX}/runs/${encodeURIComponent(run.id)}/events` })
      } catch (error) {
        // The session remains owned and usable when its first run is rejected.
        throw error
      }
      return
    }

    const messagesMatch = url.pathname.match(new RegExp(`^${EXTERNAL_API_PREFIX}/sessions/([^/]+)/messages$`, 'u'))
    if (messagesMatch !== null) {
      const sessionId = parsePathIdentifier(messagesMatch[1]!)
      assertOwned(options.ownership, token, sessionId)
      if (request.method === 'GET') {
        requireScope(token, 'sessions:read')
        const beforeSeq = parseOptionalNonNegativeInt(url.searchParams.get('beforeSeq'), 'beforeSeq')
        const limit = parseLimit(url.searchParams.get('limit'))
        assertOnlyQuery(url, ['beforeSeq', 'limit'])
        const value = await hostValue('session.history', options.host.sessions.history(rpc({
          sessionId,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          maxMessages: limit,
        })))
        assertCurrent()
        const entries = Array.isArray(value.events) ? value.events : []
        const items = entries.flatMap((entry) => {
          if (!isRecord(entry)) return []
          const projected = projectHistoryEvent(entry.event)
          return projected === undefined ? [] : [projected]
        })
        const firstSeq = entries.reduce<number | undefined>((min, entry) => {
          if (!isRecord(entry) || !isRecord(entry.event)) return min
          const seq = entry.event.seq
          if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return min
          return min === undefined || seq < min ? seq : min
        }, undefined)
        sendJson(response, 200, {
          items,
          hasMore: value.hasMore === true,
          ...(value.hasMore === true && firstSeq !== undefined ? { nextBeforeSeq: firstSeq } : {}),
        })
        return
      }
      if (request.method === 'POST') {
        assertNoQuery(url)
        requireScope(token, 'runs:write')
        const body = await readJsonObject(request, config.requestBodyLimitBytes)
        const run = await startRun(sessionId, body, token, options, config, assertCurrent)
        sendJson(response, 202, { run, eventsUrl: `${EXTERNAL_API_PREFIX}/runs/${encodeURIComponent(run.id)}/events` })
        return
      }
      throw methodNotAllowed(['GET', 'POST'])
    }

    const sessionRunsMatch = url.pathname.match(new RegExp(`^${EXTERNAL_API_PREFIX}/sessions/([^/]+)/runs$`, 'u'))
    if (sessionRunsMatch !== null) {
      assertMethod(request, ['POST'])
      assertNoQuery(url)
      requireScope(token, 'runs:write')
      const sessionId = parsePathIdentifier(sessionRunsMatch[1]!)
      assertOwned(options.ownership, token, sessionId)
      const body = await readJsonObject(request, config.requestBodyLimitBytes)
      const run = await startRun(sessionId, body, token, options, config, assertCurrent)
      sendJson(response, 202, { run, eventsUrl: `${EXTERNAL_API_PREFIX}/runs/${encodeURIComponent(run.id)}/events` })
      return
    }

    const runEventsMatch = url.pathname.match(new RegExp(`^${EXTERNAL_API_PREFIX}/runs/([^/]+)/events$`, 'u'))
    if (runEventsMatch !== null) {
      assertMethod(request, ['GET'])
      assertNoQuery(url)
      requireScope(token, 'runs:read')
      const runId = parsePathIdentifier(runEventsMatch[1]!)
      await streamRunEvents(request, response, origin, token, runId, options, config, sseByToken)
      return
    }

    const cancelMatch = url.pathname.match(new RegExp(`^${EXTERNAL_API_PREFIX}/runs/([^/]+)/cancel$`, 'u'))
    if (cancelMatch !== null) {
      assertMethod(request, ['POST'])
      assertNoQuery(url)
      requireScope(token, 'runs:write')
      await readJsonObject(request, config.requestBodyLimitBytes, { allowEmpty: true })
      const runId = parsePathIdentifier(cancelMatch[1]!)
      assertCurrent()
      const run = options.runs.requestCancel(token.id, runId)
      if (run === undefined) throw new HttpError(409, 'RUN_NOT_CANCELLABLE', 'The run is not the active cancellable run.')
      try {
        const value = await hostValue('session.cancel', options.host.sessions.cancel(rpc({ sessionId: run.sessionId })))
        if (value.accepted !== true) throw new HttpError(502, 'HOST_REJECTED', 'DSH did not accept the cancellation.')
      } catch (error) {
        options.runs.fail(run.id, 'CANCEL_REJECTED', 'DSH could not cancel the run.')
        throw error
      }
      assertCurrent()
      sendJson(response, 202, { run: options.runs.getOwned(token.id, runId) })
      return
    }

    const runMatch = url.pathname.match(new RegExp(`^${EXTERNAL_API_PREFIX}/runs/([^/]+)$`, 'u'))
    if (runMatch !== null) {
      assertMethod(request, ['GET'])
      assertNoQuery(url)
      requireScope(token, 'runs:read')
      const runId = parsePathIdentifier(runMatch[1]!)
      const run = options.runs.getOwned(token.id, runId)
      if (run === undefined) throw notFound()
      sendJson(response, 200, { run })
      return
    }

    throw notFound()
  }

  async function revokeToken(tokenId: string): Promise<void> {
    const activeRuns = options.runs.activeRunsForToken(tokenId)
    for (const run of activeRuns) {
      options.runs.fail(run.id, 'TOKEN_REVOKED', 'The token used for this run was revoked.')
    }
    const connections = sseByToken.get(tokenId)
    if (connections !== undefined) {
      for (const response of connections) response.destroy()
      sseByToken.delete(tokenId)
    }
    await Promise.allSettled(activeRuns.map(run => settleWithin(
      Promise.resolve()
        .then(() => options.host.sessions.cancel(rpc({ sessionId: run.sessionId })))
        .then(() => undefined, () => undefined),
      REVOKE_CANCEL_TIMEOUT_MS,
    )))
  }

  function close(): void {
    for (const connections of sseByToken.values()) {
      for (const response of connections) response.destroy()
    }
    sseByToken.clear()
  }

  function updateConfig(next: ExternalApiConfig): void {
    authGeneration += 1
    config = next
    authenticator = new TokenAuthenticator(next.tokens)
    limiter = new TokenRateLimiter(next.rateLimitPerMinute)
    // Re-authentication is required after any policy change. Active runs stay
    // tracked and clients can reconnect with a still-valid token.
    close()
  }

  return { handle, revokeToken, updateConfig, close }
}

async function createSession(
  body: Record<string, unknown>,
  token: AuthenticatedToken,
  options: ExternalApiRouterOptions,
  assertCurrent: () => void,
): Promise<{ id: string; agentPreset?: string }> {
  assertOnlyKeys(body, ['workspaceId', 'agentPreset'])
  const workspaceId = optionalString(body, 'workspaceId', { max: 200, trim: true })
  const agentPreset = optionalString(body, 'agentPreset', { max: 200, trim: true })
  if (workspaceId !== undefined && !isAllowed(token.allowedWorkspaceIds, workspaceId)) {
    throw new HttpError(403, 'WORKSPACE_FORBIDDEN', 'The token cannot use this workspace.')
  }
  if (agentPreset !== undefined && !isAllowed(token.allowedAgentPresets, agentPreset)) {
    throw new HttpError(403, 'AGENT_FORBIDDEN', 'The token cannot use this agent preset.')
  }
  const sessionId = `external-${randomUUID()}`
  assertCurrent()
  await options.ownership.claim(token.id, sessionId)
  try {
    assertCurrent()
    const value = await hostValue('session.create', options.host.sessions.create(rpc({
      sessionId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })))
    if (value.sessionId !== sessionId) throw new HttpError(502, 'HOST_PROTOCOL_ERROR', 'DSH returned an invalid session response.')
    assertCurrent()
    return { id: sessionId, ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }) }
  } catch (error) {
    await options.ownership.release(token.id, sessionId).catch(() => undefined)
    throw error
  }
}

async function startRun(
  sessionId: string,
  body: Record<string, unknown>,
  token: AuthenticatedToken,
  options: ExternalApiRouterOptions,
  config: ExternalApiConfig,
  assertCurrent: () => void,
): Promise<ExternalRunView> {
  const { input, clientTimeZone } = validateRunBody(body)

  assertCurrent()
  const sessions = await hostValue('session.list', options.host.sessions.list(rpc({})))
  const summary = (Array.isArray(sessions.items) ? sessions.items : [])
    .find(item => isRecord(item) && item.sessionId === sessionId)
  if (!isRecord(summary)) throw notFound()
  if (summary.running === true) throw new HttpError(409, 'SESSION_BUSY', 'The session is already running.')
  assertCurrent()
  // Recheck immediately before the synchronous registry claim. This closes
  // the race between concurrent requests while the host list call was pending.
  if (options.runs.activeCount(token.id) >= config.maxConcurrentRunsPerToken
    || options.runs.activeCount() >= config.maxConcurrentRunsGlobal) {
    throw new HttpError(429, 'RUN_LIMIT_REACHED', 'Too many runs are active.')
  }

  const promptRpcId = randomUUID()
  let run: ExternalRunView
  try {
    run = options.runs.create(token.id, sessionId, promptRpcId)
  } catch (error) {
    if (error instanceof RunConflictError) throw new HttpError(409, 'SESSION_BUSY', 'The session already has an active run.')
    throw error
  }
  try {
    assertCurrent()
    const accepted = await hostValue('session.prompt', options.host.sessions.prompt({
      rpcId: promptRpcId,
      payload: {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: input }],
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
      },
    }))
    if (accepted.accepted !== true) throw new HttpError(502, 'HOST_REJECTED', 'DSH did not accept the run.')
    assertCurrent()
    return options.runs.getOwned(token.id, run.id) ?? run
  } catch (error) {
    options.runs.fail(run.id)
    throw error
  }
}

function settleWithin(task: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref()
    void task.then(finish, finish)
  })
}

function validateRunBody(body: Record<string, unknown>): { input: string; clientTimeZone?: string } {
  assertOnlyKeys(body, ['input', 'clientTimeZone'])
  const input = optionalString(body, 'input', { max: MAX_PROMPT_CODE_UNITS })
  if (input === undefined) throw new HttpError(400, 'INVALID_BODY', 'input must be a string.')
  if (input.trim().length === 0) throw new HttpError(400, 'EMPTY_INPUT', 'input must not be empty.')
  if (input.trimStart().startsWith('/')) {
    throw new HttpError(400, 'SLASH_COMMAND_FORBIDDEN', 'Slash commands are not available through the external API.')
  }
  const clientTimeZone = optionalString(body, 'clientTimeZone', { max: 100, trim: true })
  return { input, ...(clientTimeZone === undefined ? {} : { clientTimeZone }) }
}

async function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  token: AuthenticatedToken,
  runId: string,
  options: ExternalApiRouterOptions,
  config: ExternalApiConfig,
  sseByToken: Map<string, Set<ServerResponse>>,
): Promise<void> {
  const active = sseByToken.get(token.id) ?? new Set<ServerResponse>()
  if (active.size >= config.maxSseConnectionsPerToken) {
    throw new HttpError(429, 'SSE_LIMIT_REACHED', 'Too many event streams are open for this token.')
  }
  const cursorHeader = singleHeader(request, 'last-event-id')
  const cursor = cursorHeader === undefined ? undefined : parseOptionalNonNegativeInt(cursorHeader, 'Last-Event-ID')
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let unsubscribe = (): void => {}
  const cleanup = () => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    unsubscribe()
    active.delete(response)
    if (active.size === 0) sseByToken.delete(token.id)
  }
  const write = (event: { id: number; type: string; data: Readonly<Record<string, unknown>> }) => {
    if (closed || response.destroyed) return
    const accepted = response.write(`id: ${String(event.id)}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    if (!accepted && response.writableLength > MAX_SSE_BUFFER_BYTES) {
      cleanup()
      response.destroy()
      return
    }
    if (event.type === 'run.completed' || event.type === 'run.cancelled' || event.type === 'run.failed') {
      queueMicrotask(() => {
        cleanup()
        if (!response.writableEnded) response.end()
      })
    }
  }
  const subscription = options.runs.subscribe(token.id, runId, cursor, write)
  if (subscription === undefined) throw notFound()

  applySecurityHeaders(response)
  applyCors(response, origin)
  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('connection', 'keep-alive')
  response.setHeader('x-accel-buffering', 'no')
  response.flushHeaders()
  active.add(response)
  sseByToken.set(token.id, active)
  unsubscribe = subscription.unsubscribe
  request.once('aborted', cleanup)
  response.once('close', cleanup)
  response.write('retry: 3000\n\n')
  for (const event of subscription.replay) write(event)
  if (subscription.terminal) {
    cleanup()
    response.end()
    return
  }
  heartbeat = setInterval(() => {
    if (!closed) response.write(': keep-alive\n\n')
  }, 15_000)
  heartbeat.unref()
}

function requiredOwnedSessionQuery(url: URL, token: AuthenticatedToken, ownership: OwnershipStore): string {
  assertOnlyQuery(url, ['sessionId'])
  const raw = url.searchParams.get('sessionId')
  if (raw === null) throw new HttpError(400, 'SESSION_ID_REQUIRED', 'sessionId is required.')
  const sessionId = parsePathIdentifier(raw)
  assertOwned(ownership, token, sessionId)
  return sessionId
}

function assertOwned(ownership: OwnershipStore, token: AuthenticatedToken, sessionId: string): void {
  // Cross-token and unknown sessions intentionally have the same response.
  if (!ownership.owns(token.id, sessionId)) throw notFound()
}

async function hostValue<T>(operation: string, promise: Promise<RpcResponseLike<T>>): Promise<T> {
  let response: RpcResponseLike<T>
  try {
    response = await promise
  } catch {
    throw new HttpError(502, 'HOST_UNAVAILABLE', 'DSH could not complete the request.')
  }
  if (response.result.ok) return response.result.value
  throw new HostCallError(response.result.error.code)
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof AuthenticationError) {
    if (error.code === 'AUTH_REQUIRED') return new HttpError(401, error.code, 'A bearer token is required.')
    if (error.code === 'AUTH_INVALID') return new HttpError(401, error.code, 'The bearer token is invalid.')
    if (error.code === 'SCOPE_REQUIRED') return new HttpError(403, error.code, 'The bearer token lacks the required scope.')
    return new HttpError(403, error.code, 'The request origin is not allowed for this token.')
  }
  if (error instanceof EventCursorError) {
    return new HttpError(error.code === 'EVENT_CURSOR_EXPIRED' ? 409 : 400, error.code, 'The event cursor cannot be resumed.')
  }
  if (error instanceof HostCallError) {
    switch (error.rpcCode) {
      case 'session-not-found': return notFound()
      case 'agent-busy': return new HttpError(409, 'SESSION_BUSY', 'The session is already running.')
      case 'workspace-not-found': return new HttpError(422, 'WORKSPACE_NOT_FOUND', 'The workspace does not exist.')
      case 'agent-preset-not-found': return new HttpError(422, 'AGENT_NOT_FOUND', 'The agent preset does not exist.')
      case 'agent-preset-invalid': return new HttpError(422, 'AGENT_INVALID', 'The agent preset cannot be used.')
      case 'invalid-time-zone': return new HttpError(400, 'INVALID_TIME_ZONE', 'clientTimeZone is invalid.')
      default: return new HttpError(502, 'HOST_REJECTED', 'DSH rejected the request.')
    }
  }
  return new HttpError(500, 'INTERNAL', 'The request could not be completed.')
}

function projectSessionSummary(item: unknown, owned: ReadonlySet<string>): Array<Record<string, unknown>> {
  if (!isRecord(item) || typeof item.sessionId !== 'string' || !owned.has(item.sessionId)) return []
  const values = isRecord(item.projections) && isRecord(item.projections.values) ? item.projections.values : undefined
  const title = typeof values?.title === 'string' ? values.title : undefined
  const agentPreset = typeof values?.agentPreset === 'string'
    ? values.agentPreset
    : typeof item.agentPreset === 'string' ? item.agentPreset : undefined
  return [{
    id: item.sessionId,
    updatedAt: typeof item.updatedAt === 'number' ? new Date(item.updatedAt).toISOString() : undefined,
    running: item.running === true,
    ...(title === undefined ? {} : { title }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }]
}

function projectModels(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { current: null, routable: false, providers: [] }
  const current = isRecord(value.current)
    && typeof value.current.provider === 'string'
    && typeof value.current.model === 'string'
    ? {
        provider: value.current.provider,
        model: value.current.model,
        ...(typeof value.current.reasoningEffort === 'string' ? { reasoningEffort: value.current.reasoningEffort } : {}),
      }
    : null
  const groups = Array.isArray(value.groups) ? value.groups : []
  return {
    current,
    routable: value.routable === true,
    providers: groups.flatMap((group) => {
      if (!isRecord(group) || typeof group.id !== 'string' || typeof group.name !== 'string' || !Array.isArray(group.models)) return []
      return [{
        id: group.id,
        name: group.name,
        models: group.models.flatMap(model => isRecord(model) && typeof model.id === 'string' && typeof model.name === 'string'
          ? [{ id: model.id, name: model.name, ...(typeof model.description === 'string' ? { description: model.description } : {}) }]
          : []),
      }]
    }),
  }
}

function rpc<T>(payload: T): { rpcId: string; payload: T } {
  return { rpcId: randomUUID(), payload }
}

function parseRequestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    throw new HttpError(400, 'INVALID_URL', 'The request URL is invalid.')
  }
}

function assertMethod(request: IncomingMessage, allowed: readonly string[]): void {
  if (!allowed.includes(request.method ?? 'GET')) throw methodNotAllowed(allowed)
}

function methodNotAllowed(allowed: readonly string[]): HttpError {
  return new HttpError(405, 'METHOD_NOT_ALLOWED', `Allowed methods: ${allowed.join(', ')}.`, {
    allow: allowed.join(', '),
  })
}

function notFound(): HttpError {
  return new HttpError(404, 'NOT_FOUND', 'The requested resource was not found.')
}

function assertNoQuery(url: URL): void {
  assertOnlyQuery(url, [])
}

function assertOnlyQuery(url: URL, allowed: readonly string[]): void {
  const allow = new Set(allowed)
  for (const key of url.searchParams.keys()) {
    if (!allow.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, 'INVALID_QUERY', 'The request query is invalid.')
    }
  }
}

function parseLimit(value: string | null): number {
  if (value === null) return 20
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_MESSAGES) {
    throw new HttpError(400, 'INVALID_QUERY', `limit must be between 1 and ${String(MAX_HISTORY_MESSAGES)}.`)
  }
  return parsed
}

function parseOptionalNonNegativeInt(value: string | null, name: string): number | undefined {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, 'INVALID_QUERY', `${name} must be a non-negative integer.`)
  }
  return parsed
}
