#!/usr/bin/env node
/**
 * Build the injected IIFE.
 *
 * React, ReactDOM, and agentation are bundled into one self-contained script so
 * the visited page needs no module loader, no import map, and no network. The
 * page may already have its own React, possibly another major version; bundling
 * ours keeps that unrelated.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

await build({
  entryPoints: [path.join(root, 'src/inject.tsx')],
  outfile: path.join(root, 'lib/inject.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})
