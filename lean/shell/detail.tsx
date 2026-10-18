// detail.tsx: the card detail in the terminal. "Overview first, zoom and filter, details on demand."
//
//   chat       the card's own thread, the pane's left column: the question that made the card, then each question asked
//              here with its part and the thread's answer (thread.ts). A prompt typed while the detail is open asks it,
//              and main never sees it. The pane asks for the whole width it can have, as the B4 design's two columns
//   card       the main panel: the card enlarged, its parts selectable (↑↓, a click), a knob inside it turned with , and .
//              (or a click on ◂ ▸); a header above it with the title, the takeaway and the versions, v1 · v2
//   bar        under the card, empty until asked: `e` (or [ ]) fills it with the examples of the selected part,
//              labelled with what they are examples of, and their "from" line (source · rows · labels · coverage)
//   program    behind p: the card's program over the card, the lines that drew the part lit
//
// No tab strip and no date. Keys act only while the composer is empty, so a question that starts with p or h types
// normally; a key that began a word gives its letter back. While the composer is empty the pane holds the keys, so ↑↓
// walk the parts; a letter that is no key goes to the composer and the keys go back to it. `0` and `esc` empty the bar
// and close the program, then `esc` closes the detail. Claude Code keeps ← and → (← opens its agents view), so knobs
// turn on , and . A card under a reply shows `1 open detail`; 1 on an empty prompt opens the latest card's detail.
import type { EngineInterface, Register } from 'claude-code'

import type { Sel } from '../types'
import { knobOf, turn as turnKnob } from '../draw/handoff.js'
import { renderTerm } from '../draw/term.js'
import { paintRegions } from './cells'
import { barAfter, beganWord, cycleKnob, examplesView, exampleSet, fromLine, keyOf, linkRuns, namedKnob, partOfLink, partsOf, partTop, programLines, stepPart, stepVersion, versionsOf } from './carddetail.js'
import { chainWords, fromFacts, objectRefs, refsKey, regionMeta, regionRefs } from './object.js'
import { browserOn, citeLabels, currentTheme, leanEnv, loadObject, openBrowser, prepared, preparedNow, select } from './shell'
import { askThread, noteSelection, restoreThreads, sendToMain, setThreadWindow, threadFor } from './thread'
import { cardEvent, cardKey, cardKeysHint, ownState, pressTaken, readCardState, writeCardState } from './runtime'
import type { CardAsk } from './runtime'
import type { Scope } from './thread'
import { aboutOf } from './threads.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Prepared = { object: Any; drawing: Any; grid: Any; verbs: Any[]; problems: string[]; error?: string }
type Detail = Sel & { prog?: boolean; bar?: 'details' | 'examples' | null; ask?: CardAsk | null }

export const PANE = 'object'
export const COLUMNS = 400
const SEL = { plugin: 'thimble-lean', key: 'sel' } as const
const ROWS = { plugin: 'thimble-lean', key: 'rows' } as const
const WHERE = { plugin: 'thimble-lean', key: 'where' } as const
const FACTS = { plugin: 'thimble-lean', key: 'facts' } as const
const THREAD = { plugin: 'thimble-lean', key: 'thread' } as const
const IND = { dark: '#9a93ff', light: '#4f46e5' }
const EXR = 6
const cut = (s: string, k: number) => ([...s].length <= k ? s : [...s].slice(0, Math.max(0, k - 1)).join('') + '…')
const fmtN = (x: unknown) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))

// the module's memory of the detail: whether it is open, what it drew last (for the ring and the keys), the key that
// acted last (for a word it began), the agent in the main view, and the latest version seen of each card
let isOpen = false
let drawn: { id: string; parts: Any[]; from: number; rows: number; pixel: Set<number>; w: number; h: number; zoom: boolean; filter: boolean; on?: Any[] } | null = null
// the card states this open detail has kept (by card), and the cards it has opened where the other surface left them
const kept = new Map<string, string>()
const seeded = new Set<string>()
let lastKey: { key: string; at: number; undo: Sel | null } | null = null
let viewing: string | null = null
let ringY = -1
const latestSeen = new Map<string, number>()
// a card's own frame gives way to the detail's header: its title is the header's, its right words go beside v1 · v2
const unframed = new WeakMap<object, { grid: Any; right: string }>()
let keyChain: Promise<unknown> = Promise.resolve()

// ------------------------------------------------------------------------------------------------ opening

/** Open the detail: the pane docked beside the transcript as wide as it can be, holding the keys while the composer is
 *  empty. */
export async function openDetailPane($: Engine, title: string): Promise<void> {
  isOpen = true
  setThreadWindow(true)
  await $.ui.open({ id: PANE, title, focus: true, closeOnEscape: true, columns: COLUMNS })
  // asked from a key, the open lands while the key is still in the prompt: ask for the keys again once it is gone
  regrab($)
}

