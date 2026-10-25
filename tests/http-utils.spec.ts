import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  applyCors,
  applySecurityHeaders,
  handlePreflight,
  HttpError,
  parsePathIdentifier,
  readJsonObject,
  sendExternalError,
  validateAdminRequest,
  validateExternalRequest,
} from '../src/http-utils.js'

function request(options: {
  method?: string
  url?: string
  headers?: Record<string, string | string[]>
  chunks?: Array<string | Buffer>
  localAddress?: string
  remoteAddress?: string
} = {}): IncomingMessage {
  const stream = Readable.from(options.chunks ?? []) as IncomingMessage
  Object.assign(stream, {
    method: options.method ?? 'GET',
    url: options.url ?? '/api/v1/health',
    headers: options.headers ?? { host: '127.0.0.1:43120' },
    socket: {
      localAddress: options.localAddress ?? '127.0.0.1',
      remoteAddress: options.remoteAddress ?? '127.0.0.1',
    },
  })
  return stream
}

function response(): ServerResponse & { body: string; headers: Map<string, string> } {
  const headers = new Map<string, string>()
  const target = {
    statusCode: 200,
    body: '',
    writableEnded: false,
    headersSent: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
      return target
    },
    getHeader(name: string) { return headers.get(name.toLowerCase()) },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) target.body += chunk.toString()
      target.writableEnded = true
      target.headersSent = true
      return target
    },
    headers,
  }
  return target as unknown as ServerResponse & { body: string; headers: Map<string, string> }
}

describe('external API JSON request boundaries', () => {
  it('accepts only a JSON object and permits an explicit charset', async () => {
    const parsed = await readJsonObject(request({
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      chunks: ['{"input":"hello"}'],
    }), 1024)
    expect(parsed).toEqual({ input: 'hello' })

    await expect(readJsonObject(request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      chunks: ['[]'],
    }), 1024)).rejects.toMatchObject({ status: 400, code: 'INVALID_BODY' })
  })

  it.each([undefined, 'text/plain', 'application/x-www-form-urlencoded'])('rejects content type %s', async (contentType) => {
    await expect(readJsonObject(request({
      method: 'POST',
      headers: contentType === undefined ? {} : { 'content-type': contentType },
      chunks: ['{}'],
    }), 1024)).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
  })

  it('rejects malformed, missing, and oversized bodies with bounded public errors', async () => {
    await expect(readJsonObject(request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      chunks: ['{"private":"secret"'],
    }), 1024)).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' })
    await expect(readJsonObject(request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }), 1024)).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' })
    await expect(readJsonObject(request({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2048' },
      chunks: ['{}'],
    }), 1024)).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' })
    await expect(readJsonObject(request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      chunks: ['{"value":"', 'x'.repeat(1024), '"}'],
    }), 1024)).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' })
  })

  it('allows a truly empty object only on routes that explicitly opt in', async () => {
    await expect(readJsonObject(request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }), 1024, { allowEmpty: true })).resolves.toEqual({})
  })
})

