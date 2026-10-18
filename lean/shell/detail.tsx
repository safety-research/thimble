// detail.tsx: the card detail in the terminal, one pattern for every card (the B4 design). It is a pane docked beside
// the transcript:
//
//   header     the title, the takeaway with its citations (a citation that a part rests on selects the part), and the
//              versions, v1 · v2, where the history lives
//   card       large, its parts selectable (↑↓, a click); a knob inside it turns with , and . (or a click on ◂ ▸)
//   from       one line: the source · the rows the part uses · the labels · how much of the data was read
//   examples   the records behind the selected part, their meaningful words, flipped with [ ]
//   thread     a side thread scoped to the selected part: the prompt asks it while the detail is open (thread.ts)
//   program    behind p: the card's program over the card, the lines that drew the part lit
//
// No tab strip and no date. Keys act only while the composer is empty, so a question that starts with p or h types
// normally; a key that began a word gives its letter back. While the composer is empty the pane holds the keys, so ↑↓
// walk the parts; a letter that is no key goes to the composer and the keys go back to it. `esc` closes the program,
// then the detail. Claude Code keeps ← and → (← opens the agents view), so knobs turn on , and .
import type { EngineInterface, Register } from 'claude-code'

import type { ObjRef, Sel } from '../types'
import { knobOf, turn as turnKnob } from '../draw/handoff.js'
import { paintRegions } from './cells'
import { beganWord, examplesView, exampleSet, fromLine, keyOf, linkRuns, partOfLink, partsOf, partTop, programLines, stepPart, stepVersion, versionsOf } from './carddetail.js'
import { chainWords, fromFacts, objectRefs, regionMeta, regionRefs } from './object.js'
import { browserOn, citeLabels, currentTheme, leanEnv, loadObject, openBrowser, prepared, preparedNow, select } from './shell'
import { askThread, sendToMain, setThreadWindow, threadFor } from './thread'
import type { Scope } from './thread'
import { aboutOf, threadKey } from './threads.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Prepared = { object: Any; drawing: Any; grid: Any; verbs: Any[]; problems: string[]; error?: string }

export const PANE = 'object'
export const COLUMNS = 100
const SEL = { plugin: 'thimble-lean', key: 'sel' } as const
const ROWS = { plugin: 'thimble-lean', key: 'rows' } as const
const WHERE = { plugin: 'thimble-lean', key: 'where' } as const
const FACTS = { plugin: 'thimble-lean', key: 'facts' } as const
const THREAD = { plugin: 'thimble-lean', key: 'thread' } as const
const IND = { dark: '#9a93ff', light: '#4f46e5' }
const cut = (s: string, k: number) => ([...s].length <= k ? s : [...s].slice(0, Math.max(0, k - 1)).join('') + '…')
const fmtN = (x: unknown) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))

// the module's memory of the detail: whether it is open, what it drew last (for the ring), the key that acted last
// (for a word it began), the agent in the main view, and the latest version seen of each card
let isOpen = false
let drawn: { id: string; v: number | null; parts: Any[]; from: number; rows: number; pixel: Set<number> } | null = null
let lastKey: { key: string; at: number; undo: Sel | null } | null = null
let viewing: string | null = null
let ringY = -1
const latestSeen = new Map<string, number>()
let keyChain: Promise<unknown> = Promise.resolve()

// ------------------------------------------------------------------------------------------------ opening

/** Open the detail on an object (and part): the pane docked beside the transcript, holding the keys while the composer
 *  is empty. */
export async function openDetailPane($: Engine, title: string): Promise<void> {
  isOpen = true
  setThreadWindow(true)
  await $.ui.open({ id: PANE, title, focus: true, closeOnEscape: true, columns: COLUMNS })
}

async function closed($: Engine): Promise<void> {
  isOpen = false
  setThreadWindow(false)
  drawn = null
  if (viewing) { viewing = null; await $.ui.view({}).catch(() => undefined) }
}

/** The keys back to the card: the pane takes the keyboard (granted only over an empty composer), the ring on the part. */
function regrab($: Engine): void {
  $.clock.after(0, () => {
    void (async () => {
      if (!isOpen) return
      await $.ui.open({ id: PANE, focus: true, closeOnEscape: true, columns: COLUMNS }).catch(() => undefined)
      await focusPart($)
    })()
  })
}

