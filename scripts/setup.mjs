#!/usr/bin/env node
/**
 * One-command initialization for a source checkout.
 *
 * Annotations work with the committed lib/inject.js and need nothing here.
 * This installs the small rebuild toolchain used by Settings → 网页批注 →
 * 检查更新/更新. Packed installs already receive these through package.json
 * dependencies; only a linked directory needs this step (or the 初始化 button).
 */
import { createUpdater } from '../lib/update.js'

const updater = createUpdater({ log: (...args) => { console.log(...args) } })
const before = await updater.environment()
console.log('plugin:', before.pluginDir)
console.log('missing:', before.missing.length === 0 ? 'none' : before.missing.join(', '))
if (before.ready) {
  console.log('build toolchain is ready')
  process.exit(0)
}
const result = await updater.installDependencies()
console.log(JSON.stringify(result, null, 2))
if (!result.ready) process.exitCode = 1