describe('external API browser and host-header defenses', () => {
  it('accepts only the numeric IPv4 authority selected for this socket', () => {
    expect(validateExternalRequest(request(), 43120, [])).toBeUndefined()
    expect(validateExternalRequest(request({
      headers: { host: '192.168.20.15:43120' },
      localAddress: '192.168.20.15',
      // Remote-address policy is deliberately left to the network/firewall so
      // VPN and enterprise address ranges remain usable.
      remoteAddress: '203.0.113.40',
    }), 43120, [])).toBeUndefined()
    expect(validateExternalRequest(request({
      headers: { host: '10.4.3.2:43120' },
      localAddress: '::ffff:10.4.3.2',
    }), 43120, [])).toBeUndefined()

    for (const host of ['localhost:43120', '127.0.0.1', '127.0.0.1:43121', 'evil.example', '127.0.0.1:43120.evil']) {
      expect(() => validateExternalRequest(request({ headers: { host } }), 43120, []))
        .toThrowError(expect.objectContaining<Partial<HttpError>>({ status: 421, code: 'HOST_REJECTED' }))
    }
    for (const candidate of [
      request({ headers: { host: '0.0.0.0:43120' }, localAddress: '0.0.0.0' }),
      request({ headers: { host: '192.168.20.16:43120' }, localAddress: '192.168.20.15' }),
      request({ headers: { host: '192.168.20.15:43121' }, localAddress: '192.168.20.15' }),
      request({ headers: { host: 'device.example:43120' }, localAddress: '192.168.20.15' }),
      request({ headers: { host: '192.168.20.15:43120' }, localAddress: '' }),
    ]) {
      expect(() => validateExternalRequest(candidate, 43120, []))
        .toThrowError(expect.objectContaining<Partial<HttpError>>({ status: 421, code: 'HOST_REJECTED' }))
    }
  })

  it('allows only configured origins and applies the same origin verbatim to CORS', () => {
    const origin = 'https://client.example.test'
    const req = request({ headers: { host: '127.0.0.1:43120', origin, 'sec-fetch-site': 'cross-site' } })
    expect(validateExternalRequest(req, 43120, [origin])).toBe(origin)
    const res = response()
    applyCors(res, origin)
    expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    expect(res.headers.get('vary')).toBe('Origin')

    expect(() => validateExternalRequest(request({
      headers: { host: '127.0.0.1:43120', origin: 'https://evil.example' },
    }), 43120, [origin])).toThrowError(expect.objectContaining({ code: 'ORIGIN_FORBIDDEN' }))
  })

  it.each([
    [{ 'sec-fetch-site': 'cross-site' }, 'FETCH_METADATA_REJECTED'],
    [{ 'sec-fetch-mode': 'navigate' }, 'FETCH_METADATA_REJECTED'],
    [{ 'sec-fetch-mode': 'websocket' }, 'FETCH_METADATA_REJECTED'],
    [{ 'sec-fetch-dest': 'iframe' }, 'FETCH_METADATA_REJECTED'],
  ] as const)('rejects hostile Fetch Metadata: %j', (extra, code) => {
    expect(() => validateExternalRequest(request({
      headers: { host: '127.0.0.1:43120', ...extra },
    }), 43120, [])).toThrowError(expect.objectContaining({ status: 403, code }))
  })

  it('rejects duplicate security headers and ambiguous body framing', () => {
    expect(() => validateExternalRequest(request({
      headers: { host: '127.0.0.1:43120', authorization: ['Bearer a', 'Bearer b'] },
    }), 43120, [])).toThrowError(expect.objectContaining({ code: 'DUPLICATE_HEADER' }))
    expect(() => validateExternalRequest(request({
      headers: { host: '127.0.0.1:43120', 'content-length': '2', 'transfer-encoding': 'chunked' },
    }), 43120, [])).toThrowError(expect.objectContaining({ code: 'AMBIGUOUS_BODY' }))
  })

  it('rejects oversized URLs and invalid encoded identifiers', () => {
    expect(() => validateExternalRequest(request({ url: `/${'x'.repeat(2048)}` }), 43120, []))
      .toThrowError(expect.objectContaining({ status: 414, code: 'URI_TOO_LONG' }))
    for (const id of ['..%2Fsettings', '%ZZ', 'with space', 'x'.repeat(201)]) {
      expect(() => parsePathIdentifier(id)).toThrowError(expect.objectContaining({ code: 'INVALID_IDENTIFIER' }))
    }
  })

  it('requires exact same-origin provenance for mutating admin requests', () => {
    const allowed = request({
      method: 'PUT',
      headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120', 'sec-fetch-site': 'same-origin' },
    })
    expect(validateAdminRequest(allowed, '127.0.0.1', 43120)).toBe('http://127.0.0.1:43120')
    expect(() => validateAdminRequest(request({
      method: 'PUT',
      headers: { host: '127.0.0.1:43120' },
    }), '127.0.0.1', 43120)).toThrowError(expect.objectContaining({ code: 'ORIGIN_FORBIDDEN' }))
  })

  it('answers only narrowly scoped CORS preflights', () => {
    const origin = 'https://client.example.test'
    const res = response()
    handlePreflight(request({
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, Content-Type, Last-Event-ID',
      },
    }), res, origin)
    expect(res.statusCode).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(origin)
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')

    expect(() => handlePreflight(request({
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'DELETE' },
    }), response(), origin)).toThrowError(expect.objectContaining({ status: 405 }))
    expect(() => handlePreflight(request({
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'X-Secret' },
    }), response(), origin)).toThrowError(expect.objectContaining({ code: 'HEADER_FORBIDDEN' }))
  })

  it('puts defense-in-depth headers on success and sanitized errors', () => {
    const res = response()
    applySecurityHeaders(res)
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })

    const errorRes = response()
    sendExternalError(errorRes, new HttpError(500, 'INTERNAL', 'The request could not be completed.'), 'request-id')
    expect(JSON.parse(errorRes.body)).toEqual({
      error: { code: 'INTERNAL', message: 'The request could not be completed.', requestId: 'request-id' },
    })
    expect(errorRes.body).not.toContain('stack')
  })
})
