import type { ProjectedRunEvent } from './contracts.ts'

export interface ProjectedEventInput {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface ProjectedMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly createdAt: string
  readonly seq: number
  readonly interrupted?: boolean
  readonly toolName?: string
  readonly outcome?: 'ok' | 'error'
}

/**
 * Projects the raw mux event into a deliberately small, stable vocabulary.
 * Tool arguments/results, system prompts, reasoning, private metadata and
 * arbitrary plugin events have no projection and therefore cannot cross the API.
 */
export function projectSessionEvent(event: unknown): ProjectedEventInput[] {
  if (!isRecord(event) || typeof event.type !== 'string' || !isRecord(event.data)) return []
  switch (event.type) {
    case 'turn/start':
      return [{ type: 'run.started', data: {} }]
    case 'turn/end': {
      const reason = isRecord(event.data.reason) && typeof event.data.reason.kind === 'string'
        ? event.data.reason.kind
        : 'failed'
      if (reason === 'completed') return [{ type: 'run.completed', data: { finishReason: 'completed' } }]
      if (reason === 'aborted' || reason === 'interrupted') {
        return [{ type: 'run.cancelled', data: { finishReason: 'cancelled' } }]
      }
      if (reason === 'max-tokens') return [{ type: 'run.completed', data: { finishReason: 'max_tokens' } }]
      return [{ type: 'run.failed', data: { code: 'RUN_FAILED', message: 'The run did not complete.' } }]
    }
    case 'assistant/chunk': {
      const chunk = isRecord(event.data.chunk) ? event.data.chunk : undefined
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text.length === 0) return []
      return [{ type: 'message.delta', data: { delta: chunk.text } }]
    }
    case 'assistant/message': {
      const message = isRecord(event.data.message) ? event.data.message : undefined
      const text = visibleText(message?.content)
      if (text === '') return []
      return [{
        type: 'message.completed',
        data: {
          role: 'assistant',
          content: text,
          ...(event.data.interrupted === true ? { interrupted: true } : {}),
        },
      }]
    }
    case 'tool/call': {
      const name = safeToolName(event.data.name)
      return name === undefined ? [] : [{ type: 'tool.started', data: { name } }]
    }
    case 'tool/result': {
      const message = isRecord(event.data.message) ? event.data.message : undefined
      const name = safeToolName(message?.name)
      if (name === undefined) return []
      return [{ type: 'tool.completed', data: { name, outcome: event.data.error === undefined ? 'ok' : 'error' } }]
    }
    default:
      return []
  }
}

export function projectHistoryEvent(event: unknown): ProjectedMessage | undefined {
  if (!isRecord(event)
    || typeof event.type !== 'string'
    || typeof event.seq !== 'number'
    || !Number.isSafeInteger(event.seq)
    || typeof event.time !== 'number'
    || !Number.isFinite(event.time)
    || !isRecord(event.data)) return undefined
  const timestamp = new Date(event.time)
  if (!Number.isFinite(timestamp.getTime())) return undefined
  const base = { id: `message-${String(event.seq)}`, createdAt: timestamp.toISOString(), seq: event.seq }
  if (event.type === 'user/message') {
    const source = isRecord(event.data.source) ? event.data.source : undefined
    if (source?.kind !== 'user') return undefined
    const content = visibleText(event.data.content)
    return content === '' ? undefined : { ...base, role: 'user', content }
  }
  if (event.type === 'assistant/message') {
    const message = isRecord(event.data.message) ? event.data.message : undefined
    const content = visibleText(message?.content)
    return content === '' ? undefined : {
      ...base,
      role: 'assistant',
      content,
      ...(event.data.interrupted === true ? { interrupted: true } : {}),
    }
  }
  if (event.type === 'tool/result') {
    const message = isRecord(event.data.message) ? event.data.message : undefined
    const toolName = safeToolName(message?.name)
    if (toolName === undefined) return undefined
    return {
      ...base,
      role: 'tool',
      content: '',
      toolName,
      outcome: event.data.error === undefined ? 'ok' : 'error',
    }
  }
  return undefined
}

export function projectMuxPayload(payload: unknown): { sessionId: string; event: unknown } | undefined {
  if (!isRecord(payload)
    || payload.type !== 'session/event'
    || typeof payload.sessionId !== 'string'
    || payload.sessionId.length === 0) return undefined
  return { sessionId: payload.sessionId, event: payload.event }
}

export function projectedEventHasForbiddenData(event: ProjectedRunEvent): boolean {
  return hasForbiddenKey(event)
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replaceAll('_', '')
    return normalized === 'arguments'
      || normalized === 'args'
      || normalized === 'result'
      || normalized === 'output'
      || normalized === 'systemprompt'
      || normalized === 'reasoning'
      || normalized === 'apikey'
      || normalized === 'token'
      || normalized === 'secret'
      || normalized === 'password'
      || hasForbiddenKey(child)
  })
}

function visibleText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => (block as { text: string }).text)
    .join('')
}

function safeToolName(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/u.test(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
