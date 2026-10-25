import { createExternalApiAdminApi } from './api.ts'
import { ExternalApiSettings } from './ExternalApiSettings.tsx'

export const name = 'dsh-external-api'
export const inject = ['slots', 'connection']

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
