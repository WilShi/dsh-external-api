import type { IncomingMessage, ServerResponse } from 'node:http'
import { ALL_EXTERNAL_API_SCOPES, ADMIN_API_PREFIX, type ExternalApiConfig, type ExternalApiScope, type ExternalApiTokenRecord } from './contracts.ts'
import { issueBearerToken } from './auth.ts'
import { Config, publicConfig, validateExternalApiConfig } from './config.ts'
import type { ExternalApiController } from './controller.ts'
import { assertOnlyKeys, HttpError, isRecord, parsePathIdentifier, readJsonObject, sendAdminError, sendJson, validateAdminRequest } from './http-utils.ts'

interface SettingsScopeLike {
  get(): ExternalApiConfig
  update(patch: object): Promise<void>
}

export interface AdminHandlerOptions {
  readonly host: string
  readonly port: number
  readonly settings: SettingsScopeLike
  readonly controller: ExternalApiController
}

export function createAdminHandler(options: AdminHandlerOptions) {
  let mutationTail: Promise<unknown> = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = mutationTail.catch(() => undefined).then(operation)
    mutationTail = current
    return current
  }

  return async function adminHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      validateAdminRequest(request, options.host, options.port)
      const url = parseUrl(request)
      if (request.method === 'OPTIONS') {
        response.statusCode = 204
        response.setHeader('access-control-allow-methods', 'GET, PUT, POST, DELETE, OPTIONS')
        response.setHeader('access-control-allow-headers', 'Content-Type')
        response.end()
        return
      }
      if (url.pathname === `${ADMIN_API_PREFIX}/status`) {
        requireMethod(request, 'GET')
        assertNoQuery(url)
        sendJson(response, 200, statusBody(options))
        return
      }
      if (url.pathname === `${ADMIN_API_PREFIX}/config`) {
        requireMethod(request, 'PUT')
        assertNoQuery(url)
        const body = await readJsonObject(request, 64 * 1024)
        assertOnlyKeys(body, ['enabled', 'port', 'allowedOrigins'])
        const patch = parseConfigPatch(body)
        await mutate(async () => {
          await options.settings.update(patch)
          await options.controller.configure(options.settings.get())
        })
        sendJson(response, 200, statusBody(options))
        return
      }
      if (url.pathname === `${ADMIN_API_PREFIX}/tokens`) {
        assertNoQuery(url)
        if (request.method === 'GET') {
          sendJson(response, 200, {
            ok: true,
            tokens: options.settings.get().tokens.map(publicToken),
          })
          return
        }
        if (request.method === 'POST') {
          const body = await readJsonObject(request, 64 * 1024)
          const issued = await mutate(async () => {
            const parsed = parseTokenCreate(body)
            const next = issueBearerToken(parsed.name, parsed)
            const current = options.settings.get()
            const candidate = Config({ ...current, tokens: [...current.tokens, next.record] })
            validateExternalApiConfig(candidate)
            await options.settings.update({ tokens: candidate.tokens })
            await options.controller.configure(options.settings.get())
            return next
          })
          sendJson(response, 201, { ok: true, token: publicToken(issued.record), secret: issued.secret })
          return
        }
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Allowed methods: GET, POST.')
      }
      const revokeMatch = url.pathname.match(new RegExp(`^${ADMIN_API_PREFIX}/tokens/([^/]+)$`, 'u'))
      if (revokeMatch !== null) {
        requireMethod(request, 'DELETE')
        assertNoQuery(url)
        const tokenId = parsePathIdentifier(revokeMatch[1]!)
        await mutate(async () => {
          const current = options.settings.get()
          if (!current.tokens.some(token => token.id === tokenId)) {
            throw new HttpError(404, 'NOT_FOUND', 'The token was not found.')
          }
          await options.settings.update({ tokens: current.tokens.filter(token => token.id !== tokenId) })
          await options.controller.configure(options.settings.get())
          await options.controller.revokeToken(tokenId)
        })
        sendJson(response, 200, { ok: true })
        return
      }
      throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found.')
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendAdminError(response, adminError(error))
    }
  }
}

function statusBody(options: AdminHandlerOptions): Record<string, unknown> {
  return {
    ok: true,
    config: publicConfig(options.settings.get()),
    runtime: options.controller.status(),
  }
}

function publicToken(token: ExternalApiTokenRecord): Record<string, unknown> {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: [...token.scopes],
    allowedWorkspaceIds: [...token.allowedWorkspaceIds],
    allowedAgentPresets: [...token.allowedAgentPresets],
    createdAt: token.createdAt,
  }
}

function parseConfigPatch(body: Record<string, unknown>): Partial<ExternalApiConfig> {
  const patch: {
    enabled?: boolean
    port?: number
    allowedOrigins?: string[]
  } = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw invalidBody('enabled must be a boolean.')
    patch.enabled = body.enabled
  }
  if (body.port !== undefined) {
    if (!Number.isSafeInteger(body.port) || (body.port as number) < 1024 || (body.port as number) > 65535) {
      throw invalidBody('port must be an integer between 1024 and 65535.')
    }
    patch.port = body.port as number
  }
  if (body.allowedOrigins !== undefined) {
    if (!Array.isArray(body.allowedOrigins) || body.allowedOrigins.some(origin => typeof origin !== 'string')) {
      throw invalidBody('allowedOrigins must be an array of origins.')
    }
    patch.allowedOrigins = [...body.allowedOrigins] as string[]
  }
  return patch
}

function parseTokenCreate(body: Record<string, unknown>): {
  name: string
  scopes?: ExternalApiScope[]
  allowedWorkspaceIds?: string[]
  allowedAgentPresets?: string[]
  allowedOrigins?: string[]
} {
  assertOnlyKeys(body, ['name', 'scopes', 'allowedWorkspaceIds', 'allowedAgentPresets', 'allowedOrigins'])
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 80) {
    throw invalidBody('name must be between 1 and 80 characters.')
  }
  const result: ReturnType<typeof parseTokenCreate> = { name: body.name.trim() }
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes)
      || body.scopes.some(scope => typeof scope !== 'string' || !ALL_EXTERNAL_API_SCOPES.includes(scope as ExternalApiScope))) {
      throw invalidBody('scopes contains an unsupported scope.')
    }
    result.scopes = [...new Set(body.scopes)] as ExternalApiScope[]
  }
  for (const key of ['allowedWorkspaceIds', 'allowedAgentPresets', 'allowedOrigins'] as const) {
    const value = body[key]
    if (value === undefined) continue
    const maxLength = key === 'allowedOrigins' ? 2048 : 200
    if (!Array.isArray(value)
      || value.length > (key === 'allowedOrigins' ? 64 : 256)
      || value.some(entry => typeof entry !== 'string' || entry.length < 1 || entry.length > maxLength)) {
      throw invalidBody(`${key} must be an array of strings.`)
    }
    result[key] = [...new Set(value)] as string[]
  }
  return result
}

function parseUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    throw invalidBody('The request URL is invalid.')
  }
}

function requireMethod(request: IncomingMessage, method: string): void {
  if (request.method !== method) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `Allowed method: ${method}.`)
}

function assertNoQuery(url: URL): void {
  if ([...url.searchParams].length > 0) throw invalidBody('Query parameters are not accepted.')
}

function invalidBody(message: string): HttpError {
  return new HttpError(400, 'INVALID_BODY', message)
}

function adminError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (isRecord(error) && error.code === 'SETTINGS_CONFLICT') {
    return new HttpError(409, 'SETTINGS_CONFLICT', 'The configuration changed; reload and try again.')
  }
  return new HttpError(500, 'INTERNAL', 'The configuration could not be updated.')
}
