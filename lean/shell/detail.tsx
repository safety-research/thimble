// detail.tsx: the card detail in the terminal. "Overview first, zoom and filter, details on demand."
//
// The page is a program on the card runtime (panes/detail.js), the same one the browser draws for a card's detail: a
// header (the title, the card's id, v1 · v2), the takeaway, the card enlarged with its parts, and a bar under it that
// starts empty and fills on demand with the selected part's details and examples; the program behind p. Its state
// (the part selected, what the bar shows) is kept in thimble/panes/<session>/detail-<id>.json, so the browser opens the
// card where the terminal left it, and the other way round. This file is the terminal's host for it:
//
//   chat       the card's own thread, the pane's left column: the question that made the card, then each question asked
//              here with its part and the thread's answer (thread.ts). A prompt typed while the detail is open asks it,
//              and main never sees it. The pane asks for the whole width it can have, as the B4 design's two columns
//   keys       the card's own keys (its program's k.on) first, then the detail's (the program's), only while the composer
//              is empty, so a question that starts with p or h types normally; a key that began a word gives its letter
//              back. While the composer is empty the pane holds the keys, so ↑↓ walk the parts (the ring's moves are
//              the program's focus events); a letter that is no key goes to the composer. `0` and `esc` empty the bar
//              and close the program, then `esc` closes the detail. Claude Code keeps ← and →, so knobs turn on , and .
//   card       the card's drawing, run in its own sandbox with its state (thimble/objects/.state/<id>.json), which the
//              detail's program embeds; a knob turned, a zoom or a filter is a change of the card's state
// A card under a reply shows `1 open detail`; 1 on an empty prompt opens the latest card's detail.
import type { EngineInterface, Register } from 'claude-code'

import type { Sel } from '../types'
import { renderTerm } from '../draw/term.js'
import { barText } from '../panes/host.js'
import { paintRegions } from './cells'
import { beganWord, linkRuns, partsOf, versionsOf } from './carddetail.js'
import { chainWords, objectRefs, regionMeta, regionRefs } from './object.js'
import { browserOn, citeLabels, currentTheme, loadObject, openBrowser, prepared, preparedNow, select } from './shell'
import { askThread, noteSelection, restoreThreads, sendToMain, setThreadWindow, threadFor } from './thread'
import { cardEvent, cardKey, ownState, pressTaken, readCardState, writeCardState } from './runtime'
import type { CardAsk } from './runtime'
import { paneDrawing, paneFire, paneNow, paneRun, paneState, patchPaneState, setPaneState } from './panes'
import type { Scope } from './thread'
import { aboutOf } from './threads.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Detail = Sel & { prog?: boolean; bar?: 'details' | 'examples' | null; ask?: CardAsk | null }

export const PANE = 'object'
export const COLUMNS = 400
const SEL = { plugin: 'thimble-lean', key: 'sel' } as const
const ROWS = { plugin: 'thimble-lean', key: 'rows' } as const
const WHERE = { plugin: 'thimble-lean', key: 'where' } as const
const THREAD = { plugin: 'thimble-lean', key: 'thread' } as const
const IND = { dark: '#9a93ff', light: '#4f46e5' }
const cut = (s: string, k: number) => ([...s].length <= k ? s : [...s].slice(0, Math.max(0, k - 1)).join('') + '…')

