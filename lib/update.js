/**
 * Local updater for the bundled agentation build.
 *
 * The shipped lib/inject.js is a self-contained IIFE built from src/inject.tsx.
 * Updating means: resolve the latest published `agentation` version, download
 * that exact package from the npm registry, extract its ESM dist, rebuild the
 * same wrapper, and atomically replace lib/inject.js. agentation's own source
 * is never edited; the wrapper only swaps the dependency it bundles.
 *
 * GitHub tags are the release signal the user asked for, npm is the artifact
 * channel this build can actually install. A tag that npm has not published is
 * reported as "not installable" rather than silently ignored.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

/** Version baked into the shipped lib/inject.js. Bump it when rebuilds land in git. */
export const BASELINE_VERSION = '3.1.2'

const REPO = 'benjitaylor/agentation'
const REPO_URL = `https://github.com/${REPO}`
const SEMVER = /^\d+\.\d+\.\d+$/
const CHECK_TTL_MS = 5 * 60 * 1000
const MAX_TARBALL_BYTES = 10 * 1024 * 1024
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024
const MIN_BUNDLE_BYTES = 200 * 1024
const BUILD_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 180_000
const execFileAsync = promisify(execFile)

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const STATE_DIR = path.join(PLUGIN_DIR, 'state')
const STATE_FILE = path.join(STATE_DIR, 'agentation.json')
const INJECT_FILE = path.join(PLUGIN_DIR, 'lib', 'inject.js')
const INJECT_ENTRY = path.join(PLUGIN_DIR, 'src', 'inject.tsx')

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

async function fetchJson(url, headers = {}, timeoutMs = 15_000) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-annotate', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) throw new Error('response is too large')
  return JSON.parse(text)
}

