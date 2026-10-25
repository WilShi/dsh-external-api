import type { IncomingMessage, ServerResponse } from 'node:http'

export const EXTERNAL_API_PREFIX = '/api/v1'
export const ADMIN_API_PREFIX = '/external-api-admin'
export const LOOPBACK_HOST = '127.0.0.1'
/** IPv4 wildcard used only by the opt-in external listener, never by the DSH management server. */
export const EXTERNAL_API_BIND_HOST = '0.0.0.0'

export type ExternalApiScope =
  | 'capabilities:read'
  | 'sessions:read'
  | 'sessions:write'
  | 'runs:read'
  | 'runs:write'

export const ALL_EXTERNAL_API_SCOPES: readonly ExternalApiScope[] = [
  'capabilities:read',
  'sessions:read',
  'sessions:write',
  'runs:read',
  'runs:write',
]

export interface ExternalApiTokenRecord {
  readonly id: string
  readonly name: string
  /** SHA-256 of the bearer secret, encoded as 64 lowercase hexadecimal chars. */
  readonly digest: string
  /** Non-secret display fragment. It is never accepted for authentication. */
  readonly prefix: string
  readonly scopes: ExternalApiScope[]
  /** `*` permits every registered workspace; raw filesystem paths remain forbidden. */
  readonly allowedWorkspaceIds: string[]
  /** `*` permits every healthy agent preset. */
  readonly allowedAgentPresets: string[]
  /** Empty means inherit the server-level origin allowlist. */
  readonly allowedOrigins: string[]
  readonly createdAt: string
}

export interface ExternalApiConfig {
  readonly enabled: boolean
  readonly port: number
  readonly allowedOrigins: string[]
  readonly requestBodyLimitBytes: number
  readonly rateLimitPerMinute: number
  readonly maxSseConnectionsPerToken: number
  readonly maxConcurrentRunsPerToken: number
  readonly maxConcurrentRunsGlobal: number
  readonly eventBufferSize: number
  readonly tokens: ExternalApiTokenRecord[]
}

export interface RpcErrorLike {
  readonly code: string
  readonly message?: string
  readonly details?: unknown
}

export type RpcResponseLike<T> = {
  readonly rpcId: string
  readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcErrorLike }
}

/**
 * Small host-facing port consumed by the external API.
 *
 * The request/response envelopes are private to this package.  They preserve
 * request correlation for the run registry while keeping the HTTP layer
 * independent from the Harness transport implementation.  Production binds
 * this port to the rc.2 Host controllers; tests provide an in-memory adapter.
 */
export interface ExternalApiHost {
  readonly sessions: {
    list(request: RpcRequestLike<{ cursor?: string }>): Promise<RpcResponseLike<{ items: readonly unknown[] }>>
    create(request: RpcRequestLike<{ workspaceId?: string; sessionId?: string; agentPreset?: string }>): Promise<RpcResponseLike<{ sessionId: string; agentPreset?: string }>>
    history(request: RpcRequestLike<{ sessionId: string; beforeSeq?: number; maxMessages?: number }>): Promise<RpcResponseLike<{ events: ReadonlyArray<{ event: unknown }>; hasMore: boolean }>>
    models(request: RpcRequestLike<{ sessionId: string }>): Promise<RpcResponseLike<unknown>>
    prompt(request: RpcRequestLike<{
      sessionId: string
      mode: 'queue' | 'steer'
      content: Array<{ type: 'text'; text: string }>
      clientTimeZone?: string
    }>): Promise<RpcResponseLike<{ accepted: true }>>
    cancel(request: RpcRequestLike<{ sessionId: string }>): Promise<RpcResponseLike<{ accepted: true }>>
  }
  readonly workspace: {
    list(request: RpcRequestLike<Record<string, never>>): Promise<RpcResponseLike<{ items: readonly unknown[]; archivedSessionIds: readonly string[] }>>
  }
  readonly agentPresets: {
    list(request: RpcRequestLike<Record<string, never>>): Promise<RpcResponseLike<{ presets: readonly unknown[]; authorable: boolean; hasDocument: boolean }>>
  }
  readonly skills: {
    list(request: RpcRequestLike<{ sessionId: string }>): Promise<RpcResponseLike<{ skills: readonly unknown[] }>>
  }
  readonly events: {
    mux(request: RpcRequestLike<{ since?: Record<string, number> }>, signal: AbortSignal): AsyncIterable<RpcRequestLike<unknown>>
    host(request: RpcRequestLike<Record<string, never>>, signal: AbortSignal): AsyncIterable<RpcRequestLike<unknown>>
  }
}

export interface RpcRequestLike<T> {
  readonly rpcId: string
  readonly payload: T
}

export interface ExternalApiLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface AuthenticatedToken {
  readonly id: string
  readonly name: string
  readonly scopes: ReadonlySet<ExternalApiScope>
  readonly allowedWorkspaceIds: ReadonlySet<string>
  readonly allowedAgentPresets: ReadonlySet<string>
  readonly allowedOrigins: ReadonlySet<string>
}

export type ExternalRunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'

export interface ExternalRunView {
  readonly id: string
  readonly sessionId: string
  readonly status: ExternalRunStatus
  readonly createdAt: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly finishReason?: 'completed' | 'cancelled' | 'max_tokens' | 'failed'
  readonly error?: { readonly code: string; readonly message: string }
}

export interface ProjectedRunEvent {
  readonly id: number
  readonly type: string
  readonly createdAt: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface RouteContext {
  readonly host: ExternalApiHost
  readonly config: ExternalApiConfig
  readonly request: IncomingMessage
  readonly response: ServerResponse
}

export interface AdminWebServer {
  readonly host: string
  readonly port: number
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler(request: IncomingMessage, response: ServerResponse): Promise<void> | void
  }): () => void
}