/** The ring onto the selected part's first cell, when it is drawn there as a Button. */
async function focusPart($: Engine): Promise<void> {
  const sel = (await $.state.get(SEL)).value as Sel | null
  const part = drawn?.parts.find((x: Any) => x.id === sel?.region)
  const top = partTop(part)
  if (!top || !drawn || top.y < drawn.from || top.y >= drawn.from + drawn.rows || drawn.pixel.has(top.y)) return
  ringY = top.y
  await $.ui.focus({ requestId: PANE, key: `r|pane|${top.y}|${part.id}` }).catch(() => undefined)
}

// ------------------------------------------------------------------------------------------------ what the keys do

async function current($: Engine): Promise<{ sel: Sel; p: Prepared } | null> {
  const sel = (await $.state.get(SEL)).value as Sel | null
  if (!sel || sel.cite || sel.cites) return null
  const p = await prepared($, sel, drawnWidth, sel.state, 'detail')
  return p.object ? { sel, p } : null
}
let drawnWidth = COLUMNS - 2

async function keyCtx($: Engine): Promise<Any> {
  const sel = (await $.state.get(SEL)).value as Sel | null
  if (!sel || sel.cite || sel.cites) return null
  const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
  const part = drawn?.parts.find((x: Any) => x.id === sel.region)
  return {
    composer: '', versions: versionsOf(latest).length, knob: !!part?.knob, overlay: !!(sel as Any).prog,
    thread: !!threadFor({ object: sel.id }), browser: browserOn(),
  }
}

/** One act of the detail: a part, an example, the program, a version, a knob, the thread, main, the browser. */
async function act($: Engine, a: { act: string; dir?: number }): Promise<void> {
  const cur = await current($)
  if (!cur) return
  const { sel, p } = cur
  const parts = drawn?.parts ?? partsOf(p.grid)
  switch (a.act) {
    case 'part': {
      const id = stepPart(parts, sel.region, a.dir || 1)
      if (id) await selectPart($, sel, id)
      return
    }
    case 'example':
      await $.state.set(SEL, { ...sel, ex: (sel.ex || 0) + (a.dir || 1) })
      return
    case 'program':
      await $.state.set(SEL, { ...sel, prog: !(sel as Any).prog } as Sel)
      return
    case 'version': {
      const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
      const v = stepVersion(versionsOf(latest), sel.v ?? latest?.version)
      if (v !== sel.v) await select($, { ...sel, v, ex: 0, all: false })
      return
    }
    case 'knob': {
      const id = sel.region && knobOf(p.drawing, sel.region) ? sel.region : null
      if (!id) return
      await $.state.set(SEL, { ...sel, state: turnKnob(p.drawing, sel.state || {}, id, a.dir || 1), knob: id })
      return
    }
    case 'main': {
      const t = threadFor({ object: sel.id })
      if (t) $.ui.toast(await sendToMain($, t.key))
      return
    }
    case 'thread': {
      const t = threadFor({ object: sel.id })
      if (!t?.agentId) return
      if (viewing === t.agentId) { viewing = null; await $.ui.view({}).catch(() => undefined) } else { await $.ui.view({ agentId: t.agentId }).catch(() => undefined); viewing = t.agentId }
      return
    }
    case 'browser': {
      const row = ((await $.state.get({ ...WHERE, id: sel.id })).value as string | undefined) ?? null
      $.ui.toast(await openBrowser($, { id: sel.id, v: sel.v, region: sel.region, root: sel.root, row }))
      return
    }
    case 'close':
      await $.ui.close({ id: PANE }).catch(() => undefined)
  }
}

/** Select a part: its rows resolve, the example goes back to the first, and a thread in view gives the main view back,
 *  so the next question carries the new part. */
async function selectPart($: Engine, sel: Sel, id: string): Promise<void> {
  if (id === sel.region) return
  await select($, { ...sel, region: id, ex: 0, all: false })
  if (viewing) { viewing = null; await $.ui.view({}).catch(() => undefined) }
}

