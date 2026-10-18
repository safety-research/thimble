// The lean Squeeze demo: the Squeeze verb (lean/verbs/squeeze) in a real Claude Code session, until the shell lands.
//
//   a long reply         arrives squeezed: when a turn ends with a long answer, run() squeezes it with one quiet
//                        $.model.complete call, and the reply's row then draws the squeezed object in place of the text
//   /squeeze             squeezes the last long reply now, or squeezes it more
//   /squeeze fuller | <dimension> | <dimension>=<level> | <any words>   moves along the dimensions Claude chose
//   /squeeze why 2       line 2 selected, with the spans of the original it came from lit
//   /squeeze original    the original under the squeezed version, what it keeps underlined
//   /squeeze full        the reply as written again (/squeeze back squeezes it again)
//   /squeeze open [2]    the same object and selection in the browser
//   /squeeze session     the whole session, one line per turn
//
// No model tool is registered: the person runs the verb, and the call it makes reads only text already on screen.
// Objects are kept in $THIMBLE_HOME/lean/squeeze/objects/, never in the person's folder. Programs run in a Node child
// (lean/draw/sandbox-node.mjs), as in the draw demo.
import { read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { toHash } from './lib/handoff.js'
import { paintGrid } from './lib/paint.js'
import { isLong, run } from './lib/run.mjs'
import { gridText, renderTerm } from './lib/term.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Obj = { id: string; v: number; title?: string; program: string; data: Any; text?: string; kind?: string; lineage?: Any }
type Entry = { key: string; text: string; question?: string; turn?: string; object?: Obj; pending?: boolean; full?: boolean; error?: string }
type Drawn = { drawing: Any; grid: ReturnType<typeof renderTerm>; w: number }

const tick = { plugin: 'lean-squeeze-demo', key: 'tick' } as const

const replies = new Map<string, Entry>() // by the reply's text
const drawn = new Map<string, Drawn>() // by `${id}@${v}${show}:${w}`
const shown = new Map<string, { object: Obj; region?: string; moved?: boolean }>() // what a /squeeze row draws, by its marker
let question = ''
let theme: 'dark' | 'light' = 'dark'
let verb: Any = {}
let skill = ''
let home = ''

function keyOf(text: string): string {
  const s = String(text || '').trim()
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0') + ':' + s.length
}
const dirs = (root: string) => {
  const r = root.replace(/\/+$/, '')
  const verbDir = r.replace(/\/demo$/, '')
  return { verbDir, draw: verbDir.replace(/\/verbs\/squeeze$/, '') + '/draw' }
}

async function bump($: Any) { await update($, tick, n => (n ?? 0) + 1) }

async function drawOf($: Any, object: Obj, w: number): Promise<Drawn> {
  const k = `${object.id}@${object.v}${object.data?.show || ''}${object.data?.focus || ''}:${w}`
  const have = drawn.get(k)
  if (have) return have
  const { draw } = dirs($.plugin.root)
  const r = await $.process.run(['node', '--permission', `--allow-fs-read=${draw}`, `${draw}/sandbox-node.mjs`], {
    stdin: JSON.stringify({ program: object.program, data: object.data, w, h: 24 }),
    timeoutMs: 20000,
  })
  if (r.exitCode !== 0) throw new Error(`the sandbox did not run: ${String(r.stderr).slice(0, 300)}`)
  const drawing = JSON.parse(r.stdout)
  const d = { drawing, grid: renderTerm(drawing, { w }), w }
  drawn.set(k, d)
  return d
}

async function keep($: Any, object: Obj, entry?: Entry) {
  try {
    await $.fs.write(`${home}/lean/squeeze/objects/${object.id}.json`, JSON.stringify(object))
    // which reply it squeezes, so a resumed session draws the reply squeezed again
    if (entry) await $.fs.write(`${home}/lean/squeeze/replies/${entry.key.replace(/\W/g, '-')}.json`, JSON.stringify({ key: entry.key, object: object.id, at: Date.now() }))
  } catch {
    // keeping a copy for the browser and for a resume is a convenience; the object stays in this session
  }
}

async function reload($: Any) {
  try {
    const dir = `${home}/lean/squeeze/replies`
    if (!(await $.fs.exists(dir))) return
    for (const f of await $.fs.list(dir)) {
      if (!String(f.name).endsWith('.json')) continue
      const r = JSON.parse(String(await $.fs.read(`${dir}/${f.name}`)))
      const object = JSON.parse(String(await $.fs.read(`${home}/lean/squeeze/objects/${r.object}.json`)))
      if (object.data) delete object.data.focus
      replies.set(r.key, { key: r.key, text: '', object })
    }
  } catch {
    // nothing kept, or a copy that does not read: those replies show as written
  }
}

function ctxFor($: Any, object: Any, args = '', region?: string) {
  return { object, args, region, model: { complete: (req: Any) => $.model.complete(req) }, skill, verb }
}

async function squeezeReply($: Any, entry: Entry) {
  try {
    const r = await run(ctxFor($, { id: `reply:${entry.turn || entry.key}`, text: entry.text, question: entry.question }))
    if (r.object) { entry.object = r.object as Obj; await keep($, entry.object, entry) }
    else entry.error = r.text || 'nothing came back'
  } catch (err) {
    entry.error = String((err as Error)?.message || err).slice(0, 200)
    $.ui.toast(`Squeeze failed: ${entry.error}. Type /squeeze to try again.`)
  }
  entry.pending = false
  $.ui.status(undefined)
  await bump($)
}

// the one line of hints under a squeeze: what the verb can do next for THIS object
function hints(o: Obj): string {
  const d = o.data
  const focus = /^line-(\d+)$/.exec(d.focus || '')
  if (focus) {
    const v = d.versions.find((x: Any) => JSON.stringify(x.at) === JSON.stringify(d.at)) || d.versions[0]
    const n = Number(focus[1])
    const near = [n - 1, n + 1].filter(i => i >= 1 && i <= v.lines.length).map(i => `why ${i}`)
    return '/squeeze  ' + near.concat([`open ${n}`, 'original']).join(' · ')
  }
  const v = d.versions.find((x: Any) => JSON.stringify(x.at) === JSON.stringify(d.at)) || d.versions[0]
  const first = d.dims[0]
  const at = v.at[first.id] ?? 0
  const parts: string[] = []
  if (at > 0) parts.push('shorter')
  if (at < first.levels.length - 1) parts.push('fuller')
  for (const x of d.dims.slice(1)) parts.push(`${x.name} ▸ ${x.levels[((v.at[x.id] ?? 0) + 1) % x.levels.length]}`)
  if (v.lines.length > 1) parts.push('why 2')
  parts.push(d.show === 'original' ? 'back' : 'original', 'open')
  return '/squeeze  ' + parts.join(' · ')
}

function view(els: Any, s: { object: Obj; d: Drawn; region?: string }, key: string, bullet: boolean) {
  const { Box, Text } = els
  const body = paintGrid(s.d.grid, els, { theme, selected: s.region, key })
  const rows = [body]
  const r = s.region && !s.object.data?.focus ? s.d.grid.regions.find((x: Any) => x.id === s.region) : undefined
  if (r) {
    const cite = r.meta.cite ? s.d.drawing.cites[r.meta.cite] : undefined
    const said = cite ? `▸ ${r.id.replace('-', ' ')} came from ${cite.source.replace(/^the original, /, '')}: ${cite.text}` : `▸ ${r.meta.label || r.id}`
    rows.push(Text({ wrap: 'truncate-end', bold: true, children: said }))
  }
  rows.push(Text({ dimColor: true, wrap: 'truncate-end', children: hints(s.object) }))
  const col = Box({ flexDirection: 'column', children: rows })
  return bullet ? Box({ flexDirection: 'row', marginTop: 1, children: [Text({ children: '● ' }), col] }) : col
}

function messagesToUnits(msgs: Any[]): { id: string; text: string }[] {
  const units: { id: string; text: string }[] = []
  let cur: { you: string; claude: string[]; tools: number } | null = null
  const flush = () => {
    if (!cur) return
    const said = cur.claude.join(' ').replace(/\s+/g, ' ').trim()
    units.push({ id: `t${units.length + 1}`, text: `you: ${cur.you.replace(/\s+/g, ' ').slice(0, 300)} → claude${cur.tools ? ` (${cur.tools} tool calls)` : ''}: ${said.slice(0, 600)}${said.length > 600 ? '…' : ''}` })
    cur = null
  }
  for (const m of msgs) {
    // a turn starts at the person's own words (a slash command's record is not a turn)
    if (m.role === 'user' && m.text && !(m.toolResults || []).length && !/^\s*(<command-|\/)/.test(m.text)) { flush(); cur = { you: m.text, claude: [], tools: 0 } }
    else if (m.role === 'assistant' && cur) { if (m.text) cur.claude.push(m.text); cur.tools += (m.toolUses || []).length }
  }
  flush()
  return units
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { verbDir } = dirs($.plugin.root)
    await $.command.register({
      name: 'squeeze',
      description: 'Squeeze the last long reply on dimensions Claude picks: /squeeze [fuller | <dimension> | why 2 | original | full | open | session | any words]',
      argumentHint: '[fuller | <dimension> | why N | original | full | open | session]',
    })
    try {
      const row = (await $.config.list()).find((x: Any) => x.key === 'theme')
      theme = String(row?.value ?? 'dark').startsWith('light') ? 'light' : 'dark'
    } catch { theme = 'dark' }
    try { verb = JSON.parse(String(await $.fs.read(`${verbDir}/verb.json`))) } catch { verb = {} }
    try { skill = String(await $.fs.read(`${verbDir}/SKILL.md`)) } catch { skill = '' }
    home = ((await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`).replace(/\/+$/, '')
    await reload($)
    $.ui.status(undefined) // a squeeze an earlier load of this module left running is gone with it
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const t = String((e as Any).text || '')
    if (t && !t.startsWith('/')) question = t
    return next(e)
  })

  // the default: a long answer arrives squeezed
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId || e.reason !== 'answer' || verb.auto === false) return r
      const text = String(e.answer || '')
      if (!isLong(text, verb.auto || {})) return r
      const key = keyOf(text)
      if (replies.has(key)) return r
      const entry: Entry = { key, text, question, turn: e.turnId, pending: true }
      replies.set(key, entry)
      $.ui.status('squeezing the reply…')
      $.clock.after(1, () => { void squeezeReply($, entry) })
    } catch {
      // the default never changes a turn's end
    }
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    try {
      await read($, tick)
      const entry = replies.get(keyOf(e.props.text))
      if (!entry || entry.full || !entry.object) return next(e)
      const w = Math.max(40, Math.min(140, (e.viewport?.columns ?? 100) - 4))
      const d = await drawOf($, entry.object, w)
      return view($.ui.resolve(e), { object: entry.object, d }, `reply-${entry.key.replace(/\W/g, '')}`, e.props.isFirstOfReply)
    } catch {
      return next(e)
    }
  })

  on('command.run', { command: 'squeeze' }, async ($, e) => {
    const args = e.args.trim()
    const w = Math.max(40, Math.min(140, e.presentation.columns - 4))
    // a move changes the reply's own row, so its command row is one line; a new object draws in the command row
    const answer = async (object: Obj, region: string | undefined, said: string | null, note?: string | null, moved = false) => {
      if (!object.data?.focus) await keep($, object) // a focused view is a way of drawing the object, not a version of it
      const marker = `${object.id}@${object.v}${object.data?.show ? '~' + object.data.show : ''}${object.data?.focus ? '#' + object.data.focus : ''}${region ? ' ' + region : ''}`
      shown.set(marker, { object, region, moved })
      if (!moved) await drawOf($, object, w)
      return { text: `[squeeze ${marker}]\n${said || object.text || ''}`, ...(note ? { context: [note] } : {}) }
    }
    try {
      if (args === 'session') {
        const units = messagesToUnits(await $.session.messages())
        if (units.length < 3) return { text: 'The session has fewer than three turns, so there is nothing to squeeze yet.' }
        const r = await run(ctxFor($, { id: 'session', title: 'this session', units, question: 'What happened in this session, turn by turn?' }))
        return r.object ? answer(r.object as Obj, undefined, r.text, r.note) : { text: r.text || 'Nothing came back.' }
      }
      // the conversation's last long reply, squeezed already or not
      let entry: Entry | undefined
      const msgs = await $.session.messages()
      for (let i = msgs.length - 1; i >= 0 && !entry; i--) {
        const m = msgs[i]
        if (!m || m.role !== 'assistant' || !isLong(m.text, verb.auto || {})) continue
        const key = keyOf(m.text)
        entry = replies.get(key)
        if (!entry) {
          const asked = msgs.slice(0, i).reverse().find((x: Any) => x.role === 'user' && x.text && !(x.toolResults || []).length)
          entry = { key, text: m.text, question: asked?.text }
          replies.set(key, entry)
        }
      }
      if (!entry) return { text: 'There is no long reply to squeeze yet.' }
      if (args === 'full' || args === 'back') {
        entry.full = args === 'full'
        await bump($)
        return { text: entry.full ? 'The reply is shown as written. /squeeze back squeezes it again.' : 'The reply is squeezed again.' }
      }
      const open = /^open(?:\s+(\d+))?$/.exec(args)
      if (open) {
        if (!entry.object) return { text: 'Squeeze the reply first: /squeeze.' }
        const { draw } = dirs($.plugin.root)
        const page = `${home}/lean/squeeze/page.html`
        await keep($, entry.object)
        const b = await $.process.run(['node', `${draw}/browser/build.mjs`, page, 'none', '--objects', `${home}/lean/squeeze/objects`], { timeoutMs: 30000 })
        if (b.exitCode !== 0) return { text: `The browser page was not built: ${String(b.stderr || b.stdout).trim().split('\n')[0]}` }
        const url = `file://${page}${toHash({ object: entry.object.id, v: entry.object.v, region: open[1] ? `line-${open[1]}` : undefined })}`
        const browser = await $.env.get('BROWSER')
        for (const argv of browser ? [[browser, url]] : [['xdg-open', url], ['open', url]]) {
          const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => null)
          if (r && r.exitCode === 0) return { text: `Opened ${entry.object.id}@${entry.object.v} in the browser.` }
        }
        return { text: `Could not open a browser. The page: ${url}` }
      }
      if (entry.pending) return { text: 'The reply is still being squeezed; it shows in place when it is ready.' }
      const why = /^(?:why|from)\s+(\d+)$/.exec(args)
      if (why && entry.object) {
        const r = await run(ctxFor($, entry.object, '', `line-${why[1]}`))
        const object = { ...entry.object, data: { ...entry.object.data, show: null, focus: `line-${why[1]}` } }
        return answer(object, `line-${why[1]}`, r.text, null)
      }
      $.ui.status('squeezing…')
      const r = await run(ctxFor($, entry.object || { id: `reply:${entry.turn || entry.key}`, text: entry.text, question: entry.question }, args))
      $.ui.status(undefined)
      if (!r.object) return { text: r.text || 'Nothing changed.' }
      entry.object = r.object as Obj
      entry.full = false
      entry.error = undefined
      await keep($, entry.object, entry)
      await bump($)
      return answer(entry.object, undefined, r.text, r.note, true)
    } catch (err) {
      $.ui.status(undefined)
      return { text: `Squeeze failed: ${String((err as Error)?.message || err).slice(0, 300)}. Type /squeeze again to retry.` }
    }
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'squeeze' || e.props.isErrored) return next(e)
    try {
      const marker = /\[squeeze ([^\]]+)\]/.exec(e.props.text)?.[1]
      const s = marker ? shown.get(marker) : undefined
      if (!s) return next(e)
      if (s.moved) {
        const { Text } = $.ui.resolve(e)
        const d = s.object.data
        const v = d.versions.find((x: Any) => JSON.stringify(x.at) === JSON.stringify(d.at)) || d.versions[0]
        const where = d.dims.map((x: Any) => `${x.name} ${x.levels[v.at[x.id] ?? 0]}`).join(' · ')
        return Text({ dimColor: true, wrap: 'truncate-end', children: `  ⎿  ↑ the reply above is now ${d.show === 'original' ? 'beside its original' : `${v.lines.length} of ${d.of.lines} lines`} · ${where}` })
      }
      const w = Math.max(40, Math.min(140, (e.viewport?.columns ?? 100) - 4))
      const d = await drawOf($, s.object, w)
      return view($.ui.resolve(e), { object: s.object, d, region: s.region }, `cmd-${(marker || '').replace(/\W+/g, '-')}`, false)
    } catch {
      return next(e)
    }
  })
}

