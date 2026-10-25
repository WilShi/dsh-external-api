import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CreatedToken,
  ExternalApiAdminApi,
  ExternalApiStatus,
  ListenerState,
  TokenSummary,
} from './api.ts'
import { ExternalApiAdminError } from './api.ts'
import { externalApiStyles } from './styles.ts'

export interface ExternalApiSettingsFace {
  api: ExternalApiAdminApi
}

const MIN_PORT = 1024
const MAX_PORT = 65_535

function statusLabel(status: ExternalApiStatus | null): { text: string; state: ListenerState } {
  if (status === null) return { text: '正在读取', state: 'stopped' }
  switch (status.runtime.state) {
    case 'running': return { text: '运行中', state: 'running' }
    case 'starting': return { text: '正在启动', state: 'starting' }
    case 'error': return { text: '启动失败', state: 'error' }
    default: return { text: status.config.enabled ? '未运行' : '已关闭', state: 'stopped' }
  }
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function authorizationSummary(ids: string[]): string {
  if (ids.includes('*')) return '全部'
  if (ids.length === 0) return '未授权'
  if (ids.length <= 2) return ids.join('、')
  return `${ids.length} 项`
}

function readableError(cause: unknown): string {
  if (cause instanceof ExternalApiAdminError) {
    switch (cause.code) {
      case 'SETTINGS_CONFLICT': return '配置刚刚被其他窗口修改，请刷新状态后重试。'
      case 'ORIGIN_FORBIDDEN': return '管理请求被安全策略拒绝，请在 DSH Desktop 设置页中操作。'
      case 'HOST_REJECTED': return '当前页面不是受信任的 DSH Desktop 地址。'
      default: return cause.message
    }
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function runtimeErrorMessage(code: string): string {
  switch (code) {
    case 'PORT_IN_USE': return '端口已被其他程序占用，请更换端口后重试。'
    case 'PORT_FORBIDDEN': return '系统不允许监听这个端口，请更换端口后重试。'
    case 'LISTENER_FAILED': return 'API 服务启动失败，请更换端口或重启 DSH 后重试。'
    default: return `API 服务启动失败（${code}）。`
  }
}

export function ExternalApiSettings({ api }: ExternalApiSettingsFace) {
  const [status, setStatus] = useState<ExternalApiStatus | null>(null)
  const [tokens, setTokens] = useState<TokenSummary[]>([])
  const [enabledDraft, setEnabledDraft] = useState(false)
  const [portDraft, setPortDraft] = useState('47831')
  const [configDirty, setConfigDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tokenName, setTokenName] = useState('')
  const [allowAllWorkspaces, setAllowAllWorkspaces] = useState(false)
  const [allowAllAgentPresets, setAllowAllAgentPresets] = useState(false)
  const [creatingToken, setCreatingToken] = useState(false)
  const [revokingToken, setRevokingToken] = useState<string | null>(null)
  const [createdToken, setCreatedToken] = useState<(CreatedToken & { copied: boolean }) | null>(null)
  const secretInputRef = useRef<HTMLInputElement>(null)

  const syncStatus = (next: ExternalApiStatus) => {
    setStatus(next)
    setEnabledDraft(next.config.enabled)
    setPortDraft(String(next.config.port))
    setConfigDirty(false)
  }

  const load = async (background = false) => {
    if (background) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const [nextStatus, nextTokens] = await Promise.all([api.status(), api.listTokens()])
      syncStatus(nextStatus)
      setTokens(nextTokens)
    } catch (cause) {
      setError(readableError(cause))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    void Promise.all([api.status(), api.listTokens()])
      .then(([nextStatus, nextTokens]) => {
        if (!active) return
        syncStatus(nextStatus)
        setTokens(nextTokens)
      })
      .catch((cause: unknown) => { if (active) setError(readableError(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api])

  // A settings section has no chat context. Match the other desktop-owned
  // management sections and hide the composer only while this page is open.
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.externalApiHideComposer = ''
    style.textContent = '[data-composer-seat]{display:none!important}'
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  const parsedPort = Number(portDraft)
  const portValid = Number.isInteger(parsedPort) && parsedPort >= MIN_PORT && parsedPort <= MAX_PORT
  const runtimePort = status?.runtime.state === 'running'
    ? status.runtime.port ?? status.config.port
    : null
  const actualBindAddress = runtimePort === null
    ? '当前未监听'
    : `${status?.runtime.host ?? '0.0.0.0'}:${runtimePort}`
  const localAccessUrl = runtimePort === null ? null : `http://127.0.0.1:${runtimePort}/api/v1`
  const localAccessText = localAccessUrl ?? '服务启动后可用'
  const badge = statusLabel(status)
  const configAction = status?.config.enabled
    ? enabledDraft
      ? '保存并应用'
      : '关闭服务'
    : enabledDraft
      ? '启用服务'
      : '保存配置'

  const saveConfig = async () => {
    if (!portValid || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const next = await api.updateConfig({ enabled: enabledDraft, port: parsedPort })
      syncStatus(next)
      if (next.runtime.state === 'error' && next.runtime.error !== undefined) {
        setNotice(null)
      } else {
        setNotice(next.runtime.state === 'running'
          ? `服务已在 ${next.runtime.url ?? `http://127.0.0.1:${next.runtime.port ?? next.config.port}`} 运行。`
          : next.config.enabled
            ? '配置已保存，服务正在启动。'
            : '服务已关闭，Token 已保留，可在下次启用时继续使用。')
      }
    } catch (cause) {
      setError(readableError(cause))
    } finally {
      setSaving(false)
    }
  }

  const copyText = async (value: string, success: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(success)
      return true
    } catch {
      setError('自动复制失败，请选中文本后按 Ctrl+C。')
      return false
    }
  }

  const createToken = async () => {
    const name = tokenName.trim()
    if (name === '' || creatingToken) return
    setCreatingToken(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.createToken({
        name,
        allowedWorkspaceIds: allowAllWorkspaces ? ['*'] : [],
        allowedAgentPresets: allowAllAgentPresets ? ['*'] : [],
      })
      setTokens((current) => [result.token, ...current.filter((item) => item.id !== result.token.id)])
      setCreatedToken({ ...result, copied: false })
      setTokenName('')
      setAllowAllWorkspaces(false)
      setAllowAllAgentPresets(false)
    } catch (cause) {
      setError(readableError(cause))
    } finally {
      setCreatingToken(false)
    }
  }

  const revokeToken = async (token: TokenSummary) => {
    if (revokingToken !== null) return
    if (!window.confirm(`撤销 Token“${token.name}”？使用它的应用将立即无法访问 API。`)) return
    setRevokingToken(token.id)
    setError(null)
    setNotice(null)
    try {
      await api.revokeToken(token.id)
      setTokens((current) => current.filter((item) => item.id !== token.id))
      setNotice(`已撤销 Token“${token.name}”。`)
    } catch (cause) {
      setError(readableError(cause))
    } finally {
      setRevokingToken(null)
    }
  }

  const closeSecret = () => {
    if (createdToken === null) return
    if (!createdToken.copied
      && !window.confirm('这个 Token 尚未复制。关闭后将无法再次查看，确定继续吗？')) return
    setCreatedToken(null)
  }

  const copySecret = async () => {
    if (createdToken === null) return
    const copied = await copyText(createdToken.secret, 'Token 已复制到剪贴板。')
    if (copied) setCreatedToken((current) => current === null ? null : { ...current, copied: true })
    else secretInputRef.current?.select()
  }

  const sortedTokens = useMemo(() => [...tokens].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime()
    const rightTime = new Date(right.createdAt).getTime()
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
  }), [tokens])

  return (
    <div className="dsh-external-api-root" data-external-api-settings>
      <style data-external-api-styles>{externalApiStyles}</style>
      <main className="dsh-external-api-page">
        <header className="dsh-external-api-heading">
          <div>
            <h2>API 服务</h2>
            <p>让本机应用或受信任局域网内的设备通过 HTTP API 调用 DSH。监听端口与访问凭证由你控制。</p>
          </div>
          <span className="dsh-external-api-status-badge" data-state={badge.state}>{badge.text}</span>
        </header>

        {error !== null ? <div className="dsh-external-api-banner" data-kind="error" role="alert">{error}</div> : null}
        {notice !== null ? <div className="dsh-external-api-banner" data-kind="success" role="status">{notice}</div> : null}

        {loading ? <div className="dsh-external-api-card dsh-external-api-loading">正在加载 API 服务配置…</div> : (
          <>
            <section className="dsh-external-api-card dsh-external-api-service-card" aria-labelledby="external-api-service-title">
              <div className="dsh-external-api-switch-row">
                <div className="dsh-external-api-switch-copy">
                  <strong id="external-api-service-title">启用本机与局域网 API 服务</strong>
                  <span>开启后监听所有 IPv4 网络接口；关闭或再次启用不会改变已有 Token。</span>
                </div>
                <input
                  className="dsh-external-api-switch"
                  type="checkbox"
                  role="switch"
                  aria-label="启用本机与局域网 API 服务"
                  checked={enabledDraft}
                  disabled={saving}
                  onChange={(event) => { setEnabledDraft(event.target.checked); setConfigDirty(true); setNotice(null) }}
                />
              </div>

              <div className="dsh-external-api-config-grid">
                <label className="dsh-external-api-field">
                  <span className="dsh-external-api-label">监听端口</span>
                  <input
                    className="dsh-external-api-input dsh-external-api-input-mono"
                    type="number"
                    inputMode="numeric"
                    min={MIN_PORT}
                    max={MAX_PORT}
                    step={1}
                    value={portDraft}
                    disabled={saving}
                    aria-invalid={!portValid}
                    onChange={(event) => { setPortDraft(event.target.value); setConfigDirty(true); setNotice(null) }}
                  />
                  <span className="dsh-external-api-help">可用范围 {MIN_PORT}–{MAX_PORT}；首次启动端口冲突会失败，运行中换端口失败则继续使用原地址。</span>
                </label>

                <div className="dsh-external-api-field">
                  <span className="dsh-external-api-label">实际绑定地址</span>
                  <div className="dsh-external-api-address">
                    <code title={actualBindAddress}>{actualBindAddress}</code>
                  </div>
                  <div className="dsh-external-api-access-details">
                    <div className="dsh-external-api-local-url">
                      <span>本机访问 URL</span>
                      <code title={localAccessText}>{localAccessText}</code>
                      <button
                        type="button"
                        className="dsh-external-api-link-button"
                        disabled={localAccessUrl === null}
                        onClick={() => { if (localAccessUrl !== null) void copyText(localAccessUrl, '本机访问 URL 已复制。') }}
                      >复制</button>
                    </div>
                    <span className="dsh-external-api-help">局域网设备访问时，请将 <code>127.0.0.1</code> 替换为这台电脑的局域网 IPv4 地址。</span>
                  </div>
                </div>
              </div>

              <div className="dsh-external-api-service-footer">
                {status?.runtime.error !== undefined ? (
                  <div className="dsh-external-api-banner" data-kind="error" role="alert">{runtimeErrorMessage(status.runtime.error)}</div>
                ) : null}

                <div className="dsh-external-api-actions">
                  <Button size="sm" disabled={saving || refreshing} onClick={() => { void load(true) }}>
                    {refreshing ? '刷新中…' : '刷新状态'}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={saving || !portValid || (!configDirty && status?.runtime.state !== 'error')}
                    onClick={() => { void saveConfig() }}
                  >{saving ? '应用中…' : configAction}</Button>
                </div>
              </div>
            </section>

            <aside className="dsh-external-api-security" aria-label="安全说明">
              <strong>安全边界</strong>
              <ul>
                <li>所有业务接口都必须携带下方创建的 Bearer Token；请按应用分别创建，停用应用时及时撤销。</li>
                <li>服务会绑定 <code>0.0.0.0</code>，仅应在你信任的家庭或办公局域网中启用。</li>
                <li>局域网设备请使用这台电脑的局域网 IPv4 地址，并在 Windows 防火墙中仅放行受信任网络。</li>
                <li>不要通过路由器端口转发、DMZ 或公网 IP 直接暴露此 HTTP 服务；远程访问应使用受信任的 TLS 反向代理。</li>
                <li>浏览器网页调用还需将页面来源加入 <code>allowedOrigins</code>；非浏览器客户端不受该项限制。</li>
              </ul>
            </aside>

            <section className="dsh-external-api-card" aria-labelledby="external-api-token-title">
              <div className="dsh-external-api-card-heading">
                <div>
                  <h3 id="external-api-token-title">访问 Token</h3>
                  <p>每个调用方使用独立 Token，便于审计和单独撤销。Token 明文只在创建后显示一次。</p>
                </div>
              </div>

              <div className="dsh-external-api-token-form">
                <label className="dsh-external-api-field">
                  <span className="dsh-external-api-label">Token 名称</span>
                  <input
                    className="dsh-external-api-input"
                    type="text"
                    maxLength={64}
                    value={tokenName}
                    placeholder="例如：数据分析脚本"
                    disabled={creatingToken}
                    onChange={(event) => setTokenName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void createToken() }}
                  />
                </label>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={creatingToken || tokenName.trim() === ''}
                  onClick={() => { void createToken() }}
                >{creatingToken ? '创建中…' : '创建 Token'}</Button>
              </div>

              <fieldset className="dsh-external-api-permissions" disabled={creatingToken}>
                <legend>资源授权（默认不授权）</legend>
                <label className="dsh-external-api-permission-option">
                  <input
                    type="checkbox"
                    checked={allowAllWorkspaces}
                    onChange={(event) => setAllowAllWorkspaces(event.target.checked)}
                  />
                  <span>
                    <strong>允许使用所有工作区</strong>
                    <small>可发现当前及以后新增的工作区，并在其中创建会话。</small>
                  </span>
                </label>
                <label className="dsh-external-api-permission-option">
                  <input
                    type="checkbox"
                    checked={allowAllAgentPresets}
                    onChange={(event) => setAllowAllAgentPresets(event.target.checked)}
                  />
                  <span>
                    <strong>允许使用所有 Agent Preset</strong>
                    <small>可发现当前及以后新增的 Agent Preset，并用于创建会话。</small>
                  </span>
                </label>
                <p>未勾选的资源类型对新 Token 不可见。可按最小权限创建，需要更改时请撤销并重新创建。</p>
              </fieldset>

              {sortedTokens.length === 0 ? (
                <div className="dsh-external-api-empty">还没有 Token。创建一个后即可开始调用。</div>
              ) : (
                <div className="dsh-external-api-token-list" aria-label="Token 列表">
                  {sortedTokens.map((token) => (
                    <article className="dsh-external-api-token-row" key={token.id}>
                      <div className="dsh-external-api-token-name">
                        <strong title={token.name}>{token.name}</strong>
                        <span className="dsh-external-api-mono">{token.prefix}</span>
                      </div>
                      <div className="dsh-external-api-token-meta">
                        创建：{formatTime(token.createdAt)}
                      </div>
                      <div className="dsh-external-api-token-access">
                        <span>工作区：{authorizationSummary(token.allowedWorkspaceIds)}</span>
                        <span>Agent Preset：{authorizationSummary(token.allowedAgentPresets)}</span>
                        <span title={token.scopes.join(', ')}>接口权限：{token.scopes.length} 项</span>
                      </div>
                      <button
                        type="button"
                        className="dsh-external-api-link-button"
                        disabled={revokingToken !== null}
                        onClick={() => { void revokeToken(token) }}
                      >{revokingToken === token.id ? '撤销中…' : '撤销'}</button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {createdToken !== null ? (
        <div className="dsh-external-api-overlay" role="presentation">
          <section className="dsh-external-api-dialog" role="dialog" aria-modal="true" aria-labelledby="external-api-secret-title">
            <h3 id="external-api-secret-title">保存新 Token</h3>
            <p className="dsh-external-api-secret-warning">这是唯一一次显示完整 Token。请立即复制到调用方的安全配置中；DSH 不会再次回显。</p>
            {error !== null ? <div className="dsh-external-api-banner" data-kind="error" role="alert">{error}</div> : null}
            <label className="dsh-external-api-field">
              <span className="dsh-external-api-label">{createdToken.token.name}</span>
              <span className="dsh-external-api-secret-row">
                <input
                  ref={secretInputRef}
                  className="dsh-external-api-input dsh-external-api-input-mono"
                  type="text"
                  readOnly
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                  value={createdToken.secret}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button size="sm" variant="primary" onClick={() => { void copySecret() }}>
                  {createdToken.copied ? '已复制' : '复制 Token'}
                </Button>
              </span>
            </label>
            <div className="dsh-external-api-actions">
              <Button size="sm" onClick={closeSecret}>{createdToken.copied ? '我已保存，关闭' : '关闭'}</Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
