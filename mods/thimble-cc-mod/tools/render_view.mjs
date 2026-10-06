#!/usr/bin/env node
// A view (view.json and rows.json) drawn as the panel draws it, printed as ANSI text or plain text: for the builder's
// checks, the reviewer's look at the view, and screenshots. Imports the mod's own drawing code (hooks/viewdraw.ts).
//
//   node tools/render_view.mjs --spec view.json --rows rows.json [--width 96] [--height 48] [--tab N]
//        [--select <collection>/<key> | --select first] [--state state.json] [--plain] [--theme dark|light]
//   node tools/render_view.mjs ... --all     every tab, then each tab with its first row selected, one after another
//   node tools/render_view.mjs ... --check   the spec's and the rows' problems, and each state's lines against the width,
//                                            as JSON; exit 1 when any fails
//   node tools/render_view.mjs ... --check --labeltest   also each tab with a test label on, which must draw its marks
//   node tools/render_view.mjs ... --builtin   a view the mod writes itself (the file browser), which may leave out a
//                                            tab's overview
//
// The ANSI output is drawn on the panel's background, as Claude Code draws a docked pane (--bare: on the terminal's).
//
// Needs Node 22.18 or newer (it runs the .ts files by stripping their types).
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// the mod's modules import each other without extensions, as the engine resolves them
const hook = `export async function resolve(s, c, n) { try { return await n(s, c) } catch (e) { if (s.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(s)) return n(s + '.ts', c); throw e } }`
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const { validateSpec, validateData } = await import(join(here, '../hooks/viewspec.ts'))
const { viewLayout: layout, initialState, reduce, VIEW_MARGIN } = await import(join(here, '../hooks/viewdraw.ts'))
// as the panel lays a view out: the records leave the margin where "?" stands, and every line starts with the 2-cell
// margin where `❯` marks the selected row (register.tsx), so a drawing is `cols` wide in all
const viewLayout = (spec, data, st, cols, rows) => layout(spec, data, st, cols - 2, rows, VIEW_MARGIN, 2)
const { lineWidth } = await import(join(here, '../hooks/draw.ts'))

// Claude Code's theme colours, by the keys paint.ts uses
const THEMES = {
  dark: { composerSidebarBackground: '#262626', text: '#ffffff', inactive: '#999999', subtle: '#505050', userMessageBackground: '#373737', selectionBg: '#264f78', permission: '#b1b9f9', suggestion: '#b1b9f9', remember: '#b1b9f9', error: '#ff6b80', success: '#4eba65', warning: '#ffc107' },
  light: { composerSidebarBackground: '#f5f5f5', text: '#000000', inactive: '#666666', subtle: '#afafaf', userMessageBackground: '#f0f0f0', selectionBg: '#b4d5ff', permission: '#5769f7', suggestion: '#5769f7', remember: '#0000ff', error: '#ab2b3f', success: '#2c7a39', warning: '#966c1e' },
}

function args(argv) {
  const out = { width: 96, height: 48, theme: 'dark' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    if (['plain', 'check', 'all', 'labeltest', 'bare', 'builtin'].includes(k)) out[k] = true
    else out[k] = argv[++i]
  }
  return out
}

function rgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? [1, 2, 3].map(i => parseInt(m[i], 16)).join(';') : null
}

export function ansi(lines, theme = 'dark', width = 0) {
  const t = THEMES[theme] ?? THEMES.dark
  const colour = c => (c ? rgb(t[c] ?? c) : null)
  const panel = width ? 'composerSidebarBackground' : undefined
  // on the panel's background, plain text takes the theme's text colour rather than the terminal's, which may be
  // drawn for the other theme
  const text = width ? 'text' : undefined
  return lines
    .map(l =>
      [...l, ...(width ? [{ s: ' '.repeat(Math.max(0, width - lineWidth(l))) }] : [])]
        .map(s => {
          const codes = []
          const fg = colour(s.fg ?? text)
          const bg = colour(s.bg ?? panel)
          if (s.b) codes.push(1)
          if (s.d) codes.push(2)
          if (s.i) codes.push(3)
          if (s.u) codes.push(4)
          if (s.inv) codes.push(7)
          if (fg) codes.push(`38;2;${fg}`)
          if (bg) codes.push(`48;2;${bg}`)
          return codes.length ? `\x1b[${codes.join(';')}m${s.s}\x1b[0m` : s.s
        })
        .join(''),
    )
    .join('\n')
}

const plain = lines => lines.map(l => l.map(s => s.s).join('').replace(/\s+$/, '')).join('\n')

/** The states a check or a reviewer looks at: each tab as it opens, then with its first row selected. */
function states(spec, data, cols, rows) {
  const out = []
  spec.tabs.forEach((tab, i) => {
    let st = { ...initialState(), tab: i }
    out.push({ name: `${tab.name}`, st })
    const lay = viewLayout(spec, data, st, cols, rows)
    const first = lay.meta.order[0]
    if (first) {
      st = reduce(spec, data, st, { op: 'select', c: first.c, k: first.k }).state
      out.push({ name: `${tab.name}, first row selected`, st })
    }
  })
  return out
}