// ------------------------------------------------------------------------------------------------ the from line's facts

async function factsNow($: Engine, sel: Sel): Promise<Any | null> {
  const id = `${sel.root}|${sel.id}@${sel.v ?? ''}`
  const got = (await $.state.get({ ...FACTS, id })).value
  if (got !== undefined) return got
  $.clock.after(0, () => {
    void (async () => {
      const dir = $.plugin.root.replace(/\/+$/, '')
      let cov: Any = null
      try {
        const r = await $.process.run([`${dir}/bin/lean`, 'coverage', sel.id, '--json'], { cwd: sel.root, env: await leanEnv($, sel.root), timeoutMs: 60000 })
        cov = JSON.parse(r.stdout)
      } catch {
        cov = null
      }
      const o = await loadObject($, sel)
      await $.state.set({ ...FACTS, id }, fromFacts(o, cov))
    })()
  })
  return null
}

// ------------------------------------------------------------------------------------------------ drawing

/** The detail pane. */
export async function detailPane($: Engine, e: Any): Promise<Any> {
  const els = $.ui.resolve(e) as Any
  const { Box, Text } = els
  viewing = e.props?.view?.agentId ?? null
  const sel = (await $.state.get(SEL)).value as Sel | null
  if (!sel) return Text({ dimColor: true, children: 'No card is open. A card Claude saves shows under its reply; open it from there.' })
  const C = Math.max(40, (e.props.bodyColumns ?? COLUMNS) - 1)
  const R = Math.max(20, e.props.scroll?.bodyRows ?? 40)
  if (sel.cites && !sel.cite) return citesList($, els, sel, C, R)
  if (sel.cite) return citeView($, els, sel, C)
  const W = C - 2
  drawnWidth = W
  const p = await preparedNow($, sel, W, sel.state, 'detail')
  if (!p) return Text({ dimColor: true, children: `drawing ${sel.id}…` })
  if (p.error || !p.grid) return Text({ color: 'error', wrap: 'wrap', children: `× ${sel.id} cannot be drawn: ${p.error || 'no drawing'}. Ask Claude to fix its program and save it again.` })
  const o = p.object
  const theme = currentTheme()
  const ind = IND[theme]
  const grid = p.grid
  const parts = partsOf(grid)
  let part = parts.find((x: Any) => x.id === sel.region) ?? null
  if (!part && parts.length) {
    part = parts[0]
    const first = part.id
    $.clock.after(0, () => { void select($, { ...sel, region: first, ex: 0, all: false }) })
  }
  const meta = part ? regionMeta(p.drawing, part.id) || {} : {}
  const prog = !!(sel as Any).prog

  // versions: a new one saved while the detail is open is shown at once, when the person was on the latest
  const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
  const versions = versionsOf(latest)
  const lv = Number(latest?.version ?? sel.v)
  const seen = latestSeen.get(`${sel.root}|${sel.id}`)
  latestSeen.set(`${sel.root}|${sel.id}`, lv)
  if (seen != null && lv > seen && sel.v === seen) $.clock.after(0, () => { void select($, { ...sel, v: lv, ex: 0, all: false }) })
  const thread = threadFor({ object: sel.id })
  if (thread) await $.state.get({ ...THREAD, id: thread.key })

  const kids: Any[] = []
  // ---- header: title, versions; the takeaway with its citations
  const vText: Any[] = []
  versions.forEach((x: Any, i: number) => {
    if (i) vText.push(Text({ dimColor: true, children: ' · ' }))
    vText.push(Text({ color: x.v === (sel.v ?? lv) ? ind : undefined, bold: x.v === (sel.v ?? lv), dimColor: x.v !== (sel.v ?? lv), children: `v${x.v}` }))
  })
  kids.push(Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
    Text({ bold: true, wrap: 'truncate-end', children: String(o.title || o.id) }),
    Box({ flexDirection: 'row', flexShrink: 0, children: [Text({ children: ' ' }), ...vText] }),
  ] }))
  const take = String(o.text || o.question || '')
  const refsOf = (id: string) => regionRefs(o, p.drawing, id).refs
  if (take) {
    const runs = linkRuns(cut(take.replace(/\s+/g, ' '), C * 2 - 4))
    kids.push(Text({ wrap: 'wrap', children: runs.map((r: Any, i: number) => {
      if (!r.link) return Text({ key: `t${i}`, bold: r.bold || undefined, children: r.s })
      const on = part && partOfLink(r.link, parts, refsOf) === part.id
      return Text({ key: `t${i}`, color: ind, underline: true, bold: on || undefined, backgroundColor: on ? 'selectionBg' : undefined, children: r.s })
    }) }))
  }
  kids.push(Text({ children: ' ' }))

  // ---- the program behind p, over the card and its rows
  const fixed = 1 + (take ? 2 : 0) + 1 + 1 + 1 + 1 + 1 + 1 + 1
  if (prog) {
    kids.push(...programEls($, els, o, p, part, R - fixed + 3, C, ind))
  } else {
    // ---- the card: the selected part lit, its first row marked
    const rest = R - fixed
    const EXR = Math.max(3, Math.min(8, rest - Math.min(grid.h, 6)))
    let rows = Math.min(grid.h, Math.max(4, rest - EXR))
    let from = 0
    if (grid.h > rows) {
      const top = partTop(part)
      from = Math.max(0, Math.min(grid.h - rows, (top ? top.y : 0) - Math.floor(rows / 3)))
    }
    rows = Math.min(rows, grid.h - from)
    const pixel = new Set<number>()
    for (let y = 0; y < grid.h; y++) if (grid.rows[y].some((c: Any) => c.px) && !grid.rows[y].some((c: Any) => c.b || c.ref || c.w2)) pixel.add(y)
    drawn = { id: sel.id, v: sel.v, parts, from, rows, pixel }
    const top = partTop(part)
    const gutter = Box({ flexDirection: 'column', width: 1, flexShrink: 0, children: Array.from({ length: rows }, (_, i) => Text({ key: `g${i}`, color: ind, bold: true, children: top && top.y === from + i ? '▸' : ' ' })) })
    const onPress = (id: string, dir?: number) => {
      if (dir) return $.state.set(SEL, { ...sel, region: id, state: turnKnob(p.drawing, sel.state || {}, id, dir), knob: id })
      return selectPart($, sel, id)
    }
    kids.push(Box({ flexDirection: 'row', children: [gutter, paintRegions(grid, els, { theme, selected: part?.id ?? null, key: 'pane', from, rows, onPress })] }))
    if (from > 0 || from + rows < grid.h) kids.push(Text({ dimColor: true, children: ` ${from ? `↑ ${from} rows above` : ''}${from && from + rows < grid.h ? ' · ' : ''}${from + rows < grid.h ? `↓ ${grid.h - from - rows} rows below` : ''}` }))
    else kids.push(Text({ children: ' ' }))
    kids.push(...(await evidenceEls($, els, sel, o, p, part, meta, EXR, C, ind)))
  }

  // ---- the thread and the keys
  kids.push(threadLine(els, sel, part, thread, ind))
  kids.push(keysRow($, els, sel, part, versions.length, !!thread, prog))
  return Box({ flexDirection: 'column', children: kids })
}

