import { randomUUID } from 'node:crypto'
import type {
  ExternalRunStatus,
  ExternalRunView,
  ProjectedRunEvent,
} from './contracts.ts'
import type { ProjectedEventInput } from './event-projector.ts'

interface RunRecord extends ExternalRunView {
  readonly tokenId: string
  /** RPC id minted for the exact session.prompt call represented by this run. */
  readonly promptRpcId?: string
  /** Most recent unbound turn/start observed while waiting for the user message. */
  candidateTurn?: number
  /** Turn proven to contain the user/message carrying promptRpcId. */
  boundTurn?: number
  status: ExternalRunStatus
  startedAt?: string
  completedAt?: string
  finishReason?: 'completed' | 'cancelled' | 'max_tokens' | 'failed'
  error?: { readonly code: string; readonly message: string }
  nextEventId: number
  readonly events: ProjectedRunEvent[]
  readonly subscribers: Set<(event: ProjectedRunEvent) => void>
  terminalRetained: boolean
}

export class RunConflictError extends Error {
  constructor(readonly activeRunId: string) {
    super('the session already has an active external run')
    this.name = 'RunConflictError'
  }
}

export class EventCursorError extends Error {
  readonly code: 'EVENT_CURSOR_INVALID' | 'EVENT_CURSOR_EXPIRED'

  constructor(code: EventCursorError['code']) {
    super(code)
    this.name = 'EventCursorError'
    this.code = code
  }
}

export interface RunRegistryOptions {
  readonly eventBufferSize?: number
  readonly maxTerminalRuns?: number
  readonly now?: () => Date
  readonly idFactory?: () => string
}

export interface RunSubscription {
  readonly replay: readonly ProjectedRunEvent[]
  readonly terminal: boolean
  readonly unsubscribe: () => void
}

export class RunRegistry {
  readonly #runs = new Map<string, RunRecord>()
  readonly #activeBySession = new Map<string, string>()
  readonly #eventBufferSize: number
  readonly #maxTerminalRuns: number
  readonly #terminalRuns: string[] = []
  readonly #now: () => Date
  readonly #idFactory: () => string

  constructor(options: RunRegistryOptions = {}) {
    this.#eventBufferSize = options.eventBufferSize ?? 256
    this.#maxTerminalRuns = options.maxTerminalRuns ?? 512
    this.#now = options.now ?? (() => new Date())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  create(tokenId: string, sessionId: string, promptRpcId?: string): ExternalRunView {
    const active = this.#activeBySession.get(sessionId)
    if (active !== undefined) throw new RunConflictError(active)
    const id = this.#idFactory()
    const record: RunRecord = {
      id,
      tokenId,
      sessionId,
      ...(promptRpcId === undefined ? {} : { promptRpcId }),
      status: 'queued',
      createdAt: this.#now().toISOString(),
      nextEventId: 1,
      events: [],
      subscribers: new Set(),
      terminalRetained: false,
    }
    this.#runs.set(id, record)
    this.#activeBySession.set(sessionId, id)
    this.#append(record, { type: 'run.queued', data: {} })
    return view(record)
  }

  getOwned(tokenId: string, runId: string): ExternalRunView | undefined {
    const record = this.#runs.get(runId)
    return record?.tokenId === tokenId ? view(record) : undefined
  }

  activeForSession(sessionId: string): ExternalRunView | undefined {
    const id = this.#activeBySession.get(sessionId)
    const record = id === undefined ? undefined : this.#runs.get(id)
    return record === undefined ? undefined : view(record)
  }

  isBoundActiveSession(sessionId: string, turn?: unknown): boolean {
    const id = this.#activeBySession.get(sessionId)
    const record = id === undefined ? undefined : this.#runs.get(id)
    if (record?.boundTurn === undefined) return false
    return turn === undefined || turn === record.boundTurn
  }

  activeRunsForToken(tokenId: string): readonly ExternalRunView[] {
    const runs: ExternalRunView[] = []
    for (const run of this.#runs.values()) {
      if (run.tokenId === tokenId && !isTerminal(run.status)) runs.push(view(run))
    }
    return runs
  }

  activeCount(tokenId?: string): number {
    if (tokenId === undefined) return this.#activeBySession.size
    return this.activeRunsForToken(tokenId).length
  }

