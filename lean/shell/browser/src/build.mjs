// build.mjs: builds the browser app (src/) into app/, the folder the page server serves at /<token>/app/.
//
//   node lean/shell/browser/src/build.mjs [--dev] [--watch]
//   frontend/node_modules/.bin/tsc -p lean/shell/browser/src      (types only)
//
// The app is thimble 0.9's browser on lean's runtime. It imports 0.9's own components and stylesheets from the
// repository's frontend/src (the alias @09), and its toolchain from frontend/node_modules (run `npm ci` in frontend/
// once). The built files are committed, so the plugin needs no build step where it is installed: app/index.html,
// app/app.js, app/app.css and app/fonts/ (the latin faces of Hanken Grotesk and Geist Mono, as 0.9 serves them).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..')
const FRONT = join(REPO, 'frontend')
const MODS = join(FRONT, 'node_modules')
const OUT = join(HERE, '..', 'app')
const dev = process.argv.includes('--dev')
const watch = process.argv.includes('--watch')

if (!existsSync(join(MODS, 'esbuild'))) {
  console.error(`No toolchain: run \`npm ci\` in ${FRONT} once, then build again.`)
  process.exit(1)
}
const require = createRequire(join(MODS, 'x.js'))
const esbuild = require('esbuild')

// the faces 0.9 uses (styles/fonts.css), latin and latin-ext only: the browser fetches a file only for text that needs it
const FACES = [
  ['Hanken Grotesk', 'hanken-grotesk', 400, 'normal'], ['Hanken Grotesk', 'hanken-grotesk', 400, 'italic'],
  ['Hanken Grotesk', 'hanken-grotesk', 500, 'normal'], ['Hanken Grotesk', 'hanken-grotesk', 600, 'normal'],
  ['Geist Mono', 'geist-mono', 400, 'normal'], ['Geist Mono', 'geist-mono', 500, 'normal'],
]
const RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
}

function fonts() {
  const dir = join(OUT, 'fonts')
  mkdirSync(dir, { recursive: true })
  const rules = []
  for (const [family, pkg, weight, style] of FACES) {
    for (const [subset, range] of Object.entries(RANGES)) {
      const name = `${pkg}-${subset}-${weight}-${style}.woff2`
      const from = join(MODS, '@fontsource', pkg, 'files', name)
      if (!existsSync(from)) continue
      copyFileSync(from, join(dir, name))
      rules.push(`@font-face{font-family:'${family}';font-style:${style};font-display:swap;font-weight:${weight};src:url(fonts/${name}) format('woff2');unicode-range:${range}}`)
    }
  }
  return rules.join('\n')
}

const INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>thimble</title>
<link rel="stylesheet" href="fonts.css">
<link rel="stylesheet" href="app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="app.js"></script>
</body>
</html>
`

const options = {
  entryPoints: { app: join(HERE, 'main.tsx') },
  outdir: OUT,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'eof',
  nodePaths: [MODS],
  tsconfig: join(HERE, 'tsconfig.json'),
  alias: { '@09': join(FRONT, 'src') },
  loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'dataurl' },
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"', 'import.meta.env.DEV': dev ? 'true' : 'false' },
  logLevel: 'warning',
}

function finish() {
  writeFileSync(join(OUT, 'index.html'), INDEX)
  writeFileSync(join(OUT, 'fonts.css'), fonts() + '\n')
  let total = 0
  const walk = d => { for (const n of readdirSync(d)) { const f = join(d, n); const s = statSync(f); if (s.isDirectory()) walk(f); else total += s.size } }
  walk(OUT)
  console.log(`built ${OUT} (${(total / 1024).toFixed(0)} KB)`)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
if (watch) {
  const ctx = await esbuild.context({ ...options, plugins: [{ name: 'done', setup(b) { b.onEnd(r => { if (!r.errors.length) finish() }) } }] })
  await ctx.watch()
  console.log('watching src/ ...')
} else {
  await esbuild.build(options)
  finish()
}