/** The claim of the selected part, its "from" line and its records. */
async function evidenceEls($: Engine, els: Any, sel: Sel, o: Any, p: Prepared, part: Any, meta: Any, EXR: number, C: number, ind: string): Promise<Any[]> {
  const { Box, Text } = els
  const out: Any[] = []
  if (!part) {
    out.push(Text({ dimColor: true, children: ' This card has no parts to select.' }))
    return out
  }
  const cite = typeof meta.cite === 'string' ? p.drawing.cites?.[meta.cite] : null
  const set = exampleSet(p.drawing, meta)
  const { refs } = regionRefs(o, p.drawing, part.id)
  const resolved = refs[0] ? (await $.state.get({ ...ROWS, id: `${sel.root}|${refs[0]}` })).value as Any : undefined
  const chain = resolved ? chainWords(resolved) : null
  const records = set ? set.records : chain && !chain.error ? chain.records : []
  const total = set ? (set.total ?? set.records.length) : resolved?.count ?? records.length
  const n = records.length
  const ex = n ? ((((sel.ex || 0) % n) + n) % n) : 0
  const claim = String(cite?.text || meta.label || part.label || part.id).replace(/\*\*/g, '')
  const pos = n ? `[ ] ${ex + 1} of ${fmtN(total)}` : ''
  out.push(Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
    Text({ bold: true, wrap: 'truncate-end', children: [Text({ color: ind, children: '▸ ' }), cut(claim, C - pos.length - 4)] }),
    Text({ bold: true, children: pos ? ` ${pos}` : '' }),
  ] }))
  // the from line
  const facts = await factsNow($, sel)
  const rows = resolved?.count ?? (set ? set.total ?? set.records.length : cite ? (cite.rows?.length || 0) + (cite.more || 0) : null)
  const segs = fromLine(facts || { sources: cite?.source ? [{ path: cite.source }] : [] }, { rows, ...(cite?.source && !facts ? { source: cite.source } : {}) })
  out.push(Text({ wrap: 'truncate-end', children: [Text({ children: '  ' }), ...segs.map((s: Any, i: number) => Text({ key: `f${i}`, bold: s.bold || undefined, dimColor: s.tone === 'dim' || s.tone === 'unseen' || undefined, color: s.tone === 'warn' ? 'warning' : undefined, children: s.t }))] }))
  out.push(Text({ children: ' ' }))
  if (!n) {
    if (refs[0] && resolved === undefined) out.push(Text({ dimColor: true, children: '   reading the rows behind it…' }))
    else if (chain?.error) out.push(Text({ color: 'error', wrap: 'wrap', children: `   ${chain.notes[0]}` }))
    else out.push(Text({ dimColor: true, children: '   ░ no records behind this part' }))
    for (let i = 1; i < EXR; i++) out.push(Text({ key: `pad${i}`, children: ' ' }))
    return out
  }
  const view = examplesView(records, { at: ex, fit: EXR, fmt: set?.fmt, fields: meta.fields ?? set?.fields })
  const shown: Any[] = []
  if (view.kind === 'table') {
    const cols: string[] = view.cols
    const val = (r: Any, k: string) => (r?.[k] == null ? '' : typeof r[k] === 'number' && !/(^|_)(id|step|epoch|run|rev|line|seq)$/i.test(k) ? fmtN(r[k]) : String(r[k]))
    const widths = cols.map((k, i) => (i === cols.length - 1 ? 0 : Math.min(18, Math.max(k.length, ...view.rows.map((x: Any) => val(x.rec, k).length)))))
    const line = (cells: string[]) => cells.map((s, i) => (i === cells.length - 1 ? s : (s + ' '.repeat(widths[i] ?? 0)).slice(0, widths[i] ?? 0) + '  ')).join('')
    shown.push(Text({ dimColor: true, wrap: 'truncate-end', children: `    ${line(cols)}` }))
    for (const r of view.rows) {
      const s = cut(line(cols.map(k => val(r.rec, k))), C - 6)
      shown.push(Text({ key: `x${r.i}`, wrap: 'truncate-end', children: [Text({ color: ind, bold: true, children: r.on ? '  ▸ ' : '    ' }), Text({ bold: r.on || undefined, backgroundColor: r.on ? 'selectionBg' : undefined, children: r.on ? s.padEnd(C - 6) : s })] }))
    }
  } else {
    for (const r of view.rows) {
      shown.push(Text({ key: `w${r.i}`, wrap: 'truncate-end', children: [Text({ color: ind, bold: true, children: r.on ? '  ▸ ' : '    ' }), Text({ bold: r.on || undefined, dimColor: !r.on || undefined, children: cut(r.words || '', C - 6) })] }))
      shown.push(Text({ key: `m${r.i}`, dimColor: true, wrap: 'truncate-end', children: `      ${cut(r.meta || '', C - 8)}` }))
    }
  }
  out.push(...shown)
  for (let i = shown.length; i < EXR; i++) out.push(Text({ key: `pad${i}`, children: ' ' }))
  return out
}

