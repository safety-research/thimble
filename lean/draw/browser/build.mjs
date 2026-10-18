// build.mjs: write the browser demo as one self-contained page (no network, no server).
//
//   node browser/build.mjs <out.html> [example ids...] [--objects <dir>]
//
// --objects adds every object file in <dir> ({id, v, title, program, data} as JSON), such as the objects Claude drew
// in a session, so the terminal can hand them to the page too.
// The page carries kit.js as text (for the sandbox), the renderer modules joined into one module script, and the
// example objects. It runs every program itself, in the sandbox, so what it draws is what the program says.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadExamples } from '../examples/load.mjs'

const DRAW = fileURLToPath(new URL('..', import.meta.url))
const out = process.argv[2]
if (!out) { console.error('usage: node browser/build.mjs <out.html> [example ids...]'); process.exit(2) }
const rest = process.argv.slice(3)
const at = rest.indexOf('--objects')
const extraDir = at >= 0 ? rest[at + 1] : null
const only = at >= 0 ? rest.slice(0, at).concat(rest.slice(at + 2)) : rest
const extra = extraDir && existsSync(extraDir) ? readdirSync(extraDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(extraDir + '/' + f, 'utf8'))) : []
const objects = loadExamples().filter(o => !only.length || only.includes(o.id)).concat(extra)

// modules in dependency order; their imports are dropped and their exports become plain declarations
const strip = src => src.replace(/^import [^\n]*\n/gm, '').replace(/^export (?=(async )?function|const|let|class)/gm, '')
const modules = ['flex.js', 'palette.js', 'svg.js', 'handoff.js', 'browser/sandbox.js', 'browser/page.js']
const bundle = modules.map(f => `// ---- ${f}\n` + strip(readFileSync(DRAW + f, 'utf8'))).join('\n')
const safe = s => s.replace(/<\/script/gi, '<\\/script')

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drawing Contract</title>
<style>
:root { --paper: #ffffff; --ink: #1d1b18; --dim: #8a847a; --rule: #e4e0d8; --accent: #2a78c4; --wash: #f6f5f1; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --paper: #1e1e1e; --ink: #e6e3dd; --dim: #8f8a82; --rule: #3a3936; --accent: #5aa2e6; --wash: #262624; } }
:root[data-theme="dark"] { --paper: #1e1e1e; --ink: #e6e3dd; --dim: #8f8a82; --rule: #3a3936; --accent: #5aa2e6; --wash: #262624; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 13px/1.5 "Instrument Sans", Inter, -apple-system, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 18px 16px 40px; }
nav { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 14px; }
nav button { font: inherit; color: var(--dim); background: none; border: 1px solid transparent; border-radius: 4px; padding: 3px 9px; cursor: pointer; }
nav button.on { color: var(--ink); border-color: var(--rule); background: var(--wash); }
#stage { overflow-x: auto; min-height: 120px; }
#stage svg { display: block; }
#stage [data-region] { cursor: pointer; }
#detail { margin-top: 14px; border-top: 1px solid var(--rule); padding-top: 10px; max-width: 900px; }
#detail .head { display: flex; gap: 10px; align-items: baseline; }
#detail .id { color: var(--dim); font-family: "JetBrains Mono", Menlo, monospace; font-size: 12px; }
#detail .back { margin-left: auto; color: var(--dim); font-size: 12px; }
#detail h4 { margin: 12px 0 4px; font-size: 12px; font-weight: 600; color: var(--dim); text-transform: none; }
#detail h4 button { font: inherit; border: 1px solid var(--rule); background: var(--paper); color: var(--ink); border-radius: 4px; width: 22px; margin-left: 4px; cursor: pointer; }
#detail p { margin: 2px 0; }
#detail .src, #detail .more, #detail .hint, #detail .dim { color: var(--dim); }
#detail .note { color: var(--dim); font-style: italic; }
code { font-family: "JetBrains Mono", Menlo, monospace; font-size: 12px; }
blockquote { margin: 4px 0; padding: 6px 10px; background: var(--wash); border-radius: 4px; }
table.rows { border-collapse: collapse; margin: 6px 0; font-variant-numeric: tabular-nums; }
table.rows th { text-align: left; color: var(--dim); font-weight: 500; border-bottom: 1px solid var(--rule); padding: 2px 14px 2px 0; }
table.rows td { padding: 2px 14px 2px 0; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
table.rows td.num { text-align: right; }
</style></head>
<body><main><nav id="objects-nav"></nav><div id="stage"></div><div id="detail"></div></main>
<script id="kit-src" type="text/plain">${safe(readFileSync(DRAW + 'kit.js', 'utf8'))}</script>
<script id="objects" type="application/json">${safe(JSON.stringify(objects))}</script>
<script type="module">
${safe(bundle)}
</script>
</body></html>
`
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)
console.log(`${out}: ${objects.length} objects, ${Math.round(html.length / 1024)} KB`)
