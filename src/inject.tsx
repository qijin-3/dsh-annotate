/**
 * Injected wrapper around agentation.
 *
 * This file is bundled with esbuild into lib/inject.js as a self-contained IIFE
 * (React 18 + ReactDOM + agentation). It runs inside the annotated page and is
 * the only bridge between agentation's `onSubmit` and the DSH Host route.
 *
 * agentation itself is consumed as an unmodified dependency: nothing in this
 * file patches, forks, or monkey-patches it.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { Agentation } from 'agentation'

export interface MountOptions {
  /** Submit routes to try in order; the first reachable one wins. */
  readonly submitUrls: readonly string[]
  /** Short-lived token bound to the owning Session and this page origin. */
  readonly token: string
  /** Optional app label forwarded to agentation's copied output. */
  readonly appName?: string
}

interface State {
  root?: Root
  mounted: boolean
}

const state: State = { mounted: false }
const TOAST_TAG = 'dsh-annotate-toast'

/** Shadow-isolated status toast; the page's own CSS cannot restyle it. */
function toast(text: string, kind: 'ok' | 'error'): void {
  try {
    if (document.body === null) return
    const host = document.createElement(TOAST_TAG)
    const shadow = host.attachShadow({ mode: 'open' })
    const box = document.createElement('div')
    box.textContent = text
    box.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'left:50%', 'bottom:96px',
      'transform:translateX(-50%)', 'max-width:min(560px,90vw)',
      'padding:10px 14px', 'border-radius:10px',
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.18)', 'pointer-events:none',
      'background:' + (kind === 'ok' ? '#0f172a' : '#7f1d1d'), 'color:#fff',
      'opacity:0', 'transition:opacity .18s ease',
    ].join(';')
    shadow.appendChild(box)
    host.style.cssText = 'position:fixed;z-index:2147483647;inset:0;pointer-events:none'
    document.body.appendChild(host)
    requestAnimationFrame(() => { box.style.opacity = '1' })
    setTimeout(() => {
      box.style.opacity = '0'
      setTimeout(() => host.remove(), 300)
    }, kind === 'ok' ? 3200 : 6000)
  } catch {
    // A page tearing down mid-submit must not mask the real result.
  }
}

async function submit(output: string, count: number, options: MountOptions): Promise<void> {
  const body = JSON.stringify({
    token: options.token,
    markdown: output,
    count,
    url: location.href,
    title: document.title,
    origin: location.origin,
    timeZone: (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined }
    })(),
  })
  let last: { url: string, error: unknown } | undefined
  for (const url of options.submitUrls) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 10_000)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
    } catch (error) {
      last = { url, error }
      console.warn('[dsh-annotate] route unreachable, trying next:', url, error)
      continue
    } finally {
      clearTimeout(timer)
    }
    const data = (await response.json().catch(() => undefined)) as
      | { ok?: boolean, error?: string }
      | undefined
    if (!response.ok || data?.ok !== true) {
      const message = data?.error ?? 'HTTP ' + response.status
      toast('发送失败：' + message, 'error')
      throw new Error(message)
    }
    toast('批注已发送到当前对话', 'ok')
    return
  }
  const detail = last === undefined ? 'no route configured' : last.url + ' · '
    + String((last.error as Error)?.name ?? 'Error') + ': '
    + String((last.error as Error)?.message ?? last.error)
  console.warn('[dsh-annotate] submit failed everywhere:', detail)
  toast('无法连接到 DSH：' + detail, 'error')
  throw last?.error ?? new Error('no submit route')
}

/** Whether the page already rendered an agentation instance of its own. */
function hasOwnAgentation(): boolean {
  return document.getElementById('agentation-styles') !== null
    || document.querySelector('[data-feedback-toolbar], [data-agentation-portal], agentation-toolbar') !== null
}

/**
 * Mount agentation once per document.
 * @param options - Host submit URL and the token for this page load.
 * @returns `mounted` when this document already owns an instance.
 */
export function mount(options: MountOptions): { ok: boolean, mounted?: boolean } {
  if (state.mounted) return { ok: true, mounted: true }
  if (document.getElementById('dsh-annotate-root') !== null) return { ok: true, mounted: true }
  if (hasOwnAgentation()) {
    state.mounted = true
    return { ok: true, mounted: true }
  }
  if (document.body === null) return { ok: false }

  const host = document.createElement('div')
  host.id = 'dsh-annotate-root'
  host.setAttribute('data-dsh-annotate-root', '')
  document.body.appendChild(host)
  try {
    const root = createRoot(host)
    state.root = root
    state.mounted = true
    root.render(createElement(Agentation, {
      appName: options.appName,
      onSubmit: async (output: string, annotations: unknown[]) => {
        await submit(output, Array.isArray(annotations) ? annotations.length : 0, options)
      },
    }))
    return { ok: true }
  } catch (error) {
    state.mounted = false
    state.root = undefined
    host.remove()
    console.warn('[dsh-annotate] mount failed:', error)
    return { ok: false }
  }
}

declare global {
  interface Window {
    __dshAnnotate?: {
      mount: typeof mount
    }
  }
}

window.__dshAnnotate = { mount }
