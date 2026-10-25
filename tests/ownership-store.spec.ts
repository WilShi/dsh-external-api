import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnershipConflictError, OwnershipStore } from '../src/ownership-store.js'

const temporaryRoots: string[] = []

async function temporaryFile(): Promise<{ root: string; filename: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-external-api-ownership-'))
  temporaryRoots.push(root)
  return { root, filename: join(root, 'nested', 'ownership.json') }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('external API session ownership', () => {
  it('requires an explicit load before reading or mutating state', async () => {
    const store = new OwnershipStore()

    expect(() => store.owns('token-a', 'session-a')).toThrow(/has not been loaded/u)
    await expect(store.claim('token-a', 'session-a')).rejects.toThrow(/has not been loaded/u)
  })

  it('isolates sessions between tokens and returns defensive snapshots', async () => {
    const store = new OwnershipStore()
    await store.load()
    await store.claim('token-a', 'session-a')

    expect(store.owns('token-a', 'session-a')).toBe(true)
    expect(store.owns('token-b', 'session-a')).toBe(false)
    expect(store.ownerOf('session-a')).toBe('token-a')
    const sessions = store.sessionsFor('token-a') as Set<string>
    sessions.clear()
    expect(store.sessionsFor('token-a')).toEqual(new Set(['session-a']))
  })

  it('serializes competing claims so exactly one token wins', async () => {
    const store = new OwnershipStore()
    await store.load()

    const results = await Promise.allSettled([
      store.claim('token-a', 'session-race'),
      store.claim('token-b', 'session-race'),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejection.reason).toBeInstanceOf(OwnershipConflictError)
    expect(['token-a', 'token-b']).toContain(store.ownerOf('session-race'))
  })

  it('does not let a non-owner release a session', async () => {
    const store = new OwnershipStore()
    await store.load()
    await store.claim('token-a', 'session-a')

    await store.release('token-b', 'session-a')
    expect(store.ownerOf('session-a')).toBe('token-a')
    await store.release('token-a', 'session-a')
    expect(store.ownerOf('session-a')).toBeUndefined()
  })

  it('persists ownership across restarts without storing bearer secrets', async () => {
    const { filename } = await temporaryFile()
    const secretMarker = 'dshx_never-write-this-bearer-secret'
    const first = new OwnershipStore(filename)
    await first.load()
    await first.claim('token-a', 'session-a')
    await first.claim('token-a', 'session-b')
    await first.claim('token-b', 'session-c')

    const disk = await readFile(filename, 'utf8')
    expect(disk).not.toContain(secretMarker)
    expect(JSON.parse(disk)).toEqual({
      version: 1,
      sessions: {
        'session-a': 'token-a',
        'session-b': 'token-a',
        'session-c': 'token-b',
      },
    })

    const restarted = new OwnershipStore(filename)
    await restarted.load()
    expect(restarted.sessionsFor('token-a')).toEqual(new Set(['session-a', 'session-b']))
    expect(restarted.owns('token-b', 'session-c')).toBe(true)
    expect(restarted.owns('token-b', 'session-a')).toBe(false)
  })

  it('revoking a token removes only its durable ownership records', async () => {
    const { filename } = await temporaryFile()
    const store = new OwnershipStore(filename)
    await store.load()
    await store.claim('token-a', 'session-a')
    await store.claim('token-b', 'session-b')

    await store.revokeToken('token-a')
    expect(store.ownerOf('session-a')).toBeUndefined()
    expect(store.ownerOf('session-b')).toBe('token-b')

    const restarted = new OwnershipStore(filename)
    await restarted.load()
    expect(restarted.ownerOf('session-a')).toBeUndefined()
    expect(restarted.ownerOf('session-b')).toBe('token-b')
  })

  it('prunes removed tokens and host-removed sessions from durable ownership', async () => {
    const { filename } = await temporaryFile()
    const store = new OwnershipStore(filename)
    await store.load()
    await store.claim('token-a', 'session-a')
    await store.claim('token-b', 'session-b')
    await store.claim('token-b', 'session-c')

    await store.retainTokens(new Set(['token-b']))
    await store.releaseSession('session-b')

    const restarted = new OwnershipStore(filename)
    await restarted.load()
    expect(restarted.ownerOf('session-a')).toBeUndefined()
    expect(restarted.ownerOf('session-b')).toBeUndefined()
    expect(restarted.ownerOf('session-c')).toBe('token-b')
  })

  it('fails closed for corrupt, invalid, and oversized ownership files', async () => {
    const malformed = await temporaryFile()
    await writeFile(join(malformed.root, 'malformed.json'), '{not-json', 'utf8')
    await expect(new OwnershipStore(join(malformed.root, 'malformed.json')).load()).rejects.toThrow()

    const invalid = await temporaryFile()
    await writeFile(join(invalid.root, 'invalid.json'), JSON.stringify({ version: 1, sessions: { '../escape': 'token-a' } }))
    await expect(new OwnershipStore(join(invalid.root, 'invalid.json')).load()).rejects.toThrow(/invalid external API ownership entry/u)

    const oversized = await temporaryFile()
    await writeFile(join(oversized.root, 'oversized.json'), 'x'.repeat(1024 * 1024 + 1))
    await expect(new OwnershipStore(join(oversized.root, 'oversized.json')).load()).rejects.toThrow(/too large/u)
  })
})
