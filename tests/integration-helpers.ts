import type { AddressInfo } from 'node:net'
import {
  createServer as createHttpServer,
  request as nodeHttpRequest,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { vi } from 'vitest'
import { issueBearerToken, type IssuedToken } from '../src/auth.js'
import { EXTERNAL_API_BIND_HOST, type ExternalApiHost, type ExternalApiConfig, type ExternalApiTokenRecord } from '../src/contracts.js'
import { createExternalApiServer, type ExternalApiServer } from '../src/listener.js'

export function rpcOk<T>(request: { rpcId: string }, value: T) {
  return { rpcId: request.rpcId, result: { ok: true as const, value } }
}

export function rpcFailure(request: { rpcId: string }, code: string, message = 'private host detail') {
  return { rpcId: request.rpcId, result: { ok: false as const, error: { code, message, details: {} } } }
}

interface AsyncQueue<T> {
  readonly items: T[]
  wake: (() => void) | undefined
  closed: boolean
}

/** A broadcast async iterable whose subscribers settle immediately on abort. */
export class EventChannel<T> {
  readonly #queues = new Set<AsyncQueue<T>>()
  streamCount = 0

  stream(signal: AbortSignal): AsyncIterable<T> {
    const owner = this
    return {
      async *[Symbol.asyncIterator]() {
        owner.streamCount += 1
        const queue: AsyncQueue<T> = { items: [], wake: undefined, closed: false }
        owner.#queues.add(queue)
        const close = () => {
          queue.closed = true
          queue.wake?.()
        }
        signal.addEventListener('abort', close, { once: true })
        try {
          while (!queue.closed) {
            if (queue.items.length === 0) {
              await new Promise<void>(resolve => { queue.wake = resolve })
              queue.wake = undefined
            }
            while (queue.items.length > 0) yield queue.items.shift() as T
          }
        } finally {
          signal.removeEventListener('abort', close)
          owner.#queues.delete(queue)
        }
      },
    }
  }

  emit(value: T): void {
    for (const queue of this.#queues) {
      queue.items.push(value)
      queue.wake?.()
    }
  }
}

export interface FakeApiState {
  readonly sessions: Map<string, Record<string, unknown>>
  readonly histories: Map<string, unknown[]>
  readonly models: Map<string, unknown>
  workspaces: unknown[]
  agents: unknown[]
  skills: unknown[]
}

export function createFakeHost() {
  const mux = new EventChannel<{ rpcId: string; payload: unknown }>()
  const host = new EventChannel<{ rpcId: string; payload: unknown }>()
  const state: FakeApiState = {
    sessions: new Map(),
    histories: new Map(),
    models: new Map(),
    workspaces: [],
    agents: [],
    skills: [],
  }
  const list = vi.fn(async (request: { rpcId: string }) => rpcOk(request, { items: [...state.sessions.values()] }))
  const create = vi.fn(async (request: { rpcId: string; payload: Record<string, unknown> }) => {
    const sessionId = String(request.payload.sessionId)
    state.sessions.set(sessionId, {
      sessionId,
      updatedAt: Date.parse('2026-09-08T00:00:00.000Z'),
      running: false,
      blank: true,
      ...(typeof request.payload.agentPreset === 'string' ? { agentPreset: request.payload.agentPreset } : {}),
    })
    return rpcOk(request, {
      sessionId,
      ...(typeof request.payload.agentPreset === 'string' ? { agentPreset: request.payload.agentPreset } : {}),
    })
  })
  const history = vi.fn(async (request: { rpcId: string; payload: { sessionId: string } }) => rpcOk(request, {
    events: (state.histories.get(request.payload.sessionId) ?? []).map(event => ({ event })),
    hasMore: false,
  }))
  const models = vi.fn(async (request: { rpcId: string; payload: { sessionId: string } }) => rpcOk(request,
    state.models.get(request.payload.sessionId) ?? { current: null, routable: false, groups: [], failures: [] }))
  const prompt = vi.fn(async (request: { rpcId: string }) => rpcOk(request, { accepted: true as const }))
  const cancel = vi.fn(async (request: { rpcId: string }) => rpcOk(request, { accepted: true as const }))
  const workspaceList = vi.fn(async (request: { rpcId: string }) => rpcOk(request, {
    items: state.workspaces,
    archivedSessionIds: [],
  }))
  const agentList = vi.fn(async (request: { rpcId: string }) => rpcOk(request, {
    presets: state.agents,
    authorable: false,
    hasDocument: false,
  }))
  const skillList = vi.fn(async (request: { rpcId: string }) => rpcOk(request, { skills: state.skills }))
  const muxStream = vi.fn((_request: unknown, signal: AbortSignal) => mux.stream(signal))
  const hostStream = vi.fn((_request: unknown, signal: AbortSignal) => host.stream(signal))
  const hostApi = {
    sessions: { list, create, history, models, prompt, cancel },
    workspace: { list: workspaceList },
    agentPresets: { list: agentList },
    skills: { list: skillList },
    events: { mux: muxStream, host: hostStream },
  } as unknown as ExternalApiHost

  return {
    hostApi,
    state,
    mux,
    host,
    calls: { list, create, history, models, prompt, cancel, workspaceList, agentList, skillList, muxStream, hostStream },
  }
}

export function externalConfig(
  tokens: readonly ExternalApiTokenRecord[],
  overrides: Partial<ExternalApiConfig> = {},
): ExternalApiConfig {
  return {
    enabled: true,
    port: 0,
    allowedOrigins: [],
    requestBodyLimitBytes: 256 * 1024,
    rateLimitPerMinute: 10_000,
    maxSseConnectionsPerToken: 4,
    maxConcurrentRunsPerToken: 2,
    maxConcurrentRunsGlobal: 4,
    eventBufferSize: 256,
    tokens: [...tokens],
    ...overrides,
  }
}

export interface StartedHarness {
  readonly server: ExternalApiServer
  readonly baseUrl: string
  readonly token: IssuedToken
  readonly fake: ReturnType<typeof createFakeHost>
}

export async function startHarness(options: {
  token?: IssuedToken
  tokens?: readonly ExternalApiTokenRecord[]
  config?: Partial<ExternalApiConfig>
  ownershipFile?: string
  fake?: ReturnType<typeof createFakeHost>
  logger?: { info(message: string): void; warn(message: string): void; error(message: string): void }
} = {}): Promise<StartedHarness> {
  const token = options.token ?? issueBearerToken('test caller')
  const fake = options.fake ?? createFakeHost()
  const server = createExternalApiServer({
    config: externalConfig(options.tokens ?? [token.record], options.config),
    host: fake.hostApi,
    ...(options.ownershipFile === undefined ? {} : { ownershipFile: options.ownershipFile }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  const address = await server.start()
  if (address === undefined) throw new Error('test server did not start')
  return { server, baseUrl: address.url, token, fake }
}

export async function jsonRequest(
  harness: Pick<StartedHarness, 'baseUrl' | 'token'>,
  path: string,
  options: {
    method?: string
    token?: string | null
    headers?: Headers | Record<string, string> | Array<[string, string]>
    body?: unknown
    rawBody?: string
  } = {},
): Promise<{ response: Response; body: any; text: string }> {
  const headers = new Headers(options.headers)
  if (options.token !== null) headers.set('authorization', `Bearer ${options.token ?? harness.token.secret}`)
  let body: string | undefined
  if (options.rawBody !== undefined) body = options.rawBody
  else if (options.body !== undefined) body = JSON.stringify(options.body)
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  })
  const text = await response.text()
  let parsed: unknown
  try { parsed = text === '' ? undefined : JSON.parse(text) } catch { parsed = undefined }
  return { response, body: parsed, text }
}

export async function rawHttpRequest(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string; body: any }> {
  const url = new URL(path, baseUrl)
  return new Promise((resolve, reject) => {
    const request = nodeHttpRequest(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown
        try { body = text === '' ? undefined : JSON.parse(text) } catch { body = undefined }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, body })
      })
    })
    request.once('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await delay(5)
  }
}

export async function occupyExternalApiPort(): Promise<{ server: HttpServer; port: number }> {
  const server = createHttpServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: EXTERNAL_API_BIND_HOST, port: 0, exclusive: true }, () => resolve())
  })
  return { server, port: (server.address() as AddressInfo).port }
}

export async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

export function muxFrame(payload: unknown): { rpcId: string; payload: unknown } {
  return { rpcId: 'mux-frame', payload }
}
