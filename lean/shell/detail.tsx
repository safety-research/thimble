// detail.tsx: the card detail in the terminal. "Overview first, zoom and filter, details on demand."
//
// The page is a program on the card runtime (panes/detail.js), the same one the browser draws for a card's detail: a
// header (the title, the card's id, v1 · v2), the takeaway, the card enlarged with its parts, and a bar under it that
// starts empty and fills on demand with the selected part's details and examples; the program behind p. Its state
// (the part selected, what the bar shows) is kept in thimble/panes/<session>/detail-<id>.json, so the browser opens the
// card where the terminal left it, and the other way round. This file is the terminal's host for it:
//
//   width      the pane docks beside the transcript and leaves the chat about two fifths of the terminal (48 to 80
//              columns), so the conversation stays readable beside the card and the bar above the prompt stays one line
//   ask        the pane's last row is the card's ask line (an Input): a letter that is no key starts a question there,
//              and ↵ asks the card's own thread (thread.ts). It never passes through the prompt, so main's transcript
//              gets no row for it. The thread's latest exchange shows above the ask line, under the card
//   keys       the card's own keys (its program's k.on) first, then the detail's (the program's), only while the composer
//              is empty; a key that began a word gives its letter back to the ask line. While the composer is empty the
//              pane holds the keys, so ↑↓ walk the parts. One selection, one highlight: the ring stands in the gutter on
//              the selected part's first row (a ▸), and the part is shaded; a move of the ring is the program's focus
//              event, and after each drawing the ring is put back on the selected part, so the two never drift apart
//              when the card scrolls. `0` and `esc` empty the bar and close the program, then `esc` closes the detail.
//              Claude Code keeps ← and →, so knobs turn on , and .
//   window     a page taller than the pane shows the rows around the selected part; once the person opens the bar
//              under the card (↵ details, e examples, a flip) it shows the bar, and the wheel moves it from there
//   card       the card's drawing, run in its own sandbox with its state (thimble/objects/.state/<id>.json), which the
//              detail's program embeds; a knob turned, a zoom or a filter is a change of the card's state
// A card under a reply shows `1 open detail`; 1 on an empty prompt opens the latest card's detail.
import type { EngineInterface, Register } from 'claude-code'

import type { Sel } from '../types'
import { renderTerm } from '../draw/term.js'
import { barText, hostKeys } from '../panes/host.js'
import { paintRegions } from './cells'
import { askMerge, beganWord, examplesView, linkRuns, PAGES_DEFAULT, partsOf, versionsOf } from './carddetail.js'
import { allKnob, ownPart, pageAt, pageId, pageKnob, pageOf } from '../draw/handoff.js'
import { chainWords, objectRefs, regionMeta, regionRefs } from './object.js'
import { citeLabels, currentTheme, keysMoved, loadObject, popFocus, prepared, preparedNow, pushFocus, select } from './shell'
import { askThread, noteSelection, restoreThreads, sendToMain, setThreadWindow, threadFor } from './thread'
import { cardEvent, cardKey, noteSeen, ownState, pressTaken, readCardState, readSeen, writeCardState } from './runtime'
import type { CardAsk } from './runtime'
import { type KeyEdit, type KeyTurn } from './keys'
import { paneFire, paneNow, paneRun, paneState, paneTakes, patchPaneState, setPaneState } from './panes'
import type { Scope } from './thread'
import { aboutOf } from './threads.js'
import { check as checkLabel, checksDone, labelGen } from './labels'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Detail = Sel & { prog?: boolean; bar?: 'details' | 'examples' | null; ask?: CardAsk | null }
type Undo = { state: Record<string, unknown> | undefined; region: string | null; pane: Record<string, unknown> }

export const PANE = 'object'
const SEL = { plugin: 'thimble', key: 'sel' } as const
const ROWS = { plugin: 'thimble', key: 'rows' } as const
const WHERE = { plugin: 'thimble', key: 'where' } as const
const THREAD = { plugin: 'thimble', key: 'thread' } as const
// the ask line drawn again (a letter joined the question, the ring came or went): the pane and the bar read it, so a
// letter redraws them alone, never every row of the transcript
const ASKLINE = { plugin: 'thimble', key: 'askline' } as const
const IND = { dark: '#9a93ff', light: '#4f46e5' }
const cut = (s: string, k: number) => ([...s].length <= k ? s : [...s].slice(0, Math.max(0, k - 1)).join('') + '…')

// the module's memory of the detail: whether it is open, what it drew last (for the ring and the keys), the key that
// acted last (for a word it began), the agent in the main view, and the latest version seen of each card
let isOpen = false
let drawn: { id: string; parts: Any[]; from: number; rows: number; pixel: Set<number>; w: number; h: number; on?: Any[]; card: Any; gutter: Map<number, string[]>; selected: string | null } | null = null
// the card's last drawing, shown while it draws again
let lastCard: { key: string; p: Any } | null = null
// the room the card is drawn in: the page's width and rows, as the pane last had them
let room = { w: 98, h: 32 }
// the card states this open detail has kept (by card), and the cards it has opened where the other surface left them
const kept = new Map<string, string>()
const seeded = new Set<string>()
const askedRegion = new Map<string, string>()
// the key that acted last: what it changed, so a letter typed straight after it gives it back (it began a word); a
// card's own key keeps the card's state and part from before it (`card`)
let lastKey: { key: string; at: number; undo: Record<string, unknown> | null; card?: Undo } | null = null
let viewing: string | null = null
const latestSeen = new Map<string, number>()
// the terminal's columns, as the last drawing measured them: the detail leaves the chat its share of them
let viewCols = 0
// the ring: the element it stands on (as the last move or focus left it), its gutter row, and the question being typed
// in the ask line (kept here, so a redraw never wipes what the person typed)
let ringAt: string | null = null
let ringY = -1
let draft = ''
let refocus = false
let drawnSig = ''
let paneFocused = false
// the page's window when the page is taller than the pane: what it follows (the selected part, or the bar under the
// card once the person opened it), the bar and part it last saw, and the rows the wheel moved it by since
const win = { follow: 'part' as 'part' | 'bar', bar: '', region: null as string | null, by: 0 }

/** The terminal's width, from the band's viewport (shell.tsx) while no pane of ours is docked: then the conversation
 *  has every column. While one is docked its own drawing measures it (noteDock). */
export function noteViewport(v: { columns?: number } | undefined): void {
  if (!isOpen && v && typeof v.columns === 'number' && v.columns > 0) viewCols = v.columns
}

/** A docked pane's drawing measures the terminal: the conversation's columns beside it, its own, and the border. */
export function noteDock(e: Any): void {
  if (e?.viewport?.columns && e.props?.placement === 'dock') viewCols = e.viewport.columns + (e.props.bodyColumns ?? 0) + 1
}

