/**
 * dsh-annotate — Client half.
 *
 * Watches the built-in browser's Electron <webview> guests. For every loopback
 * page it injects the self-contained agentation bundle and tells it where to
 * submit. The owning Session is read from the Sidebar's own session marker, so
 * feedback always lands in the conversation the Browser tab belongs to.
 *
 * This file is written directly in the DSH client-module format; it has no
 * imports and needs no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-annotate',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports

    /**
     * Report one activation stage to the Host. This runs before any dependency
     * is loaded: when the bundle itself or React is rejected, the Host still
     * sees how far the factory got.
     */
    function reportBoot(stage, error, detail) {
      try {
        const base = typeof document !== 'undefined' && typeof document.baseURI === 'string'
          ? document.baseURI
          : 'http://dsh.internal/'
        void fetch(new URL('dsh-annotate/boot', base).href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stage,
            error: error === undefined ? undefined : String(error !== null && error !== undefined && error.message ? error.message : error).slice(0, 500),
            detail: detail === undefined ? undefined : String(detail).slice(0, 500),
            at: Date.now(),
          }),
          keepalive: true,
        }).catch(() => {})
      } catch { /* diagnostics must never break activation */ }
    }

    reportBoot('module')
    const React = require('react')
    const h = React.createElement

    const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
    const TAG = '[dsh-annotate]'
    const SETTINGS_NS = 'dshAnnotate'

    const DICTS = {
      zh: {
        settingsNav: '网页批注',
        title: '网页批注',
        desc: '在内置浏览器里点选页面元素、写批注，反馈会作为一条用户消息进入该标签所属的当前对话。',
        current: '当前版本',
        latest: '上游版本',
        check: '检查更新',
        recheck: '重新检查',
        checking: '正在检查上游版本…',
        update: '更新到 v{version}',
        updating: '正在下载并重新打包，约需几秒…',
        updatingButton: '更新中…',
        latestNow: '已是最新版本',
        newVersion: '发现新版本 v{version}',
        notInstallable: '上游有 v{version}，但 npm 还没发布对应的包，暂时无法自动更新',
        done: '已更新到 v{version}。刷新被批注的页面后生效。',
        restartNeeded: '更新服务还没就绪：重启一次 DSH 后可用。',
        failed: '操作失败：{message}',
        setupTitle: '初始化更新依赖',
        setupDesc: '网页批注本身不需要初始化。只有“检查更新/更新”需要在本机重新打包，依赖 esbuild、react、react-dom（约 20 MB）。',
        setupMissing: '缺少：{list}',
        setupButton: '初始化',
        setupRunning: '正在安装，可能需要几十秒…',
        setupDone: '构建依赖已就绪。',
        setupManual: '无法自动安装，请在插件目录执行：',
        setupFailed: '初始化失败：{message}',
        repo: 'agentation GitHub 仓库',
        refreshNote: '更新只替换注入脚本里的 agentation 依赖，不改动它的源码；已打开的页面刷新后才会用上新版本。',
      },
      en: {
        settingsNav: 'Page annotate',
        title: 'Page annotate',
        desc: 'Click elements in the built-in browser and write notes; the feedback arrives as a user message in the conversation that owns the tab.',
        current: 'Current',
        latest: 'Upstream',
        check: 'Check for updates',
        recheck: 'Check again',
        checking: 'Checking upstream…',
        update: 'Update to v{version}',
        updating: 'Downloading and rebuilding, a few seconds…',
        updatingButton: 'Updating…',
        latestNow: 'Up to date',
        newVersion: 'v{version} is available',
        notInstallable: 'Upstream has v{version}, but npm has not published it yet, so it cannot be installed automatically',
        done: 'Updated to v{version}. Reload annotated pages to use it.',
        restartNeeded: 'The update service is not ready yet: restart DSH once.',
        failed: 'Failed: {message}',
        setupTitle: 'Set up the update toolchain',
        setupDesc: 'Annotations need no setup. Only Check / Update rebuilds locally and needs esbuild, react, and react-dom (about 20 MB).',
        setupMissing: 'Missing: {list}',
        setupButton: 'Set up',
        setupRunning: 'Installing, this can take a while…',
        setupDone: 'The build toolchain is ready.',
        setupManual: 'Automatic setup failed. Run this in the plugin directory:',
        setupFailed: 'Setup failed: {message}',
        repo: 'agentation on GitHub',
        refreshNote: 'Updating only replaces the bundled agentation dependency; its source is untouched. Open pages pick it up after a reload.',
      },
    }

    // Fall back to Chinese so a locale failure still renders a usable label.
    let translate = key => (DICTS.zh[key] !== undefined ? DICTS.zh[key] : key)
    function t(key, params) { return translate(key, params) }

    const state = {
      enabled: true,
      hosts: [],
      configLoaded: false,
      bundle: undefined,
      seen: new WeakSet(),
      inflight: new WeakSet(),
      injected: 0,
      skipped: 0,
      lastError: '',
      locale: undefined,
    }

    let configResolve
    state.configReady = new Promise(resolve => { configResolve = resolve })

    /* ----------------------------------------------------------- transports */

    /** Directory base for relative routes; keeps reverse-proxy prefixes. */
    function directoryBase(raw) {
      const fallback = typeof location !== 'undefined' ? location.href : 'http://dsh.internal/'
      const url = new URL(raw === undefined || raw === '' ? fallback : raw, fallback)
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return url.href
    }

    /** Same-origin base the DSH page itself uses (desktop shell: dsh-app://app/). */
    function pageBase() {
      if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
        return document.baseURI
      }
      return typeof location !== 'undefined' ? location.href : 'http://dsh.internal/'
    }

    function routeUrl(path) {
      return new URL(path.replace(/^\/+/, ''), directoryBase(pageBase())).href
    }

    /**
     * The Electron guest cannot request the application Host: its session
     * cancels every http/ws request whose hostname is the Host's own hostname,
     * "localhost", "127.0.0.1" or "[::1]" on the Host port. The IPv4-mapped IPv6
     * spelling of loopback reaches the same listener while carrying a different
     * hostname, so the guard does not match it. Same port, same route, same
     * token — only the URL spelling differs.
     */
    function mappedLoopback(href) {
      let url
      try {
        url = new URL(href)
      } catch {
        return undefined
      }
      const host = url.hostname
      if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') {
        url.hostname = '[::ffff:127.0.0.1]'
        return url.href
      }
      return href
    }

    /** Real HTTP(S) base of the Host, as seen from this page. */
    function httpBase() {
      const transport = globalThis.__DSH_TRANSPORT__
      if (transport !== null && transport !== undefined
        && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl !== '') {
        return transport.streamBaseUrl
      }
      if (typeof location !== 'undefined' && (location.protocol === 'http:' || location.protocol === 'https:')) {
        return pageBase()
      }
      return undefined
    }

    /** Ordered, deduplicated submit routes: mapped loopback first, plain second. */
    function submitCandidates(fromHost) {
      const seen = new Set()
      const out = []
      const add = (href) => {
        if (href === undefined || href === '' || seen.has(href)) return
        if (!/^https?:\/\//i.test(href)) return
        seen.add(href)
        out.push(href)
      }
      const base = httpBase()
      if (base !== undefined) {
        const plain = new URL('dsh-annotate/submit', directoryBase(base)).href
        add(mappedLoopback(plain))
        add(plain)
      }
      if (typeof fromHost === 'string' && fromHost !== '') {
        add(mappedLoopback(fromHost))
        add(fromHost)
      }
      return out
    }

    /* --------------------------------------------------------------- config */

    async function loadConfig() {
      try {
        const response = await fetch(routeUrl('dsh-annotate/config'), { cache: 'no-store' })
        if (response.ok) {
          const data = await response.json()
          if (data !== null && typeof data === 'object' && data.ok === true) {
            state.enabled = data.enabled !== false
            state.hosts = Array.isArray(data.hosts) ? data.hosts : []
          }
        }
      } catch (error) {
        state.lastError = String(error && error.message || error)
      } finally {
        state.configLoaded = true
        configResolve()
      }
    }

    function hostAllowed(hostname) {
      const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
      if (host === '') return false
      if (state.hosts.length === 0) {
        return LOOPBACK.has(host) || host.endsWith('.localhost')
      }
      return state.hosts.some(entry => {
        const pattern = String(entry || '').toLowerCase()
        if (pattern === '') return false
        if (pattern.startsWith('*.')) {
          const suffix = pattern.slice(1)
          return host === pattern.slice(2) || host.endsWith(suffix)
        }
        return host === pattern
      })
    }

    function pageUrlAllowed(raw) {
      let url
      try {
        url = new URL(raw)
      } catch {
        return false
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      if (!hostAllowed(url.hostname)) return false
      // Never annotate the DSH application itself (the built-in browser rejects
      // it anyway, but a manual URL could still slip through).
      try {
        const own = httpBase()
        if (own !== undefined && url.origin === new URL(own).origin) return false
      } catch { /* keep going */ }
      return true
    }

    /* --------------------------------------------------------------- bundle */

    async function loadBundle() {
      const response = await fetch(routeUrl('dsh-annotate/inject.js'), { cache: 'no-store' })
      if (!response.ok) throw new Error('inject.js answered HTTP ' + response.status)
      const source = await response.text()
      if (source.length < 1000) throw new Error('inject.js is unexpectedly small')
      return source
    }

    async function mintToken(sessionId, origin) {
      const response = await fetch(routeUrl('dsh-annotate/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, origin }),
      })
      const data = await response.json().catch(() => undefined)
      if (!response.ok || data === undefined || data.ok !== true) {
        throw new Error('token route: ' + (data && data.error || ('HTTP ' + response.status)))
      }
      return {
        token: data.token,
        submitUrl: typeof data.submitUrl === 'string' && data.submitUrl !== '' ? data.submitUrl : undefined,
      }
    }

    /* ------------------------------------------------------------ injection */

    function sessionOf(element) {
      const owner = element.closest && element.closest('[data-sidebar-right-session]')
      return owner === null || owner === undefined ? undefined : owner.dataset.sidebarRightSession
    }

    function guestUrl(element) {
      try {
        const url = element.getURL()
        return typeof url === 'string' && url !== '' ? url : undefined
      } catch {
        return undefined
      }
    }

    async function tryInject(element) {
      if (!state.configLoaded) await state.configReady
      if (!state.enabled || state.inflight.has(element)) return
      state.inflight.add(element)
      try {
        const url = guestUrl(element)
        if (url === undefined || !pageUrlAllowed(url)) {
          state.skipped++
          return
        }
        const sessionId = sessionOf(element)
        if (sessionId === undefined) {
          state.skipped++
          return
        }
        if (typeof element.executeJavaScript !== 'function') {
          state.lastError = 'webview.executeJavaScript is unavailable in this carrier'
          console.warn(TAG, state.lastError)
          return
        }
        const [bundle, minted] = await Promise.all([
          loadBundle(),
          mintToken(sessionId, new URL(url).origin),
        ])
        if (guestUrl(element) !== url) return
        const options = {
          submitUrls: submitCandidates(minted.submitUrl),
          token: minted.token,
          appName: 'DSH',
        }
        const code = bundle + '\n;window.__dshAnnotate.mount(' + JSON.stringify(options) + ');'
        const result = await element.executeJavaScript(code, false)
        if (result !== null && typeof result === 'object' && result.ok === false) {
          throw new Error('agentation mount returned not ok')
        }
        state.injected++
        console.info(TAG, 'annotation toolbar ready for', url, '-> session', sessionId)
      } catch (error) {
        state.lastError = String(error && error.message || error)
        console.debug(TAG, 'injection skipped:', state.lastError)
      } finally {
        state.inflight.delete(element)
      }
    }

    function attach(element) {
      if (state.seen.has(element)) return
      state.seen.add(element)
      element.addEventListener('dom-ready', () => { void tryInject(element) })
      // A tab created before this plugin activated may already be ready.
      queueMicrotask(() => {
        let loading = true
        try { loading = element.isLoading() } catch { /* assume ready */ }
        if (!loading) void tryInject(element)
      })
    }

    function scan() {
      for (const element of document.querySelectorAll('webview[data-sidebar-browser-frame]')) {
        attach(element)
      }
    }

    /** Coalesce scans; the chat streams DOM mutations on almost every token. */
    let scanScheduled = false
    function scheduleScan() {
      if (scanScheduled) return
      scanScheduled = true
      const run = () => { scanScheduled = false; scan() }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else setTimeout(run, 16)
    }

    function addedBrowserFrame(records) {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue
          if (typeof node.matches === 'function' && node.matches('webview[data-sidebar-browser-frame]')) return true
          if (typeof node.querySelector === 'function' && node.querySelector('webview[data-sidebar-browser-frame]') !== null) return true
        }
      }
      return false
    }


    /* -------------------------------------------------------------- updater */

    /** Same-origin, cookie-authenticated Host route for the settings card. */
    async function requestHost(method, route, body) {
      const response = await fetch(routeUrl('dsh-annotate/' + route), {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
      if (response.status === 404) {
        const missing = new Error('update route is missing')
        missing.code = 'route-missing'
        throw missing
      }
      const data = await response.json().catch(() => undefined)
      if (!response.ok || data === null || typeof data !== 'object' || data.ok !== true) {
        throw new Error(data !== null && typeof data === 'object' && data.error ? data.error : 'HTTP ' + response.status)
      }
      return data
    }

    function messageOf(error) {
      if (error !== null && typeof error === 'object' && error.code === 'route-missing') return t('restartNeeded')
      return String(error !== null && error !== undefined && error.message ? error.message : error)
    }

    /** Re-render the card when the host locale switches. */
    function useLocaleTick() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const locale = state.locale
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => { setTick(n => n + 1) })
      }, [])
    }

    function AnnotationIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 32 32', fill: 'none', 'aria-hidden': true,
      },
      h('path', {
        d: 'M7 5h18a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-7.5L11 28v-5H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z',
        stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round',
      }),
      h('circle', { cx: 14.5, cy: 14, r: 3.4, stroke: 'currentColor', strokeWidth: 1.8 }),
      h('path', {
        d: 'M14.5 8.6v2.1M14.5 17.3v2.1M9.1 14h2.1M17.8 14h2.1',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
      }))
    }

    const SECTION_CSS = `
      .dsh-ann-section { display:flex; flex-direction:column; gap:14px; padding:8px 0; color:var(--dsw-alias-label-primary); font-size:13px; line-height:22px; }
      .dsh-ann-title { font-size:15px; font-weight:600; line-height:24px; }
      .dsh-ann-desc { color:var(--dsw-alias-label-tertiary); }
      .dsh-ann-card { display:flex; flex-direction:column; gap:10px; padding:12px 16px; border:0.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-xl); background:var(--dsw-alias-settings-card-fill); }
      .dsh-ann-row { display:flex; align-items:center; justify-content:space-between; gap:16px; min-width:0; }
      .dsh-ann-label { color:var(--dsw-alias-label-secondary); }
      .dsh-ann-version { font-variant-numeric:tabular-nums; }
      .dsh-ann-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .dsh-ann-button { appearance:none; border:0.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md); padding:5px 12px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:20px; cursor:pointer; }
      .dsh-ann-button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
      .dsh-ann-button:disabled { opacity:.45; cursor:default; }
      .dsh-ann-primary { border-color:var(--dsw-alias-button-primary-fill); background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); }
      .dsh-ann-primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); }
      .dsh-ann-status { min-height:22px; color:var(--dsw-alias-label-secondary); }
      .dsh-ann-status-error { color:var(--dsw-alias-state-error-primary); }
      .dsh-ann-code { margin:0; padding:8px 10px; border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-skeleton); color:var(--dsw-alias-label-secondary); font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-all; }
      .dsh-ann-link { color:var(--dsw-alias-brand-primary); text-decoration:none; width:fit-content; }
      .dsh-ann-link:hover { text-decoration:underline; }
    `

    function AnnotationSettings() {
      useLocaleTick()
      const [view, setView] = React.useState({
        phase: 'checking', current: null, latest: null, updateAvailable: false, error: '',
      })
      const [env, setEnv] = React.useState(null)
      const [setupPhase, setSetupPhase] = React.useState('idle')
      const [setupError, setSetupError] = React.useState('')
      const [setupManual, setSetupManual] = React.useState('')
      const alive = React.useRef(true)

      const runCheck = async () => {
        setView(previous => ({ ...previous, phase: 'checking', error: '' }))
        try {
          const data = await requestHost('POST', 'update/check')
          if (!alive.current) return
          setView({
            phase: 'checked',
            current: data.current ?? null,
            latest: data.latest ?? null,
            updateAvailable: data.updateAvailable === true,
            error: '',
          })
        } catch (error) {
          if (!alive.current) return
          setView(previous => ({ ...previous, phase: 'checked', error: messageOf(error) }))
        }
      }

      const runSetup = async () => {
        setSetupPhase('running')
        setSetupError('')
        setSetupManual('')
        try {
          const data = await requestHost('POST', 'update/setup')
          if (!alive.current) return
          if (data.ready === true) {
            setEnv({ ready: true, missing: [] })
            setSetupPhase('done')
            await runCheck()
          } else {
            setEnv({
              ready: false,
              missing: Array.isArray(data.missing) ? data.missing : [],
              manual: typeof data.manual === 'string' ? data.manual : undefined,
            })
            setSetupPhase('idle')
            if (typeof data.manual === 'string') setSetupManual(data.manual)
            if (typeof data.error === 'string') setSetupError(data.error)
          }
        } catch (error) {
          if (!alive.current) return
          setSetupPhase('idle')
          setSetupError(messageOf(error))
        }
      }

      React.useEffect(() => {
        alive.current = true
        void (async () => {
          try {
            const info = await requestHost('GET', 'update')
            if (alive.current) setView(previous => ({ ...previous, current: info.current ?? null }))
          } catch { /* runCheck below reports the real failure */ }
          try {
            const info = await requestHost('GET', 'update/env')
            if (alive.current) {
              setEnv({
                ready: info.ready === true,
                missing: Array.isArray(info.missing) ? info.missing : [],
                manual: typeof info.manual === 'string' ? info.manual : undefined,
              })
            }
          } catch { /* the card still explains the restart case via check */ }
          await runCheck()
        })()
        return () => { alive.current = false }
      }, [])

      const applyUpdate = async () => {
        const version = view.latest !== null && typeof view.latest.version === 'string' ? view.latest.version : undefined
        if (version === undefined) return
        setView(previous => ({ ...previous, phase: 'updating', error: '' }))
        try {
          const data = await requestHost('POST', 'update/apply', { version })
          if (!alive.current) return
          setView({
            phase: 'done',
            current: data.current ?? { version },
            latest: view.latest,
            updateAvailable: false,
            error: '',
          })
        } catch (error) {
          if (!alive.current) return
          setView(previous => ({ ...previous, phase: 'checked', error: messageOf(error) }))
        }
      }

      const installable = view.latest !== null && view.latest.installable === view.latest.version
      let status = ''
      let statusError = false
      if (view.error !== '') {
        status = view.error
        statusError = true
      } else if (view.phase === 'checking') {
        status = t('checking')
      } else if (view.phase === 'updating') {
        status = t('updating')
      } else if (view.phase === 'done') {
        status = t('done', { version: view.current !== null && view.current.version ? view.current.version : '' })
      } else if (view.phase === 'checked' && view.latest !== null) {
        if (view.updateAvailable && installable) status = t('newVersion', { version: view.latest.version })
        else if (view.updateAvailable) status = t('notInstallable', { version: view.latest.version })
        else status = t('latestNow')
      }

      const busy = view.phase === 'checking' || view.phase === 'updating'
      return h('div', { className: 'dsh-ann-section' },
        h('style', null, SECTION_CSS),
        h('div', { className: 'dsh-ann-title' }, t('title')),
        h('div', { className: 'dsh-ann-desc' }, t('desc')),
        env !== null && env.ready === false
          ? h('div', { className: 'dsh-ann-card' },
            h('div', { className: 'dsh-ann-title' }, t('setupTitle')),
            h('div', { className: 'dsh-ann-desc' }, t('setupDesc')),
            h('div', { className: 'dsh-ann-label' },
              t('setupMissing', { list: (env.missing ?? []).join(', ') })),
            h('div', { className: 'dsh-ann-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-ann-button dsh-ann-primary',
                disabled: setupPhase === 'running',
                onClick: () => { void runSetup() },
              }, setupPhase === 'running' ? t('setupRunning') : t('setupButton'))),
            setupPhase === 'done' ? h('div', { className: 'dsh-ann-status' }, t('setupDone')) : null,
            setupError !== '' ? h('div', { className: 'dsh-ann-status dsh-ann-status-error' },
              t('setupFailed', { message: setupError })) : null,
            setupManual !== '' ? h('div', null,
              h('div', { className: 'dsh-ann-label' }, t('setupManual')),
              h('pre', { className: 'dsh-ann-code' }, setupManual)) : null)
          : null,
        h('div', { className: 'dsh-ann-card' },
          h('div', { className: 'dsh-ann-row' },
            h('span', { className: 'dsh-ann-label' }, t('current')),
            h('span', { className: 'dsh-ann-version' },
              view.current !== null && view.current.version
                ? 'agentation ' + view.current.version
                : '…')),
          view.latest !== null && view.latest.version
            ? h('div', { className: 'dsh-ann-row' },
              h('span', { className: 'dsh-ann-label' }, t('latest')),
              h('span', { className: 'dsh-ann-version' }, 'v' + view.latest.version))
            : null,
          h('div', { className: 'dsh-ann-actions' },
            h('button', {
              type: 'button', className: 'dsh-ann-button',
              disabled: busy,
              onClick: () => { void runCheck() },
            }, view.phase === 'checking' ? t('checking') : t('recheck')),
            view.updateAvailable && installable
              ? h('button', {
                type: 'button', className: 'dsh-ann-button dsh-ann-primary',
                disabled: busy,
                onClick: () => { void applyUpdate() },
              }, view.phase === 'updating'
                ? t('updatingButton')
                : t('update', { version: view.latest.version }))
              : null),
          h('div', {
            className: 'dsh-ann-status' + (statusError ? ' dsh-ann-status-error' : ''),
            role: 'status',
          }, status)),
        h('div', { className: 'dsh-ann-desc' }, t('refreshNote')),
        h('a', {
          className: 'dsh-ann-link',
          href: 'https://github.com/benjitaylor/agentation',
          target: '_blank',
          rel: 'noreferrer',
        }, t('repo')))
    }

    /* --------------------------------------------------------------- apply */

    function apply(ctx) {
      reportBoot('apply')
      try {
        if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
          ctx.effect(() => ctx.locale.register(SETTINGS_NS, DICTS), 'dsh-annotate: dictionaries')
          translate = ctx.locale.bind(SETTINGS_NS)
          state.locale = ctx.locale
          reportBoot('locale')
        } else {
          reportBoot('locale:missing')
        }
      } catch (error) {
        reportBoot('locale:error', error)
      }

      try {
        if (ctx.slots !== undefined && typeof ctx.slots.inject === 'function') {
          // Register the section before its icon: one failing registration must
          // not hide the other.
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-annotate',
            order: 120,
            label: () => t('settingsNav'),
          }, AnnotationSettings))
          try {
            ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
              name: 'settings.section.icon',
              id: 'dsh-annotate',
              order: 120,
              label: () => t('settingsNav'),
            }, AnnotationIcon))
          } catch (error) {
            reportBoot('settings:icon-error', error)
          }
          let ids = ''
          try {
            const rows = typeof ctx.slots.entries === 'function' ? ctx.slots.entries('settings.section') : undefined
            if (Array.isArray(rows)) ids = rows.map(row => String(row && row.id)).join(',')
          } catch { /* reporting only */ }
          reportBoot('settings', undefined, ids)
        } else {
          reportBoot('settings:missing-slots')
        }
      } catch (error) {
        reportBoot('settings:error', error)
      }

      try {
        ctx.effect(() => {
          void loadConfig().then(scan)
          const observer = new MutationObserver(records => {
            if (addedBrowserFrame(records)) scheduleScan()
          })
          observer.observe(document.documentElement, { childList: true, subtree: true })
          scan()
          Object.defineProperty(window, '__dshAnnotateClient', {
            configurable: true,
            value: {
              status: () => ({
                enabled: state.enabled,
                hosts: state.hosts,
                injected: state.injected,
                skipped: state.skipped,
                lastError: state.lastError,
                frames: document.querySelectorAll('webview[data-sidebar-browser-frame]').length,
              }),
              injectNow: async () => {
                const frames = document.querySelectorAll('webview[data-sidebar-browser-frame]')
                await Promise.all(Array.from(frames, frame => tryInject(frame)))
              },
            },
          })
          return () => {
            observer.disconnect()
            try { delete window.__dshAnnotateClient } catch { /* ignore */ }
          }
        }, 'dsh-annotate: built-in browser frames')
        reportBoot('watch')
      } catch (error) {
        reportBoot('watch:error', error)
      }
    }

    // Cordis services this client half reads. Without them, `ctx.locale` and
    // `ctx.slots` throw "cannot get property ... without inject".
    exports.inject = ['locale', 'slots']
    exports.apply = apply
    return module.exports
  },
})
