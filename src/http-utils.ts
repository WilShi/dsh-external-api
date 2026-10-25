import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIPv4 } from 'node:net'

const JSON_CONTENT_TYPE = 'application/json'
const ALLOWED_PREFLIGHT_HEADERS = new Set(['authorization', 'content-type', 'last-event-id'])

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(code)
    this.name = 'HttpError'
  }
}

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  applySecurityHeaders(response)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export function sendExternalError(response: ServerResponse, error: HttpError, requestId: string): void {
  for (const [name, value] of Object.entries(error.headers)) response.setHeader(name, value)
  if (error.status === 401) response.setHeader('www-authenticate', 'Bearer realm="dsh-external-api"')
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.publicMessage,
      requestId,
    },
  })
}

export function sendAdminError(response: ServerResponse, error: HttpError): void {
  for (const [name, value] of Object.entries(error.headers)) response.setHeader(name, value)
  sendJson(response, error.status, { ok: false, code: error.code, hint: error.publicMessage })
}

export async function readJsonObject(
  request: IncomingMessage,
  limitBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== JSON_CONTENT_TYPE) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.')
  }
  const declared = singleHeader(request, 'content-length')
  if (declared !== undefined) {
    if (!/^\d+$/u.test(declared)) throw new HttpError(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length.')
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes)) throw new HttpError(400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length.')
    if (bytes > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.')
  }

  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    received += buffer.byteLength
    if (received > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.')
    chunks.push(buffer)
  }
  if (received === 0) {
    if (options.allowEmpty === true) return {}
    throw new HttpError(400, 'INVALID_JSON', 'A JSON object body is required.')
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.')
  }
  if (!isRecord(value)) throw new HttpError(400, 'INVALID_BODY', 'The request body must be a JSON object.')
  return value
}

export function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(body).some(key => !allowedSet.has(key))) {
    throw new HttpError(400, 'UNKNOWN_FIELD', 'The request body contains an unknown field.')
  }
}

export function requireString(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max: number; trim?: boolean },
): string {
  const value = body[key]
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_BODY', `${key} must be a string.`)
  const normalized = options.trim === true ? value.trim() : value
  if (normalized.length < (options.min ?? 1) || normalized.length > options.max) {
    throw new HttpError(400, 'INVALID_BODY', `${key} has an invalid length.`)
  }
  return normalized
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max: number; trim?: boolean },
): string | undefined {
  if (body[key] === undefined) return undefined
  return requireString(body, key, options)
}

export function validateExternalRequest(
  request: IncomingMessage,
  port: number,
  allowedOrigins: readonly string[],
): string | undefined {
  rejectDuplicateSecurityHeaders(request)
  const localAddress = normalizeIpv4Address(request.socket.localAddress)
  // Binding the listener to 0.0.0.0 must not turn Host validation into an
  // arbitrary-host allowlist. The kernel-selected local endpoint is the only
  // numeric address that can be named by this request. A DNS-rebinding host,
  // another interface address, the wildcard address, and a wrong port all
  // fail this exact comparison.
  const host = singleHeader(request, 'host')
  if (localAddress === undefined || host !== `${localAddress}:${String(port)}`) {
    throw new HttpError(421, 'HOST_REJECTED', 'The Host header is not allowed.')
  }
  const origin = singleHeader(request, 'origin')
  if (origin !== undefined && !allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'The request origin is not allowed.')
  }
  validateFetchMetadata(request, origin !== undefined)
  if ((request.url?.length ?? 0) > 2048) throw new HttpError(414, 'URI_TOO_LONG', 'The request URL is too long.')
  return origin
}

function normalizeIpv4Address(address: string | undefined): string | undefined {
  if (address === undefined) return undefined
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (normalized === '0.0.0.0' || isIPv4(normalized) === false) return undefined
  return normalized
}

