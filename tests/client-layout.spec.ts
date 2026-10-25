import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { externalApiStyles } from '../src-client/styles.ts'

const SETTINGS_SOURCE = readFileSync(fileURLToPath(new URL(
  '../src-client/ExternalApiSettings.tsx',
  import.meta.url,
)), 'utf8')

describe('external API settings layout', () => {
  it('aligns the port and runtime address as two equal-height control rows', () => {
    expect(externalApiStyles).toMatch(
      /\.dsh-external-api-config-grid\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(180px,\s*\.75fr\)\s*minmax\(280px,\s*1\.25fr\);[^}]*align-items:\s*start;/su,
    )
    expect(externalApiStyles).toMatch(
      /\.dsh-external-api-config-grid\s*>\s*\.dsh-external-api-field\s*\{[^}]*grid-template-rows:\s*auto\s+36px\s+auto;/su,
    )
    expect(externalApiStyles).toMatch(
      /\.dsh-external-api-config-grid \.dsh-external-api-input,\s*\.dsh-external-api-config-grid \.dsh-external-api-address\s*\{[^}]*height:\s*36px;/su,
    )
  })

  it('stacks the fields and footer by card width with a viewport fallback', () => {
    expect(externalApiStyles).toMatch(
      /@container dsh-external-api-service \(max-width:\s*620px\)[\s\S]*?\.dsh-external-api-config-grid,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    )
    expect(externalApiStyles).toMatch(
      /@media \(max-width:\s*700px\)[\s\S]*?\.dsh-external-api-config-grid,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    )
  })

  it('keeps runtime feedback and controls in one responsive service footer', () => {
    expect(SETTINGS_SOURCE).toContain(
      'className="dsh-external-api-card dsh-external-api-service-card"',
    )
    const footer = SETTINGS_SOURCE.indexOf('className="dsh-external-api-service-footer"')
    const runtimeError = SETTINGS_SOURCE.indexOf('runtimeErrorMessage(status.runtime.error)', footer)
    const actions = SETTINGS_SOURCE.indexOf('className="dsh-external-api-actions"', footer)

    expect(footer).toBeGreaterThan(-1)
    expect(runtimeError).toBeGreaterThan(footer)
    expect(actions).toBeGreaterThan(runtimeError)
    expect(externalApiStyles).toMatch(
      /\.dsh-external-api-service-footer\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*align-items:\s*center;/su,
    )
  })

  it('distinguishes the all-interface bind address from the loopback access URL', () => {
    expect(SETTINGS_SOURCE).toContain("`${status?.runtime.host ?? '0.0.0.0'}:${runtimePort}`")
    expect(SETTINGS_SOURCE).toContain('`http://127.0.0.1:${runtimePort}/api/v1`')
    expect(SETTINGS_SOURCE).toContain('>实际绑定地址</span>')
    expect(SETTINGS_SOURCE).toContain('>本机访问 URL</span>')
    expect(SETTINGS_SOURCE).toContain("copyText(localAccessUrl, '本机访问 URL 已复制。')")
    expect(SETTINGS_SOURCE).toContain('将 <code>127.0.0.1</code> 替换为这台电脑的局域网 IPv4 地址')
    expect(SETTINGS_SOURCE).not.toContain('`http://${next.runtime.host}:')
  })

  it('explains the LAN security boundary next to the enable control', () => {
    expect(SETTINGS_SOURCE).toContain('启用本机与局域网 API 服务')
    expect(SETTINGS_SOURCE).toContain('所有业务接口都必须携带下方创建的 Bearer Token')
    expect(SETTINGS_SOURCE).toContain('仅应在你信任的家庭或办公局域网中启用')
    expect(SETTINGS_SOURCE).toContain('Windows 防火墙中仅放行受信任网络')
    expect(SETTINGS_SOURCE).toContain('不要通过路由器端口转发、DMZ 或公网 IP 直接暴露')
    expect(SETTINGS_SOURCE).toContain('将页面来源加入 <code>allowedOrigins</code>')
    expect(SETTINGS_SOURCE).not.toContain('首版固定监听 <code>127.0.0.1</code>')
  })
})
