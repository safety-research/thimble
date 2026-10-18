// The lean-draw demo: objects drawn in the terminal with the drawing contract.
//
//   /draw                      lists the example objects
//   /draw <object>[@v]         draws one in the transcript, at the terminal's width
//   /draw <object> <region>    draws it with that region selected, its cite under it, and a link that opens the
//                              browser page on the same object and selection
//   the draw tool              Claude draws an object of its own: a program against the toolkit (TOOLKIT.md)
//
// A hooks module cannot run program text (code generation from strings is off here), so each program runs in a
// Node child, sandbox-node.mjs, under --permission: a fresh vm context that holds the toolkit and the data only.
// The child hands back a drawing (plain JSON); term.js lays it out in cells and paint.js draws the cells.
import type { Register } from 'claude-code'

import { fromArgs, toCommand, toHash } from './lib/handoff.js'
import { paintGrid } from './lib/paint.js'
import { gridText, renderTerm } from './lib/term.js'

type Meta = { label?: string; cite?: string; examples?: string; [k: string]: unknown }
type Drawing = {
  w: number
  regions: { id: string; meta: Meta }[]
  cites: Record<string, { text?: string; source?: string; more?: number; rows?: unknown[] }>
  examples: Record<string, { label?: string; total: number }>
  warnings: string[]
  error?: { name: string; message: string; line?: number | null }
}
type Grid = ReturnType<typeof renderTerm>
type Obj = { id: string; v?: number; title?: string; program: string; data: unknown }
type Shown = { object: Obj; drawing: Drawing; grid: Grid; region?: string; w: number }
type Entry = { id: string; v: number; title: string; program: string; data: string }
// the engine's interface and element table, as far as this module uses them
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const byArgs = new Map<string, Shown>()
const byCall = new Map<string, Shown>()
const byId = new Map<string, Obj>()   // the objects Claude drew with the tool, the latest version of each
let theme: 'dark' | 'light' = 'dark'
let page = ''
let work = ''
let pageProblem = ''

function dirOf(root: string): string {
  return root.replace(/\/+$/, '').replace(/\/demo-plugin$/, '')
}