/** The columns a docked pane of ours asks for, leaving the chat its share. */
export function paneColumns(): number {
  return detailColumns(viewCols)
}

/** The chat's columns beside the docked detail: about two fifths of the terminal, 48 to 80, so its lines read. */
export function chatColumns(cols: number): number {
  return Math.max(48, Math.min(80, Math.round(cols * 0.4)))
}

/** The columns the detail asks for: the terminal less the chat's share (a card needs 60 at least). */
export function detailColumns(cols: number): number {
  return cols > 0 ? Math.max(60, cols - chatColumns(cols)) : 96
}

const GUTTER = (y: number) => `g|pane|${y}`
// the ask line's key: a new one each time text is put in it from outside (a letter typed before it had the keys), so
// the field is drawn afresh holding that text (a field already drawn keeps what it holds), and the ring waits for
// that drawing
let askGen = 0
const askKey = () => `ask-${askGen}`
const isAsk = (k: string | null) => !!k && k.startsWith('ask-')
// The ring's move to the ask line, and the field that has it. The letters of a question come through the prompt until
// the ring lands on the field; each draws the field afresh holding the question. One move is on its way at a time,
// started by a letter, never cancelled by the next: a terminal busy drawing may hand the ring to a field it drew a
// moment before, which the ring is sent on from to the field drawn last; a move that did not land (the prompt still
// showed letters, so the pane could not take the keys) is started again by the next letter. A field with the ring is
// never drawn afresh, since the letters typed into it meanwhile would be lost with it
let moveGen = 0
let moving = false
let landed: string | null = null
const fields = new Map<string, { seen: string }>()
let askDrawn = 0
function askRedraw($: Engine): void {
  void $.state.set(ASKLINE, ++askDrawn).catch(() => undefined)
}

// ------------------------------------------------------------------------------------------------ opening

/** Open the detail: the pane docked beside the transcript, leaving the chat its share, holding the keys while the
 *  composer is empty. */
export async function openDetailPane($: Engine, title: string): Promise<void> {
  isOpen = true
  setThreadWindow(true)
  await pushFocus($, 'detail')
  const r = await $.ui.open({ id: PANE, title, focus: true, closeOnEscape: true, columns: detailColumns(viewCols) })
  // a terminal too narrow for a docked pane a key opened (one a command opens is placed at any width): Claude Code
  // would keep it waiting, undrawn, with the keys still the detail's. It is closed again, and the toast says what opens it
  if (r && (r as Any).isPlaced === false) {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    if (isOpen) await closed($)
    $.ui.toast(waitingWords(String((r as Any).reason || '')))
    return
  }
  // asked from a key, the open lands while the key is still in the prompt: ask for the keys again once it is gone
  regrab($)
}

/** What the toast says when the detail cannot be placed: the width it needs and what opens it now. */
export function waitingWords(reason: string): string {
  const m = /(\d+) columns \((\d+) now\)/.exec(reason)
  return m
    ? `The card's detail needs ${m[1]} columns when a key opens it (${m[2]} now). Type /card to open it here, or widen the terminal.`
    : `The card's detail cannot open here${reason ? ` (${reason})` : ''}. Type /card to open it.`
}

async function closed($: Engine): Promise<void> {
  isOpen = false
  seeded.clear()
  askedRegion.clear()
  setThreadWindow(false)
  drawn = null
  ringAt = null
  ringY = -1
  draft = ''
  landed = null
  moveGen++
  await popFocus($, 'detail')
  if (viewing) { viewing = null; await $.ui.view({}).catch(() => undefined) }
  // the labels the person checked are counted again, their cards drawn again, and Claude hears of the checks
  $.clock.after(0, () => { void checksDone($).catch(() => undefined) })
}

/** The keys back to the card: the pane takes the keyboard (granted only over an empty composer), the ring on the part.
 *  A question begun since it was asked keeps the keys: the person is typing in the ask line. */
function regrab($: Engine): void {
  $.clock.after(0, () => {
    void (async () => {
      if (!isOpen || isAsk(ringAt)) return
      await $.ui.open({ id: PANE, focus: true, closeOnEscape: true, columns: detailColumns(viewCols) }).catch(() => undefined)
      // taking the keyboard again starts the ring afresh: put it on the selected part, wherever it was
      ringAt = null
      await focusPart($)
    })()
  })
}

/** The ring onto the selected part: the gutter cell of the part's first row (its ▸), when that row is drawn. */
async function focusPart($: Engine): Promise<void> {
  const key = selectedGutter()
  // the wheel moved the selected part out of the window (a long page, every page at once): the window goes back to it,
  // and the drawing that brings it puts the ring there, so the keys are the card's again and never stay with the ask line
  if (!key && drawn?.selected && win.by && !isAsk(ringAt)) { win.by = 0; win.follow = 'part'; $.ui.invalidate('ui.render'); return }
  // never while the person types in the ask line: a drawing asked for before the first letter would take it back
  if (!key || ringAt === key || isAsk(ringAt)) return
  const r = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'failed' }))
  // a question begun while the ring moved keeps the ask line's claim: its own focus follows
  if (!(r as Any)?.deny && !isAsk(ringAt)) { ringAt = key; ringY = Number(key.split('|')[2]) }
}

/** The gutter key of the selected part's first row in the last drawing, or null when it is not drawn. */
function selectedGutter(): string | null {
  if (!drawn) return null
  for (const [y, ids] of drawn.gutter) if (ids.includes(drawn.selected ?? '')) return GUTTER(y)
  return null
}

/** The ask line takes the keys, holding what the person has typed so far. The ring belongs to the ask line from this
 *  moment, before the focus lands: a drawing in between must not put it back on the card, or the next letters go to
 *  the prompt and the field is drawn again without them. A letter that came through the prompt draws the field afresh
 *  holding the whole question (the pane and the bar alone draw again, never the transcript), unless the field has the
 *  ring: then the letter joins the question as it stands, and the field keeps what is typed into it. */
function toAsk($: Engine, text: string): void {
  draft = text
  if (!(isAsk(ringAt) && landed === askKey())) { askGen++; ringAt = askKey(); landed = null }
  askRedraw($)
  moveSoon($)
}

/** The ring to the ask line's field: the pane takes the keys and the field drawn last takes the ring (see moveGen). */
function moveSoon($: Engine): void {
  if (moving || landed === askKey()) return
  moving = true
  const at = moveGen
  $.clock.after(0, () => {
    void (async () => {
      try {
        if (at !== moveGen || !isOpen || !isAsk(ringAt) || landed === askKey()) return
        await $.ui.open({ id: PANE, focus: true, closeOnEscape: true, columns: detailColumns(viewCols) }).catch(() => undefined)
        if (at !== moveGen || !isOpen || !isAsk(ringAt) || landed === askKey()) return
        const r = await $.ui.focus({ requestId: PANE, key: askKey() }).catch(() => ({ deny: 'failed' }))
        if (!(r as Any)?.deny && at === moveGen && isAsk(ringAt)) landed = askKey()
      } finally {
        moving = false
      }
    })()
  })
}