/** p: how Claude drew this. The program's lines, the ones that drew the selected part lit, and the query behind its rows. */
function programEls($: Engine, els: Any, o: Any, p: Prepared, part: Any, room: number, C: number, ind: string): Any[] {
  const { Box, Text } = els
  const lines = String(o.program || '').split('\n')
  const lit = programLines(o.program, part?.id)
  const out: Any[] = []
  out.push(Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
    Text({ children: [Text({ color: 'warning', children: '✻ ' }), Text({ bold: true, children: 'how Claude drew this' }), Text({ dimColor: true, children: ` · ${lines.length} lines of the card program` })] }),
    Text({ children: [Text({ color: ind, children: '▌' }), Text({ dimColor: true, children: ' lines that drew ' }), Text({ color: ind, bold: true, children: cut(String(part?.label || 'the card'), 30) })] }),
  ] }))
  const { refs } = part ? regionRefs(o, p.drawing, part.id) : { refs: [] as string[] }
  if (refs[0]) out.push(Text({ dimColor: true, wrap: 'truncate-end', children: `rows  ${refs[0]}` }))
  out.push(Text({ children: ' ' }))
  const first = Math.min(...[...lit], lines.length) || 1
  const h = Math.max(6, room - out.length)
  const top = Math.max(0, Math.min(first - 4, lines.length - h))
  for (let i = top; i < Math.min(lines.length, top + h); i++) {
    const on = lit.has(i + 1)
    out.push(Text({ key: `pl${i}`, wrap: 'truncate-end', children: [
      Text({ color: on ? ind : undefined, dimColor: !on || undefined, bold: on || undefined, children: `${String(i + 1).padStart(3)} ${on ? '▌' : '│'} ` }),
      Text({ backgroundColor: on ? 'selectionBg' : undefined, children: cut(lines[i] || ' ', C - 8) }),
    ] }))
  }
  return out
}