// the module's memory of the detail: whether it is open, what it drew last (for the ring and the keys), the key that
// acted last (for a word it began), the agent in the main view, and the latest version seen of each card
let isOpen = false
let drawn: { id: string; parts: Any[]; from: number; rows: number; pixel: Set<number>; w: number; h: number; on?: Any[]; card: Any } | null = null
// the card's last drawing, shown while it draws again
let lastCard: { key: string; p: Any } | null = null
// the room the card is drawn in: the page's width and rows, as the pane last had them
let room = { w: 98, h: 32 }
// the card states this open detail has kept (by card), and the cards it has opened where the other surface left them
const kept = new Map<string, string>()
const seeded = new Set<string>()
let lastKey: { key: string; at: number; undo: Record<string, unknown> | null } | null = null
let viewing: string | null = null
let ringY = -1
const latestSeen = new Map<string, number>()
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
  const top = bodyTop(part)
  if (!top || !drawn || top.y < drawn.from || top.y >= drawn.from + drawn.rows || drawn.pixel.has(top.y)) return
  ringY = top.y
  await $.ui.focus({ requestId: PANE, key: `r|pane|${top.y}|${part.id}` }).catch(() => undefined)
}

// ------------------------------------------------------------------------------------------------ the card and its program

/** The open card as the pane last drew it (its drawing, for its own keys and presses), or null. */
async function current($: Engine): Promise<{ sel: Detail; p: Any } | null> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return null
  if (!drawn) { $.ui.invalidate('ui.render'); return null }
  const p = await preparedNow($, sel, drawn.w, sel.state, 'detail', drawn.h)
  return p?.object ? { sel, p } : null
}

/** The card the detail's program reads (shell.tsx's paneStore 'card'): the object at the version shown, its versions,
 *  and its drawing at the page's room with the card's state; null while it draws (the program says so). */
export async function cardStore($: Engine, id: string): Promise<Any> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.id !== id || sel.cite || sel.cites) return null
  const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
  // while the card draws again (a knob turned, its state from the browser), the page keeps its last drawing
  const fresh = await preparedNow($, sel, room.w, sel.state, 'detail', room.h)
  if (fresh?.drawing && !fresh.error) lastCard = { key: `${sel.root}|${sel.id}|${sel.v ?? ''}`, p: fresh }
  const p = fresh ?? (lastCard && lastCard.key === `${sel.root}|${sel.id}|${sel.v ?? ''}` ? lastCard.p : null)
  const object = p?.object ?? latest
  if (!object) return null
  return {
    object, drawing: p ? (p.error ? { error: { name: 'Error', message: p.error } } : p.drawing) : null,
    versions: versionsOf(latest), v: sel.v ?? latest?.version ?? null, state: ownState(sel.state),
    thread: !!threadFor({ object: sel.id }), browser: browserOn(),
  }
}

/** The detail's state as its program keeps it, mirrored into the selection the rest of the shell reads (the part a
 *  question is about, the rows read for it); a new part is told to the card's thread. */
async function mirror($: Engine): Promise<void> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return
  const st = await paneState($, 'detail', { id: sel.id })
  const region = typeof st.region === 'string' ? st.region : sel.region
  const next: Detail = { ...sel, region, bar: (st.bar as Detail['bar']) ?? null, prog: !!st.prog, ex: Number(st.ex) || 0 }
  if (JSON.stringify(next) === JSON.stringify(sel)) return
  await $.state.set(SEL, next)
  if (region !== sel.region) {
    $.clock.after(0, () => { void select($, next).catch(() => undefined) })
    const t = threadFor({ object: sel.id })
    if (t && region) {
      const cur = await current($)
      const label = String(drawn?.parts.find((x: Any) => x.id === region)?.label || region)
      await noteSelection($, t.key, { region, label, refs: cur ? regionRefs(cur.p.object, cur.p.drawing, region).refs : [] })
    }
    await writeCardState($, sel.root, sel.id, { state: next.state, region }, 'terminal')
  }
}

/** The detail's state changed elsewhere (the browser's run of the same program): the terminal follows it. */
export async function followDetail($: Engine, id: string): Promise<void> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (sel && sel.id === id) await mirror($)
}

/** A key or a press for the detail's program; its state is mirrored. True when the program took it. */
async function detailFire($: Engine, event: Record<string, unknown>): Promise<boolean> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return false
  const took = await paneFire($, 'detail', { id: sel.id }, event)
  if (took) await mirror($)
  return took
}