/** Whether the prompt's text is letters the question took (in their order, among its last letters): what a busy
 *  terminal still shows of keys whose answers it has not applied yet. */
function takenTail(question: string, shown: string): boolean {
  const want = Array.from(shown)
  let i = 0
  for (const ch of Array.from(question).slice(-(want.length + 16))) if (ch === want[i]) i++
  return i === want.length
}

/** What a field of the ask line reports as typed: the field drawn last holds the whole question. One drawn before it
 *  (it still had the ring while the newer one was on its way) reports the letters it took, which join the question. */
function askTyped($: Engine, key: string, base: { seen: string }, v: string): void {
  const current = key === askKey()
  const m = askMerge(draft, base.seen, v, current)
  base.seen = m.seen
  // the field the person types into has the ring
  if (current) { draft = m.draft; landed = key }
  else if (m.added) toAsk($, m.draft)
}

// ------------------------------------------------------------------------------------------------ the card and its program

/** The open card as the pane last drew it (its drawing, for its own keys and presses), or null. */
async function current($: Engine): Promise<{ sel: Detail; p: Any } | null> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return null
  if (!drawn) { $.ui.invalidate('ui.render'); return null }
  // while it draws again (a page turned, every page at once), its last drawing answers
  const p = (await shownCard($, sel, drawn.w, drawn.h)) ?? (lastCard && lastCard.key === `${sel.root}|${sel.id}|${sel.v ?? ''}` ? lastCard.p : null)
  return p?.object ? { sel, p } : null
}

/** The knob whose pages the open card shows all at once, or null: its page knob, when the person chose all at once (a),
 *  else as PAGES_DEFAULT says. */
function allOf(sel: Detail, drawing: Any): string | null {
  const pk = pageKnob(drawing)
  return pk && (sel.pages ?? PAGES_DEFAULT) === 'all' ? pk.id : null
}

/** The card as the detail shows it, at `w` columns and `h` rows: one page, or every page at once (allOf). Null while
 *  it draws. */
async function shownCard($: Engine, sel: Detail, w: number, h: number): Promise<Any | null> {
  const one = await preparedNow($, sel, w, sel.state, 'detail', h)
  const all = one?.drawing && !one.error ? allOf(sel, one.drawing) : null
  return all ? await preparedNow($, sel, w, sel.state, 'detail', h, all) : one
}

/** The card the detail's program reads (shell.tsx's paneStore 'card'): the object at the version shown, its versions,
 *  and its drawing at the page's room with the card's state; null while it draws (the program says so). */
export async function cardStore($: Engine, id: string): Promise<Any> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.id !== id || sel.cite || sel.cites) return null
  const latest = await loadObject($, { id: sel.id, v: null, root: sel.root })
  // while the card draws again (a knob turned, its state from the browser, every page at once), the page keeps its last
  // drawing
  const fresh = await shownCard($, sel, room.w, room.h)
  if (fresh?.drawing && !fresh.error) lastCard = { key: `${sel.root}|${sel.id}|${sel.v ?? ''}`, p: fresh }
  const p = fresh ?? (lastCard && lastCard.key === `${sel.root}|${sel.id}|${sel.v ?? ''}` ? lastCard.p : null)
  const object = p?.object ?? latest
  if (!object) return null
  // the latest version drawn here is one the person saw; the header lists those, and the rest are drafts (h)
  const v = sel.v ?? latest?.version ?? null
  let seen = await readSeen($, sel.root, sel.id)
  // (a card with no record, saved before records were kept, lists every version, as before)
  if (seen && fresh?.drawing && !fresh.error && v != null && v === latest?.version && !seen.includes(Number(v))) {
    await noteSeen($, sel.root, sel.id, v)
    seen = [...seen, Number(v)]
  }
  return {
    object, drawing: p ? (p.error ? { error: { name: 'Error', message: p.error } } : p.drawing) : null,
    versions: versionsOf(latest, seen), v, state: ownState(sel.state),
    thread: !!threadFor({ object: sel.id }), labelGen: await labelGen($),
  }
}

/** The detail's state as its program keeps it, mirrored into the selection the rest of the shell reads (the part a
 *  question is about, the rows read for it); a new part is told to the card's thread. */
