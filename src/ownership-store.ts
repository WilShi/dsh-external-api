import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const FORMAT_VERSION = 1
const MAX_OWNERSHIP_FILE_BYTES = 1024 * 1024

interface OwnershipDocument {
  readonly version: typeof FORMAT_VERSION
  readonly sessions: Record<string, string>
}

export class OwnershipConflictError extends Error {
  constructor(readonly sessionId: string) {
    super('session is already owned by another external API token')
    this.name = 'OwnershipConflictError'
  }
}

/** Durable token-to-session ownership. A missing path selects an in-memory store for tests. */
export class OwnershipStore {
  readonly #filename: string | undefined
  #owners = new Map<string, string>()
  #loaded = false
  #tail: Promise<void> = Promise.resolve()

  constructor(filename?: string) {
    this.#filename = filename
  }

  async load(): Promise<void> {
    if (this.#loaded) return
    if (this.#filename === undefined) {
      this.#loaded = true
      return
    }
    let text: string
    try {
      const handle = await open(this.#filename, 'r')
      try {
        const stat = await handle.stat()
        if (stat.size > MAX_OWNERSHIP_FILE_BYTES) throw new Error('ownership file is too large')
        text = await handle.readFile({ encoding: 'utf8' })
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        this.#loaded = true
        return
      }
      throw error
    }

    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !isRecord(parsed.sessions)) {
      throw new Error('invalid external API ownership file')
    }
    const owners = new Map<string, string>()
    for (const [sessionId, tokenId] of Object.entries(parsed.sessions)) {
      if (!isIdentifier(sessionId) || !isIdentifier(tokenId)) throw new Error('invalid external API ownership entry')
      owners.set(sessionId, tokenId)
    }
    this.#owners = owners
    this.#loaded = true
  }

  owns(tokenId: string, sessionId: string): boolean {
    this.#assertLoaded()
    return this.#owners.get(sessionId) === tokenId
  }

  ownerOf(sessionId: string): string | undefined {
    this.#assertLoaded()
    return this.#owners.get(sessionId)
  }

  sessionsFor(tokenId: string): ReadonlySet<string> {
    this.#assertLoaded()
    return new Set([...this.#owners].filter(([, owner]) => owner === tokenId).map(([sessionId]) => sessionId))
  }

  claim(tokenId: string, sessionId: string): Promise<void> {
    return this.#mutate(() => {
      const owner = this.#owners.get(sessionId)
      if (owner !== undefined && owner !== tokenId) throw new OwnershipConflictError(sessionId)
      this.#owners.set(sessionId, tokenId)
    })
  }

  release(tokenId: string, sessionId: string): Promise<void> {
    return this.#mutate(() => {
      if (this.#owners.get(sessionId) === tokenId) this.#owners.delete(sessionId)
    })
  }

  /** Removes a session after the host confirms that it no longer exists. */
  releaseSession(sessionId: string): Promise<void> {
    return this.#mutate(() => {
      this.#owners.delete(sessionId)
    })
  }

  revokeToken(tokenId: string): Promise<void> {
    return this.#mutate(() => {
      for (const [sessionId, owner] of this.#owners) {
        if (owner === tokenId) this.#owners.delete(sessionId)
      }
    })
  }

  /** Drops durable entries whose bearer-token records no longer exist. */
  retainTokens(tokenIds: ReadonlySet<string>): Promise<void> {
    return this.#mutate(() => {
      for (const [sessionId, owner] of this.#owners) {
        if (!tokenIds.has(owner)) this.#owners.delete(sessionId)
      }
    })
  }

  async #mutate(change: () => void): Promise<void> {
    this.#assertLoaded()
    const operation = this.#tail.then(async () => {
      const before = new Map(this.#owners)
      try {
        change()
        await this.#persist()
      } catch (error) {
        this.#owners = before
        throw error
      }
    })
    this.#tail = operation.catch(() => undefined)
    return operation
  }

  async #persist(): Promise<void> {
    if (this.#filename === undefined) return
    const sessions = Object.fromEntries([...this.#owners].sort(([left], [right]) => left.localeCompare(right)))
    const document: OwnershipDocument = { version: FORMAT_VERSION, sessions }
    await mkdir(dirname(this.#filename), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.#filename, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error('ownership store has not been loaded')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/u.test(value)
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
