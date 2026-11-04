/**
 * DSH 0.2.1 load test: mount the plugin in a real Cordis 4.0.5 runtime.
 *
 * This proves the parts a type check cannot: the `apply(ctx, config)` signature,
 * the `inject` service list and the `Config` schema are accepted by the host
 * framework, and activation registers the loopback management route through
 * `ctx.effect`.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExternalApiConfig } from '../src/contracts.ts'
import * as plugin from '../src/index.ts'

interface RegisteredRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: unknown
}

function stubHost() {
  const routes: RegisteredRoute[] = []
  const webServer = {
    host: '127.0.0.1',
    port: 47831,
    register(route: RegisteredRoute) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const sessionController = { list: async () => ({ items: [] }) }
  const workspaceController = {
    follow: async function* () { /* no baseline */ },
  }
  const agentPresets = { remoteExportList: async () => ({ presets: [] }) }
  const sessionSkillCatalog = { list: async () => ({ skills: [] }) }
  return { routes, webServer, sessionController, workspaceController, agentPresets, sessionSkillCatalog }
}

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'dsh-external-api-mount-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe('cordis 4.0.5 host mount', () => {
  it('activates through ctx.plugin() and registers the management route as an effect', async () => {
    const host = stubHost()
    const ctx = new Context()
    ctx.provide('webServer', host.webServer)
    ctx.provide('sessionController', host.sessionController)
    ctx.provide('workspaceController', host.workspaceController)
    ctx.provide('agentPresets', host.agentPresets)
    ctx.provide('sessionSkillCatalog', host.sessionSkillCatalog)

    // Mirror what the DSH Loader does with an ESM plugin module: hand Cordis the
    // module's name/inject/Config/apply. The cast only widens the plugin-specific
    // context interface back to Cordis' Context, which is what the host passes.
    const hostPlugin: Plugin.Object = {
      name: plugin.name,
      inject: plugin.inject,
      Config: plugin.Config,
      apply: (ctx, config) => plugin.apply(ctx as never, config as ExternalApiConfig),
    }
    const fiber = ctx.plugin(hostPlugin, { enabled: false })

    await fiber.await()
    expect(fiber.state).toBe(2) // FiberState.ACTIVE
    expect(host.routes).toHaveLength(1)
    expect(host.routes[0]?.kind).toBe('prefix')
    expect(host.routes[0]?.path).toBe('/external-api-admin')

    await fiber.dispose()
    expect(host.routes).toHaveLength(0)
  })

  it('exposes the 0.2.1 plugin surface', () => {
    expect(plugin.name).toBe('dsh-external-api')
    expect(plugin.inject).toEqual([
      'sessionController',
      'workspaceController',
      'agentPresets',
      'sessionSkillCatalog',
      'webServer',
    ])
    expect(plugin.inject).not.toContain('settings')
    expect(typeof plugin.apply).toBe('function')
    // Second parameter has a schema default, so the function arity is 1.
    expect(plugin.apply.length).toBeGreaterThanOrEqual(1)
    expect(typeof plugin.Config).toBe('function')
  })
})