async function mirror($: Engine): Promise<void> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return
  const st = await paneState($, 'detail', { id: sel.id })
  const raw = typeof st.region === 'string' ? st.region : sel.region
  // a part of one page of a card shown all at once is the card's own part with its knob at that page, and a page's
  // heading is that page: so the rest of the shell (the rows read, a question, the card under the reply, the browser)
  // reads the selection as the card's own, and the card under the reply turns to the page being read
  const own = raw && pageOf(raw) ? ownPart(drawn?.card, raw) : { region: raw, state: null }
  const region = own.region
  const pages = st.pages === 'all' || st.pages === 'one' ? st.pages : sel.pages
  const next: Detail = { ...sel, region, ...(own.state ? { state: { ...(sel.state || {}), ...own.state } } : {}), bar: (st.bar as Detail['bar']) ?? null, prog: !!st.prog, ex: Number(st.ex) || 0, ...(pages ? { pages } : {}) }
  if (JSON.stringify(next) === JSON.stringify(sel)) return
  await $.state.set(SEL, next)
  const moved = JSON.stringify(next.state ?? {}) !== JSON.stringify(sel.state ?? {})
  if (region !== sel.region) {
    $.clock.after(0, () => { void select($, next).catch(() => undefined) })
    const t = threadFor({ object: sel.id })
    if (t && region) {
      const cur = await current($)
      const label = String(drawn?.parts.find((x: Any) => x.id === raw)?.label || region)
      await noteSelection($, t.key, { region, label, refs: cur ? regionRefs(cur.p.object, cur.p.drawing, raw!).refs : [] })
    }
  }
  if (region !== sel.region || moved) await writeCardState($, sel.root, sel.id, { state: next.state, region }, 'terminal')
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
    case 'close':
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return
    // the person's check of a record's label value (shell/labels.ts)
    case 'check':
      return await checkLabel($, sel.root, a)
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
  // every page at once: a page's part (`pg3~~x`) is the card's own `x` with the knob at page 3, and the program answers
  // as that one page (one page drawn, not every page, so the key's answer comes quickly)
  const ak = allKnob(p.drawing)
  const mapped = ak && typeof event.region === 'string' ? ownPart(p.drawing, event.region) : null
  const ev = mapped ? { ...event, region: mapped.region ?? undefined } : event
  const at: Detail = mapped?.state ? { ...sel, state: { ...(sel.state || {}), ...mapped.state } } : sel
  const got = await cardEvent($, p.object, at, ev, { w: drawn.w, h: drawn.h })
  if (!got || got.drawing?.error) {
    $.ui.toast(`× The card could not answer ${event.type === 'key' ? `the key ${event.key}` : 'that'}: ${got?.drawing?.error ? `${got.drawing.error.name} · fix: ${got.drawing.error.fix || 'its program'}` : 'its program did not run'}`)
    return
  }
  const region = typeof ev.region === 'string' ? ev.region : sel.region
  let next: Detail = { ...(sel as Detail), state: got.state, region, ex: 0 }
  // the card's own key (or a press on a part of a page) turned the page of a card shown all at once: the page goes to
  // that page's heading. A press on a part runs at the part's own page, which is no turn
  const page = ak ? pageAt(ak, got.state?.[ak.id]) : 0
  const was = ak ? at.state?.[ak.id] ?? ak.values[ak.i] : null
  if (ak && JSON.stringify(got.state?.[ak.id]) !== JSON.stringify(was)) {
    next = { ...next, region: null }
    await patchPaneState($, 'detail', { id: sel.id }, { region: pageId(page, ''), ex: 0 })
  }
  const ask = got.ask
  if (ask && ask.text) {
    const o = p.object
    const refs = ask.refs?.length ? ask.refs : ask.region ? regionRefs(o, got.drawing, ask.region).refs : []
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
    if (sel.region) askedRegion.set(id, sel.region)
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
  // a part named from outside (an open on a part, a click in the browser's chat) is the program's selection too
  const named = sel.region ?? null
  if (named && askedRegion.get(id) !== named) {
    askedRegion.set(id, named)
    // (the page's selection of a part of one of its pages, `pg3~~x`, names `x` already)
    $.clock.after(0, () => { void (async () => { const st = await paneState($, 'detail', { id: sel.id }); const at = typeof st.region === 'string' ? ownPart(drawn?.card, st.region).region : null; if (st.region !== named && at !== named) await patchPaneState($, 'detail', { id: sel.id }, { region: named, ex: 0 }) })().catch(() => undefined) })
  }
  if (kept.get(id) === now) return
  kept.set(id, now)
  $.clock.after(0, () => { void writeCardState($, sel.root, sel.id, { state: sel.state, region: sel.region }, 'terminal').catch(() => undefined) })
}

/** The selection now, and its rows read after: `thimble resolve` runs outside the key's hook, which has little time. */
async function selectSoon($: Engine, sel: Sel): Promise<void> {
  await $.state.set(SEL, sel)
  $.clock.after(0, () => { void select($, sel).catch(() => undefined) })
}

// ------------------------------------------------------------------------------------------------ drawing

/** The detail pane: the page (the detail's program on the card) at the pane's width, the card's thread under it once
 *  the person has asked, and the ask line at the bottom. */
export async function detailPane($: Engine, e: Any): Promise<Any> {
  const els = $.ui.resolve(e) as Any
  const { Box, Text, Button } = els
  // the terminal's width: the conversation's columns beside the dock, the dock's, and its border
  noteDock(e)
  viewing = e.props?.view?.agentId ?? null
  const sel = (await $.state.get(SEL)).value as Detail | null
  await $.state.get(ASKLINE)
  if (!sel) return Text({ dimColor: true, children: 'No card is open. A card Claude saves shows under its reply; open it from there.' })
  const C = Math.max(40, (e.props.bodyColumns ?? 100) - 1)
  const R = Math.max(12, e.props.scroll?.bodyRows ?? 40)
  if (sel.cites && !sel.cite) return citesList(els, sel, C, R)
  if (sel.cite) return citeView($, els, sel, C)
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

  // the rows: the ask line at the bottom (a blank row above it), the thread's latest exchange above that (at most two
  // fifths of the pane), the page in the rest
  const tlines = thread ? threadSection(els, thread, C, ind) : []
  const T = Math.min(tlines.length, Math.max(4, Math.floor(R * 0.4)))
  const pageRows = Math.max(6, R - 2 - (T ? T + 1 : 0))
  room = { w: C - 3, h: Math.max(10, pageRows - 8) }

  // the page beside its one-cell gutter, where the ring stands on the selected part's first row
  const d = await paneRun($, 'detail', { id: sel.id }, { w: C - 1, h: pageRows })
  const grid = renderTerm(d, { w: C - 1 })
  const card = (await shownCard($, sel, room.w, room.h)) ?? (lastCard && lastCard.key === `${sel.root}|${sel.id}|${sel.v ?? ''}` ? lastCard.p : null)
  const parts = partsOf({ ...grid, regions: grid.regions.filter((r: Any) => !/^ver-\d+$/.test(r.id)) })
  const region = typeof d.selected === 'string' ? d.selected : null
  const part = parts.find((x: Any) => x.id === region) ?? null
  // a page taller than its rows: the rows around the selected part, or, once the person opened the bar under the card
  // (↵ details, e examples, a flip), the bar with as much of the card above it as fits; the wheel moves the window
  // from there until the selection or the bar changes
  const barNow = `${sel.bar ?? ''}|${sel.bar === 'examples' ? sel.ex ?? 0 : ''}`
  if (barNow !== win.bar) { win.bar = barNow; win.by = 0; if (sel.bar) win.follow = 'bar' }
  if (region !== win.region) { win.region = region; win.by = 0; win.follow = 'part' }
  let rows = Math.min(grid.h, pageRows)
  let from = 0
  if (grid.h > rows) {
    const top = bodyTop(part)
    const end = grid.h - rows
    // the bar is the page's last rows
    // a page's heading (every page at once) goes to the top, so the page reads from its start
    const lead = part && pageOf(part.id)?.id === '' ? 0 : Math.floor(rows / 3)
    const at = sel.bar && win.follow === 'bar' ? end : Math.max(0, Math.min(end, (top ? top.y : 0) - lead))
    from = Math.max(0, Math.min(end, at + win.by))
    win.by = from - at
  } else win.by = 0
  rows = Math.min(rows, grid.h - from)
  const pixel = new Set<number>()
  for (let y = 0; y < grid.h; y++) if (grid.rows[y].some((c: Any) => c.px) && !grid.rows[y].some((c: Any) => c.b || c.ref || c.w2)) pixel.add(y)
  // each part's first row in the window holds a gutter cell the ring can stand on (one per row, in reading order)
  const gutter = new Map<number, string[]>()
  for (const x of parts) {
    const top = bodyTop(x)
    if (!top || top.y < from || top.y >= from + rows) continue
    gutter.set(top.y, [...(gutter.get(top.y) ?? []), x.id])
  }
  drawn = { id: sel.id, parts, from, rows, pixel, w: room.w, h: room.h, on: card?.drawing?.on || [], card: card?.drawing ?? null, gutter, selected: region }
  // a press on a part the card's program answers is the card's (k.on('press:<id>')); any other is the detail's: it
  // selects the part, and on the selected part fills the bar with its details; a knob's ◂ ▸ turns it
  const onPress = (id: string, dir?: number) => {
    if (!dir && card?.drawing && pressTaken(card.drawing, id)) return cardAct($, { type: 'press', region: id })
    return detailFire($, { type: 'press', region: id, ...(dir ? { dir } : {}) })
  }
  const top = bodyTop(part)
  const gcells = Array.from({ length: rows }, (_, i) => {
    const y = from + i
    const ids = gutter.get(y)
    const mark = top && top.y === y ? '▸' : ' '
    if (!ids) return Text({ key: `gt${y}`, color: ind, bold: true, children: mark })
    const at = ids.includes(region ?? '') ? region! : ids[0]!
    const label = String(parts.find((x: Any) => x.id === at)?.label || at)
    // the selected part's cell takes the ring whenever the pane takes the keyboard (an open, a key that gave it back),
    // except while a question is being typed: then the ask line takes it
    return Button({ key: GUTTER(y), plain: true, label, onPress: () => onPress(at), children: mark, ...(ids.includes(region ?? '') && !isAsk(ringAt) ? { autoFocus: true } : {}) })
  })
  const kids: Any[] = [Box({ flexDirection: 'row', children: [
    Box({ flexDirection: 'column', width: 1, flexShrink: 0, children: gcells }),
    // the pane's background is the theme's: its ink is the theme's text color
    paintRegions(grid, els, { theme, selected: region, key: 'pane', from, rows, onPress, painted: true }),
  ] })]
  if (T) kids.push(Text({ children: ' ' }), ...tlines.slice(tlines.length - T))
  kids.push(Text({ children: ' ' }), askLine($, els, sel, part, ind))
  // the ring follows the selection: after a drawing that moved the part (a scroll, a zoom, a key), it is put back on
  // the selected part's gutter cell, unless the person is typing in the ask line
  const want = selectedGutter()
  // which part each gutter cell stands for: when that changes (a zoom, the bar opening, a scroll), the ring's cell may
  // stand for another part now, so it is put back on the selected one
  const sig = [...gutter].map(([y, ids]) => `${y}:${ids.join('/')}`).join(',')
  if (sig !== drawnSig) { drawnSig = sig; if (!isAsk(ringAt)) ringAt = null }
  // the pane taking the keyboard back puts the ring where the person last moved it, as the engine kept it, which is
  // another part once the page scrolled: it goes back on the selected part
  if (e.props.isFocused && !paneFocused && !isAsk(ringAt)) ringAt = null
  paneFocused = !!e.props.isFocused
  if (want && e.props.isFocused && !isAsk(ringAt) && ringAt !== want && !refocus) {
    refocus = true
    $.clock.after(0, () => { void focusPart($).finally(() => { refocus = false }) })
  }
  return Box({ flexDirection: 'column', width: C, children: kids })
}

