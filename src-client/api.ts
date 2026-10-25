/**
 * Typed, same-origin client for the host-only External API administration
 * surface. The bearer secret returned by createToken is deliberately never
 * placed in a URL, browser storage, or a long-lived shared service.
 */

export type ListenerState = 'stopped' | 'starting' | 'running' | 'error'

export interface ExternalApiConfig {
  enabled: boolean
  port: number
}

export interface ExternalApiRuntime {
  state: ListenerState
  host: string
  port: number | null
  url?: string
  error?: string
}

export interface ExternalApiStatus {
  config: ExternalApiConfig
  runtime: ExternalApiRuntime
}

export interface TokenSummary {
  id: string
  name: string
  prefix: string
  scopes: string[]
  allowedWorkspaceIds: string[]
  allowedAgentPresets: string[]
  createdAt: string
}

export interface CreateTokenInput {
  name: string
  allowedWorkspaceIds: string[]
  allowedAgentPresets: string[]
}

export interface CreatedToken {
  token: TokenSummary
  /** Plaintext bearer secret. The host returns this value exactly once. */
  secret: string
}

export interface ExternalApiAdminApi {
  status(): Promise<ExternalApiStatus>
  updateConfig(config: ExternalApiConfig): Promise<ExternalApiStatus>
  listTokens(): Promise<TokenSummary[]>
  createToken(input: CreateTokenInput): Promise<CreatedToken>
  revokeToken(id: string): Promise<void>
}

type JsonObject = Record<string, unknown>

export class ExternalApiAdminError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'ExternalApiAdminError'
    this.code = code
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function responseError(body: unknown, fallback: string): ExternalApiAdminError {
  const record = isObject(body) ? body : undefined
  return new ExternalApiAdminError(
    stringValue(record?.hint) ?? stringValue(record?.message) ?? fallback,
    stringValue(record?.code),
  )
}

async function request(path: string, init?: RequestInit): Promise<JsonObject> {
  let response: Response
  try {
    const headers = new Headers(init?.headers)
    headers.set('accept', 'application/json')
    if (init?.body !== undefined) headers.set('content-type', 'application/json')
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers,
    })
  } catch {
    throw new ExternalApiAdminError('无法连接到本地 API 管理服务，请稍后重试。', 'NETWORK')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ExternalApiAdminError('本地 API 管理服务返回了无效响应。', 'INVALID_RESPONSE')
  }

  if (!response.ok || !isObject(body) || body.ok !== true) {
    throw responseError(body, `操作失败（HTTP ${response.status}）`)
  }
  return body
}

function parsePort(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new ExternalApiAdminError(`${label}返回了无效端口。`, 'INVALID_RESPONSE')
  }
  return value as number
}

function parseStatus(body: JsonObject): ExternalApiStatus {
  // updateConfig may wrap the resulting snapshot in `status`; GET status uses
  // the top-level shape. Supporting both keeps the write response compact.
  const source = isObject(body.status) ? body.status : body
  if (!isObject(source.config) || !isObject(source.runtime)) {
    throw new ExternalApiAdminError('本地 API 状态响应缺少必要字段。', 'INVALID_RESPONSE')
  }

  const config = source.config
  const runtime = source.runtime
  const state = runtime.state
  if (typeof config.enabled !== 'boolean'
    || (state !== 'stopped' && state !== 'starting' && state !== 'running' && state !== 'error')) {
    throw new ExternalApiAdminError('本地 API 状态响应格式不正确。', 'INVALID_RESPONSE')
  }

  const host = stringValue(runtime.host)
  if (host === undefined) {
    throw new ExternalApiAdminError('本地 API 状态响应缺少监听地址。', 'INVALID_RESPONSE')
  }

  const runtimePort = runtime.port === null ? null : parsePort(runtime.port, '运行状态')
  const url = stringValue(runtime.url)
  const runtimeError = stringValue(runtime.error)
  return {
    config: {
      enabled: config.enabled,
      port: parsePort(config.port, '配置'),
    },
    runtime: {
      state,
      host,
      port: runtimePort,
      ...(url === undefined ? {} : { url }),
      ...(runtimeError === undefined ? {} : { error: runtimeError }),
    },
  }
}

function parseToken(value: unknown): TokenSummary {
  if (!isObject(value)
    || stringValue(value.id) === undefined
    || stringValue(value.name) === undefined
    || stringValue(value.prefix) === undefined
    || stringValue(value.createdAt) === undefined
    || !Array.isArray(value.scopes)
    || !value.scopes.every((scope) => typeof scope === 'string')
    || !Array.isArray(value.allowedWorkspaceIds)
    || !value.allowedWorkspaceIds.every((id) => typeof id === 'string')
    || !Array.isArray(value.allowedAgentPresets)
    || !value.allowedAgentPresets.every((id) => typeof id === 'string')) {
    throw new ExternalApiAdminError('Token 列表响应格式不正确。', 'INVALID_RESPONSE')
  }
  return {
    id: value.id as string,
    name: value.name as string,
    prefix: value.prefix as string,
    scopes: [...value.scopes] as string[],
    allowedWorkspaceIds: [...value.allowedWorkspaceIds] as string[],
    allowedAgentPresets: [...value.allowedAgentPresets] as string[],
    createdAt: value.createdAt as string,
  }
}

export function createExternalApiAdminApi(): ExternalApiAdminApi {
  return {
    async status() {
      return parseStatus(await request('/external-api-admin/status'))
    },

    async updateConfig(config) {
      const body = await request('/external-api-admin/config', {
        method: 'PUT',
        body: JSON.stringify(config),
      })
      return parseStatus(body)
    },

    async listTokens() {
      const body = await request('/external-api-admin/tokens')
      if (!Array.isArray(body.tokens)) {
        throw new ExternalApiAdminError('Token 列表响应缺少必要字段。', 'INVALID_RESPONSE')
      }
      return body.tokens.map(parseToken)
    },

    async createToken(input) {
      const body = await request('/external-api-admin/tokens', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      const secret = stringValue(body.secret)
      if (secret === undefined) {
        throw new ExternalApiAdminError('服务没有返回新 Token；请撤销该条目后重试。', 'SECRET_MISSING')
      }
      return { token: parseToken(body.token), secret }
    },

    async revokeToken(id) {
      await request(`/external-api-admin/tokens/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    },
  }
}
