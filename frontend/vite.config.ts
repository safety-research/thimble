import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { build } from 'esbuild'

// the config runs under node; this is the one node global it reads
declare const process: { env: Record<string, string | undefined> }

// BACKEND_PORT names the backend the dev server proxies /api to (8300 by default); VITE_CACHE_DIR gives a
// scratch checkout its own cache beside a shared node_modules.
const backend = process.env.BACKEND_PORT || '8300'
const cacheDir = process.env.VITE_CACHE_DIR || undefined

/** The backend refuses a state-changing request whose Origin is not its own (backend/app/http_guard.py). A request the
 * dev server's own page sent through this proxy names the dev server as its origin, so the proxy renames it to the
 * backend's; a request from any other origin keeps its Origin and is refused there. */
type ProxyReq = { getHeader(name: string): unknown; setHeader(name: string, value: string): void }
type Incoming = { headers: Record<string, string | string[] | undefined> }
export function ownOriginToTarget(req: ProxyReq, incoming: Incoming, target: string): void {
  const origin = incoming.headers.origin
  const host = incoming.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return
  let at: URL
  try {
    at = new URL(origin)
  } catch {
    return
  }
  if ((at.protocol === 'http:' || at.protocol === 'https:') && at.host.toLowerCase() === host.toLowerCase()) req.setHeader('origin', target)
}

const target = `http://127.0.0.1:${backend}`

/** The canvas's chart drawing as the one script a view's page inlines for the view kit's thimble.chart (src/lib/kitChart,
 * backend views.KIT_CHART_JS): written beside the app as kit/chart.js on every build, so a view's charts and the
 * canvas's are drawn by the same code. */
export function kitChart(): Plugin {
  let root = '.'
  return {
    name: 'thimble-kit-chart',
    apply: 'build',
    configResolved(config) {
      root = config.root
    },
    async generateBundle() {
      const out = await build({
        entryPoints: [`${root}/src/lib/kitChart.ts`],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        minify: true,
        legalComments: 'none',
        write: false,
        logLevel: 'error',
      })
      this.emitFile({ type: 'asset', fileName: 'kit/chart.js', source: out.outputFiles[0].text })
    },
  }
}

export default defineConfig({
  plugins: [react(), kitChart()],
  cacheDir,
  server: {
    port: 5300,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReq', (req, incoming) => ownOriginToTarget(req, incoming, target)),
      },
    },
  },
  // render.html is the card harness's page (src/render.tsx, backend/app/render.py): shipped beside the app in dist
  build: { rollupOptions: { input: { main: 'index.html', render: 'render.html' } } },
})
