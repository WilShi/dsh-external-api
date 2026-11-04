import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdminHandler } from './admin.ts'
import { Config, legacyConcurrencyUpgrade, validateExternalApiConfig } from './config.ts'
import { FileExternalApiConfigScope } from './config-scope.ts'
import type { AdminWebServer, ExternalApiConfig, ExternalApiLogger } from './contracts.ts'
import { ADMIN_API_PREFIX } from './contracts.ts'
import {
  createControllerExternalApiHost,
  type ExternalApiControllerContext,
} from './controller-host.ts'
import { ExternalApiController } from './controller.ts'

export { Config } from './config.ts'
export type { ExternalApiConfig, ExternalApiScope, ExternalApiTokenRecord } from './contracts.ts'
export { FileExternalApiConfigScope } from './config-scope.ts'
export type { ExternalApiConfigPatch, ExternalApiConfigScope } from './config-scope.ts'
export { createExternalApiServer } from './listener.ts'
export { createControllerExternalApiHost } from './controller-host.ts'

export const name = 'dsh-external-api'
/**
 * Host services this plugin needs. `settings` is deliberately absent: DSH 0.2.1
 * removed the programmatic `SettingsProvider` scope, so the plugin owns its
 * live configuration through {@link FileExternalApiConfigScope} instead.
 */
export const inject = [
  'sessionController',
  'workspaceController',
  'agentPresets',
  'sessionSkillCatalog',
  'webServer',
]

interface ApplyContext extends ExternalApiControllerContext {
  readonly webServer: AdminWebServer
  readonly logger: {
    info(format: string, ...args: unknown[]): void
    warn(format: string, ...args: unknown[]): void
    error(format: string, ...args: unknown[]): void
  }
  effect<T extends (() => Promise<void> | void)>(setup: () => T | Promise<T>, description?: string): unknown
}

function dshHome(): string {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Activate the opt-in external API.
 *
 * `entryConfig` is the Loader row configuration (validated by the exported
 * {@link Config} schema). Administrative edits made through the loopback
 * management API are merged over it and persisted under
 * `$DSH_HOME/external-api/config-v1.json`.
 */
export async function apply(
  ctx: ApplyContext,
  entryConfig: ExternalApiConfig = Config({} as ExternalApiConfig),
): Promise<void> {
  validateExternalApiConfig(entryConfig)
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('dsh-external-api: the management API requires the DSH host web server to use loopback')
  }
  const home = dshHome()
  const settings = await FileExternalApiConfigScope.open({
    filename: join(home, 'external-api', 'config-v1.json'),
    base: entryConfig,
    validate: validateExternalApiConfig,
  })
  const concurrencyUpgrade = legacyConcurrencyUpgrade(settings.get())
  if (concurrencyUpgrade !== undefined) {
    await settings.update(concurrencyUpgrade)
    ctx.logger.info(
      'dsh-external-api: upgraded legacy default concurrency from 2/4 to 10/20 (per-token/global)',
    )
  }
  const logger: ExternalApiLogger = {
    info: message => ctx.logger.info(message),
    warn: message => ctx.logger.warn(message),
    error: message => ctx.logger.error(message),
  }
  const controller = new ExternalApiController({
    host: createControllerExternalApiHost(ctx),
    config: settings.get(),
    ownershipFile: join(home, 'external-api', 'ownership-v1.json'),
    logger,
  })

  await ctx.effect(async () => {
    await controller.configure(settings.get())
    const stopWatching = settings.watch(async next => controller.configure(next))
    const unregisterAdmin = ctx.webServer.register({
      kind: 'prefix',
      path: ADMIN_API_PREFIX,
      handler: createAdminHandler({
        host: ctx.webServer.host,
        port: ctx.webServer.port,
        settings,
        controller,
      }) as (request: IncomingMessage, response: ServerResponse) => Promise<void>,
    })
    return async () => {
      unregisterAdmin()
      stopWatching()
      await controller.stop()
    }
  }, 'dsh-external-api: external listener and loopback management routes')
}

export default { name, inject, Config, apply }