export function validateAdminRequest(request: IncomingMessage, host: string, port: number): string | undefined {
  rejectDuplicateSecurityHeaders(request)
  const expectedHost = `${host}:${String(port)}`
  if (singleHeader(request, 'host') !== expectedHost) {
    throw new HttpError(421, 'HOST_REJECTED', 'The Host header is not allowed.')
  }
  const origin = singleHeader(request, 'origin')
  const expectedOrigin = `http://${expectedHost}`
  const mutating = request.method !== 'GET' && request.method !== 'HEAD'
  if ((origin !== undefined && origin !== expectedOrigin) || (mutating && origin !== expectedOrigin)) {
    throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'The request must come from the DSH Desktop origin.')
  }
  const site = singleHeader(request, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'FETCH_METADATA_REJECTED', 'The browser request context is not allowed.')
  }
  return origin
}

export function applyCors(response: ServerResponse, origin: string | undefined): void {
  if (origin === undefined) return
  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('vary', 'Origin')
}

export function handlePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
): void {
  if (origin === undefined) throw new HttpError(403, 'ORIGIN_REQUIRED', 'CORS preflight requires an allowed Origin.')
  const method = singleHeader(request, 'access-control-request-method')?.toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'The requested CORS method is not allowed.')
  }
  const requestedHeaders = (singleHeader(request, 'access-control-request-headers') ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  if (requestedHeaders.some(header => !ALLOWED_PREFLIGHT_HEADERS.has(header))) {
    throw new HttpError(403, 'HEADER_FORBIDDEN', 'A requested CORS header is not allowed.')
  }
  applySecurityHeaders(response)
  applyCors(response, origin)
  response.statusCode = 204
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  response.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Last-Event-ID')
  response.setHeader('access-control-max-age', '600')
  response.end()
}

export function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct?.[name]
  if (values !== undefined) {
    if (values.length !== 1) throw new HttpError(400, 'DUPLICATE_HEADER', `Duplicate ${name} header.`)
    return values[0]
  }
  const value = request.headers[name]
  if (Array.isArray(value)) throw new HttpError(400, 'DUPLICATE_HEADER', `Duplicate ${name} header.`)
  return value
}

export function parsePathIdentifier(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new HttpError(400, 'INVALID_IDENTIFIER', 'The resource identifier is invalid.')
  }
  if (decoded.length < 1 || decoded.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(decoded)) {
    throw new HttpError(400, 'INVALID_IDENTIFIER', 'The resource identifier is invalid.')
  }
  return decoded
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectDuplicateSecurityHeaders(request: IncomingMessage): void {
  for (const name of [
    'host', 'authorization', 'origin', 'content-type', 'content-length', 'transfer-encoding',
    'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'last-event-id',
  ]) singleHeader(request, name)
  if (request.headers['content-length'] !== undefined && request.headers['transfer-encoding'] !== undefined) {
    throw new HttpError(400, 'AMBIGUOUS_BODY', 'Ambiguous request framing is not allowed.')
  }
}

function validateFetchMetadata(request: IncomingMessage, hasAllowedOrigin: boolean): void {
  const site = singleHeader(request, 'sec-fetch-site')
  if (site !== undefined
    && site !== 'same-origin'
    && site !== 'same-site'
    && site !== 'none'
    && !(site === 'cross-site' && hasAllowedOrigin)) {
    throw new HttpError(403, 'FETCH_METADATA_REJECTED', 'The browser request context is not allowed.')
  }
  const mode = singleHeader(request, 'sec-fetch-mode')
  if (mode === 'navigate' || mode === 'websocket') {
    throw new HttpError(403, 'FETCH_METADATA_REJECTED', 'Navigation and WebSocket requests are not allowed.')
  }
  const destination = singleHeader(request, 'sec-fetch-dest')
  if (destination !== undefined && destination !== 'empty') {
    throw new HttpError(403, 'FETCH_METADATA_REJECTED', 'The browser request destination is not allowed.')
  }
}
