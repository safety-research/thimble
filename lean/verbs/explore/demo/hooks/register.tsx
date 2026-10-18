// Explore (x) in Claude Code, until the lean shell lands. A stand-in for the shell, kept small:
//
//   /explore                 explores what the last turn made: the object it saved, else the reply itself
//   /explore <object> [region] [knob=value]   explores that object, with a part selected and knobs set
//   /explore open            the view the person used last, in the browser, same knobs and selection
//   a `lean save` of an explore view shows the view under the call, ready to use
//
// The verb itself (lean/verbs/explore/run.mjs) decides: it opens a view Claude already wrote, or returns a note
// asking Claude to write one, which this module submits as a turn the person sees. The view is a Client: a click
// gives it the keys, then ◂ ▸ turn a knob, tab moves between parts, ↵ reads the selected part's rows through the
// kernel (`lean resolve`, `lean rows`). Programs run in a Node child under --permission (lean/draw/sandbox-node.mjs),
// as the draw demo runs them.
import type { Register } from 'claude-code'

import { fromArgs, toHash } from './lib/draw/handoff.js'
import { hex } from './lib/draw/palette.js'
import { regionAt, renderTerm } from './lib/draw/term.js'
import { press, run, turnKnob } from './lib/verbs/explore/run.mjs'
import { viewLines } from './lib/verbs/explore/view.mjs'

// the engine's interface and element table, as far as this module uses them
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Obj = { id: string; version?: number; title?: string; verb?: string; program?: string; data?: unknown; updated?: string; [k: string]: unknown }
type Live = { id: string; view: Any; ctx: Any; cols: number; ack: number }

const live = new Map<string, Live>()
const byCall = new Map<string, string>() // a `lean save` call's tool_use_id -> the view under it
const byArgs = new Map<string, string>() // an /explore command's arguments -> its view
let savedInTurn: string[] = [] // objects the last turn saved
let lastView = ''
let theme: 'dark' | 'light' = 'dark'
let cols = 100
let seq = 0
const LOAD = Math.random().toString(36).slice(2, 8)

function paths($: Any) {
  const root = String($.plugin.root).replace(/\/+$/, '')
  const lean = root.replace(/\/verbs\/explore\/demo$/, '')
  return { lean, draw: `${lean}/draw`, bin: `${lean}/bin/lean`, skill: `${lean}/verbs/explore/SKILL.md` }
}