/** The ask line: an Input the letters of a question go to; ↵ asks the card's thread about the selected part. */
function askLine($: Engine, els: Any, sel: Detail, part: Any, ind: string): Any {
  const { Input } = els
  const about = sel.ask ? String(sel.ask.label) : part ? String(part.label || part.id) : ''
  const what = about ? cut(about, 40) : 'this card'
  const key = askKey()
  // what the field holds, as it was first drawn and then reported: a field with the ring keeps its own text when drawn
  // again, so a letter the question took through the prompt meanwhile is not in it
  let base = fields.get(key)
  if (!base) { base = { seen: draft }; fields.set(key, base); if (fields.size > 8) fields.delete(fields.keys().next().value!) }
  return Input({
    // what will happen, in plain words: the question is about this part, and its answer shows here, under the card
    key, placeholder: `ask about ${what}${what.endsWith('…') ? '' : '…'} · the answer shows here`, value: draft, submitLabel: 'ask',
    // while a question is being typed, the field takes the ring when the pane takes the keyboard
    ...(isAsk(ringAt) ? { autoFocus: true } : {}),
    onInput: (v: string) => askTyped($, key, base, v),
    // the question as the field and the prompt gave it: a letter that reached it through the prompt as the ring landed
    // is in it, though the field never showed it
    onSubmit: (v: string) => { askTyped($, key, base, v); void askHere($, key === askKey() ? draft : v) },
  })
}

/** A question typed in the ask line: the card's thread is asked about the selected part (or the selection the card's
 *  program named), and the ring goes back to the card. */
async function askHere($: Engine, text: string): Promise<void> {
  if (!String(text || '').trim()) return
  const problem = await askCard($, text)
  if (problem) { $.ui.toast(`× ${problem}`); return }
  // the line empties: a field drawn afresh, so no word of the question stays in it
  draft = ''
  askGen++
  ringAt = null
  landed = null
  moveGen++
  $.ui.invalidate('ui.render')
  regrab($)
}

/** The card's thread, under the card: its latest exchange (the question with its part, the steps, the answer with its
 *  citations), cut from the top to the rows it has. Its words are in the theme's text color (`text`), which reads on
 *  the pane's background, as the terminal's own text color may not. */