function threadLine(els: Any, sel: Sel, part: Any, thread: Any, ind: string): Any {
  const { Text } = els
  const about = part ? String(part.label || part.id) : 'this card'
  if (!thread) return Text({ dimColor: true, wrap: 'truncate-end', children: ` thread · type a question about ${cut(about, 40)} · Claude here does not see it` })
  const qs = thread.asks?.length || 0
  const state = thread.status === 'running' ? 'answering…' : thread.status === 'failed' ? `failed: ${cut(String(thread.error || ''), 60)}` : 'answered'
  return Text({ wrap: 'truncate-end', children: [Text({ color: ind, children: ' thread' }), Text({ dimColor: true, children: ` · ${qs} question${qs === 1 ? '' : 's'} · ${state}${viewing === thread.agentId ? ' · on the left' : ''}` })] })
}

function keysRow($: Engine, els: Any, sel: Sel, part: Any, nv: number, hasThread: boolean, prog: boolean): Any {
  const { Box, Button, Text } = els
  const kids: Any[] = []
  const sep = () => Text({ dimColor: true, children: ' · ' })
  const key = (k: string, label: string) => [Text({ bold: true, children: k }), Text({ dimColor: true, children: ` ${label}` })]
  const press = (k: string, label: string, a: { act: string }) => Button({ key: `k:${k}`, plain: true, hotkey: k, label, children: [Text({ dimColor: true, children: label })], onPress: () => keyPressed($, k, a) })
  if (prog) {
    kids.push(press('p', 'close the program', { act: 'program' }), sep(), ...key('↑↓', 'part'))
  } else {
    kids.push(...key('↑↓', 'part'), sep(), ...key('[ ]', 'examples'), sep(), press('p', 'program', { act: 'program' }))
    if (nv > 1) kids.push(sep(), press('h', 'v1 · v2', { act: 'version' }))
    if (part?.knob) kids.push(sep(), ...key(', .', 'turn'))
    if (hasThread) kids.push(sep(), press('t', 'thread', { act: 'thread' }), sep(), press('m', 'send to main', { act: 'main' }))
    if (browserOn()) kids.push(sep(), press('o', 'browser', { act: 'browser' }))
  }
  kids.push(sep(), ...key('esc', 'back'))
  return Box({ flexDirection: 'row', flexWrap: 'wrap', children: [Text({ children: ' ' }), ...kids] })
}