async function closed($: Engine): Promise<void> {
  isOpen = false
  seeded.clear()
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

/** The open card as the pane last drew it. Keys never wait on a drawing (a key's hook has little time): with none ready
 *  the key does nothing, and the pane is asked to draw again. */
async function current($: Engine): Promise<{ sel: Detail; p: Prepared } | null> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return null
  if (!drawn) { $.ui.invalidate('ui.render'); return null }
  const p = await preparedNow($, sel, drawn.w, sel.state, 'detail', drawn.h)
  return p?.object ? { sel, p } : null
}

async function keyCtx($: Engine): Promise<Any> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return null
  if (!drawn) { $.ui.invalidate('ui.render'); return null }
  const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
  const part = drawn?.parts.find((x: Any) => x.id === sel.region)
  return {
    composer: '', versions: versionsOf(latest).length, knob: !!part?.knob, overlay: !!sel.prog, bar: sel.bar ?? null,
    zoom: drawn.zoom, filter: drawn.filter,
    thread: !!threadFor({ object: sel.id }), browser: browserOn(),
  }
}

/** One act of the detail: a part, the examples, the program, a version, a knob, the thread, main, the browser. */
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
    case 'details': case 'examples':
      await $.state.set(SEL, { ...sel, bar: barAfter(sel.bar ?? null, a.act), ex: 0 } as Sel)
      return
    case 'example':
      // [ ] flip the examples, and show them when they are not shown
      await $.state.set(SEL, { ...sel, bar: 'examples', ex: sel.bar === 'examples' ? (sel.ex || 0) + (a.dir || 1) : 0 } as Sel)
      return
    case 'zoom': case 'filter': {
      // a card's own zoom and filter are knobs inside it: + and − turn the zoom, f cycles the filter
      const c = namedKnob(p.drawing, a.act)
      if (!c) return
      // + zooms into the selected part when the zoom has a level for it (a station `rerun-loop` for the part
      // `st-rerun-loop`), else one level in; − goes back out to the overview
      const into = (c.values as Any[]).find(v => typeof v === 'string' && v && sel.region && (sel.region === v || sel.region.endsWith(`-${v}`) || sel.region === `st-${v}`))
      const state = a.act === 'filter' ? cycleKnob(c, sel.state || {})
        : (a.dir || 1) > 0 ? (into != null && c.values[c.i] !== into ? { ...(sel.state || {}), [c.id]: into } : turnKnob(p.drawing, sel.state || {}, c.id, 1))
          : { ...(sel.state || {}), [c.id]: c.values[0] }
      await $.state.set(SEL, { ...sel, state, region: null, ex: 0 } as Sel)
      return
    }
    case 'program':
      await $.state.set(SEL, { ...sel, prog: !sel.prog } as Sel)
      return
    case 'back':
      await $.state.set(SEL, (sel.prog ? { ...sel, prog: false } : { ...sel, bar: barAfter(sel.bar ?? null, 'back') }) as Sel)
      return
    case 'version': {
      const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
      const v = stepVersion(versionsOf(latest), sel.v ?? latest?.version)
      if (v !== sel.v) await selectSoon($, { ...sel, v, ex: 0, all: false })
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

/** What the person did in the card, as its program's event: the program answers with new state (kept where the browser
 *  reads it too), and an ask(selection) opens the card's thread on that selection: asked at once when the program gave
 *  the words, else the person's next question goes there. */
async function cardAct($: Engine, event: Record<string, unknown>): Promise<void> {
  const cur = await current($)
  if (!cur || !drawn) return
  const { sel, p } = cur
  const got = await cardEvent($, p.object, sel, event, { w: drawn.w, h: drawn.h, browser: browserOn() })
  if (!got || got.drawing?.error) {
    $.ui.toast(`× The card could not answer ${event.type === 'key' ? `the key ${event.key}` : 'that'}: ${got?.drawing?.error ? `${got.drawing.error.name} · fix: ${got.drawing.error.fix || 'its program'}` : 'its program did not run'}`)
    return
  }
  const region = typeof event.region === 'string' ? event.region : sel.region
  let next: Detail = { ...(sel as Detail), state: got.state, region, ex: 0 }
  const ask = got.ask
  if (ask && ask.text) {
    const o = p.object
    const refs = ask.refs?.length ? ask.refs : ask.region ? regionRefs(o, p.drawing, ask.region).refs : []
    const r = await askThread($, { text: ask.text, scope: { object: sel.id, v: o.version ?? sel.v, ...(ask.region ? { region: ask.region } : {}), label: ask.label }, refs, root: sel.root, card: { id: o.id, v: o.version, title: o.title, file: `${sel.root}/thimble/objects/${o.id}.json` } })
    if (r.problem) $.ui.toast(`× ${r.problem}`)
  } else if (ask) next = { ...next, ask }
  await $.state.set(SEL, next)
  await writeCardState($, sel.root, sel.id, { state: next.state, region: next.region }, 'terminal')
}

/** The card opens where the person (here or in the browser) left it, and what they change here is kept for the
 *  browser: thimble/objects/.state/<id>.json. */
function syncCardState($: Engine, sel: Detail): void {
  const id = `${sel.root}|${sel.id}`
  const now = JSON.stringify({ s: ownState(sel.state), r: sel.region ?? null })
  if (!seeded.has(id)) {
    seeded.add(id)
    kept.set(id, now)
    $.clock.after(0, () => {
      void (async () => {
        const was = await readCardState($, sel.root, sel.id)
        if (!was || Object.keys(ownState(sel.state)).length || sel.region || (!Object.keys(was.state).length && !was.region)) return
        const cur = (await $.state.get(SEL)).value as Detail | null
        if (cur && cur.id === sel.id && cur.root === sel.root) await $.state.set(SEL, { ...cur, state: { ...was.state, ...(cur.state || {}) }, region: cur.region ?? was.region })
      })().catch(() => undefined)
    })
    return
  }
  if (kept.get(id) === now) return
  kept.set(id, now)
  $.clock.after(0, () => { void writeCardState($, sel.root, sel.id, { state: sel.state, region: sel.region }, 'terminal').catch(() => undefined) })
}

/** Select a part: its rows resolve, the examples go back to the first, and the card's thread learns which part the
 *  person has selected now (a question typed in the thread's own view carries no part of its own). */
async function selectPart($: Engine, sel: Detail, id: string): Promise<void> {
  if (id === sel.region) return
  await selectSoon($, { ...sel, region: id, ex: 0, all: false })
  const t = threadFor({ object: sel.id })
  if (t) {
    const cur = await current($)
    const label = String(drawn?.parts.find((x: Any) => x.id === id)?.label || id)
    const refs = cur ? regionRefs(cur.p.object, cur.p.drawing, id).refs : []
    await noteSelection($, t.key, { region: id, label, refs })
  }
}

/** The selection now, and its rows read after: `lean resolve` runs outside the key's hook, which has little time. */
async function selectSoon($: Engine, sel: Sel): Promise<void> {
  await $.state.set(SEL, sel)
  $.clock.after(0, () => { void select($, sel).catch(() => undefined) })
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
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel) return Text({ dimColor: true, children: 'No card is open. A card Claude saves shows under its reply; open it from there.' })
  const CC = Math.max(40, (e.props.bodyColumns ?? 100) - 1)
  const R = Math.max(20, e.props.scroll?.bodyRows ?? 40)
  if (sel.cites && !sel.cite) return citesList(els, sel, CC, R)
  if (sel.cite) return citeView($, els, sel, CC)
  // two columns once there is room: the card's thread at the left, the card's page at the right
  const TW = CC >= 110 ? Math.min(44, Math.max(32, Math.floor(CC * 0.3))) : 0
  const C = TW ? CC - TW - 2 : CC
  const W = C - 2
  const H = Math.max(12, R - 8)
  const p = await preparedNow($, sel, W, sel.state, 'detail', H)
  if (!p) return Text({ dimColor: true, children: `drawing ${sel.id}…` })
  if (p.error || !p.grid) return Text({ color: 'error', wrap: 'wrap', children: `× ${sel.id} cannot be drawn: ${p.error || 'no drawing'}. Ask Claude to fix its program and save it again.` })
  syncCardState($, sel)
  const o = p.object
  const theme = currentTheme()
  const ind = IND[theme]
  const { grid } = unframe(p, W)
  const parts = partsOf(grid)
  let part = parts.find((x: Any) => x.id === sel.region) ?? null
  if (!part && parts.length) {
    part = parts[0]
    const first = part.id
    $.clock.after(0, () => { void select($, { ...sel, region: first, ex: 0, all: false }) })
  }
  const meta = part ? regionMeta(p.drawing, part.id) || {} : {}

  // versions: a new one saved while the detail is open (the thread changed the card) is shown at once, when the person
  // was on the latest
  const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
  const versions = versionsOf(latest)
  const lv = Number(latest?.version ?? sel.v)
  const seen = latestSeen.get(`${sel.root}|${sel.id}`)
  latestSeen.set(`${sel.root}|${sel.id}`, lv)
  if (seen != null && lv > seen && sel.v === seen) $.clock.after(0, () => { void select($, { ...sel, v: lv, ex: 0, all: false }) })
  await restoreThreads($, sel.root)
  const thread = threadFor({ object: sel.id })
  if (thread) await $.state.get({ ...THREAD, id: thread.key })

  const kids: Any[] = []
  // ---- the header: title and versions; the takeaway with its citations
  const on = sel.v ?? lv
  const vText: Any[] = []
  versions.forEach((x: Any, i: number) => {
    if (i) vText.push(Text({ dimColor: true, children: ' · ' }))
    vText.push(Text({ color: x.v === on ? ind : undefined, bold: x.v === on, dimColor: x.v !== on, children: `v${x.v}` }))
  })
  // the header: the title, and at its right the card's id (shown here only) and its versions when it has more than one;
  // where its values come from is the bar's one dim line
  kids.push(Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
    Text({ bold: true, wrap: 'truncate-end', children: String(o.title || o.id) }),
    Box({ flexDirection: 'row', flexShrink: 0, children: [Text({ dimColor: true, children: ` card:${cut(String(o.id), 30)}` }), ...(versions.length > 1 ? [Text({ children: '   ' }), ...vText] : [])] }),
  ] }))
  const take = String(o.text || o.question || '')
  const refsOf = (id: string) => regionRefs(o, p.drawing, id).refs
  if (take) {
    const runs = cutRuns(linkRuns(take.replace(/\s+/g, ' ')), C * 2 - 4)
    kids.push(Text({ wrap: 'wrap', children: runs.map((r: Any) => {
      if (!r.link) return Text({ bold: r.bold || undefined, children: r.s })
      const lit = part && partOfLink(r.link, parts, refsOf) === part.id
      return Text({ color: ind, underline: true, bold: lit || undefined, backgroundColor: lit ? 'selectionBg' : undefined, children: r.s })
    }) }))
  }
  kids.push(Text({ children: ' ' }))

  // ---- the bar's rows: one empty rule, or the examples of the part
  const head = 1 + (take ? 2 : 0) + 1
  const barRows = sel.prog ? 1 : sel.bar === 'examples' ? 4 + EXR : 4
  const threadRow = thread && !TW ? 1 : 0
  const room = R - head - barRows - threadRow
  if (sel.prog) {
    kids.push(...programEls(els, o, p, part, room + barRows, C, ind))
  } else {
    // ---- the card, enlarged: the selected part lit, its first row marked
    let rows = Math.min(grid.h, Math.max(4, room))
    let from = 0
    if (grid.h > rows) {
      const top = partTop(part)
      from = Math.max(0, Math.min(grid.h - rows, (top ? top.y : 0) - Math.floor(rows / 3)))
    }
    rows = Math.min(rows, grid.h - from)
    const pixel = new Set<number>()
    for (let y = 0; y < grid.h; y++) if (grid.rows[y].some((c: Any) => c.px) && !grid.rows[y].some((c: Any) => c.b || c.ref || c.w2)) pixel.add(y)
    drawn = { id: sel.id, parts, from, rows, pixel, w: W, h: H, zoom: !!namedKnob(p.drawing, 'zoom'), filter: !!namedKnob(p.drawing, 'filter'), on: p.drawing?.on || [] }
    const top = partTop(part)
    const gutter = Box({ flexDirection: 'column', width: 1, flexShrink: 0, children: Array.from({ length: rows }, (_, i) => Text({ color: ind, bold: true, children: top && top.y === from + i ? '▸' : ' ' })) })
    // a click selects a part; ↵ on the selected part (the ring's press) fills the bar with its details
    const onPress = (id: string, dir?: number) => {
      if (dir) return $.state.set(SEL, { ...sel, region: id, state: turnKnob(p.drawing, sel.state || {}, id, dir), knob: id })
      // a part the program answers a press on: the press is the program's (k.on('press:<id>'))
      if (pressTaken(p.drawing, id)) return cardAct($, { type: 'press', region: id })
      if (id === sel.region) return $.state.set(SEL, { ...sel, bar: barAfter(sel.bar ?? null, 'details') } as Sel)
      return selectPart($, sel, id)
    }
    kids.push(Box({ flexDirection: 'row', children: [gutter, paintRegions(grid, els, { theme, selected: part?.id ?? null, key: 'pane', from, rows, onPress })] }))
    for (let i = rows; i < room; i++) kids.push(Text({ children: ' ' }))
    // ---- the bar: empty until asked
    kids.push(...(await barEls($, els, sel, o, p, part, meta, C, ind)))
  }

  // ---- the thread, as one line when there is no room for its column; the keys are in the hint line under the prompt
  if (threadRow) kids.push(threadLine(els, thread, ind))
  const pageBox = Box({ flexDirection: 'column', width: C, children: kids })
  if (!TW) return pageBox
  return Box({ flexDirection: 'row', children: [
    Box({ flexDirection: 'column', width: TW, flexShrink: 0, children: threadColumn(els, o, thread, part, TW, R, ind) }),
    Box({ flexDirection: 'column', width: 2, flexShrink: 0, children: Array.from({ length: R }, () => Text({ dimColor: true, children: '│ ' })) }),
    pageBox,
  ] })
}

