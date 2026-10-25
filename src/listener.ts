import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  EXTERNAL_API_BIND_HOST,
  LOOPBACK_HOST,
  type ExternalApiHost,
  type ExternalApiConfig,
  type ExternalApiLogger,
} from './contracts.ts'
import { projectMuxPayload, projectSessionEvent } from './event-projector.ts'
import { validateExternalApiConfig } from './config.ts'
import { OwnershipStore } from './ownership-store.ts'
import { createExternalApiHandler, type ExternalApiHandler } from './router.ts'
import { RunRegistry } from './run-registry.ts'

export type ExternalApiServerState = 'stopped' | 'starting' | 'running' | 'error'

export interface ExternalApiAddress {
  /** Actual socket bind address. The separately returned URL stays directly usable. */
  readonly host: typeof EXTERNAL_API_BIND_HOST
  readonly port: number
  readonly url: string
}

export interface ExternalApiServerOptions {
  readonly config: ExternalApiConfig
  readonly host: ExternalApiHost
  readonly ownership?: OwnershipStore
  readonly ownershipFile?: string
  readonly runs?: RunRegistry
  readonly logger?: ExternalApiLogger
  /** A controller-owned pump keeps event subscriptions alive across port changes. */
  readonly eventPump?: EventPump
}

export interface ExternalApiServer {
  readonly ownership: OwnershipStore
  readonly runs: RunRegistry
  readonly state: ExternalApiServerState
  readonly errorCode: string | undefined
  start(): Promise<ExternalApiAddress | undefined>
  stop(): Promise<void>
  address(): ExternalApiAddress | undefined
  updateConfig(config: ExternalApiConfig): void
  revokeToken(tokenId: string): Promise<void>
}

export function createExternalApiServer(options: ExternalApiServerOptions): ExternalApiServer {
  validateExternalApiConfig(options.config)
  const ownership = options.ownership ?? new OwnershipStore(options.ownershipFile)
  const runs = options.runs ?? new RunRegistry({ eventBufferSize: options.config.eventBufferSize })
  const logger = options.logger ?? silentLogger
  const ownsEventPump = options.eventPump === undefined
  let eventPump = options.eventPump ?? new EventPump(options.host, ownership, runs, logger)
  let server: Server | undefined
  let router: ExternalApiHandler | undefined
  let currentAddress: ExternalApiAddress | undefined
  let state: ExternalApiServerState = 'stopped'
  let errorCode: string | undefined
  const sockets = new Set<Socket>()

  return {
    ownership,
    runs,
    get state() { return state },
    get errorCode() { return errorCode },
    async start() {
      if (!options.config.enabled) return undefined
      if (state === 'running') return currentAddress
      if (state === 'starting') throw new Error('external API server is already starting')
      state = 'starting'
      errorCode = undefined
      try {
        await ownership.load()
        await ownership.retainTokens(new Set(options.config.tokens.map(token => token.id)))
        const httpServer = createServer((request, response) => {
          if (router === undefined) {
            response.statusCode = 503
            response.end()
            return
          }
          void router.handle(request, response)
        })
        server = httpServer
        httpServer.requestTimeout = 30_000
        httpServer.headersTimeout = 10_000
        httpServer.keepAliveTimeout = 5_000
        httpServer.maxHeadersCount = 50
        httpServer.maxConnections = 128
        httpServer.on('connection', (socket) => {
          sockets.add(socket)
          socket.once('close', () => sockets.delete(socket))
        })
        httpServer.on('clientError', (_error, socket) => {
          if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        })
        const port = await listen(httpServer, options.config.port)
        currentAddress = { host: EXTERNAL_API_BIND_HOST, port, url: `http://${LOOPBACK_HOST}:${String(port)}` }
        router = createExternalApiHandler({
          host: options.host,
          config: options.config,
          port,
          ownership,
          runs,
          logger,
        })
        state = 'running'
        eventPump.start()
        logger.info(`dsh-external-api: listening on ${EXTERNAL_API_BIND_HOST}:${String(port)}`)
        return currentAddress
      } catch (error) {
        errorCode = listenerErrorCode(error)
        state = 'error'
        router?.close()
        router = undefined
        if (ownsEventPump) {
          await eventPump.stop()
          eventPump = new EventPump(options.host, ownership, runs, logger)
        }
        if (server !== undefined) await closeServer(server, sockets)
        server = undefined
        currentAddress = undefined
        throw error
      }
    },
    async stop() {
      const current = server
      if (current === undefined) {
        state = 'stopped'
        errorCode = undefined
        return
      }
      router?.close()
      router = undefined
      if (ownsEventPump) {
        await eventPump.stop()
        eventPump = new EventPump(options.host, ownership, runs, logger)
      }
      await closeServer(current, sockets)
      if (server === current) server = undefined
      currentAddress = undefined
      state = 'stopped'
      errorCode = undefined
    },
    address() {
      return currentAddress
    },
    updateConfig(config) {
      router?.updateConfig(config)
    },
    async revokeToken(tokenId: string) {
      await router?.revokeToken(tokenId)
    },
  }
}