/** A key the pane's Button took (the pane holds the keys): the act, remembered so a word it began can take it back. */
async function keyPressed($: Engine, k: string, a: { act: string; dir?: number }): Promise<void> {
  const before = (await $.state.get(SEL)).value as Sel | null
  await act($, a)
  lastKey = { key: k, at: Date.now(), undo: a.act === 'program' || a.act === 'version' ? before : null }
}

// ------------------------------------------------------------------------------------------------ citations (a reply's)

async function citesList($: Engine, els: Any, sel: Sel, C: number, R: number): Promise<Any> {
  const { Box, Text } = els
  const list = sel.cites || []
  const shown = list.slice(0, Math.max(5, R - 4))
  return Box({ flexDirection: 'column', children: [
    Text({ bold: true, children: `${list.length} values cited in the reply` }),
    Box({ flexDirection: 'column', marginTop: 1, children: shown.map((c, i) => Text({ key: `c${i}`, wrap: 'truncate-end', children: [Text({ children: cut(c.label, Math.floor(C / 2)) }), Text({ dimColor: true, children: `  ${c.ref}` })] })) }),
  ] })
}

async function citeView($: Engine, els: Any, sel: Sel, C: number): Promise<Any> {
  const { Box, Text } = els
  const label = citeLabels.get(sel.cite!) || sel.cite!
  const r = (await $.state.get({ ...ROWS, id: `${sel.root}|${sel.cite}` })).value as Any
  const kids: Any[] = [Text({ bold: true, wrap: 'truncate-end', children: `where ${label} comes from` })]
  if (r === undefined) kids.push(Text({ dimColor: true, children: '  reading its rows…' }))
  else {
    const c = chainWords(r)
    if (c.error) kids.push(Text({ color: 'error', wrap: 'wrap', children: `  ${c.notes[0]}` }))
    else {
      kids.push(Text({ dimColor: true, wrap: 'truncate-end', children: `  ← ${c.line}` }))
      const view = examplesView(c.records, { at: sel.ex || 0, fit: 10 })
      for (const x of view.rows as Any[]) {
        kids.push(Text({ key: `w${x.i}`, wrap: 'truncate-end', children: `  ${cut(x.words || '', C - 4)}` }))
        kids.push(Text({ key: `m${x.i}`, dimColor: true, wrap: 'truncate-end', children: `    ${x.meta || ''}` }))
      }
    }
  }
  return Box({ flexDirection: 'column', children: kids })
}

// ------------------------------------------------------------------------------------------------ hooks

