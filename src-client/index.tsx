import { createExternalApiAdminApi } from './api.ts'
import { ExternalApiSettings } from './ExternalApiSettings.tsx'

export const name = 'dsh-external-api'
/**
 * Client services this plugin reads. DSH 0.2.1's web shell exposes the `slots`
 * service; the previous `connection` dependency is gone and unnecessary here
 * because the admin client calls the same-origin loopback HTTP route directly.
 */
export const inject = ['slots']

interface ClientContext {
  slots: {
    inject(name: string, loader: () => unknown): void
    register(entry: Record<string, unknown>, component: unknown): unknown
  }
}

export function apply(ctx: ClientContext): void {
  const api = createExternalApiAdminApi()

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'external-api',
    order: 50,
    label: () => 'API 服务',
    inject: () => ({ api }),
  }, ExternalApiSettings))
}