/** The card's thread, the left column: the card's question, then each question asked here with its part and the
 *  thread's answers with their citations, the newest at the bottom; before the first, `❯ ask this card…`. */
function threadColumn(els: Any, o: Any, thread: Any, part: Any, TW: number, R: number, ind: string): Any[] {
  const { Text } = els
  const w = TW - 1
  const lines: Any[] = []
  const say = (runs: Any[], first: Any, rest = '  ') => wrapRuns(runs, w - 2).forEach((l, i) => lines.push(Text({ wrap: 'truncate-end', children: [i ? Text({ children: rest }) : first, ...l.map(styled)] })))
  const styled = (r: Any) => (r.link ? Text({ color: ind, underline: true, children: r.s }) : Text({ bold: r.bold || undefined, dimColor: r.dim || undefined, children: r.s }))
  const person = (text: string, about?: string) => {
    say([{ s: text, bold: true }], Text({ color: ind, children: '❯ ' }))
    if (about) lines.push(Text({ wrap: 'truncate-end', children: [Text({ dimColor: true, children: '  about ' }), Text({ color: ind, children: cut(about, w - 9) })] }))
    lines.push(Text({ children: ' ' }))
  }
  // the card's question at the top, and until the person asks, a placeholder that says where a question goes
  if (o.question) {
    say([{ s: String(o.question), dim: true }], Text({ children: '' }), '')
    lines.push(Text({ children: ' ' }))
  }
  if (!thread?.turns?.length) lines.push(Text({ dimColor: true, children: '❯ ask this card…' }))
  for (const t of thread?.turns || []) {
    if (t.role === 'person') { person(String(t.text), t.about); continue }
    const calls: string[] = t.calls || []
    if (calls.length > 2) lines.push(Text({ dimColor: true, children: `  ${calls.length - 2} earlier step${calls.length - 2 === 1 ? '' : 's'}` }))
    for (const c of calls.slice(-2)) lines.push(Text({ dimColor: true, wrap: 'truncate-end', children: `⏺ ${cut(c, w - 2)}` }))
    // the answer keeps its lines (a list stays a list); code marks are dropped, citations read as their words
    String(t.text || '').replace(/`/g, '').split(/\n+/).map(x => x.trim()).filter(Boolean).forEach((para, i) =>
      say(linkRuns(para), Text({ children: i ? '  ' : '⏺ ' })))
    lines.push(Text({ children: ' ' }))
  }
  if (thread?.status === 'running') lines.push(Text({ color: 'warning', children: '✻ answering…' }))
  if (thread?.status === 'failed') lines.push(Text({ color: 'error', wrap: 'wrap', children: `× ${cut(String(thread.error || 'the thread stopped'), w * 2)}` }))
  const room = R - 1
  return lines.length > room ? lines.slice(lines.length - room) : lines
}

/** Runs wrapped at word boundaries into lines of at most `w` characters. */
function wrapRuns(runs: Any[], w: number): Any[][] {
  const out: Any[][] = [[]]
  let len = 0
  for (const r of runs) {
    for (const word of String(r.s).split(/(\s+)/)) {
      if (!word) continue
      const n = [...word].length
      if (/^\s+$/.test(word)) { if (len && len < w) { out[out.length - 1]!.push({ ...r, s: ' ' }); len++ } continue }
      if (len + n > w && len) { out.push([]); len = 0 }
      const piece = n > w ? [...word].slice(0, w - 1).join('') + '…' : word
      out[out.length - 1]!.push({ ...r, s: piece })
      len += Math.min(n, w)
    }
  }
  return out.filter((l, i) => l.length || i === 0)
}

/** The card without its own frame, which the detail's header replaces (the browser does the same). */
function unframe(p: Prepared, w: number): { grid: Any; right: string } {
  const r = p.drawing?.root
  if (!r || r.t !== 'frame' || !r.kid || r.tone === 'bad' || p.drawing.error) return { grid: p.grid, right: '' }
  const hit = unframed.get(p.drawing)
  if (hit) return hit
  const plain = (x: Any): string => (typeof x === 'string' ? x : Array.isArray(x) ? x.map((u: Any) => (u.br ? ' ' : u.s)).join('').trim() : '')
  const out = { grid: renderTerm({ ...p.drawing, root: r.kid }, { w }), right: plain(r.right) }
  unframed.set(p.drawing, out)
  return out
}

/** Runs cut to `n` visible characters, the last with … */
function cutRuns(runs: Any[], n: number): Any[] {
  const out: Any[] = []
  let left = n
  for (const r of runs) {
    if (left <= 0) break
    const len = [...String(r.s)].length
    if (len <= left) { out.push(r); left -= len; continue }
    out.push({ ...r, s: [...String(r.s)].slice(0, Math.max(0, left - 1)).join('') + '…' })
    break
  }
  return out
}

/** The bar under the card, filled on demand: empty, then (↵) the selected part's details, then (e) its examples,
 *  labelled with what they are examples of. */
async function barEls($: Engine, els: Any, sel: Detail, o: Any, p: Prepared, part: Any, meta: Any, C: number, ind: string): Promise<Any[]> {
  const { Box, Text } = els
  const bar = sel.bar ?? null
  const pad = (out: Any[], n: number) => { while (out.length < n) out.push(Text({ children: ' ' })); return out.slice(0, n) }
  const rows = bar === 'examples' ? 4 + EXR : 4
  // empty until asked: whitespace, no frame and no words (the hint line says ↵ details)
  if (!bar || !part) return pad([], rows)
  const cite = typeof meta.cite === 'string' ? p.drawing.cites?.[meta.cite] : null
  const set = exampleSet(p.drawing, meta)
  const { refs } = regionRefs(o, p.drawing, part.id)
  const resolved = refs[0] ? (await $.state.get({ ...ROWS, id: `${sel.root}|${refsKey(refs)}` })).value as Any : undefined
  const chain = resolved ? chainWords(resolved) : null
  const records = set ? set.records : chain && !chain.error ? chain.records : []
  const total = set ? (set.total ?? set.records.length) : resolved?.count ?? records.length
  // the part's claim, where it comes from, and the filter the card has on
  const claim = String(cite?.text || meta.label || part.label || part.id).replace(/\*\*/g, '')
  const facts = await factsNow($, sel)
  const nrows = resolved?.count ?? (set ? set.total ?? set.records.length : cite ? (cite.rows?.length || 0) + (cite.more || 0) : null)
  const segs = fromLine(facts || { sources: cite?.source ? [{ path: cite.source }] : [] }, { rows: nrows, ...(cite?.source && !facts ? { source: cite.source } : {}) })
  const filter = namedKnob(p.drawing, 'filter')
  // the details: the part's claim, then where it comes from as one dim line (with the filter the card has on)
  const out: Any[] = [Text({ children: ' ' })]
  out.push(Text({ wrap: 'truncate-end', children: [Text({ bold: true, children: claim })] }))
  out.push(Text({ wrap: 'truncate-end', children: [
    ...segs.map((x: Any) => Text({ bold: x.bold || undefined, dimColor: x.tone !== 'warn' || undefined, color: x.tone === 'warn' ? 'warning' : undefined, children: x.t })),
    ...(filter && filter.i > 0 ? [Text({ dimColor: true, children: ' · ' }), Text({ color: ind, children: `filter on: ${filter.shown[filter.i]}` })] : []),
  ] }))
  // what the examples are examples of: the examples' own label, else the part's claim
  const of = String(set?.label || claim)
  if (bar !== 'examples') return pad(out, rows)
  const n = records.length
  const ex = n ? ((((sel.ex || 0) % n) + n) % n) : 0
  const pos = n ? `${ex + 1} of ${fmtN(total)}` : ''
  out.push(Text({ children: ' ' }))
  out.push(Text({ wrap: 'truncate-end', children: [Text({ color: ind, children: `examples of ${cut(of, C - pos.length - 16)}` }), Text({ dimColor: true, children: pos ? ` · ${pos}` : '' })] }))
  const body: Any[] = []
  if (!n) {
    if (refs[0] && resolved === undefined) body.push(Text({ dimColor: true, children: '   reading the rows behind it…' }))
    else if (chain?.error) body.push(Text({ color: 'error', wrap: 'wrap', children: `   ${chain.notes[0]}` }))
    else body.push(Text({ dimColor: true, children: '   ░ no records behind this part' }))
  } else {
    const view = examplesView(records, { at: ex, fit: EXR - 1, fmt: set?.fmt, fields: meta.fields ?? set?.fields })
    if (view.kind === 'table') {
      const cols: string[] = view.cols
      const val = (r: Any, k: string) => (r?.[k] == null ? '' : typeof r[k] === 'number' && !/(^|_)(id|step|epoch|run|rev|line|seq)$/i.test(k) ? fmtN(r[k]) : String(r[k]))
      const widths = cols.map((k, i) => (i === cols.length - 1 ? 0 : Math.min(18, Math.max(k.length, ...view.rows.map((x: Any) => val(x.rec, k).length)))))
      const line = (cells: string[]) => cells.map((v, i) => (i === cells.length - 1 ? v : (v + ' '.repeat(widths[i] ?? 0)).slice(0, widths[i] ?? 0) + '  ')).join('')
      body.push(Text({ dimColor: true, wrap: 'truncate-end', children: `    ${line(cols)}` }))
      for (const r of view.rows) {
        const t = cut(line(cols.map(k => val(r.rec, k))), C - 6)
        body.push(Text({ wrap: 'truncate-end', children: [Text({ color: ind, bold: true, children: r.on ? '  ▸ ' : '    ' }), Text({ bold: r.on || undefined, backgroundColor: r.on ? 'selectionBg' : undefined, children: r.on ? t.padEnd(C - 6) : t })] }))
      }
    } else {
      for (const r of view.rows) {
        body.push(Text({ wrap: 'truncate-end', children: [Text({ color: ind, bold: true, children: r.on ? '  ▸ ' : '    ' }), Text({ bold: r.on || undefined, dimColor: !r.on || undefined, children: cut(r.words || '', C - 6) })] }))
        body.push(Text({ dimColor: true, wrap: 'truncate-end', children: `      ${cut(r.meta || '', C - 8)}` }))
      }
    }
  }
  out.push(...pad(body, EXR - 1))
  return pad(out, rows)
}

/** p: how Claude drew this. The program's lines, the ones that drew the selected part lit, and the rows behind it. */
function programEls(els: Any, o: Any, p: Prepared, part: Any, room: number, C: number, ind: string): Any[] {
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
    const hit = lit.has(i + 1)
    out.push(Text({ wrap: 'truncate-end', children: [
      Text({ color: hit ? ind : undefined, dimColor: !hit || undefined, bold: hit || undefined, children: `${String(i + 1).padStart(3)} ${hit ? '▌' : '│'} ` }),
      Text({ backgroundColor: hit ? 'selectionBg' : undefined, children: cut(lines[i] || ' ', C - 8) }),
    ] }))
  }
  for (let i = out.length; i < room; i++) out.push(Text({ children: ' ' }))
  return out
}

function threadLine(els: Any, thread: Any, ind: string): Any {
  const { Text } = els
  const qs = thread.asks?.length || 0
  const state = thread.status === 'running' ? 'answering…' : thread.status === 'failed' ? `failed: ${cut(String(thread.error || ''), 60)}` : 'answered'
  return Text({ wrap: 'truncate-end', children: [Text({ color: ind, children: 'thread' }), Text({ dimColor: true, children: ` · ${qs} question${qs === 1 ? '' : 's'} · ${state}` })] })
}

/** The detail's keys as the thimble line says them while the detail is open (shell.tsx): what works now, once. */
export async function detailKeys($: Engine): Promise<string | null> {
  if (!isOpen) return null
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return 'esc back'
  const part = drawn?.parts.find((x: Any) => x.id === sel.region) ?? null
  const latest = await loadObject($, { id: sel.id, v: null, root: sel.root }).catch(() => null)
  return keysHint(sel, part, versionsOf(latest).length, !!threadFor({ object: sel.id }))
}

function keysHint(sel: Detail, part: Any, nv: number, hasThread: boolean): string {
  if (sel.prog) return 'p closes the program · ↑↓ part · esc back'
  const k: string[] = ['↑↓ part']
  if (sel.bar === 'examples') k.push('[ ] flip', 'e hide examples', '0 clear')
  else if (sel.bar === 'details') k.push('e examples', '0 clear')
  else k.push('↵ details', 'e examples')
  if (drawn?.zoom) k.push(sel.state && Object.keys(sel.state).length ? '+ − zoom' : '+ zoom in')
  if (drawn?.filter) k.push('f filter')
  if (part?.knob) k.push(', . turn')
  k.push(...cardKeysHint({ on: drawn?.on }))
  k.push('p program')
  if (nv > 1) k.push('h versions')
  if (hasThread) k.push('t thread', 'm send to main')
  if (browserOn()) k.push('o browser')
  k.push(sel.ask ? `type to ask about ${cut(String(sel.ask.label), 40)}` : 'type to ask this card', 'esc back')
  return k.join(' · ')
}

/** A key the pane's Button took (the pane holds the keys): the act, remembered so a word it began can take it back. */
async function keyPressed($: Engine, k: string, a: { act: string; dir?: number }): Promise<void> {
  const before = (await $.state.get(SEL)).value as Sel | null
  await act($, a)
  lastKey = { key: k, at: Date.now(), undo: ['program', 'version', 'examples', 'filter'].includes(a.act) ? before : null }
}

// ------------------------------------------------------------------------------------------------ citations (a reply's)

function citesList(els: Any, sel: Sel, C: number, R: number): Any {
  const { Box, Text } = els
  const list = sel.cites || []
  const shown = list.slice(0, Math.max(5, R - 4))
  return Box({ flexDirection: 'column', children: [
    Text({ bold: true, children: `${list.length} values cited in the reply` }),
    Box({ flexDirection: 'column', marginTop: 1, children: shown.map(c => Text({ wrap: 'truncate-end', children: [Text({ children: cut(c.label, Math.floor(C / 2)) }), Text({ dimColor: true, children: `  ${c.ref}` })] })) }),
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
        kids.push(Text({ wrap: 'truncate-end', children: `  ${cut(x.words || '', C - 4)}` }))
        kids.push(Text({ dimColor: true, wrap: 'truncate-end', children: `    ${x.meta || ''}` }))
      }
    }
  }
  return Box({ flexDirection: 'column', children: kids })
}

// ------------------------------------------------------------------------------------------------ hooks

export function registerDetail(on: Parameters<Register>[0]): void {
  // keys while the composer is empty: e and [ ] the examples, 0 empties the bar, p the program, h versions, , . a knob,
  // t the thread, m to main, o the browser. A letter typed straight after a key that acted gives the key's letter back
  // (it began a word). When the composer empties again, the keys go back to the card. With the detail closed the
  // message layer's keys act (shell.tsx): its 1 opens the detail of the card that says `1 open detail`, its v the verb.
  on('prompt.edit', async ($, e, next) => {
    if (!e.key || e.key.ctrl || e.key.meta) return next(e)
    if (!isOpen) return next(e)
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
      // the card's own keys (its program's k.on) come before the detail's letters
      const cur = await current($)
      const own = cur ? cardKey(cur.p.drawing, k) : null
      if (own) {
        lastKey = null
        await cardAct($, { type: 'key', key: own, ...(cur!.sel.region ? { region: cur!.sel.region } : {}) })
        regrab($)
        return { text: '', cursor: 0 }
      }
      const ctx = await keyCtx($)
      const a = ctx ? keyOf(k, ctx) : null
      // ↑ with the keys in the prompt would recall an earlier prompt into it: here it moves the part, and the keys go
      // back to the card
      if (!a || a.act === 'close') { lastKey = null; return null }
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
      // a part's cells (r|…), or a dial's ◂ ▸ (t|…|down, t|…|up): the dial is its knob's part
      const m = /^[rt]\|pane\|(\d+)\|([^|]+)(?:\|(?:down|at|up))?$/.exec(el)
      if (!m || !drawn || (e.origin as { kind?: string }).kind !== 'person') return next(e)
      const sel = (await $.state.get(SEL)).value as Detail | null
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

  // esc empties the bar and closes the program first, then the detail; closing gives the main view back
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const sel = (await $.state.get(SEL)).value as Detail | null
    if (sel && (sel.prog || sel.bar) && (e.origin as { kind?: string }).kind === 'person') {
      await $.state.set(SEL, (sel.prog ? { ...sel, prog: false } : { ...sel, bar: barAfter(sel.bar ?? null, 'back') }) as Sel)
      // a refused close gives the keys back to the prompt: the pane takes them again, so the next esc reaches it
      regrab($)
      return { value: undefined } as Any
    }
    await closed($)
    return next(e)
  })

  // a prompt typed while the detail is open (the main view in front) asks the card's thread. It never reaches main:
  // Claude Code shows it as dropped, with where it went, and the thread's column shows the question and its answer.
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    if (!isOpen || e.command || e.isMeta || !String(e.text || '').trim()) return next(e)
    // the pane may have gone without its close reaching this module (a re-render marked it open again): a prompt goes
    // to the card's thread only while the pane is really there, else to Claude as always
    if (!(await paneShown($))) { await closed($); return next(e) }
    const sel = (await $.state.get(SEL)).value as Sel | null
    if (!sel || sel.cite || sel.cites) return next(e)
    const p = await prepared($, sel, drawn?.w ?? COLUMNS - 2, sel.state, 'detail', drawn?.h ?? 24)
    if (!p.object) return next(e)
    const o = p.object
    const meta = sel.region ? regionMeta(p.drawing, sel.region) : null
    const label = String(meta?.label || drawn?.parts.find((x: Any) => x.id === sel.region)?.label || sel.region || '')
    const row = ((await $.state.get({ ...WHERE, id: sel.id })).value as string | undefined) ?? undefined
    // a selection the card's program asked about (k.ask: a brushed range, several runs) comes before the part
    const ask = (sel as Detail).ask || null
    const scope: Scope = ask
      ? { object: sel.id, v: o.version ?? sel.v, ...(ask.region ? { region: ask.region } : {}), label: ask.label, ...(row ? { row } : {}) }
      : { object: sel.id, v: o.version ?? sel.v, ...(sel.region ? { region: sel.region, label } : {}), ...(row ? { row } : {}) }
    const refs = ask?.refs?.length ? ask.refs : ask?.region ? regionRefs(o, p.drawing, ask.region).refs : sel.region ? regionRefs(o, p.drawing, sel.region).refs : objectRefs(o).map((c: Any) => c.ref)
    if (ask) await $.state.set(SEL, { ...sel, ask: null } as Detail)
    const r = await askThread($, { text: e.text, scope, refs, root: sel.root, card: { id: o.id, v: o.version, title: o.title, file: `${sel.root}/thimble/objects/${o.id}.json` } })
    if (r.problem) return { drop: `${r.problem}. Your words are back in the prompt; esc closes the card, and the prompt then goes to Claude here.` }
    $.clock.after(30, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
    return { drop: `asked the card's thread about ${cut(aboutOf(scope), 40)}` }
  }).catch(($, e, next) => next(e))
}

/** Whether Claude Code shows the detail's pane now (a failed check counts as shown: the module's own state stands). */
async function paneShown($: Engine): Promise<boolean> {
  try {
    const panes = await $.ui.panes()
    return Array.isArray(panes) ? panes.some(x => x.id === PANE && x.isPlaced && (x as Any).isShown !== false) : true
  } catch {
    return true
  }
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