// run a program in a Node child: a fresh vm context, file reads limited to lean/draw, no writes, no processes
async function sandbox($: Any, object: Obj, w: number): Promise<Drawing> {
  const dir = dirOf($.plugin.root)
  const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/sandbox-node.mjs`], {
    stdin: JSON.stringify({ program: object.program, data: object.data, w, h: 24 }),
    timeoutMs: 20000,
  })
  if (r.exitCode !== 0) throw new Error(`the sandbox did not run: ${r.stderr.slice(0, 400)}`)
  return JSON.parse(r.stdout) as Drawing
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const dir = dirOf($.plugin.root)
    await $.command.register({ name: 'draw', description: 'Draw an object in the terminal: /draw <object> [region]', argumentHint: '<object> [region]' })
    await $.tool.register({
      name: 'draw',
      description: `Draw an object for the person: a small program against the drawing toolkit. It shows in the terminal now, and the same program draws in the browser. Read ${dir}/TOOLKIT.md before your first call: it says what the toolkit has and how to write a program. The result shows you the cells the person sees, the regions, and any warnings.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'a stable id for the object, such as messages-by-day' },
          title: { type: 'string' },
          program: { type: 'string', description: 'the body of a function (k, data) => node' },
          data: { type: ['object', 'array'], description: 'the data the program draws, as JSON (not a string)' },
          select: { type: 'string', description: 'a region id to show selected' },
        },
        required: ['program'],
      },
    })
    try {
      const row = (await $.config.list()).find(r => r.key === 'theme')
      theme = String(row?.value ?? 'dark').startsWith('light') ? 'light' : 'dark'
    } catch { theme = 'dark' }
    // the browser page the terminal hands off to: one self-contained file, built from the examples
    const tmp = (await $.env.get('TMPDIR')) || '/tmp'
    work = `${tmp.replace(/\/+$/, '')}/lean-draw`
    const out = `${work}/demo.html`
    try {
      const built = await $.process.run(['node', `${dir}/browser/build.mjs`, out, '--objects', `${work}/objects`], { timeoutMs: 30000 })
      if (built.exitCode === 0) page = out
      else {
        const lines = (built.stderr || built.stdout || `exit ${built.exitCode}`).trim().split('\n')
        pageProblem = (lines.find(l => /Error/.test(l)) || lines[0] || '').trim().slice(0, 160)
      }
    } catch (err) {
      pageProblem = String((err as Error)?.message || err).slice(0, 160)
    }
    return next(e)
  })

  on('command.run', { command: 'draw' }, async ($, e) => {
    const dir = dirOf($.plugin.root)
    const index = JSON.parse(await $.fs.read(`${dir}/examples/index.json`)) as Entry[]
    let args = e.args.trim()
    // /draw open <object> [region]: the same object and selection in the browser page
    if (/^open(\s|$)/.test(args)) {
      const want = fromArgs(args.replace(/^open\s*/, ''))
      if (!want) return { text: 'Type /draw open <object> [region].' }
      if (!page) return { text: `There is no browser page: ${pageProblem || 'it was not built'}.` }
      if (byId.has(want.object)) {
        // the page carries the objects Claude drew: build it again so it has the latest
        await $.process.run(['node', `${dirOf($.plugin.root)}/browser/build.mjs`, page, '--objects', `${work}/objects`], { timeoutMs: 30000 })
      }
      const shownBefore = [...byArgs.values(), ...byCall.values()].reverse().find(x => x.object.id === want.object)
      const url = `file://${page}${toHash({ ...want, v: want.v ?? shownBefore?.object.v, w: shownBefore?.w })}`
      const browser = await $.env.get('BROWSER')
      const tries = browser ? [[browser, url]] : [['xdg-open', url], ['open', url]]
      for (const argv of tries) {
        const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => null)
        if (r && r.exitCode === 0) return { text: `Opened ${toCommand(want).replace(/^\/draw /, '')} in the browser.` }
      }
      return { text: `Could not open a browser. The page: ${url}` }
    }
    const sel = fromArgs(args)
    const refs = index.map(x => `${x.id}@${x.v}`).join(' · ')
    if (!sel) return { text: `Objects: ${refs}\n\n/draw <object> draws one; /draw <object> <region> selects a part of it.` }
    const entry = index.find(x => x.id === sel.object && (sel.v == null || x.v === sel.v))
    const drawn = byId.get(sel.object)
    if (!entry && !drawn) return { text: `There is no object "${sel.object}". The objects: ${refs}${byId.size ? ' · ' + [...byId.keys()].join(' · ') : ''}` }
    const object: Obj = entry ? {
      id: entry.id, v: entry.v, title: entry.title,
      program: await $.fs.read(`${dir}/examples/${entry.program}`),
      data: JSON.parse(await $.fs.read(`${dir}/examples/${entry.data}`)),
    } : drawn!
    const w = Math.max(40, Math.min(140, e.presentation.columns - 4))
    const drawing = await sandbox($, object, w)
    const grid = renderTerm(drawing, { w })
    byArgs.set(args, { object, drawing, grid, region: sel.region, w })
    const ref = `${object.id}@${object.v}`
    return {
      text: '```\n' + gridText(grid) + '\n```',
      context: [`The person drew ${ref} with /draw${sel.region ? `, with the region ${sel.region} selected` : ''}. It reads:\n${gridText(grid)}`],
    }
  })

  // Claude's own objects: the program runs in the same sandbox; Claude reads back the cells the person sees
  on('tool.call', { tool: 'mcp__lean-draw-demo__draw' }, async ($, e) => {
    const input = e as unknown as { tool_use_id?: string; id?: string; title?: string; program?: string; data?: unknown; select?: string }
    let data = input.data ?? {}
    if (typeof data === 'string') {
      try { data = JSON.parse(data) } catch { return { result: 'data is a string that is not JSON; pass the data as a JSON object or array.' } }
    }
    const id = String(input.id || 'object').replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 64) || 'object'
    const prev = byId.get(id)
    const same = prev && prev.program === String(input.program || '') && JSON.stringify(prev.data) === JSON.stringify(data)
    const object: Obj = { id, v: same ? prev!.v : (prev?.v ?? 0) + 1, title: input.title, program: String(input.program || ''), data }
    byId.set(id, object)
    if (work) await $.fs.write(`${work}/objects/${id}.json`, JSON.stringify(object)).catch(() => undefined)
    const w = 100
    const drawing = await sandbox($, object, w)
    const grid = renderTerm(drawing, { w })
    if (input.tool_use_id) byCall.set(input.tool_use_id, { object, drawing, grid, region: input.select, w })
    const lines = [gridText(grid), '']
    if (drawing.error) lines.push(`The program failed: ${drawing.error.name}: ${drawing.error.message}${drawing.error.line ? ` (line ${drawing.error.line})` : ''}`)
    lines.push(`object: ${id}@${object.v} · regions: ${grid.regions.map(r => r.id).join(', ') || 'none'}`)
    if (drawing.warnings.length) lines.push('warnings:', ...drawing.warnings.map(x => '- ' + x))
    if (grid.cut.length) lines.push(`cut to fit ${w} columns: ${JSON.stringify(grid.cut).slice(0, 400)}`)
    return { result: lines.join('\n') }
  }).catch(($, e, next) => ({ deny: `the draw tool failed: ${String(next.error && (next.error as Error).message || next.error).slice(0, 300)}` }))

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'draw' || e.props.isErrored) return next(e)
    const shown = byArgs.get(e.props.args.trim())
    if (!shown) return next(e)
    return view($.ui.resolve(e), shown, 'cmd-' + e.props.args.trim().replace(/[^A-Za-z0-9]+/g, '-'))
  })

  // the call row: what is being drawn, not the program's text
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'mcp__lean-draw-demo__draw') return next(e)
    const { Text } = $.ui.resolve(e)
    const input = (e.props.input || {}) as { title?: string; id?: string; program?: string }
    const lines = String(input.program || '').split('\n').length
    return Text({ wrap: 'truncate-end', children: [
      Text({ bold: true, children: '● draw ' }),
      Text({ children: input.title || input.id || 'an object' }),
      Text({ dimColor: true, children: e.props.isRunning ? '  · running its program…' : `  · ${input.id || 'object'} · a program of ${lines} lines` }),
    ] })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'mcp__lean-draw-demo__draw' || e.props.isErrored) return next(e)
    const shown = byCall.get(e.props.tool_use_id)
    if (!shown) return next(e)
    return view($.ui.resolve(e), shown, 'call-' + e.props.tool_use_id.slice(-12))
  })

  // the object, then one quiet line: the selected part and its cite, or how to select one; and the way to the browser
  function view(els: Any, s: Shown, key: string) {
    const { Box, Text } = els
    const body = paintGrid(s.grid, els, { theme, selected: s.region, key })
    const sel = { object: s.object.id, v: s.object.v, region: s.region, w: s.w }
    const r = s.region ? s.grid.regions.find(x => x.id === s.region) : undefined
    // one line: what is selected (or how to select), cut to fit here; the way to the browser kept whole at its end
    const said: { s: string; bold?: boolean }[] = []
    if (r) {
      const cite = r.meta.cite ? s.drawing.cites[r.meta.cite as string] : undefined
      const ex = r.meta.examples ? s.drawing.examples[r.meta.examples as string] : undefined
      said.push({ s: `▸ ${r.meta.label || r.id}`, bold: true })
      if (cite?.text) said.push({ s: `  ${cite.text}${cite.source ? ` · ${cite.source}` : ''}` })
      if (ex) said.push({ s: ` · ${ex.total.toLocaleString('en-US')} examples` })
    } else if (s.region) {
      said.push({ s: `no region "${s.region}" in this object` })
    } else if (s.object.v != null) {
      const first = s.grid.regions.find(x => x.rects.length)
      said.push({ s: `${s.grid.regions.filter(x => x.rects.length).length} parts${first ? ` · ${toCommand({ ...sel, region: first.id })} selects one` : ''}` })
    }
    const open = `  ↗ ${toCommand(sel).replace(/^\/draw /, '/draw open ')}`
    const tail = page ? open : pageProblem ? `  no browser page: ${pageProblem}` : ''
    let room = Math.max(8, s.grid.w - [...tail].length)
    const cut: unknown[] = []
    for (const p of said) {
      if (room <= 0) break
      const chars = [...p.s]
      const text = chars.length <= room ? p.s : chars.slice(0, Math.max(0, room - 1)).join('') + '…'
      room -= [...text].length
      cut.push(Text({ bold: p.bold, dimColor: !p.bold, children: text }))
    }
    if (page) cut.push(Text({ dimColor: true, children: tail }))
    else if (pageProblem) cut.push(Text({ color: 'error', children: tail }))
    return Box({ flexDirection: 'column', children: [body, Text({ wrap: 'truncate-end', children: cut })] })
  }
}