  failAllActive(code = 'EVENT_STREAM_LOST'): void {
    for (const runId of [...this.#activeBySession.values()]) {
      this.fail(runId, code, 'Run status could not be observed safely.')
    }
  }

  appendForSession(sessionId: string, input: ProjectedEventInput): void {
    const id = this.#activeBySession.get(sessionId)
    if (id === undefined) return
    const record = this.#runs.get(id)
    if (record === undefined) return
    if (input.type === 'run.started' && record.status === 'queued') {
      record.status = 'running'
      record.startedAt = this.#now().toISOString()
    } else if (input.type === 'run.completed') {
      this.#settle(record, 'completed', input.data.finishReason === 'max_tokens' ? 'max_tokens' : 'completed')
    } else if (input.type === 'run.cancelled') {
      this.#settle(record, 'cancelled', 'cancelled')
    } else if (input.type === 'run.failed') {
      record.error = { code: 'RUN_FAILED', message: 'The run did not complete.' }
      this.#settle(record, 'failed', 'failed')
    }
    this.#append(record, input)
  }

  /**
   * Admit a raw session event only after proving it belongs to this run's
   * prompt RPC and turn. turn/start merely records a candidate; the binding
   * happens on the following user/message whose source.rpcId matches.
   */
  observeSessionEvent(sessionId: string, event: unknown): boolean {
    const id = this.#activeBySession.get(sessionId)
    const record = id === undefined ? undefined : this.#runs.get(id)
    if (record === undefined || !isEventRecord(event)) return false
    if (event.type === 'turn/start') {
      if (record.boundTurn === undefined && isRecord(event.data) && isTurn(event.data.turn)) {
        record.candidateTurn = event.data.turn
      }
      return false
    }
    if (event.type === 'user/message') {
      if (record.boundTurn !== undefined || record.promptRpcId === undefined || record.candidateTurn === undefined) return false
      const source = isRecord(event.data) && isRecord(event.data.source) ? event.data.source : undefined
      if (source?.rpcId !== record.promptRpcId) return false
      record.boundTurn = record.candidateTurn
      delete record.candidateTurn
      this.appendForSession(sessionId, { type: 'run.started', data: {} })
      return false
    }
    if (record.boundTurn === undefined || !isRecord(event.data) || event.data.turn !== record.boundTurn) return false
    return true
  }

  requestCancel(tokenId: string, runId: string): ExternalRunView | undefined {
    const record = this.#runs.get(runId)
    if (record === undefined || record.tokenId !== tokenId || isTerminal(record.status)) return undefined
    if (this.#activeBySession.get(record.sessionId) !== runId) return undefined
    if (record.status !== 'cancelling') {
      record.status = 'cancelling'
      this.#append(record, { type: 'run.cancelling', data: {} })
    }
    return view(record)
  }

  fail(runId: string, code = 'RUN_REJECTED', message = 'The run could not be started.'): void {
    const record = this.#runs.get(runId)
    if (record === undefined || isTerminal(record.status)) return
    record.error = { code, message }
    this.#settle(record, 'failed', 'failed')
    this.#append(record, { type: 'run.failed', data: record.error })
  }

  failActiveSession(sessionId: string, code = 'RUN_FAILED'): void {
    const id = this.#activeBySession.get(sessionId)
    if (id !== undefined) this.fail(id, code, 'The run did not complete.')
  }

  subscribe(
    tokenId: string,
    runId: string,
    afterEventId: number | undefined,
    listener: (event: ProjectedRunEvent) => void,
  ): RunSubscription | undefined {
    const record = this.#runs.get(runId)
    if (record === undefined || record.tokenId !== tokenId) return undefined
    const last = record.nextEventId - 1
    if (afterEventId !== undefined) {
      if (!Number.isSafeInteger(afterEventId) || afterEventId < 0 || afterEventId > last) {
        throw new EventCursorError('EVENT_CURSOR_INVALID')
      }
      const first = record.events[0]?.id ?? record.nextEventId
      if (afterEventId < first - 1) throw new EventCursorError('EVENT_CURSOR_EXPIRED')
    }
    const replay = record.events.filter(event => event.id > (afterEventId ?? 0))
    const terminal = isTerminal(record.status)
    if (!terminal) record.subscribers.add(listener)
    return {
      replay,
      terminal,
      unsubscribe: () => { record.subscribers.delete(listener) },
    }
  }

  #settle(record: RunRecord, status: Extract<ExternalRunStatus, 'completed' | 'cancelled' | 'failed'>, finishReason: NonNullable<ExternalRunView['finishReason']>): void {
    record.status = status
    record.finishReason = finishReason
    record.completedAt = this.#now().toISOString()
    if (this.#activeBySession.get(record.sessionId) === record.id) this.#activeBySession.delete(record.sessionId)
  }

  #append(record: RunRecord, input: ProjectedEventInput): void {
    const event: ProjectedRunEvent = {
      id: record.nextEventId++,
      type: input.type,
      createdAt: this.#now().toISOString(),
      data: { ...input.data },
    }
    record.events.push(event)
    if (record.events.length > this.#eventBufferSize) record.events.splice(0, record.events.length - this.#eventBufferSize)
    for (const subscriber of record.subscribers) subscriber(event)
    if (isTerminal(record.status)) {
      record.subscribers.clear()
      if (!record.terminalRetained) {
        record.terminalRetained = true
        this.#terminalRuns.push(record.id)
        while (this.#terminalRuns.length > this.#maxTerminalRuns) {
          const expired = this.#terminalRuns.shift()
          if (expired !== undefined) this.#runs.delete(expired)
        }
      }
    }
  }
}

function view(record: RunRecord): ExternalRunView {
  return {
    id: record.id,
    sessionId: record.sessionId,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.finishReason === undefined ? {} : { finishReason: record.finishReason }),
    ...(record.error === undefined ? {} : { error: { ...record.error } }),
  }
}

export function isTerminal(status: ExternalRunStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}

function isEventRecord(value: unknown): value is { type: string; data: unknown } {
  return isRecord(value) && typeof value.type === 'string' && 'data' in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTurn(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