export class EventPump {
  readonly #controller = new AbortController()
  readonly #tasks: Promise<void>[] = []
  #started = false

  constructor(
    private readonly host: ExternalApiHost,
    private readonly ownership: OwnershipStore,
    private readonly runs: RunRegistry,
    private readonly logger: ExternalApiLogger,
  ) {}

  start(): void {
    if (this.#started) return
    this.#started = true
    this.#tasks.push(this.#muxLoop(), this.#hostLoop())
  }

  async stop(): Promise<void> {
    this.#controller.abort()
    await Promise.allSettled(this.#tasks)
  }

  async #muxLoop(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      try {
        const stream = this.host.events.mux(rpc({}), this.#controller.signal)
        for await (const message of stream) {
          if (this.#controller.signal.aborted) break
          const payload = message?.payload
          const projected = projectMuxPayload(payload)
          if (projected !== undefined) {
            if (this.ownership.ownerOf(projected.sessionId) === undefined) continue
            if (!this.runs.observeSessionEvent(projected.sessionId, projected.event)) continue
            for (const event of projectSessionEvent(projected.event)) {
              this.runs.appendForSession(projected.sessionId, event)
            }
            continue
          }
          if (isRecord(payload)
            && (payload.type === 'approval/requested' || payload.type === 'question/requested')
            && typeof payload.sessionId === 'string'
            && this.runs.isBoundActiveSession(payload.sessionId, payload.turn)) {
            // V1 deliberately exposes no approval/question response capability.
            // Cancel instead of leaving an externally-created run suspended.
            void this.host.sessions.cancel(rpc({ sessionId: payload.sessionId })).catch(() => undefined)
            this.runs.failActiveSession(payload.sessionId, 'INTERACTION_REQUIRED')
          }
          if (isRecord(payload) && payload.type === 'stream/error') {
            this.runs.failAllActive('EVENT_STREAM_ERROR')
          }
        }
      } catch {
        if (!this.#controller.signal.aborted) {
          this.runs.failAllActive('EVENT_STREAM_LOST')
          this.logger.warn('dsh-external-api: mux event stream disconnected; retrying')
        }
      }
      if (!this.#controller.signal.aborted) this.runs.failAllActive('EVENT_STREAM_LOST')
      await abortableDelay(250, this.#controller.signal)
    }
  }

  async #hostLoop(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      try {
        const stream = this.host.events.host(rpc({}), this.#controller.signal)
        for await (const message of stream) {
          if (this.#controller.signal.aborted) break
          const payload = message?.payload
          if (!isRecord(payload) || typeof payload.sessionId !== 'string') continue
          if (payload.type === 'host/agent-error' && this.runs.isBoundActiveSession(payload.sessionId, payload.turn)) {
            this.runs.failActiveSession(payload.sessionId, 'AGENT_FAILED')
          }
          if (payload.type === 'host/session-removed') {
            this.runs.failActiveSession(payload.sessionId, 'SESSION_REMOVED')
            await this.ownership.releaseSession(payload.sessionId).catch(() => {
              this.logger.warn('dsh-external-api: failed to persist removed-session ownership cleanup')
            })
          }
        }
      } catch {
        if (!this.#controller.signal.aborted) this.logger.warn('dsh-external-api: host event stream disconnected; retrying')
      }
      await abortableDelay(250, this.#controller.signal)
    }
  }
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: EXTERNAL_API_BIND_HOST, port, exclusive: true })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('external API listener has no TCP address')
  return address.port
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  if (!server.listening) {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    return
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeIdleConnections()
    for (const socket of sockets) socket.destroy()
  })
  sockets.clear()
}

function listenerErrorCode(error: unknown): string {
  if (isRecord(error) && error.code === 'EADDRINUSE') return 'PORT_IN_USE'
  if (isRecord(error) && error.code === 'EACCES') return 'PORT_FORBIDDEN'
  return 'LISTENER_FAILED'
}

function rpc<T>(payload: T): { rpcId: string; payload: T } {
  return { rpcId: randomUUID(), payload }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    timer.unref()
    signal.addEventListener('abort', finish, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const silentLogger: ExternalApiLogger = {
  info() {},
  warn() {},
  error() {},
}