/** What the detail's program asks of the terminal (k.do): a change of the card's state (a knob, the zoom, the filter),
 *  another version, the card's thread in the main view, its answer sent to main, the browser, closing. */
export async function detailAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return '× No card is open in the detail.'
  switch (String(a.do || '')) {
    case 'card': {
      const state = a.state && typeof a.state === 'object' ? (a.state as Record<string, unknown>) : {}
      await $.state.set(SEL, { ...sel, state, ...(typeof a.knob === 'string' ? { knob: a.knob } : {}) } as Sel)
      await writeCardState($, sel.root, sel.id, { state, region: sel.region }, 'terminal')
      return
    }
    case 'version': {
      const v = Number(a.v)
      if (Number.isInteger(v) && v !== sel.v) await selectSoon($, { ...sel, v, ex: 0, all: false })
      return
    }
    case 'thread': {
      const t = threadFor({ object: sel.id })
      if (!t?.agentId) return 'This card has no thread yet: type a question to start one.'
      if (viewing === t.agentId) { viewing = null; await $.ui.view({}).catch(() => undefined) } else { await $.ui.view({ agentId: t.agentId }).catch(() => undefined); viewing = t.agentId }
      return
    }
    case 'main': {
      const t = threadFor({ object: sel.id })
      return t ? await sendToMain($, t.key) : 'This card has no thread yet: type a question to start one.'
    }
    case 'browser': {
      const row = ((await $.state.get({ ...WHERE, id: sel.id })).value as string | undefined) ?? null
      return await openBrowser($, { id: sel.id, v: sel.v, region: (typeof a.region === 'string' ? a.region : sel.region) ?? null, root: sel.root, row })
    }
    case 'close':
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return
    default:
      return false
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
 *  browser: thimble/objects/.state/<id>.json (the card's own state) and thimble/panes/<session>/detail-<id>.json (the
 *  detail's: the part selected, what the bar shows). */
function syncCardState($: Engine, sel: Detail): void {
  const id = `${sel.root}|${sel.id}`
  const now = JSON.stringify({ s: ownState(sel.state), r: sel.region ?? null })
  if (!seeded.has(id)) {
    seeded.add(id)
    kept.set(id, now)
    $.clock.after(0, () => {
      void (async () => {
        // the detail's own state: where either surface left it, unless this open names a part
        const st = await paneState($, 'detail', { id: sel.id })
        if (sel.region && st.region !== sel.region) await patchPaneState($, 'detail', { id: sel.id }, { region: sel.region, ex: 0 })
        else await mirror($)
        const was = await readCardState($, sel.root, sel.id)
        if (!was || Object.keys(ownState(sel.state)).length || (!Object.keys(was.state).length && !was.region)) return
        const cur = (await $.state.get(SEL)).value as Detail | null
        if (cur && cur.id === sel.id && cur.root === sel.root) await $.state.set(SEL, { ...cur, state: { ...was.state, ...(cur.state || {}) } })
      })().catch(() => undefined)
    })
    return
  }
  if (kept.get(id) === now) return
  kept.set(id, now)
  $.clock.after(0, () => { void writeCardState($, sel.root, sel.id, { state: sel.state, region: sel.region }, 'terminal').catch(() => undefined) })
}

/** The selection now, and its rows read after: `lean resolve` runs outside the key's hook, which has little time. */
async function selectSoon($: Engine, sel: Sel): Promise<void> {
  await $.state.set(SEL, sel)
  $.clock.after(0, () => { void select($, sel).catch(() => undefined) })
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
  room = { w: W, h: Math.max(12, R - 8) }
  syncCardState($, sel)
  const theme = currentTheme()
  const ind = IND[theme]
  // versions: a new one saved while the detail is open (the thread changed the card) is shown at once, when the person
  // was on the latest
  const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
  const lv = Number(latest?.version ?? sel.v)
  const seen = latestSeen.get(`${sel.root}|${sel.id}`)
  latestSeen.set(`${sel.root}|${sel.id}`, lv)
  if (seen != null && lv > seen && sel.v === seen) $.clock.after(0, () => { void select($, { ...sel, v: lv, ex: 0, all: false }) })
  await restoreThreads($, sel.root)
  const thread = threadFor({ object: sel.id })
  if (thread) await $.state.get({ ...THREAD, id: thread.key })

  // the page: the detail's program (panes/detail.js) on the card, in the room it has
  const threadRow = thread && !TW ? 1 : 0
  const d = await paneRun($, 'detail', { id: sel.id }, { w: C, h: R - threadRow })
  const grid = renderTerm(d, { w: C })
  const card = (await preparedNow($, sel, room.w, sel.state, 'detail', room.h)) ?? (lastCard && lastCard.key === `${sel.root}|${sel.id}|${sel.v ?? ''}` ? lastCard.p : null)
  const parts = partsOf({ ...grid, regions: grid.regions.filter((r: Any) => !/^ver-\d+$/.test(r.id)) })
  const region = typeof d.selected === 'string' ? d.selected : null
  const part = parts.find((x: Any) => x.id === region) ?? null
  // a page taller than the pane: the rows around the selected part, the header kept
  let rows = Math.min(grid.h, R - threadRow)
  let from = 0
  if (grid.h > rows) {
    const top = bodyTop(part)
    from = Math.max(0, Math.min(grid.h - rows, (top ? top.y : 0) - Math.floor(rows / 3)))
  }
  rows = Math.min(rows, grid.h - from)
  const pixel = new Set<number>()
  for (let y = 0; y < grid.h; y++) if (grid.rows[y].some((c: Any) => c.px) && !grid.rows[y].some((c: Any) => c.b || c.ref || c.w2)) pixel.add(y)
  drawn = { id: sel.id, parts, from, rows, pixel, w: room.w, h: room.h, on: card?.drawing?.on || [], card: card?.drawing ?? null }
  const top = bodyTop(part)
  const gutter = Box({ flexDirection: 'column', width: 1, flexShrink: 0, children: Array.from({ length: rows }, (_, i) => Text({ color: ind, bold: true, children: top && top.y === from + i ? '▸' : ' ' })) })
  // a press on a part the card's program answers is the card's (k.on('press:<id>')); any other is the detail's: it
  // selects the part, and on the selected part fills the bar with its details; a knob's ◂ ▸ turns it
  const onPress = (id: string, dir?: number) => {
    if (!dir && card?.drawing && pressTaken(card.drawing, id)) return cardAct($, { type: 'press', region: id })
    return detailFire($, { type: 'press', region: id, ...(dir ? { dir } : {}) })
  }
  const kids: Any[] = [Box({ flexDirection: 'row', children: [gutter, paintRegions(grid, els, { theme, selected: region, key: 'pane', from, rows, onPress })] })]
  if (threadRow) kids.push(threadLine(els, thread, ind))
  const pageBox = Box({ flexDirection: 'column', width: C, children: kids })
  if (!TW) return pageBox
  const o = card?.object ?? latest
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

function threadLine(els: Any, thread: Any, ind: string): Any {
  const { Text } = els
  const qs = thread.asks?.length || 0
  const state = thread.status === 'running' ? 'answering…' : thread.status === 'failed' ? `failed: ${cut(String(thread.error || ''), 60)}` : 'answered'
  return Text({ wrap: 'truncate-end', children: [Text({ color: ind, children: 'thread' }), Text({ dimColor: true, children: ` · ${qs} question${qs === 1 ? '' : 's'} · ${state}` })] })
}

/** Where a part's body starts: its biggest rect (a citation of it in the takeaway is a rect of it too, a small one). */
function bodyTop(part: Any): { x: number; y: number } | null {
  if (!part || !part.rects?.length) return null
  return part.rects.reduce((a: Any, q: Any) => (q.w * q.h > a.w * a.h ? q : a), part.rects[0])
}

/** The detail's keys as the thimble line says them while the detail is open (shell.tsx): the card's own keys, then
 *  the detail's, as their programs name them, and where a question goes. */
export async function detailKeys($: Engine): Promise<string | null> {
  if (!isOpen) return null
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return 'esc back'
  const d = paneDrawing('detail', { id: sel.id }) ?? (await paneNow($, 'detail', { id: sel.id }))
  const keys = barText([{ on: drawn?.on || [] }, d])
  const ask = sel.ask ? `type to ask about ${cut(String(sel.ask.label), 40)}` : 'type to ask this card'
  const parts = keys.split(' · ').filter(Boolean)
  const esc = parts.findIndex(x => x.startsWith('esc '))
  if (esc >= 0) parts.splice(esc, 0, ask)
  else parts.push(ask)
  return parts.join(' · ')
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
  // keys while the composer is empty: the card's own keys (its program's k.on) first, then the detail's program's. A
  // letter typed straight after a key that acted gives the key's letter back (it began a word). When the composer
  // empties again, the keys go back to the card. With the detail closed the message layer's keys act (shell.tsx).
  on('prompt.edit', async ($, e, next) => {
    if (!e.key || e.key.ctrl || e.key.meta) return next(e)
    if (!isOpen) return next(e)
    const mine = keyChain.then(async () => {
      if (e.text !== '') return null
      const k = e.key!.key
      const now = Date.now()
      const sel = (await $.state.get(SEL)).value as Detail | null
      if (lastKey && beganWord(lastKey.key, now - lastKey.at, e.inputText)) {
        const back = lastKey
        lastKey = null
        if (back.undo && sel) { await setPaneState($, 'detail', { id: sel.id }, back.undo, 'terminal'); await mirror($) }
        return { text: `${back.key}${e.inputText}`, cursor: back.key.length + e.inputText.length }
      }
      // the card's own keys (its program's k.on) come before the detail's
      const cur = await current($)
      const own = cur ? cardKey(cur.p.drawing, k) : null
      if (own) {
        lastKey = null
        await cardAct($, { type: 'key', key: own, ...(cur!.sel.region ? { region: cur!.sel.region } : {}) })
        regrab($)
        return { text: '', cursor: 0 }
      }
      if (!sel || sel.cite || sel.cites) return null
      const before = { ...(await paneState($, 'detail', { id: sel.id })) }
      // esc, ↑ and the like never reach here: Claude Code keeps them (the pane's close and ring do them)
      if (!(await detailFire($, { type: 'key', key: k === 'enter' ? 'return' : k }))) { lastKey = null; return null }
      lastKey = { key: k, at: now, undo: /^[a-z]$/.test(k) ? before : null }
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
  // to the next part, so each part is one stop; where the ring stands is the program's focus event
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
      const ids = drawn.parts.map((x: Any) => x.id)
      if (id === sel.region && ids.length) {
        const i = ids.indexOf(id)
        id = ids[(i + (y < ringY ? -1 : 1) + ids.length) % ids.length] ?? id
      }
      const top = bodyTop(drawn.parts.find((x: Any) => x.id === id))
      const target = top && top.y >= drawn.from && top.y < drawn.from + drawn.rows && !drawn.pixel.has(top.y) ? `r|pane|${top.y}|${id}` : el
      ringY = top ? top.y : y
      await detailFire($, { type: 'focus', region: id })
      return next({ ...e, element: target })
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  // esc empties the bar and closes the program first (the program's esc), then the detail; closing gives the main view
  // back
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const sel = (await $.state.get(SEL)).value as Detail | null
    if (sel && !sel.cite && !sel.cites && (sel.prog || sel.bar) && (e.origin as { kind?: string }).kind === 'person') {
      await detailFire($, { type: 'key', key: 'esc' })
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
  lastCard = null
  keyChain = Promise.resolve()
}