// the ctx run() and press() take: the kernel through the `lean` command, programs in a sandboxed Node child
async function makeCtx($: Any, w: number) {
  const P = paths($)
  const cwd = String(await $.session.cwd())
  const sid = String(await $.session.id())
  const lean = async (args: string[]) => {
    const r = await $.process.run([P.bin, ...args], { cwd, env: { LEAN_SESSION: sid }, timeoutMs: 60000 })
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.exitCode}`).trim().slice(0, 300))
    return String(r.stdout)
  }
  const objects = async (): Promise<Obj[]> => {
    const dir = `${cwd}/thimble/objects`
    if (!(await $.fs.exists(dir))) return []
    const out: Obj[] = []
    for (const f of await $.fs.list(dir)) if (f.kind === 'file' && f.name.endsWith('.json')) {
      try { out.push(JSON.parse(String(await $.fs.read(`${dir}/${f.name}`)))) } catch { /* a file being written */ }
    }
    return out
  }
  const cache = new Map<string, Any>()
  return {
    w, h: 24, skill: P.skill, cwd, check: `node ${P.lean}/verbs/explore/cli.mjs --text`,
    kernel: {
      resolve: async (ref: string, o: { n?: number } = {}) => JSON.parse(await lean(['resolve', ref, '--json', '-n', String(o.n || 5)])),
      rows: async (ref: string, o: { n?: number; fields?: string[] } = {}) => (await lean(['rows', ref, '-n', String(o.n || 5), '--first', '--width', '200', ...(o.fields && o.fields.length ? ['--fields', o.fields.join(',')] : [])]))
        .split('\n').map(l => /^(\S+#\S+) {2}(.*)$/.exec(l)).filter(Boolean).map(m => { let value: unknown = m![2]; try { value = JSON.parse(m![2]!) } catch { /* a text row */ } return { ref: m![1], value } }),
      list: objects,
      load: async (name: string) => (await objects()).find(o => o.id === name || o.id.replace(/^\d+-/, '') === name) || null,
    },
    draw: {
      run: async (object: Obj, o: { w: number; h: number; state: unknown }) => {
        const key = `${object.id}@${object.version}|${o.w}|${JSON.stringify(o.state || {})}`
        if (cache.has(key)) return cache.get(key)
        const r = await $.process.run(['node', '--permission', `--allow-fs-read=${P.draw}`, `${P.draw}/sandbox-node.mjs`], {
          stdin: JSON.stringify({ program: object.program, data: object.data, w: o.w, h: o.h, state: o.state }), timeoutMs: 20000,
        })
        if (r.exitCode !== 0) throw new Error(`the sandbox did not run: ${String(r.stderr).slice(0, 300)}`)
        const d = JSON.parse(String(r.stdout))
        cache.set(key, d)
        return d
      },
    },
  }
}

const isExplore = (o: Obj | null) => !!o && (o.verb === 'explore' || /\bk\.knob\s*\(/.test(String(o.program || '')))

function width(c: number) { return Math.max(60, Math.min(120, c - 6)) }

async function openLive($: Any, object: Obj | null, sel: Any, reply?: string) {
  const w = width(cols)
  const ctx = await makeCtx($, w)
  Object.assign(ctx, { object, state: (sel && sel.state) || {}, region: (sel && sel.region) || null, reply: reply ? { text: reply } : undefined })
  let r = await run(ctx as Any)
  if (!r.view) return { r }
  // a new version of a view the person already used opens with their knobs and selection, when the ids still hold
  const before = [...live.values()].reverse().find(x => x.view.object.id === r.object.id)
  if (before && !sel && (Object.keys(before.view.state || {}).length || before.view.region)) {
    Object.assign(ctx, { object: r.object, state: before.view.state, region: before.view.region })
    r = await run(ctx as Any)
    if (!r.view) return { r }
  }
  ;(ctx as Any).object = r.object
  const id = `${LOAD}-${++seq}` // unique across reloads: a Client drawn by an earlier load never reaches a newer view
  live.set(id, { id, view: r.view, ctx, cols: w, ack: 0 })
  lastView = id
  return { r, id }
}

// the Client's props: the view's lines with colors, the last key it has seen
function propsOf(L: Live) {
  const lines = viewLines(L.view, { w: L.cols, hintRight: 'click for keys · /explore open ↗' })
  const col = (t: string | undefined) => (!t || t === 'ink' ? undefined : hex(t, theme))
  return {
    id: L.id, cols: L.cols, ack: L.ack,
    lines: lines.map((l: Any[]) => l.map(g => ({ s: g.s, fg: col(g.tone), ...(g.sel ? { bg: hex('select', theme) } : g.bg ? { bg: hex(g.bg, theme) } : {}), ...(g.b ? { b: true } : {}), ...(g.u ? { u: true } : {}) }))),
  }
}

function client(els: Any, L: Live) {
  const { Client } = els
  return <Client key={`explore-${L.id}`} module="./view.tsx" width={L.cols} props={JSON.parse(JSON.stringify(propsOf(L)))} />
}

const text = (L: Live) => viewLines(L.view, { w: L.cols }).map((l: Any[]) => l.map(g => g.s).join('').replace(/\s+$/, '')).join('\n')

// a click selects the part under it; on a knob's ◂ or ▸ it turns the knob; a second click on a part reads its rows
async function click(L: Live, x: number, y: number) {
  const grid = renderTerm(L.view.drawing, { w: L.cols })
  if (y >= grid.h) return L.view
  const r = regionAt(grid, x, y)
  if (!r) return { ...L.view, region: null, rows: null }
  if (r.meta && (r.meta as Any).knob) {
    const q = r.rects.find(q => y >= q.y && y < q.y + q.h)!
    const f = (x - q.x) / Math.max(1, q.w)
    // the arrows turn the knob and leave the selection where it was, so open rows keep following their part
    if (f < 0.34 || f > 0.66) return turnKnob(L.view, (r.meta as Any).knob, f < 0.34 ? -1 : 1, L.ctx)
    return { ...L.view, region: r.id }
  }
  if (L.view.region === r.id) return press(L.view, 'enter', L.ctx)
  return { ...L.view, region: r.id, rows: null }
}

// the view the person used last, in the browser: the same object, knobs and selection
async function openBrowser($: Any) {
  const L = live.get(lastView)
  if (!L) return { text: 'There is no explore view to open yet.' }
  const P = paths($)
  const tmp = String((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
  const work = `${tmp}/lean-explore`
  const o = L.view.object as Obj
  await $.fs.write(`${work}/objects/${o.id}.json`, JSON.stringify({ id: o.id, v: o.version, title: o.title || o.id, program: o.program, data: o.data }))
  const out = `${work}/explore.html`
  const built = await $.process.run(['node', `${P.draw}/browser/build.mjs`, out, 'none', '--objects', `${work}/objects`], { timeoutMs: 30000 })
  if (built.exitCode !== 0) return { text: `The browser page did not build: ${String(built.stderr).slice(0, 200)}` }
  const url = `file://${out}${toHash({ object: o.id, v: o.version, region: L.view.region || undefined, state: L.view.state, w: L.cols })}`
  const browser = await $.env.get('BROWSER')
  for (const argv of browser ? [[browser, url]] : [['xdg-open', url], ['open', url]]) {
    const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => null)
    if (r && r.exitCode === 0) return { text: `Opened ${o.id}${L.view.region ? ' · ' + L.view.region : ''} in the browser, with the same knobs.` }
  }
  return { text: `Could not open a browser. The page: ${url}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'explore', description: 'Explore the last result: a view Claude writes, with knobs and the real rows (x)', argumentHint: '[object] [region] [knob=value] | open' })
    try {
      const row = (await $.config.list()).find((r: Any) => r.key === 'theme')
      theme = String(row?.value ?? 'dark').startsWith('light') ? 'light' : 'dark'
    } catch { theme = 'dark' }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) savedInTurn = []
    return next(e)
  })

  // a `lean save`: remember what the turn made; an explore view shows under the call, ready to use
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (String(e.tool) !== 'Bash') return r
    try {
      const input = e as unknown as { command?: string; tool_use_id?: string }
      if (!/\blean\s+save\b/.test(String(input.command || ''))) return r
      const out = typeof (r as Any).text === 'string' ? (r as Any).text : String((r as Any).result ?? '')
      const m = /saved (\S+) v(\d+)/.exec(out)
      if (!m) return r
      savedInTurn.push(m[1]!)
      const cwd = String(await $.session.cwd())
      const object = JSON.parse(String(await $.fs.read(`${cwd}/thimble/objects/${m[1]}.json`))) as Obj
      if (!isExplore(object) || !input.tool_use_id) return r
      const got = await openLive($, object, null)
      if (got.id) byCall.set(input.tool_use_id, got.id)
    } catch {
      // the demo only adds a view; the call keeps its result
    }
    return r
  }).catch(($, e, next) => next(e)) // it never gates: if it fails, the call goes on with its result

  on('command.run', { command: 'explore' }, async ($, e) => {
    cols = Math.max(60, Number(e.presentation?.columns) || cols)
    const args = e.args.trim()
    if (/^open(\s|$)/.test(args)) return openBrowser($)
    const sel = args ? fromArgs(args) : null
    if (args && !sel) return { text: 'Type /explore, /explore <object> [region] [knob=value], or /explore open.' }
    const ctx = await makeCtx($, width(cols))
    let object: Obj | null = null
    let reply: string | undefined
    if (sel) {
      object = (await ctx.kernel.load(sel.object)) as Obj | null
      if (!object) return { text: `There is no object ${sel.object} in thimble/objects.` }
    } else if (savedInTurn.length) {
      object = (await ctx.kernel.load(savedInTurn[savedInTurn.length - 1]!)) as Obj | null
    } else {
      const msgs = (await $.session.messages()) as Any[]
      reply = [...msgs].reverse().find(m => m.role === 'assistant' && String(m.text).trim())?.text
      if (!reply) return { text: 'There is nothing to explore yet: ask Claude something first.' }
    }
    const got = await openLive($, object, sel, reply)
    // the note to Claude is a turn of its own, which can start only once this command is done
    const note = got.r.note
    if (note) $.clock.after(50, () => { void $.prompt.submit({ text: note }) })
    if (!got.id) return { text: got.r.text || 'Claude is writing a view you can explore.' }
    byArgs.set(args, got.id)
    return { text: text(live.get(got.id)!), context: [`The person opened ${got.r.object.id} with /explore. They see:\n${text(live.get(got.id)!)}`] }
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'explore' || e.props.isErrored) return next(e)
    const L = live.get(byArgs.get(String(e.props.args).trim()) || '')
    if (!L) return next(e)
    return client($.ui.resolve(e), L)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const L = live.get(byCall.get(e.props.tool_use_id) || '')
    if (!L || e.props.isErrored) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      Text({ dimColor: true, children: `saved ${L.view.object.id} v${L.view.object.version} · an explore view` }),
      client($.ui.resolve(e), L),
    ] })
  })

  // the person's keys and clicks, from the Client: each one changes the view; the Client gets the next lines
  on('ui.message', async ($, e, next) => {
    const data = e.data as { type?: string; id?: string; sent?: { seq: number; k?: string; x?: number; y?: number }[] }
    if (!data || data.type !== 'explore') return next(e)
    const L = live.get(String(data.id))
    if (!L) return {}
    lastView = L.id
    for (const s of data.sent || []) {
      if (s.seq <= L.ack) continue
      L.ack = s.seq
      try {
        if (s.k) L.view = await press(L.view, s.k, L.ctx)
        else if (s.x != null && s.y != null) L.view = await click(L, s.x, s.y)
      } catch (err) {
        L.view = { ...L.view, rows: { id: L.view.region, label: 'rows', refs: [], count: 0, records: [], note: String((err as Error)?.message || err).slice(0, 200) } }
      }
    }
    return { props: JSON.parse(JSON.stringify(propsOf(L))) }
  })
}