/** Read one file from an uncompressed ustar/PAX tarball. */
function readTarFile(tar, wanted) {
  let offset = 0
  while (offset + 512 <= tar.length) {
    const rawName = tar.toString('utf8', offset, offset + 100)
    const name = rawName.replace(/\0.*$/, '')
    if (name === '') break
    const rawSize = tar.toString('utf8', offset + 124, offset + 136).replace(/\0.*$/, '').trim()
    const size = Number.parseInt(rawSize, 8) || 0
    const prefix = tar.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/, '')
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const dataStart = offset + 512
    if (fullName === wanted) return tar.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return undefined
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function createUpdater(options = {}) {
  const log = options.log ?? (() => {})
  let cachedCheck
  let updating
  let installing

  /**
   * Whether the local rebuild toolchain is present. The annotation itself needs
   * none of this; only the update button does.
   * @returns readiness plus the missing package names.
   */
  async function environment() {
    const missing = []
    for (const name of ['esbuild', 'react', 'react-dom']) {
      try {
        await import(name)
      } catch {
        missing.push(name)
      }
    }
    return { ready: missing.length === 0, missing, pluginDir: PLUGIN_DIR }
  }

  /** Locate the DSH-bundled pnpm first, then a system npm. */
  function packageManager() {
    const pnpm = process.argv.find(arg => typeof arg === 'string' && /pnpm[\\/]bin[\\/]pnpm\.mjs$/.test(arg))
    if (pnpm !== undefined) {
      return { kind: 'pnpm', command: process.execPath, prefix: [pnpm], env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
    const candidates = ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm']
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir !== '') candidates.push(path.join(dir, 'npm'))
    }
    const npm = candidates.find(candidate => existsSync(candidate))
    if (npm !== undefined) return { kind: 'npm', command: npm, prefix: [], env: {} }
    return undefined
  }

  /**
   * Install the rebuild toolchain on demand. Called only from the user's
   * settings button, never on boot.
   * @returns readiness, or a manual command when no package manager is usable.
   */
  async function installDependencies() {
    if (installing !== undefined) throw new Error('初始化已经在进行中')
    const before = await environment()
    if (before.ready) return { ready: true, already: true, missing: [] }
    const manager = packageManager()
    const manual = `cd ${PLUGIN_DIR} && npm install --omit=dev --no-audit --no-fund`
    if (manager === undefined) return { ready: false, missing: before.missing, manual }
    installing = (async () => {
      try {
        const args = manager.kind === 'pnpm'
          ? [...manager.prefix, '--dir', PLUGIN_DIR, 'install', '--prod', '--no-frozen-lockfile']
          : ['install', '--omit=dev', '--no-audit', '--no-fund']
        const result = await execFileAsync(manager.command, args, {
          cwd: PLUGIN_DIR,
          env: { ...process.env, ...manager.env },
          timeout: INSTALL_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        })
        const after = await environment()
        return {
          ready: after.ready,
          missing: after.missing,
          manager: manager.kind,
          output: `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-8).join('\n'),
          ...(after.ready ? {} : { manual }),
        }
      } catch (error) {
        // pnpm can exit non-zero only because it refused to run dependency build
        // scripts (esbuild still works through its platform package). Re-check
        // the toolchain instead of treating the exit code as the result.
        const after = await environment()
        const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n')
        if (after.ready) {
          return {
            ready: true,
            missing: [],
            manager: manager.kind,
            warning: String(error?.message ?? error),
            output,
          }
        }
        return {
          ready: false,
          missing: after.missing,
          manager: manager.kind,
          manual,
          error: String(error?.message ?? error),
          output,
        }
      } finally {
        installing = undefined
      }
    })()
    return installing
  }

  async function current() {
    const state = await readState()
    const version = typeof state.version === 'string' && SEMVER.test(state.version)
      ? state.version
      : BASELINE_VERSION
    return {
      version,
      source: version === BASELINE_VERSION && state.version === undefined ? 'bundled' : 'local',
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : undefined,
    }
  }

  async function latestUpstream() {
    const now = Date.now()
    if (cachedCheck !== undefined && now - cachedCheck.at < CHECK_TTL_MS) return cachedCheck.value

    const failures = []
    let github
    try {
      const tags = await fetchJson(
        `https://api.github.com/repos/${REPO}/tags?per_page=100`,
        { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      )
      const versions = []
      for (const tag of Array.isArray(tags) ? tags : []) {
        const name = typeof tag?.name === 'string' ? tag.name : ''
        const match = /^v?(\d+\.\d+\.\d+)$/.exec(name)
        if (match !== null) versions.push({ version: match[1], tag: name })
      }
      versions.sort((a, b) => compareVersions(a.version, b.version))
      if (versions.length > 0) github = versions[versions.length - 1]
    } catch (error) {
      failures.push('GitHub: ' + String(error?.message ?? error))
    }

    let npm
    try {
      const meta = await fetchJson('https://registry.npmjs.org/agentation/latest')
      if (typeof meta?.version === 'string' && SEMVER.test(meta.version)) {
        npm = { version: meta.version, tarball: meta.dist?.tarball }
      }
    } catch (error) {
      failures.push('npm: ' + String(error?.message ?? error))
    }

    if (github === undefined && npm === undefined) {
      throw new Error(failures.join('; ') || '无法读取上游版本')
    }

    const newest = github !== undefined && npm !== undefined
      ? (compareVersions(github.version, npm.version) > 0 ? github : npm)
      : (github ?? npm)
    const installable = npm !== undefined && compareVersions(newest.version, npm.version) <= 0
      ? npm.version
      : undefined

    const value = {
      version: newest.version,
      tag: github?.tag ?? `v${newest.version}`,
      url: `${REPO_URL}/releases/tag/${github?.tag ?? `v${newest.version}`}`,
      repoUrl: REPO_URL,
      installable,
      npmVersion: npm?.version,
      warnings: failures,
      checkedAt: new Date().toISOString(),
    }
    cachedCheck = { at: now, value }
    return value
  }

  async function check() {
    const base = await current()
    const latest = await latestUpstream()
    return {
      current: base,
      latest,
      updateAvailable: compareVersions(latest.version, base.version) > 0,
      repoUrl: REPO_URL,
    }
  }

  async function buildFromPackage(version) {
    const meta = await fetchJson(`https://registry.npmjs.org/agentation/${version}`, {}, 20_000)
    if (meta?.version !== version) throw new Error('npm 返回的版本与请求不一致')
    const url = meta.dist?.tarball
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('npm 返回的下载地址无效')
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org') {
      throw new Error('拒绝从非 npm registry 地址下载')
    }
    const response = await fetch(parsed.href, {
      headers: { 'user-agent': 'dsh-annotate' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`下载 agentation@${version} 失败：HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_TARBALL_BYTES) throw new Error('下载的安装包过大')
    const tar = gunzipSync(buffer)
    const dist = readTarFile(tar, 'package/dist/index.mjs')
    if (dist === undefined || dist.length < 100 * 1024) throw new Error('安装包里没有找到 dist/index.mjs')
    const source = dist.toString('utf8')
    if (!/export\s*\{/.test(source) || !/Agentation/.test(source)) {
      throw new Error('安装包内容看起来不是 agentation')
    }

    await mkdir(STATE_DIR, { recursive: true })
    const id = randomUUID().slice(0, 8)
    const moduleFile = path.join(STATE_DIR, `agentation-${id}.mjs`)
    const outputFile = path.join(STATE_DIR, `inject-${id}.js`)
    await writeFile(moduleFile, dist)
    try {
      let esbuild
      try {
        esbuild = await import('esbuild')
      } catch {
        throw new Error('缺少构建依赖 esbuild，请重新安装插件后再试')
      }
      const build = esbuild.build({
        entryPoints: [INJECT_ENTRY],
        outfile: outputFile,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['chrome120'],
        minify: true,
        legalComments: 'none',
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'silent',
        plugins: [{
          name: 'pin-agentation',
          setup(builder) {
            builder.onResolve({ filter: /^agentation$/ }, () => ({ path: moduleFile }))
          },
        }],
      })
      await Promise.race([
        build,
        new Promise((_, reject) => {
          setTimeout(() => { reject(new Error('打包超时')) }, BUILD_TIMEOUT_MS).unref()
        }),
      ])
      const info = await stat(outputFile)
      if (info.size < MIN_BUNDLE_BYTES || info.size > MAX_BUNDLE_BYTES) {
        throw new Error(`生成的脚本大小异常：${info.size} 字节`)
      }
      const built = await readFile(outputFile, 'utf8')
      if (!built.includes('__dshAnnotate') || !built.includes('agentation')) {
        throw new Error('生成的脚本缺少预期标记')
      }
      const previous = await current()
      await rename(outputFile, INJECT_FILE)
      await writeFile(STATE_FILE, JSON.stringify({
        version,
        updatedAt: new Date().toISOString(),
        bytes: info.size,
        tarball: parsed.href,
      }, null, 2))
      log('updated agentation', previous.version, '->', version, `(${info.size} bytes)`)
      return { previous: previous.version, version, bytes: info.size }
    } finally {
      await rm(moduleFile, { force: true })
      await rm(outputFile, { force: true })
    }
  }

  async function apply(version) {
    if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error('版本号无效')
    if (updating !== undefined) throw new Error('已有一次更新正在进行')
    const base = await current()
    if (compareVersions(version, base.version) <= 0) throw new Error('已经是最新版本')
    const latest = await latestUpstream()
    if (latest.installable !== version) {
      throw new Error(latest.installable === undefined
        ? '该版本还没有发布到 npm，暂时无法自动安装'
        : `上游最新可安装版本是 ${latest.installable}`)
    }
    updating = (async () => {
      try {
        return await buildFromPackage(version)
      } finally {
        updating = undefined
      }
    })()
    return updating
  }

  return { current, check, apply, environment, installDependencies, pluginDir: PLUGIN_DIR }
}
