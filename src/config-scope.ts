import { open, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Config } from './config.ts'
import type { ExternalApiConfig } from './contracts.ts'

const FORMAT_VERSION = 1
const MAX_CONFIG_FILE_BYTES = 256 * 1024

/** Fields the loopback management API may edit at runtime. */
export type ExternalApiConfigPatch = Partial<ExternalApiConfig>

interface ConfigDocument {
  readonly version: typeof FORMAT_VERSION
  readonly config: ExternalApiConfig
}

/**
 * Live, durable view of this plugin's configuration.
 *
 * DSH 0.2.1 moved plugin configuration onto the Loader entry: `apply(ctx,
 * config)` receives the entry config, and the removed `dsh-settings`
 * `SettingsProvider`/`SettingsForms` API only edits *other* entries by profile
 * entry id. The loopback management API still needs to read, mutate and watch
 * its own configuration, so this package owns that layer: the Loader entry
 * config is the base layer, admin edits are merged over it and persisted
 * atomically under the harness home.
 */
export interface ExternalApiConfigScope {
  get(): ExternalApiConfig
  update(patch: ExternalApiConfigPatch): Promise<void>
  watch(listener: (next: ExternalApiConfig) => void | Promise<void>): () => void
}

interface OpenOptions {
  /** Durable JSON overlay. Omit for an in-memory scope (tests). */
  readonly filename?: string
  /** Loader entry configuration, used as the base layer. */
  readonly base: ExternalApiConfig
  /** Semantic validation applied to the merged document on every write. */
  readonly validate: (config: ExternalApiConfig) => void
}

export class FileExternalApiConfigScope implements ExternalApiConfigScope {
  readonly #filename: string | undefined
  readonly #validate: (config: ExternalApiConfig) => void
  readonly #listeners = new Set<(next: ExternalApiConfig) => void | Promise<void>>()
  #current: ExternalApiConfig
  #tail: Promise<void> = Promise.resolve()

  private constructor(options: OpenOptions, current: ExternalApiConfig) {
    this.#filename = options.filename
    this.#validate = options.validate
    this.#current = current
  }

  /** Read the durable overlay (if any), merge it over the entry config and validate. */
  static async open(options: OpenOptions): Promise<FileExternalApiConfigScope> {
    const overlay = await readOverlay(options.filename)
    const merged = Config({ ...options.base, ...overlay })
    options.validate(merged)
    return new FileExternalApiConfigScope(options, merged)
  }

  get(): ExternalApiConfig {
    return this.#current
  }

  /** Merge a patch, validate it, persist it, then notify watchers in order. */
  update(patch: ExternalApiConfigPatch): Promise<void> {
    const operation = this.#tail.then(async () => {
      const merged = Config({ ...this.#current, ...patch })
      this.#validate(merged)
      await this.#persist(merged)
      this.#current = merged
      for (const listener of [...this.#listeners]) await listener(merged)
    })
    this.#tail = operation.catch(() => undefined)
    return operation
  }

  watch(listener: (next: ExternalApiConfig) => void | Promise<void>): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  async #persist(config: ExternalApiConfig): Promise<void> {
    if (this.#filename === undefined) return
    const document: ConfigDocument = { version: FORMAT_VERSION, config }
    await mkdir(dirname(this.#filename), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.#filename, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

async function readOverlay(filename: string | undefined): Promise<Partial<ExternalApiConfig>> {
  if (filename === undefined) return {}
  let text: string
  try {
    const handle = await open(filename, 'r')
    try {
      const stat = await handle.stat()
      if (stat.size > MAX_CONFIG_FILE_BYTES) throw new Error('external API config file is too large')
      text = await handle.readFile({ encoding: 'utf8' })
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) return {}
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !isRecord(parsed.config)) {
    throw new Error('invalid external API config file')
  }
  return parsed.config as Partial<ExternalApiConfig>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