const opt = args(process.argv.slice(2))
if (!opt.spec || !opt.rows) {
  process.stderr.write('usage: render_view.mjs --spec view.json --rows rows.json [--width N] [--height N] [--tab N] [--select c/k|first] [--plain] [--all] [--check]\n')
  process.exit(2)
}
const cols = Number(opt.width)
const rows = Number(opt.height)
const spec = JSON.parse(readFileSync(opt.spec, 'utf8'))
const data = JSON.parse(readFileSync(opt.rows, 'utf8'))
// rows.json in parts (helper/viewpipe.py write_rows): each part's rows put back in place
for (const part of data.parts ?? []) {
  const got = JSON.parse(readFileSync(join(dirname(opt.rows), part), 'utf8'))
  for (const [k, rows] of Object.entries(got.collections ?? {})) (data.collections[k] ??= []).push(...rows)
}
delete data.parts
const specProblems = validateSpec(spec, { builtin: Boolean(opt.builtin) })

if (opt.check) {
  const report = { ok: false, spec: specProblems, rows: [], notes: [], width: [] }
  if (!specProblems.length) {
    const d = validateData(spec, data)
    report.rows = d.problems
    report.notes = d.notes
    if (!d.problems.length) {
      for (const w of [cols, Math.max(60, cols - 30)]) {
        for (const s of states(spec, data, w, rows)) {
          try {
            const lay = viewLayout(spec, data, s.st, w, rows)
            const wide = lay.lines.findIndex(l => lineWidth(l) > w)
            if (wide >= 0) report.width.push(`${s.name} at ${w} columns: line ${wide + 1} is ${lineWidth(lay.lines[wide])} wide`)
            if (lay.lines.length > rows) report.width.push(`${s.name} at ${w} columns: ${lay.lines.length} lines for ${rows}`)
          } catch (err) {
            report.width.push(`${s.name} at ${w} columns: drawing failed: ${String(err?.stack ?? err).split('\n').slice(0, 3).join(' ')}`)
          }
        }
      }
    }
  }
  // thimble's label check (--labeltest): a test label that marks about one row in seven, on; each tab must draw its
  // colour on the marked rows in view
  if (opt.labeltest && !report.spec.length && !report.rows.length) {
    report.labels = []
    report.marked = 0
    const TEST = '#0f7b6c'
    const marks = {}
    for (const c of spec.collections) {
      ;(data.collections[c.name] ?? []).forEach((r, i) => {
        if (i % 7 === 0 && typeof r[c.ref ?? 'ref'] === 'string') marks[r[c.ref ?? 'ref']] = 'marked'
      })
    }
    const tested = { ...data, labels: [...(data.labels ?? []), { id: 'test-label', name: 'Test label', values: ['marked', 'other'], colours: { marked: TEST }, marks }] }
    spec.tabs.forEach((tab, i) => {
      try {
        const lay = viewLayout(spec, tested, { ...initialState(), tab: i, labelsOn: ['test-label'] }, cols, rows)
        const col = spec.collections.find(c => c.name === tab.collection)
        const byKey = new Map((tested.collections[tab.collection] ?? []).map(r => [String(r[col.key]), r]))
        const shown = lay.meta.order.slice(lay.meta.start, lay.meta.start + lay.meta.cap)
        const inView = shown.filter(o => o.c === tab.collection && marks[byKey.get(o.k)?.[col.ref ?? 'ref']]).length
        const drawn = lay.lines.filter(l => l.some(s => s.fg === TEST || s.bg === TEST)).length
        report.marked += drawn
        if (inView && !drawn) report.labels.push(`${tab.name}: the test label marks ${inView} rows in view and none is drawn in its colour`)
      } catch (err) {
        report.labels.push(`${tab.name} with a label on: drawing failed: ${String(err?.stack ?? err).split('\n').slice(0, 3).join(' ')}`)
      }
    })
  }
  report.ok = !report.spec.length && !report.rows.length && !report.width.length && !(report.labels ?? []).length
  process.stdout.write(JSON.stringify(report, null, 1) + '\n')
  process.exit(report.ok ? 0 : 1)
}

if (specProblems.length) {
  process.stderr.write(`the spec does not validate:\n${specProblems.map(p => `  ${p}`).join('\n')}\n`)
  process.exit(1)
}
const print = lines => (opt.plain ? plain(lines) : ansi(opt.bare ? lines : [...lines, ...Array.from({ length: Math.max(0, rows - lines.length) }, () => [])], opt.theme, opt.bare ? 0 : cols))
if (opt.all) {
  const parts = states(spec, data, cols, rows).map(s => {
    const lay = viewLayout(spec, data, s.st, cols, rows)
    return `=== ${s.name}\n${print(lay.lines)}`
  })
  process.stdout.write(parts.join('\n\n') + '\n')
} else {
  let st = opt.state ? { ...initialState(), ...JSON.parse(opt.state.trim().startsWith('{') ? opt.state : readFileSync(opt.state, 'utf8')) } : initialState()
  if (opt.tab !== undefined) st.tab = Number(opt.tab)
  if (opt.select) {
    if (opt.select === 'first') {
      const first = viewLayout(spec, data, st, cols, rows).meta.order[0]
      if (first) st = reduce(spec, data, st, { op: 'select', ...first }).state
    } else {
      const at = opt.select.indexOf('/')
      st = reduce(spec, data, st, { op: 'select', c: opt.select.slice(0, at), k: opt.select.slice(at + 1) }).state
    }
  }
  process.stdout.write(print(viewLayout(spec, data, st, cols, rows).lines) + '\n')
}
