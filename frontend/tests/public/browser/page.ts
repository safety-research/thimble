// What the browser checks share. A check writes a small entry that mounts real components from src, bundles it with
// esbuild (resolving imports as Vite and tsc do), and loads it in a headless Chromium page on a made-up origin whose
// every request the check answers itself, so nothing listens on a port and nothing leaves the machine.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build, type BuildOptions } from 'esbuild'
import { chromium, type Browser } from 'playwright'

export const FRONTEND = path.resolve(__dirname, '../../..')
export const ORIGIN = 'http://thimble.test'
/** A path under src as an import specifier for an entry. */
export const src = (p: string) => path.join(FRONTEND, 'src', p).split(path.sep).join('/')

const dirs: string[] = []

/** A temporary folder, removed by `cleanup`. */
function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `thimble-${name}-`))
  dirs.push(dir)
  return dir
}

/** Remove the temporary folders this file made. */
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

/** Bundle `lines` (a TSX module) into one script and return its path. Stylesheets and fonts the components import
 * are left out. */
export async function bundle(name: string, lines: string[], options: BuildOptions = {}): Promise<string> {
  const dir = tempDir(name)
  const entry = path.join(dir, 'entry.tsx')
  writeFileSync(entry, [...lines, ''].join('\n'))
  const outfile = path.join(dir, 'bundle.js')
  await build({
    entryPoints: [entry],
    nodePaths: [path.join(FRONTEND, 'node_modules')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.woff2': 'empty', '.woff': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    outfile,
    logLevel: 'error',
    ...options,
  })
  return outfile
}

export const launch = (): Promise<Browser> => chromium.launch({ headless: true })
