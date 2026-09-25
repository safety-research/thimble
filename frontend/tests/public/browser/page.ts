// What the browser checks share. A check writes a small entry that mounts real components from src, bundles it with
// esbuild (resolving imports as Vite and tsc do), and loads it in a headless Chromium page on a made-up origin whose
// every request the check answers itself, so nothing listens on a port and nothing leaves the machine. The page takes
// the app's stylesheets from src/styles, so what it lays out is what the app lays out.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build, type BuildOptions } from 'esbuild'
import { chromium, type Browser, type BrowserContextOptions, type Page, type Request, type Route } from 'playwright'

export const FRONTEND = path.resolve(__dirname, '../../..')
export const ORIGIN = 'http://thimble.test'
/** A path under src as an import specifier for an entry. */
export const src = (p: string) => path.join(FRONTEND, 'src', p).split(path.sep).join('/')

const dirs: string[] = []

/** A temporary folder, removed by `cleanup`. */
export function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `thimble-${name}-`))
  dirs.push(dir)
  return dir
}

/** Remove the temporary folders this file made. */
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

/** Bundle `lines` (a TSX module) into one script and return its path. Stylesheets and fonts the components import
 * are left out: a page takes the app's stylesheets with `addStyles`. */
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

const BLOCKNOTE = ['core/dist/style.css', 'react/dist/style.css', 'mantine/src/mantineStyles.css', 'mantine/src/blocknoteStyles.css']

/** Add the app's stylesheets `names` (files of src/styles, without .css) to the page, and BlockNote's own when the
 * page holds the report editor. The faces are left out: a check measures in whatever face the machine has. */
export async function addStyles(page: Page, names: string[], blocknote = false): Promise<void> {
  const files = [...names.map((n) => path.join(FRONTEND, 'src', 'styles', `${n}.css`)), ...(blocknote ? BLOCKNOTE.map((f) => path.join(FRONTEND, 'node_modules', '@blocknote', f)) : [])]
  for (const f of files) await page.addStyleTag({ content: readFileSync(f, 'utf8').replace(/^@import[^;]*;/gm, '') })
}

/** An answer to one request: JSON, an HTML page, or nothing (the default answer). */
export type Answer = { json: unknown; status?: number } | { html: string } | undefined
export type Api = (req: Request, url: URL) => Answer | Promise<Answer>

const BLANK = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>'

/** Answer the page's requests to ORIGIN from `api`; what it leaves unanswered is a 404 under /api and a blank page
 * elsewhere, and a request to any other host is aborted. */
export async function serve(target: Page, api: Api = () => undefined): Promise<void> {
  await target.route(/^https?:\/\//, async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.origin !== ORIGIN) return route.abort()
    const a = await api(req, url)
    if (a && 'json' in a) return route.fulfill({ status: a.status ?? 200, contentType: 'application/json', body: JSON.stringify(a.json) })
    if (a && 'html' in a) return route.fulfill({ status: 200, contentType: 'text/html', body: a.html })
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: BLANK })
  })
}

export interface Opened {
  page: Page
  /** uncaught errors in the page */
  errors: string[]
  /** load the page afresh, with its styles and the bundle */
  load(): Promise<void>
  close(): Promise<void>
}

/** A page in a context of its own at `ORIGIN/?ws=<ws>`, with the stylesheets `styles` and the bundle loaded, its
 * requests answered by `api`. */
export async function open(
  browser: Browser,
  opts: { script: string; styles: string[]; blocknote?: boolean; api?: Api; ws?: string; context?: BrowserContextOptions; init?: () => void },
): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, ...opts.context })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  if (opts.init) await page.addInitScript(opts.init)
  await serve(page, opts.api)
  const load = async () => {
    await page.goto(`${ORIGIN}/?ws=${opts.ws ?? 'w'}`)
    await addStyles(page, opts.styles, opts.blocknote)
    await page.addScriptTag({ path: opts.script })
  }
  await load()
  return { page, errors, load, close: () => context.close() }
}
