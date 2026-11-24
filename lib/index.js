/**
 * dsh-annotate — Host half.
 *
 * The browser half injects agentation into loopback pages shown by DSH's
 * built-in browser. agentation's "Send to Agent" reaches this half through a
 * token-gated loopback route, and this half appends the feedback to the
 * Session that owns the Browser tab by prompting that Session directly.
 *
 * Nothing here creates a Session: annotations always land in the conversation
 * the Browser tab already belongs to.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createUpdater } from './update.js'

/** Self-contained IIFE built from src/inject.tsx (React + ReactDOM + agentation). */
const INJECT_URL = new URL('./inject.js', import.meta.url)

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000
const MAX_BODY_BYTES = 512 * 1024
const MAX_MARKDOWN_CHARS = 120_000
const MAX_SESSION_ID_CHARS = 200

/** @type {Map<string, { sessionId: string, origin: string, expiresAt: number }>} */
const tokens = new Map()

function pruneTokens(now = Date.now()) {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token)
  }
}

function corsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-max-age', '600')
}

function sendJson(res, status, value, withCors = false) {
  if (withCors) corsHeaders(res)
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req, limit) {
  const text = await readBody(req, limit)
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function validSessionId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID_CHARS
    && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Compose the user message the agent receives. */
function promptText(payload) {
  const markdown = String(payload.markdown)
  const lines = [
    '用户在内置浏览器里对页面做了批注，请按批注修改前端（先定位对应代码，再动手）。',
    '',
    '页面：' + String(payload.url ?? ''),
    '标题：' + String(payload.title ?? ''),
    '批注数：' + (Number.isFinite(payload.count) ? String(payload.count) : '若干'),
    ...(typeof payload.cwd === 'string' && payload.cwd !== '' ? ['工作区：' + payload.cwd] : []),
    '',
    markdown,
  ]
  return lines.join('\n')
}

/**
 * @param {object} ctx - Host plugin context.
 * @param {{ mode?: 'queue' | 'steer', hosts?: string[], enabled?: boolean }} config - bundle config.
 */
export function apply(ctx, config = {}) {
  const updater = createUpdater({ log: (...args) => { console.info('[dsh-annotate]', ...args) } })
  // Client boot reports stay in memory: the browser half cannot log anywhere
  // readable from the Host, and a missing settings page needs exact evidence.
  const bootReports = []
  const state = {
    enabled: config.enabled !== false,
    mode: config.mode === 'steer' ? 'steer' : 'queue',
    hosts: Array.isArray(config.hosts)
      ? config.hosts.filter(host => typeof host === 'string' && host.trim() !== '')
      : [],
  }

  const fenced = (sctx, req) => {
    const connection = sctx.get('connection')
    return connection === undefined || typeof connection.requestRejection !== 'function'
      || connection.requestRejection(req) === undefined
  }

  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const disposers = [
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/inject.js',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            try {
              const source = await readFile(fileURLToPath(INJECT_URL))
              res.statusCode = 200
              res.setHeader('content-type', 'text/javascript; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.setHeader('access-control-allow-origin', '*')
              res.setHeader('x-content-type-options', 'nosniff')
              if (req.method === 'HEAD') res.end()
              else res.end(source)
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/config',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            sendJson(res, 200, {
              ok: true,
              enabled: state.enabled,
              mode: state.mode,
              hosts: state.hosts.length > 0 ? state.hosts : LOOPBACK_HOSTS,
            })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/token',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            // Same-origin, cookie-authenticated route. It must never mint a
            // token for an anonymous page.
            const connection = sctx.get('connection')
            if (connection !== undefined && typeof connection.requestRejection === 'function'
              && connection.requestRejection(req) !== undefined) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            let payload
            try {
              payload = await readJson(req, 16 * 1024)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
              return
            }
            if (!validSessionId(payload?.sessionId)) {
              sendJson(res, 400, { ok: false, error: 'sessionId is required' })
              return
            }
            const origin = normalizeOrigin(payload?.origin)
            if (origin === undefined) {
              sendJson(res, 400, { ok: false, error: 'origin is required' })
              return
            }
            pruneTokens()
            const token = randomUUID() + randomUUID().replace(/-/g, '')
            const expiresAt = Date.now() + TOKEN_TTL_MS
            tokens.set(token, { sessionId: payload.sessionId, origin, expiresAt })
            // The annotated page cannot use the dsh-app:// shell origin; give it
            // the Host's real listening origin, which is what the Electron guest
            // reaches over loopback.
            let submitUrl
            try {
              const base = sctx.webServer.getOrigin()
              submitUrl = new URL('dsh-annotate/submit', base.replace(/\/?$/, '/')).href
            } catch { /* origin read before bind; the client falls back */ }
            sendJson(res, 200, { ok: true, token, expiresAt, ...(submitUrl === undefined ? {} : { submitUrl }) })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/boot',
          handler: async (req, res) => {
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, reports: bootReports })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            try {
              const report = await readJson(req, 8192)
              if (report !== null && typeof report === 'object') {
                bootReports.push({
                  at: new Date().toISOString(),
                  stage: String(report.stage ?? ''),
                  error: report.error === undefined ? undefined : String(report.error).slice(0, 500),
                })
                if (bootReports.length > 30) bootReports.shift()
              }
              sendJson(res, 200, { ok: true })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/update/env',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            if (!fenced(sctx, req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            try {
              sendJson(res, 200, { ok: true, ...(await updater.environment()) })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/update/setup',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            if (!fenced(sctx, req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            try {
              sendJson(res, 200, { ok: true, ...(await updater.installDependencies()) })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/update',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            if (!fenced(sctx, req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            try {
              sendJson(res, 200, { ok: true, current: await updater.current() })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/update/check',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            if (!fenced(sctx, req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            try {
              sendJson(res, 200, { ok: true, ...(await updater.check()) })
            } catch (error) {
              sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/update/apply',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            if (!fenced(sctx, req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            let payload
            try {
              payload = await readJson(req, 16 * 1024)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
              return
            }
            try {
              const result = await updater.apply(payload?.version)
              sendJson(res, 200, { ok: true, ...result, current: await updater.current() })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/dsh-annotate/submit',
          handler: async (req, res) => {
            if (req.method === 'OPTIONS') {
              corsHeaders(res)
              res.statusCode = 204
              res.end()
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' }, true)
              return
            }
            let payload
            try {
              payload = await readJson(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }, true)
              return
            }
            const entry = typeof payload?.token === 'string' ? tokens.get(payload.token) : undefined
            if (entry === undefined) {
              sendJson(res, 401, { ok: false, error: 'annotation token is missing or expired' }, true)
              return
            }
            if (entry.expiresAt <= Date.now()) {
              tokens.delete(payload.token)
              sendJson(res, 401, { ok: false, error: 'annotation token is missing or expired' }, true)
              return
            }
            const origin = normalizeOrigin(req.headers.origin)
            if (origin === undefined || origin !== entry.origin) {
              sendJson(res, 403, { ok: false, error: 'page origin does not match the token' }, true)
              return
            }
            if (typeof payload.markdown !== 'string' || payload.markdown.trim() === '') {
              sendJson(res, 400, { ok: false, error: 'markdown is empty' }, true)
              return
            }
            if (payload.markdown.length > MAX_MARKDOWN_CHARS) {
              sendJson(res, 413, { ok: false, error: 'annotation is too large' }, true)
              return
            }
            const controller = sctx.get('sessionController')
            if (controller === undefined || typeof controller.prompt !== 'function') {
              sendJson(res, 503, { ok: false, error: 'session controller is unavailable' }, true)
              return
            }
            const count = Array.isArray(payload.annotations) ? payload.annotations.length
              : Number.isFinite(payload.count) ? Number(payload.count) : undefined
            const sessions = sctx.get('sessions')
            let cwd
            try {
              const live = sessions !== undefined && typeof sessions.get === 'function'
                ? sessions.get(entry.sessionId)
                : undefined
              cwd = live?.header?.cwd
            } catch { /* header access is best-effort context */ }
            const text = promptText({ ...payload, count, cwd })
            try {
              await controller.prompt({
                requestId: randomUUID(),
                sessionId: entry.sessionId,
                mode: state.mode,
                content: [{ type: 'text', text }],
                ...(typeof payload.timeZone === 'string' ? { clientTimeZone: payload.timeZone } : {}),
              }, AbortSignal.timeout(30_000))
              sendJson(res, 200, { ok: true, sessionId: entry.sessionId }, true)
            } catch (error) {
              const message = String(error?.message ?? error)
              sendJson(res, 502, { ok: false, error: message }, true)
            }
          },
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-annotate: /dsh-annotate routes')
  })
}
