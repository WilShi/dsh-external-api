import type {
  ExternalApiHost,
  ExternalApiConfig,
  ExternalApiLogger,
} from './contracts.ts'
import { EXTERNAL_API_BIND_HOST } from './contracts.ts'
import { validateExternalApiConfig } from './config.ts'
import { createExternalApiServer, EventPump, type ExternalApiServer, type ExternalApiServerState } from './listener.ts'
import { OwnershipStore } from './ownership-store.ts'
import { RunRegistry } from './run-registry.ts'

export interface ExternalApiRuntimeStatus {
  readonly state: ExternalApiServerState
  readonly host: typeof EXTERNAL_API_BIND_HOST
  readonly port: number
  readonly url?: string
  readonly error?: string
}

export class ExternalApiController {
  readonly ownership: OwnershipStore
  readonly runs: RunRegistry
  readonly #host: ExternalApiHost
  readonly #logger: ExternalApiLogger
  #eventPump: EventPump | undefined
  #config: ExternalApiConfig
  #server: ExternalApiServer | undefined
  #desiredFingerprint = ''
  #queue: Promise<void> = Promise.resolve()
  #runtime: ExternalApiRuntimeStatus

  constructor(options: {
    host: ExternalApiHost
    config: ExternalApiConfig
    ownershipFile: string
    logger: ExternalApiLogger
  }) {
    validateExternalApiConfig(options.config)
    this.#host = options.host
    this.#config = options.config
    this.#logger = options.logger
    this.ownership = new OwnershipStore(options.ownershipFile)
    this.runs = new RunRegistry({ eventBufferSize: options.config.eventBufferSize })
    this.#runtime = { state: 'stopped', host: EXTERNAL_API_BIND_HOST, port: options.config.port }
  }

  get config(): ExternalApiConfig {
    return this.#config
  }

  status(): ExternalApiRuntimeStatus {
    return { ...this.#runtime }
  }

  configure(config: ExternalApiConfig): Promise<void> {
    validateExternalApiConfig(config)
    const snapshot = structuredClone(config)
    const fingerprint = JSON.stringify(snapshot)
    if (fingerprint === this.#desiredFingerprint && this.#runtime.state !== 'error') return this.#queue
    this.#desiredFingerprint = fingerprint
    this.#queue = this.#queue.catch(() => undefined).then(async () => {
      const previousConfig = this.#config
      const previousServer = this.#server
      const previousAddress = previousServer?.address()
      const removedTokenIds = previousConfig.tokens
        .filter(token => !snapshot.tokens.some(next => next.id === token.id))
        .map(token => token.id)

      if (previousServer !== undefined && previousAddress !== undefined) {
        previousServer.updateConfig(snapshot)
        const revokedTokenIds = new Set([
          ...removedTokenIds,
          ...(!snapshot.enabled ? previousConfig.tokens.map(token => token.id) : []),
        ])
        const revocations = [...revokedTokenIds].map(tokenId => previousServer.revokeToken(tokenId))
        await this.ownership.load()
        await Promise.allSettled([
          ...revocations,
          this.ownership.retainTokens(new Set(snapshot.tokens.map(token => token.id))),
        ])
        if (!snapshot.enabled) {
          await previousServer.stop()
          await this.#stopEventPump()
          this.#server = undefined
          this.#config = snapshot
          this.#runtime = { state: 'stopped', host: EXTERNAL_API_BIND_HOST, port: snapshot.port }
          return
        }
        if (previousAddress.port === snapshot.port) {
          this.#config = snapshot
          this.#runtime = { state: 'running', ...previousAddress }
          return
        }

        const candidate = createExternalApiServer({
          config: snapshot,
          host: this.#host,
          ownership: this.ownership,
          runs: this.runs,
          logger: this.#logger,
          eventPump: this.#ensureEventPump(),
        })
        try {
          const address = await candidate.start()
          if (address === undefined) throw new Error('candidate listener did not start')
          await previousServer.stop()
          this.#server = candidate
          this.#config = snapshot
          this.#runtime = { state: 'running', ...address }
        } catch {
          const candidateError = candidate.errorCode ?? 'LISTENER_FAILED'
          await candidate.stop().catch(() => undefined)
          this.#server = previousServer
          this.#config = snapshot
          this.#desiredFingerprint = ''
          this.#runtime = {
            state: 'running',
            ...previousAddress,
            error: candidateError,
          }
          this.#logger.error(`dsh-external-api: replacement listener failed (${candidateError})`)
        }
        return
      }

      await this.ownership.load()
      await this.ownership.retainTokens(new Set(snapshot.tokens.map(token => token.id)))
      await previousServer?.stop()
      this.#server = undefined
      this.#config = snapshot
      this.#runtime = { state: snapshot.enabled ? 'starting' : 'stopped', host: EXTERNAL_API_BIND_HOST, port: snapshot.port }
      if (!snapshot.enabled) {
        await this.#stopEventPump()
        return
      }
      const server = createExternalApiServer({
        config: snapshot,
        host: this.#host,
        ownership: this.ownership,
        runs: this.runs,
        logger: this.#logger,
        eventPump: this.#ensureEventPump(),
      })
      this.#server = server
      try {
        const address = await server.start()
        this.#runtime = address === undefined
          ? { state: 'stopped', host: EXTERNAL_API_BIND_HOST, port: snapshot.port }
          : { state: 'running', ...address }
      } catch {
        this.#desiredFingerprint = ''
        await this.#stopEventPump()
        this.#runtime = {
          state: 'error',
          host: EXTERNAL_API_BIND_HOST,
          port: snapshot.port,
          error: server.errorCode ?? 'LISTENER_FAILED',
        }
        this.#logger.error(`dsh-external-api: listener failed (${server.errorCode ?? 'LISTENER_FAILED'})`)
      }
    })
    return this.#queue
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.#server?.revokeToken(tokenId)
    await this.ownership.load()
    await this.ownership.revokeToken(tokenId)
  }

  async stop(): Promise<void> {
    await this.#queue.catch(() => undefined)
    try {
      await this.#server?.stop()
    } finally {
      await this.#stopEventPump()
      this.#server = undefined
      this.#runtime = { state: 'stopped', host: EXTERNAL_API_BIND_HOST, port: this.#config.port }
    }
  }

  #ensureEventPump(): EventPump {
    this.#eventPump ??= new EventPump(this.#host, this.ownership, this.runs, this.#logger)
    return this.#eventPump
  }

  async #stopEventPump(): Promise<void> {
    const pump = this.#eventPump
    this.#eventPump = undefined
    await pump?.stop()
  }
}