function threadSection(els: Any, thread: Any, C: number, ind: string): Any[] {
  const { Text } = els
  const w = C - 1
  const lines: Any[] = []
  const say = (runs: Any[], first: Any, rest = '  ') => wrapRuns(runs, w - 2).forEach((l, i) => lines.push(Text({ wrap: 'truncate-end', color: 'text', children: [i ? Text({ children: rest }) : first, ...l.map(styled)] })))
  const styled = (r: Any) => (r.link ? Text({ color: ind, underline: true, children: r.s }) : Text({ color: 'text', bold: r.bold || undefined, dimColor: r.dim || undefined, children: r.s }))
  const turns: Any[] = thread?.turns || []
  const last = turns.map((t: Any) => t.role).lastIndexOf('person')
  const asked = thread?.asks?.length || 0
  if (asked > 1) lines.push(Text({ dimColor: true, children: `thread · ${asked} questions` }))
  for (const t of last >= 0 ? turns.slice(last) : []) {
    if (t.role === 'person') {
      lines.push(Text({ wrap: 'truncate-end', children: [Text({ color: ind, children: '❯ ' }), Text({ color: 'text', bold: true, children: cut(String(t.text), w - 4) }), ...(t.about ? [Text({ dimColor: true, children: `  about ${cut(String(t.about), 40)}` })] : [])] }))
      continue
    }
    const calls: string[] = t.calls || []
    if (calls.length > 1) lines.push(Text({ dimColor: true, children: `  ${calls.length - 1} earlier step${calls.length - 1 === 1 ? '' : 's'}` }))
    for (const c of calls.slice(-1)) lines.push(Text({ dimColor: true, wrap: 'truncate-end', children: `⏺ ${cut(c, w - 2)}` }))
    // the answer keeps its lines (a list stays a list); code marks are dropped, citations read as their words
    String(t.text || '').replace(/`/g, '').split(/\n+/).map(x => x.trim()).filter(Boolean).forEach((para, i) =>
      say(linkRuns(para), Text({ color: 'text', children: i ? '  ' : '⏺ ' })))
  }
  if (thread?.status === 'running') lines.push(Text({ color: 'warning', children: '✻ answering…' }))
  if (thread?.status === 'failed') lines.push(Text({ color: 'error', wrap: 'truncate-end', children: `× ${cut(String(thread.error || 'the thread stopped'), w - 2)}` }))
  return lines
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

/** Where a part's body starts: its biggest rect (a citation of it in the takeaway is a rect of it too, a small one). */
function bodyTop(part: Any): { x: number; y: number } | null {
  if (!part || !part.rects?.length) return null
  return part.rects.reduce((a: Any, q: Any) => (q.w * q.h > a.w * a.h ? q : a), part.rects[0])
}

/** The detail's keys as the bar says them while the detail is open (shell.tsx): the card's own keys, then
 *  the detail's, as their programs name them, and where a question goes. */
export async function detailKeys($: Engine): Promise<string | null> {
  if (!isOpen) return null
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return 'esc back'
  await $.state.get(ASKLINE)
  // typing a question in the ask line: its own keys
  if (isAsk(ringAt) || draft) return `↵ ask${sel.ask ? ` about ${cut(String(sel.ask.label), 40)}` : ''} · esc back to the card`
  // the program run now (it follows the card's drawing and the detail's state as they change)
  const d = await paneNow($, 'detail', { id: sel.id })
  // the card's keys that reach it here (Claude Code keeps ← and →, so the bar never names them), then the detail's
  const taken = hostKeys('detail', 'terminal')
  // (before the pane has drawn the card, the card as it draws now: the line draws again once it has)
  const card = drawn?.card ?? (await shownCard($, sel, room.w, room.h))?.drawing ?? null
  const keys = barText([{ on: (card?.on || []).filter((h: Any) => !(String(h?.name) in taken)), controls: card?.controls || [] }, d])
  // what typing does, in plain words: a question about the selected part (or the card)
  const part = drawn?.selected ? drawn.parts.find((x: Any) => x.id === drawn!.selected) : null
  const about = sel.ask ? String(sel.ask.label) : part ? String(part.label || part.id) : 'this card'
  const ask = `type to ask about ${cut(about, 40)}`
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
    Text({ color: 'text', bold: true, children: `${list.length} values cited in the reply` }),
    Box({ flexDirection: 'column', marginTop: 1, children: shown.map(c => Text({ wrap: 'truncate-end', children: [Text({ color: 'text', children: cut(c.label, Math.floor(C / 2)) }), Text({ dimColor: true, children: `  ${c.ref}` })] })) }),
  ] })
}

async function citeView($: Engine, els: Any, sel: Sel, C: number): Promise<Any> {
  const { Box, Text } = els
  const label = citeLabels.get(sel.cite!) || sel.cite!
  const r = (await $.state.get({ ...ROWS, id: `${sel.root}|${sel.cite}` })).value as Any
  const kids: Any[] = [Text({ color: 'text', bold: true, wrap: 'truncate-end', children: `where ${label} comes from` })]
  if (r === undefined) kids.push(Text({ dimColor: true, children: '  reading its rows…' }))
  else {
    const c = chainWords(r)
    if (c.error) kids.push(Text({ color: 'error', wrap: 'wrap', children: `  ${c.notes[0]}` }))
    else {
      kids.push(Text({ dimColor: true, wrap: 'truncate-end', children: `  ← ${c.line}` }))
      const view = examplesView(c.records, { at: sel.ex || 0, fit: 10 })
      for (const x of view.rows as Any[]) {
        kids.push(Text({ color: 'text', wrap: 'truncate-end', children: `  ${cut(x.words || '', C - 4)}` }))
        kids.push(Text({ dimColor: true, wrap: 'truncate-end', children: `    ${x.meta || ''}` }))
      }
    }
  }
  return Box({ flexDirection: 'column', children: kids })
}

// ------------------------------------------------------------------------------------------------ keys

/** What a key pressed in the prompt comes to while the detail is open (keys.ts; shell.tsx's one prompt.edit hook asks
 *  it first): the card's own keys (its program's k.on), then the detail's program's. A letter that is no key starts a
 *  question in the ask line (it never types into the prompt), and a letter typed straight after a key that acted
 *  gives the key's letter back there (it began a word). Letters that arrive before the ask line has the keys join the
 *  question. It types while the detail is closed. */
export async function detailKey($: Engine, e: KeyEdit): Promise<KeyTurn> {
  if (!isOpen) return { box: null }
  // a paste (or keys typed faster than the terminal sends them one by one) with no key: a question too
  const paste = !e.key && !!e.inputText
  // a question begun, and the prompt still showing letters it took: when the terminal is busy, the prompt takes the
  // answers to keys later than the keys come, so a key can come on a prompt that still holds letters of the question.
  // Those letters and this key are the question's (the answer empties the prompt), never the start of a prompt for main
  const leftover = e.text !== '' && (isAsk(ringAt) || !!draft) && takenTail(draft, e.text)
  if ((!e.key && !paste) || e.key?.ctrl || e.key?.meta || (e.text !== '' && !leftover)) return { box: null }
  const none = { text: '', cursor: 0 }
  // (the question as it stands when the key's work runs: the work of the keys before it has run by then)
  if (paste) { const more = String(e.inputText); return { box: none, work: () => toAsk($, draft + more) } }
  const k = e.key!.key
  // the session clock (a test moves it), so a key and the letter after it are timed alike everywhere
  const now = Number(await $.clock.now())
  const typed = String(e.inputText || '')
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return { box: null }
  // a question already begun: the letter joins it (⌫ takes its last letter back, while the ask line has no keys)
  if (isAsk(ringAt) || (draft && typed) || leftover) {
    if (k === 'backspace' && !typed) return { box: none, work: () => toAsk($, draft.slice(0, -1)) }
    // ↵ before the ring reached the field (the letters came through the prompt): the question is asked as it stands
    if ((k === 'return' || k === 'enter') && !typed) return { box: none, work: () => { moveGen++; void askHere($, draft) } }
    return { box: none, work: () => toAsk($, draft + typed) }
  }
  // a letter typed straight after a key that acted: that key began a word, and what it changed goes back
  const back = lastKey
  if (back && beganWord(back.key, now - back.at, typed)) {
    return { box: none, work: async () => {
      lastKey = null
      // the question at once, so the letters after it join it; what the key changed goes back after, outside the key's
      // own work (the next key waits for that work)
      toAsk($, `${back.key}${typed}`)
      $.clock.after(0, () => { void (async () => {
        if (back.undo) { await setPaneState($, 'detail', { id: sel.id }, back.undo, 'terminal'); await mirror($) }
        // a card's own key (a page turned on n) goes back too: its state, its part, and the page's selection
        if (back.card) {
          const now = ((await $.state.get(SEL)).value as Detail | null) ?? sel
          await $.state.set(SEL, { ...now, state: back.card.state, region: back.card.region })
          await writeCardState($, sel.root, sel.id, { state: back.card.state, region: back.card.region }, 'terminal')
          await setPaneState($, 'detail', { id: sel.id }, back.card.pane, 'terminal')
          await mirror($)
        }
      })().catch(() => undefined) })
    } }
  }
  // the card's own keys (its program's k.on) come before the detail's
  const cur = await current($)
  const own = cur ? cardKey(cur.p.drawing, k) : null
  if (own) {
    const region = cur!.sel.region
    // what it changes goes back when a letter follows at once: the key began a question ("now…" on a card with n)
    const undo: Undo = { state: cur!.sel.state, region: cur!.sel.region, pane: { ...(await paneState($, 'detail', { id: sel.id })) } }
    return { box: none, work: async () => {
      lastKey = null
      await cardAct($, { type: 'key', key: own, ...(region ? { region } : {}) })
      if (/^[a-z]$/.test(k)) lastKey = { key: k, at: now, undo: null, card: undo }
      regrab($)
    } }
  }
  // esc, ↑ and the like never reach here: Claude Code keeps them (the pane's close and ring do them)
  const ev = { type: 'key', key: k === 'enter' ? 'return' : k }
  if (await paneTakes($, 'detail', { id: sel.id }, ev)) {
    return { box: none, work: async () => {
      const before = { ...(await paneState($, 'detail', { id: sel.id })) }
      lastKey = (await detailFire($, ev)) ? { key: k, at: now, undo: /^[a-z]$/.test(k) ? before : null } : null
      regrab($)
    } }
  }
  // a letter (or a paste) that is no key begins a question in the ask line
  if (typed.trim()) return { box: none, work: () => { lastKey = null; toAsk($, typed) } }
  return { box: null, work: () => { lastKey = null } }
}

/** A key typed while the detail is open, as it landed: a prompt emptied gives the keys back to the card. */
export function detailTyped($: Engine, e: KeyEdit, out: { text: string }): void {
  const plain = e.key ? !e.key.ctrl && !e.key.meta : !!e.inputText
  if (isOpen && plain && out.text === '' && e.text !== '') regrab($)
}

// ------------------------------------------------------------------------------------------------ hooks

export function registerDetail(on: Parameters<Register>[0]): void {
  // ↑↓ walk the parts. The ring stands in the gutter on the selected part's first row; the person's move (an arrow,
  // Tab, a click on a part) is turned into the program's focus event on the part before or after (or the part
  // clicked), and the ring is put on that part's gutter cell, now when it is drawn, else after the drawing that
  // scrolls it into view. So the ring and the selection are always the same part.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    try {
      const el = String(e.element || '')
      const person = (e.origin as { kind?: string }).kind === 'person'
      if (!person || !drawn) {
        // while a question is being typed, a drawing from before it (its autoFocus on the card) never takes the ring
        // from the ask line
        // nor does a field drawn before the one the question is in now (a busy terminal hands the ring to the drawing it
        // has): the ring goes to the field drawn last, and the letters typed there are kept
        if (!person && isAsk(ringAt) && (el.startsWith('g|') || (isAsk(el) && el !== askKey()))) {
          const r = await next({ ...e, element: askKey() })
          if (!r.deny) landed = askKey()
          return r
        }
        // and with no question begun (esc let one go), a drawing from before (its autoFocus still on the ask line) never
        // takes the ring there: the keys are the card's, on the selected part (or a part drawn, while the window comes
        // back to it)
        if (!person && drawn && isAsk(el) && !isAsk(ringAt) && !draft) {
          const to = selectedGutter() ?? (drawn.gutter.size ? GUTTER(Math.min(...drawn.gutter.keys())) : null)
          if (to) {
            const r = await next({ ...e, element: to })
            if (!r.deny) { ringAt = to; ringY = Number(to.split('|')[2]) }
            return r
          }
        }
        const was = isAsk(ringAt)
        const r = await next(e)
        if (!r.deny) { ringAt = el || null; landed = el === askKey() ? el : null; if (el.startsWith('g|')) ringY = Number(el.split('|')[2]) }
        if (isAsk(ringAt) !== was) askRedraw($)
        return r
      }
      const g = /^g\|pane\|(\d+)$/.exec(el)
      const m = /^[rt]\|pane\|(\d+)\|([^|]+)(?:\|(?:down|at|up))?$/.exec(el)
      const sel = (await $.state.get(SEL)).value as Detail | null
      if (!sel) return next(e)
      const ids = drawn.parts.map((x: Any) => x.id)
      const part = m ? (ids.includes(m[2]!) ? m[2]! : null) : null
      const onRing = !!ringAt && ringAt.startsWith('g|')
      // the gutter cells come first in the pane's order, so a move past the last one (or before the first) lands
      // outside them: from the ring that is a step around the parts (the program wraps), never a jump to the header
      const rows = [...drawn.gutter.keys()].sort((a, b) => a - b)
      const wrap = onRing && !g && !part ? (ringY === rows[rows.length - 1] ? 1 : ringY === rows[0] ? -1 : 0) : 0
      // the ask line, a version or the close mark, reached any other way: the ring goes there and the selection stays
      if (!g && !part && !wrap) { const was = isAsk(ringAt); const r = await next(e); if (!r.deny) { ringAt = el || null; landed = el === askKey() ? el : null } if (isAsk(ringAt) !== was) askRedraw($); return r }
      const y = g || m ? Number((g ?? m)![1]) : ringY
      const cur = drawn.selected ?? sel.region ?? null
      const dir = wrap || (ringY < 0 ? 1 : y < ringY ? -1 : 1)
      const step = () => { const i = cur ? ids.indexOf(cur) : -1; return ids.length ? ids[i < 0 ? 0 : (i + dir + ids.length) % ids.length]! : null }
      let id: string | null
      // back from the ask line: the selected part
      if (isAsk(ringAt)) id = cur ?? step()
      else if (wrap) id = step()
      // a move from the ring: along its own row it is a click on a part there (or stays); up or down it steps one part
      // from the selection, or takes the part the engine moved to when that is another part
      else if (onRing) id = y === ringY ? (part ?? cur) : part && part !== cur ? part : step()
      // the ring was elsewhere (the header, nothing): the part it lands on
      else id = part ?? drawn.gutter.get(y)?.[0] ?? cur ?? step()
      if (!id) return next(e)
      if (id !== cur) await detailFire($, { type: 'focus', region: id })
      const top = bodyTop(drawn.parts.find((x: Any) => x.id === id))
      landed = null
      if (top && drawn.gutter.has(top.y)) {
        ringAt = GUTTER(top.y)
        ringY = top.y
        return next({ ...e, element: ringAt })
      }
      // not drawn yet (the wheel moved it out of the window): the window goes back to it, and the drawing that brings
      // the part puts the ring there
      ringAt = null
      win.by = 0
      win.follow = 'part'
      $.ui.invalidate('ui.render')
      return {}
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  // the wheel over the pane (or its scroll keys) moves the page's window: the pane draws its own rows of the page, so
  // the engine has none to move
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if ((e.origin as { kind?: string }).kind !== 'person' || !drawn || !isOpen) return next(e)
    win.by += Number(e.by) || 0
    $.ui.invalidate('ui.render')
    return {}
  }).catch(($, e, next) => next(e))

  // esc in the ask line empties it and gives the keys back to the card; then esc empties the bar and closes the program
  // (the program's esc), then the detail; closing gives the main view back
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const person = (e.origin as { kind?: string }).kind === 'person'
    if (person) keysMoved(await $.clock.now())
    if (person && isOpen && (isAsk(ringAt) || draft)) {
      draft = ''
      askGen++
      ringAt = null
      landed = null
      moveGen++
      win.by = 0
      win.follow = 'part'
      $.ui.invalidate('ui.render')
      regrab($)
      return { value: undefined } as Any
    }
    const sel = (await $.state.get(SEL)).value as Detail | null
    if (sel && !sel.cite && !sel.cites && (sel.prog || sel.bar) && person) {
      await detailFire($, { type: 'key', key: 'esc' })
      // a refused close gives the keys back to the prompt: the pane takes them again, so the next esc reaches it
      regrab($)
      return { value: undefined } as Any
    }
    await closed($)
    return next(e)
  })

  // a prompt typed in the composer while the detail is open (rare: letters normally go to the ask line) asks the card's
  // thread too. It never reaches main: Claude Code shows it as dropped, with where it went.
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    if (!isOpen || e.command || e.isMeta || !String(e.text || '').trim()) return next(e)
    // the pane may have gone without its close reaching this module (a re-render marked it open again): a prompt goes
    // to the card's thread only while the pane is really there, else to Claude as always
    if (!(await paneShown($))) { await closed($); return next(e) }
    const sel = (await $.state.get(SEL)).value as Sel | null
    if (!sel || sel.cite || sel.cites) return next(e)
    // ↵ on a question typed through the prompt (its letters came before the ring reached the ask line): the prompt may
    // still show a few of its letters, the answers to their keys not applied yet; the question is the one typed, whole
    if (draft.trim() && takenTail(draft, String(e.text))) {
      const q = draft
      moveGen++
      await askHere($, q)
      $.clock.after(30, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
      return { drop: `asked the card's thread about ${cut(lastAbout, 40)}` }
    }
    const asked = await askCard($, e.text)
    if (asked === NO_CARD) return next(e)
    if (asked) return { drop: `${asked}. Your words are back in the prompt; esc closes the card, and the prompt then goes to Claude here.` }
    $.clock.after(30, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
    return { drop: `asked the card's thread about ${cut(lastAbout, 40)}` }
  }).catch(($, e, next) => next(e))
}