export function registerDetail(on: Parameters<Register>[0]): void {
  // keys while the composer is empty: [ ] examples, p program, h versions, , . a knob, t the thread, m to main, o the
  // browser. A letter typed straight after a key that acted gives the key's letter back (it began a word). When the
  // composer empties again, the keys go back to the card.
  on('prompt.edit', async ($, e, next) => {
    if (!isOpen || !e.key || e.key.ctrl || e.key.meta) return next(e)
    const mine = keyChain.then(async () => {
      if (e.text !== '') return null
      const k = e.key!.key
      const now = Date.now()
      if (lastKey && beganWord(lastKey.key, now - lastKey.at, e.inputText)) {
        const back = lastKey
        lastKey = null
        if (back.undo) await $.state.set(SEL, back.undo)
        return { text: `${back.key}${e.inputText}`, cursor: back.key.length + e.inputText.length }
      }
      const ctx = await keyCtx($)
      const a = ctx ? keyOf(k, ctx) : null
      if (!a || a.act === 'part' || a.act === 'close') { lastKey = null; return null }
      await keyPressed($, k, a)
      regrab($)
      return { text: '', cursor: 0 }
    }).catch(() => null)
    keyChain = mine
    const r = await mine
    if (r) return r
    const out = await next(e)
    if (out.text === '' && e.text !== '') regrab($)
    return out
  }).catch(($, e, next) => next(e))

  // ↑↓ walk the parts: the ring moves between the parts' cells, and a move inside the part that holds the ring goes on
  // to the next part, so each part is one stop
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    try {
      const el = String(e.element || '')
      const m = /^r\|pane\|(\d+)\|(.+)$/.exec(el)
      if (!m || !drawn || (e.origin as { kind?: string }).kind !== 'person') return next(e)
      const sel = (await $.state.get(SEL)).value as Sel | null
      if (!sel) return next(e)
      const y = Number(m[1])
      let id = m[2]!
      if (id === sel.region) id = stepPart(drawn.parts, sel.region, y < ringY ? -1 : 1) || id
      const top = partTop(drawn.parts.find((x: Any) => x.id === id))
      const target = top && top.y >= drawn.from && top.y < drawn.from + drawn.rows && !drawn.pixel.has(top.y) ? `r|pane|${top.y}|${id}` : el
      ringY = top ? top.y : y
      await selectPart($, sel, id)
      return next({ ...e, element: target })
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  // esc closes the program first, then the detail; closing gives the main view back
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const sel = (await $.state.get(SEL)).value as Any
    if (sel?.prog && (e.origin as { kind?: string }).kind === 'person') {
      await $.state.set(SEL, { ...sel, prog: false })
      return undefined as Any
    }
    await closed($)
    return next(e)
  })

  // the hint under the prompt says where a question goes while the detail is open
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!isOpen) return next(e)
    const sel = (await $.state.get(SEL)).value as Sel | null
    if (!sel || sel.cite || sel.cites) return next(e)
    if (e.props.isDraft) {
      const label = drawn?.parts.find((x: Any) => x.id === sel.region)?.label || 'this card'
      return next({ ...e, props: { ...e.props, hint: `↵ asks the side thread about ${cut(String(label), 40)} · Claude here does not see it` } })
    }
    return next({ ...e, props: { ...e.props, hint: '↑↓ part · [ ] examples · p program · esc back' } })
  })

  // a prompt typed while the detail is open (the main view in front) is a question for the card's side thread. It
  // never reaches main: Claude Code shows it as dropped, with where it went, and the thread's transcript takes the view.
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    if (!isOpen || e.command || e.isMeta || !String(e.text || '').trim()) return next(e)
    const sel = (await $.state.get(SEL)).value as Sel | null
    if (!sel || sel.cite || sel.cites) return next(e)
    const p = await prepared($, sel, drawnWidth, sel.state, 'detail')
    if (!p.object) return next(e)
    const o = p.object
    const meta = sel.region ? regionMeta(p.drawing, sel.region) : null
    const label = String(meta?.label || drawn?.parts.find((x: Any) => x.id === sel.region)?.label || sel.region || '')
    const row = ((await $.state.get({ ...WHERE, id: sel.id })).value as string | undefined) ?? undefined
    const scope: Scope = { object: sel.id, v: o.version ?? sel.v, ...(sel.region ? { region: sel.region, label } : {}), ...(row ? { row } : {}) }
    const refs = sel.region ? regionRefs(o, p.drawing, sel.region).refs : objectRefs(o).map((c: Any) => c.ref)
    const r = await askThread($, { text: e.text, scope, refs, root: sel.root, card: { id: o.id, v: o.version, title: o.title, file: `${sel.root}/thimble/objects/${o.id}.json` } }, { view: true })
    if (r.problem) return { drop: `${r.problem}. Your words are back in the prompt; esc closes the card, and the prompt then goes to Claude here.` }
    if (r.thread?.agentId) viewing = r.thread.agentId
    $.clock.after(30, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
    return { drop: `asked the side thread about ${aboutOf(scope)}; Claude here does not see it` }
  }).catch(($, e, next) => next(e))
}

/** Whether the detail is open (for the shell and the tests). */
export function detailIsOpen(): boolean {
  return isOpen
}

/** The module noticed the pane is up (a reload while it stayed open). */
export function markOpen(open: boolean): void {
  isOpen = open
  setThreadWindow(open)
}

/** The thread key of the card open in the detail (for the tray and the browser). */
export function cardThreadKey(id: string): string {
  return threadKey({ object: id })
}

/** For tests: the module's memory, cleared. */
export function resetDetail(): void {
  isOpen = false
  drawn = null
  lastKey = null
  viewing = null
  ringY = -1
  latestSeen.clear()
  keyChain = Promise.resolve()
}