const NO_CARD = 'no card'
let lastAbout = ''

/** Ask the open card's thread: about the selection the card's program named (k.ask: a brushed range, several runs),
 *  else the selected part, else the whole card. Null when asked, else the problem in a few words. */
async function askCard($: Engine, text: string): Promise<string | null> {
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return NO_CARD
  const p = await prepared($, sel, drawn?.w ?? room.w, sel.state, 'detail', drawn?.h ?? room.h)
  if (!p.object) return NO_CARD
  const o = p.object
  // the part selected: the one the page shows selected (the program's), else the shell's record of it. On a card shown
  // all at once it is a part of one page (`pg3~~x`): the thread hears of `x`, or of the page itself (its heading)
  const shown = drawn && drawn.id === sel.id && drawn.card ? drawn.card : p.drawing
  const raw = drawn && drawn.id === sel.id && drawn.selected ? drawn.selected : sel.region
  const paged = raw ? pageOf(raw) : null
  const region = paged ? ownPart(shown, raw).region : raw
  const meta = raw ? regionMeta(shown, raw) ?? regionMeta(p.drawing, raw) : null
  const label = String(meta?.label || drawn?.parts.find((x: Any) => x.id === raw)?.label || region || '')
  const row = ((await $.state.get({ ...WHERE, id: sel.id })).value as string | undefined) ?? undefined
  const ask = sel.ask || null
  const scope: Scope = ask
    ? { object: sel.id, v: o.version ?? sel.v, ...(ask.region ? { region: ask.region } : {}), label: ask.label, ...(row ? { row } : {}) }
    : { object: sel.id, v: o.version ?? sel.v, ...(region ? { region, label } : paged ? { label } : {}), ...(row ? { row } : {}) }
  const rowsOf = (id: string) => { const a = regionRefs(o, shown, id).refs; return a.length ? a : regionRefs(o, p.drawing, region ?? id).refs }
  const refs = ask?.refs?.length ? ask.refs : ask?.region ? regionRefs(o, p.drawing, ask.region).refs : region ? rowsOf(raw!) : objectRefs(o).map((c: Any) => c.ref)
  if (ask) await $.state.set(SEL, { ...sel, ask: null } as Detail)
  const r = await askThread($, { text, scope, refs, root: sel.root, card: { id: o.id, v: o.version, title: o.title, file: `${sel.root}/thimble/objects/${o.id}.json` } })
  lastAbout = aboutOf(scope)
  return r.problem ?? null
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
  ringAt = null
  draft = ''
  refocus = false
  paneFocused = false
  drawnSig = ''
  win.follow = 'part'; win.bar = ''; win.region = null; win.by = 0
  viewCols = 0
  latestSeen.clear()
  lastCard = null
}
