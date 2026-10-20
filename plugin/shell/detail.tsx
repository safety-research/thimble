// detail.tsx: the side panel in the terminal, and the card detail it shows. "Overview first, zoom and filter, details
// on demand."
//
// Whatever opens in the side panel is a thread (side.ts): the thing itself at the top, the thread's conversation under
// it (conversation.ts: each question after ❯, each answer after ● with its citations and the cards it saved), and an
// input bar at the bottom that looks and acts like Claude Code's prompt. The thing is a card's detail, or a pane of
// thimble's (a citation or an explainer, the thread list, any pane panes/ has) drawn by its program. This file is the
// terminal's host for both:
//
//   card       the card detail is a program on the card runtime (panes/detail.js), the same one the browser draws for
//              a card's detail: a header (the title, the card's id, v1 · v2), the takeaway, the card enlarged with its
//              parts, and a bar under it that starts empty and fills on demand with the selected part's details and
//              examples; the program behind p. Its state (the part selected, what the bar shows) is kept in
//              thimble/panes/<session>/detail-<id>.json, so the browser opens the card where the terminal left it. The
//              card's own drawing runs in its own sandbox with its state (thimble/objects/.state/<id>.json)
//   pane       any other pane's program (shell/panes.ts) at the panel's width: its parts are presses, the ring walks
//              them, and the part it selected (k.select) is what a question is about
//   width      the panel docks beside the transcript and leaves the chat about two fifths of the terminal (48 to 80
//              columns), so the conversation stays readable beside it and the bar above the prompt stays one line. A
//              terminal too narrow for it when a key opens it gets a toast naming the command that opens it (/card,
//              /threads), which Claude Code places at any width
//   ask        the input bar (an Input): a letter that is no key starts a question there, and ↵ asks the thread of
//              what the panel shows (thread.ts), about the part selected. It never passes through the prompt, so main's
//              transcript gets no row for it. The answer shows in the conversation, above the input bar
//   keys       the card's own keys (its program's k.on) first, then the detail's or the pane's program's, then the
//              panel's own (t the thread list, m the thread's last answer to main), only while the input bar is empty;
//              a key that began a word gives its letter back to the input bar. While the input bar is empty the panel
//              holds the keys, so ↑↓ walk the parts. One selection, one highlight: on a card the ring stands in the
//              gutter on the selected part's first row (a ▸), and the part is shaded; a move of the ring is the
//              program's focus event, and after each drawing the ring is put back on the selected part. `esc` empties
//              the input bar, then closes what the program opened, then goes back to what the panel showed before
//              (a citation opened from an answer goes back to the card), then closes the panel. Claude Code keeps ←
//              and →, so knobs turn on , and .
//   window     a page taller than its rows shows the rows around the selected part; once the person opens the bar
//              under the card (↵ details, e examples, a flip) it shows the bar, and the wheel moves it from there.
//              While the input bar holds the keys the wheel scrolls the thread's conversation instead
// A card under a reply shows `1 open detail`; 1 on an empty prompt opens the latest card's detail.
import type { EngineInterface, Register } from 'claude-code'

import type { Sel } from '../types'
import { renderTerm } from '../draw/term.js'
import { barText, hostKeys } from '../panes/host.js'
import { paintRegions, regionOfKey } from './cells'
import { askMerge, beganWord, examplesView, PAGES_DEFAULT, partsOf, versionsOf } from './carddetail.js'
import { allKnob, ownPart, pageAt, pageId, pageKnob, pageOf } from '../draw/handoff.js'
import { chainWords, objectRefs, regionMeta, regionRefs } from './object.js'
import { citeLabels, currentTheme, keysMoved, loadObject, openDetail, paneWhere, popFocus, prepared, preparedNow, pushFocus, select } from './shell'
import { askThread, noteSelection, restoreThreads, sendToMain, setThreadWindow, threadCount, threadFor, threadOf } from './thread'
import { cardEvent, cardKey, noteSeen, ownState, pressTaken, readCardState, readSeen, writeCardState } from './runtime'
import type { CardAsk } from './runtime'
import { type KeyEdit, type KeyTurn } from './keys'
import { paneFire, paneNow, paneRun, paneState, paneTakes, patchPaneState, setPaneState } from './panes'
import type { Scope } from './thread'
import { aboutOf, nameOf } from './threads.js'
import { check as checkLabel, checksDone, labelGen } from './labels'
import { conversation, entry, ENTRY_ROWS, fitItems, type Item } from './conversation'
import { openMark, openThreads, paneSubject, sideBack, sideClosed, sideDepth, sideNow, type Subject } from './side'
import type { SideView } from '../types'

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
// the input bar drawn again (a letter joined the question, the ring came or went): the pane and the bar read it, so a
// letter redraws them alone, never every row of the transcript
const ASKLINE = { plugin: 'thimble', key: 'askline' } as const
const IND = { dark: '#9a93ff', light: '#4f46e5' }
const cut = (s: string, k: number) => ([...s].length <= k ? s : [...s].slice(0, Math.max(0, k - 1)).join('') + '…')
type PaneView = Extract<SideView, { kind: 'pane' }>
/** How long a key of the panel's own (t, m) waits before it acts: a letter typed within it makes the key the start of
 *  a question, as v's does in main. */
const WORD_MS = 700

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
// card's own key keeps the card's state and part from before it (`card`), and a key of the detail's program the card
// as it was opened (`sel`: a key such as h shows another version)
let lastKey: { key: string; at: number; undo: Record<string, unknown> | null; card?: Undo; pane?: PaneView; sel?: Detail } | null = null
// a key of the panel's own (t, m) waiting out WORD_MS before it acts
let pendingHost: { key: string; at: number; cancelled: boolean } | null = null
const latestSeen = new Map<string, number>()
// a pane the panel shows (not a card): what it drew last, for the ring (the button of each part) and the keys
let paneDrawn: { name: string; args: Record<string, unknown>; selected: string | null; buttons: Map<string, string>; first: string | null; order: string[] } | null = null
// what the panel draws now, as its latest drawing began (a card's drawing still under way when the panel turned to a
// pane must not take the ring from the pane's parts)
let showing: 'card' | 'pane' = 'card'
// the conversation's window: rows up from its end (the wheel moves it while the input bar holds the keys, or while
// the thing above it fits its rows), and whether the thing above it is cut to a window of its rows
let convBy = 0
let pageCut = false
// the terminal's columns, as the last drawing measured them: the detail leaves the chat its share of them
let viewCols = 0
// the ring: the element it stands on (as the last move or focus left it), its gutter row, and the question being typed
// in the input bar (kept here, so a redraw never wipes what the person typed)
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
// the input bar's key: a new one each time text is put in it from outside (a letter typed before it had the keys), so
// the field is drawn afresh holding that text (a field already drawn keeps what it holds), and the ring waits for
// that drawing
let askGen = 0
const askKey = () => `ask-${askGen}`
const isAsk = (k: string | null) => !!k && k.startsWith('ask-')
// The ring's move to the input bar, and the field that has it. The letters of a question come through the prompt until
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

/** Open the side panel on what side.ts says it shows: the pane docked beside the transcript, leaving the chat its
 *  share, holding the keys while the input bar is empty. False when the terminal had no room for it. */
export async function openDock($: Engine, title: string): Promise<boolean> {
  const was = isOpen
  isOpen = true
  setThreadWindow(true)
  await pushFocus($, 'detail')
  // something else in the panel: its conversation starts at its end, and the ring goes to its selected part (a
  // question being typed stays in the input bar)
  if (was) { convBy = 0; win.by = 0; win.follow = 'part'; if (!isAsk(ringAt)) ringAt = null }
  const r = await $.ui.open({ id: PANE, title, focus: true, closeOnEscape: true, columns: detailColumns(viewCols) }).catch((err: unknown) => ({ isPlaced: false, reason: String((err as Error)?.message || err).slice(0, 160) }))
  // a terminal too narrow for a docked pane a key opened (one a command opens is placed at any width): Claude Code
  // would keep it waiting, undrawn, with the keys still the panel's. It is closed again, and the toast says what opens
  // it; what it would have shown stays, for that command
  if (r && (r as Any).isPlaced === false) {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    if (isOpen) await closed($, true)
    const v = await sideNow($)
    $.ui.toast(waitingWords(String((r as Any).reason || ''), !v || v.kind === 'card' ? 'card' : 'thread'))
    return false
  }
  // asked from a key, the open lands while the key is still in the prompt: ask for the keys again once it is gone
  regrab($)
  return true
}

/** The card's detail opens in the side panel (shell.tsx openDetail). */
export async function openDetailPane($: Engine, title: string): Promise<boolean> {
  return openDock($, title)
}

/** What the toast says when the panel cannot be placed: the width it needs and what opens it now (/card for a card's
 *  detail, /threads for anything else). */
export function waitingWords(reason: string, what: 'card' | 'thread' = 'card'): string {
  const m = /(\d+) columns \((\d+) now\)/.exec(reason)
  const name = what === 'card' ? "The card's detail" : 'The side panel'
  const cmd = what === 'card' ? '/card' : '/threads'
  return m
    ? `${name} needs ${m[1]} columns when a key opens it (${m[2]} now). Type ${cmd} to open it here, or widen the terminal.`
    : `${name} cannot open here${reason ? ` (${reason})` : ''}. Type ${cmd} to open it.`
}

/** The input bar takes the keys now, holding what is typed in it so far (a thread opened to be asked). */
export function focusEntry($: Engine): void {
  toAsk($, draft)
}

async function closed($: Engine, keep = false): Promise<void> {
  isOpen = false
  seeded.clear()
  askedRegion.clear()
  setThreadWindow(false)
  drawn = null
  paneDrawn = null
  ringAt = null
  ringY = -1
  draft = ''
  landed = null
  convBy = 0
  moveGen++
  if (pendingHost) { pendingHost.cancelled = true; pendingHost = null }
  await popFocus($, 'detail')
  // what the panel showed, and the way back through it, end with it (kept when it could not be placed: /threads opens it)
  if (!keep) await sideClosed($)
  // the labels the person checked are counted again, their cards drawn again, and Claude hears of the checks
  $.clock.after(0, () => { void checksDone($).catch(() => undefined) })
}

/** The keys back to the card: the pane takes the keyboard (granted only over an empty composer), the ring on the part.
 *  A question begun since it was asked keeps the keys: the person is typing in the input bar. */
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

/** The ring onto the selected part: the gutter cell of the part's first row (its ▸) on a card, the part's first press
 *  in a pane, when it is drawn. */
async function focusPart($: Engine): Promise<void> {
  const key = selectedGutter()
  // the wheel moved the selected part out of the window (a long page, every page at once): the window goes back to it,
  // and the drawing that brings it puts the ring there, so the keys are the card's again and never stay with the input bar
  if (!key && drawn?.selected && win.by && !isAsk(ringAt)) { win.by = 0; win.follow = 'part'; $.ui.invalidate('ui.render'); return }
  // never while the person types in the input bar: a drawing asked for before the first letter would take it back
  if (!key || ringAt === key || isAsk(ringAt)) return
  const r = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'failed' }))
  // a question begun while the ring moved keeps the input bar's claim: its own focus follows
  if (!(r as Any)?.deny && !isAsk(ringAt)) { ringAt = key; ringY = Number(key.split('|')[2]) }
}

/** Where the ring stands on the selected part in the last drawing: on a card the gutter key of its first row, in a
 *  pane its first press (else the pane's first part); null when it is not drawn. */
function selectedGutter(): string | null {
  if (showing === 'pane') return !paneDrawn ? null : (paneDrawn.selected ? paneDrawn.buttons.get(paneDrawn.selected) : null) ?? paneDrawn.first
  if (!drawn) return null
  for (const [y, ids] of drawn.gutter) if (ids.includes(drawn.selected ?? '')) return GUTTER(y)
  return null
}

/** The input bar takes the keys, holding what the person has typed so far. The ring belongs to the input bar from this
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

/** The ring to the input bar's field: the pane takes the keys and the field drawn last takes the ring (see moveGen). */
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

/** What a field of the input bar reports as typed: the field drawn last holds the whole question. One drawn before it
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
    versions: versionsOf(latest, seen), v, state: ownState(sel.state), labelGen: await labelGen($),
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
 *  another version, its thread's answer sent to main, closing. */
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
    // the card's thread's last answer, to main (m is the panel's own key; the browser's page may ask it)
    case 'main': {
      const t = threadFor({ object: sel.id })
      return t ? await sendToMain($, t.key) : 'This card has no thread yet: type a question to start one.'
    }
    // esc with nothing open over the card: back to what the panel showed before, else the panel closes
    case 'close':
      if (await sideBack($)) return
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
    const r = await askThread($, { text: ask.text, scope: { object: sel.id, v: o.version ?? sel.v, ...(ask.region ? { region: ask.region } : {}), label: ask.label }, refs, root: sel.root, card: { id: o.id, v: o.version, title: o.title, file: `${sel.root}/thimble/objects/${o.id}.json` }, anchor: { kind: 'card', id: sel.id, v: null, root: sel.root, region: ask.region ?? null } })
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

/** The side panel: what it shows at the top (a card's detail page, or a pane's program) at the panel's width, the
 *  thread's conversation under it, and the input bar at the bottom. */
export async function detailPane($: Engine, e: Any): Promise<Any> {
  const els = $.ui.resolve(e) as Any
  const { Box, Text, Button } = els
  // the terminal's width: the conversation's columns beside the dock, the dock's, and its border
  noteDock(e)
  await $.state.get(ASKLINE)
  const C = Math.max(40, (e.props.bodyColumns ?? 100) - 1)
  const R = Math.max(12, e.props.scroll?.bodyRows ?? 40)
  const view = await sideNow($)
  showing = view?.kind === 'pane' ? 'pane' : 'card'
  if (view?.kind === 'pane') return panePane($, e, els, view, C, R)
  paneDrawn = null
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel) return Text({ dimColor: true, children: 'No card is open. A card Claude saves shows under its reply; open it from there.' })
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

  // the rows: the input bar at the bottom, the thread's conversation above it (two fifths of the panel, three fifths
  // while the input bar holds the keys), the page in the rest
  const conv = await convOf($, els, thread, nameOf({ scope: { object: sel.id }, card: latest?.title || sel.id }), C - 1, { id: sel.id, root: sel.root })
  const T = convRows(conv, R)
  const pageRows = Math.max(6, R - ENTRY_ROWS - T)
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
  pageCut = grid.h > pageRows
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
    // except while a question is being typed: then the input bar takes it
    return Button({ key: GUTTER(y), plain: true, label, onPress: () => onPress(at), children: mark, ...(ids.includes(region ?? '') && !isAsk(ringAt) ? { autoFocus: true } : {}) })
  })
  const kids: Any[] = [Box({ flexDirection: 'row', children: [
    Box({ flexDirection: 'column', width: 1, flexShrink: 0, children: gcells }),
    // the pane's background is the theme's: its ink is the theme's text color
    paintRegions(grid, els, { theme, selected: region, key: 'pane', from, rows, onPress, painted: true }),
  ] })]
  kids.push(...convEls(els, conv, T))
  const about = sel.ask ? String(sel.ask.label) : part ? String(part.label || part.id) : 'this card'
  kids.push(...entryEls($, els, about, C))
  // the ring follows the selection: after a drawing that moved the part (a scroll, a zoom, a key), it is put back on
  // the selected part's gutter cell, unless the person is typing in the input bar
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

/** The conversation's rows: as many as it has, up to two fifths of the panel (three fifths while the input bar holds
 *  the keys, the person is in the thread), at least 4. */
function convRows(conv: Item[], R: number): number {
  if (!conv.length) return 0
  const total = conv.reduce((n, x) => n + x.h, 0)
  return Math.min(total, Math.max(4, Math.floor(R * (isAsk(ringAt) || draft ? 0.6 : 0.4))))
}

/** The conversation cut to its rows: its newest rows, or where the wheel moved it. */
function convEls(els: Any, conv: Item[], T: number): Any[] {
  if (!T) return []
  const fit = fitItems(els, conv, T, convBy)
  convBy = fit.by
  return fit.items.map(x => x.el)
}

/** The thread's conversation as rows (conversation.ts): its citations open in the panel over what it shows, and the
 *  cards its agent saved are drawn under their answers (the card the panel shows is named, not drawn again). */
async function convOf($: Engine, els: Any, thread: Any | null, name: string, w: number, shown: { id: string; root: string } | null): Promise<Item[]> {
  if (!thread?.turns?.length) return []
  const { Box, Text } = els
  const theme = currentTheme()
  const here = (c: { id: string; root: string }) => !!shown && shown.id === c.id && shown.root === c.root
  // the cards it saved, drawn before the conversation is laid out (a card being drawn says so, and draws again once
  // it is ready)
  const cards = new Map<string, Any>()
  for (const t of thread.turns) {
    for (const c of (t.cards || []) as { id: string; v: number | null; root: string }[]) {
      const k = `${c.root}|${c.id}`
      if (cards.has(k) || here(c)) continue
      cards.set(k, await preparedNow($, { id: c.id, v: null, root: c.root }, Math.max(30, w - 2), null, 'inline', 14))
    }
  }
  return conversation(els, {
    thread, name, w, theme, key: 'conv', now: Date.now(),
    onCite: (ref, label) => { void openMark($, { kind: 'cite', ref, label }, { push: true }) },
    card: (c, key) => {
      if (here(c)) return { el: Text({ key, dimColor: true, wrap: 'truncate-end', children: '  ⎿ saved a new version of this card, shown above' }), h: 1 }
      const p = cards.get(`${c.root}|${c.id}`)
      if (!p?.grid) return { el: Text({ key, dimColor: true, wrap: 'truncate-end', children: `  ⎿ saved ${c.id} · ${p?.error ? `it cannot be drawn: ${p.error}` : 'drawing it…'}` }), h: 1 }
      // a press on a part opens the card's detail on it, over what the panel shows
      const onPress = (id: string) => { void openDetail($, { id: c.id, v: null, root: c.root }, id, { side: 'push' }) }
      return { el: Box({ key, marginLeft: 2, children: [paintRegions(p.grid, els, { theme, key, onPress, painted: true })] }), h: p.grid.h }
    },
  })
}

/** The input bar: what is typed in it so far, and ↵ asks the thread of what the panel shows about `about`. */
function entryEls($: Engine, els: Any, about: string, C: number): Any[] {
  const key = askKey()
  // what the field holds, as it was first drawn and then reported: a field with the ring keeps its own text when drawn
  // again, so a letter the question took through the prompt meanwhile is not in it
  let base = fields.get(key)
  if (!base) { base = { seen: draft }; fields.set(key, base); if (fields.size > 8) fields.delete(fields.keys().next().value!) }
  const what = cut(about, 40)
  const b = base
  return entry(els, {
    key, w: C - 1, value: draft,
    // what it is about, in a few words, as Claude Code's prompt says what it takes
    placeholder: `Ask about ${what}${what.endsWith('…') ? '' : '…'}`,
    // while a question is being typed, the field takes the ring when the panel takes the keyboard
    autoFocus: isAsk(ringAt),
    onInput: (v: string) => askTyped($, key, b, v),
    // the question as the field and the prompt gave it: a letter that reached it through the prompt as the ring landed
    // is in it, though the field never showed it
    onSubmit: (v: string) => { askTyped($, key, b, v); void askHere($, key === askKey() ? draft : v) },
  })
}

/** A pane of thimble's in the panel: its program at the panel's width (its parts presses the ring walks, the part it
 *  selected shaded), its thread's conversation under it, and the input bar, unless the pane has no thread now. */
async function panePane($: Engine, e: Any, els: Any, view: PaneView, C: number, R: number): Promise<Any> {
  const { Box } = els
  drawn = null
  const theme = currentTheme()
  // the program first, at every row it needs (its window is cut below), so the part it selected names the thread's
  // subject in this same drawing
  const d = await paneRun($, view.pane, view.args, { w: C - 1, h: R })
  await restoreThreads($)
  const subject = paneSubject(view)
  const thread = subject ? threadOf(subject.key) : null
  if (subject) await $.state.get({ ...THREAD, id: subject.key })
  const conv = subject ? await convOf($, els, thread, subject.name, C - 1, null) : []
  const T = convRows(conv, R)
  const rows0 = Math.max(4, R - (subject ? ENTRY_ROWS : 0) - T)
  const grid = renderTerm(d, { w: C - 1 })
  const region = typeof d?.selected === 'string' ? d.selected : null
  if (region !== win.region) { win.region = region; win.by = 0; win.follow = 'part' }
  // a program taller than its rows: the rows around the part selected; the wheel moves the window from there
  let rows = Math.min(grid.h, rows0)
  let from = 0
  const tops = new Map<string, number>()
  for (const r of grid.regions as Any[]) if (r.rects?.length && !r.link) tops.set(r.id, Math.min(...r.rects.map((q: Any) => q.y)))
  if (grid.h > rows) {
    const end = grid.h - rows
    const at = Math.max(0, Math.min(end, (region && tops.has(region) ? tops.get(region)! : 0) - Math.floor(rows / 3)))
    from = Math.max(0, Math.min(end, at + win.by))
    win.by = from - at
  } else win.by = 0
  rows = Math.min(rows, grid.h - from)
  pageCut = grid.h > rows0
  // the press each part's first row in the window holds, where the ring stands on it
  const buttons = new Map<string, string>()
  let first: string | null = null
  for (const [id, y] of [...tops].sort((a, b) => a[1] - b[1])) {
    if (y < from || y >= from + rows) continue
    buttons.set(id, `r|side|${y}|${id}`)
    first = first ?? `r|side|${y}|${id}`
  }
  paneDrawn = { name: view.pane, args: view.args, selected: region, buttons, first, order: [...tops].sort((a, b) => a[1] - b[1]).map(([id]) => id) }
  const onPress = (id: string, dir?: number) => { void paneFire($, view.pane, view.args, { type: 'press', region: id, ...(dir ? { dir } : {}) }) }
  const kids: Any[] = [paintRegions(grid, els, { theme, selected: region, key: 'side', from, rows, onPress, painted: true })]
  kids.push(...convEls(els, conv, T))
  if (subject) kids.push(...entryEls($, els, subject.label, C))
  // the ring follows the selection, as on a card
  const want = selectedGutter()
  const sig = [...buttons].map(([id, k]) => `${id}:${k}`).join(',')
  if (sig !== drawnSig) { drawnSig = sig; if (!isAsk(ringAt)) ringAt = null }
  if (e.props.isFocused && !paneFocused && !isAsk(ringAt)) ringAt = null
  paneFocused = !!e.props.isFocused
  if (want && e.props.isFocused && !isAsk(ringAt) && ringAt !== want && !refocus) {
    refocus = true
    $.clock.after(0, () => { void focusPart($).finally(() => { refocus = false }) })
  }
  return Box({ flexDirection: 'column', width: C, children: kids })
}

/** A question typed in the input bar: the thread of what the panel shows is asked about the part selected, and the
 *  ring goes back to the thing. */
async function askHere($: Engine, text: string): Promise<void> {
  if (!String(text || '').trim()) return
  const problem = await askSide($, text)
  if (problem) { $.ui.toast(`× ${problem}`); return }
  // the line empties: a field drawn afresh, so no word of the question stays in it
  draft = ''
  askGen++
  ringAt = null
  landed = null
  moveGen++
  convBy = 0
  $.ui.invalidate('ui.render')
  regrab($)
}

/** Where a part's body starts: its biggest rect (a citation of it in the takeaway is a rect of it too, a small one). */
function bodyTop(part: Any): { x: number; y: number } | null {
  if (!part || !part.rects?.length) return null
  return part.rects.reduce((a: Any, q: Any) => (q.w * q.h > a.w * a.h ? q : a), part.rects[0])
}

/** The panel's own keys, as the bar says them: t the thread list (while there is a thread and the list is not shown),
 *  m the thread's last answer to main (once it has one). A key the program shown takes is its own, as at a key
 *  (detailKey asks the program first), so the bar never names one key twice. */
async function hostKeyWords($: Engine, view: SideView | null, subject: { key: string } | null, taken: Set<string>): Promise<string[]> {
  const out: string[] = []
  if (!taken.has('t') && threadCount() > 0 && !(view?.kind === 'pane' && view.pane === 'threads')) out.push('t threads')
  const t = subject ? threadOf(subject.key) : null
  if (!taken.has('m') && t && t.turns.some(x => x.role === 'claude' && x.text)) out.push('m send to main')
  return out
}

/** The keys these drawings' programs take (k.on), by name. */
function keysTaken(...drawings: Any[]): Set<string> {
  return new Set(drawings.flatMap(d => (Array.isArray(d?.on) ? d.on : []).map((h: Any) => String(h?.name || ''))))
}

/** The panel's keys as the bar says them while it is open (shell.tsx): the card's own keys, then the detail's or the
 *  pane's, then the panel's own, and what typing does. */
export async function detailKeys($: Engine): Promise<string | null> {
  if (!isOpen) return null
  await $.state.get(ASKLINE)
  const view = await sideNow($)
  if (view?.kind === 'pane') {
    const subject = paneSubject(view)
    const it = view.pane === 'mark' ? 'the citation' : view.pane === 'threads' ? 'the list' : 'the panel'
    if (draft) return subject ? `↵ ask about ${cut(subject.label, 40)} · esc back to ${it}` : 'esc back'
    const d = await paneNow($, view.pane, view.args)
    const parts = barText([d]).split(' · ').filter(Boolean).filter(x => !/^esc\b/.test(x))
    parts.push(...(await hostKeyWords($, view, subject, keysTaken(d))))
    if (subject) parts.push(`type to ask about ${cut(subject.label, 40)}`)
    parts.push(`esc ${await backWord($)}`)
    return parts.join(' · ')
  }
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!sel || sel.cite || sel.cites) return 'esc back'
  // typing a question in the input bar: its own keys
  if (draft) return `↵ ask${sel.ask ? ` about ${cut(String(sel.ask.label), 40)}` : ''} · esc back to the card`
  // the program run now (it follows the card's drawing and the detail's state as they change)
  const d = await paneNow($, 'detail', { id: sel.id })
  // the card's keys that reach it here (Claude Code keeps ← and →, so the bar never names them), then the detail's
  const taken = hostKeys('detail', 'terminal')
  // (before the pane has drawn the card, the card as it draws now: the line draws again once it has)
  const card = drawn?.card ?? (await shownCard($, sel, room.w, room.h))?.drawing ?? null
  const cardOn = { on: (card?.on || []).filter((h: Any) => !(String(h?.name) in taken)), controls: card?.controls || [] }
  const keys = barText([cardOn, d])
  // what typing does, in plain words: a question about the selected part (or the card)
  const part = drawn?.selected ? drawn.parts.find((x: Any) => x.id === drawn!.selected) : null
  const about = sel.ask ? String(sel.ask.label) : part ? String(part.label || part.id) : 'this card'
  const ask = `type to ask about ${cut(about, 40)}`
  const parts = keys.split(' · ').filter(Boolean)
  const esc = parts.findIndex(x => x.startsWith('esc '))
  const own = await hostKeyWords($, view, threadFor({ object: sel.id }), keysTaken(cardOn, d))
  if (esc >= 0) parts.splice(esc, 0, ...own, ask)
  else parts.push(...own, ask)
  return parts.join(' · ')
}

/** What esc does last: back to what the panel showed before, or close it. */
async function backWord($: Engine): Promise<string> {
  return (await sideDepth($)) ? 'back' : 'close'
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

/** What a key pressed in the prompt comes to while the side panel is open (keys.ts; shell.tsx's one prompt.edit hook
 *  asks it first): on a card its own keys (its program's k.on), then the detail's program's; in a pane its program's;
 *  then the panel's own (t, m). A letter that is no key starts a question in the input bar (it never types into the
 *  prompt), and a letter typed straight after a key that acted gives the key's letter back there (it began a word).
 *  Letters that arrive before the input bar has the keys join the question. It types while the panel is closed. */
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
  const view = await sideNow($)
  const pane = view?.kind === 'pane' ? view : null
  const sel = (await $.state.get(SEL)).value as Detail | null
  if (!pane && (!sel || sel.cite || sel.cites)) return { box: null }
  // a question already begun: the letter joins it (⌫ takes its last letter back, while the input bar has no keys)
  if (isAsk(ringAt) || (draft && typed) || leftover) {
    if (k === 'backspace' && !typed) return { box: none, work: () => toAsk($, draft.slice(0, -1)) }
    // ↵ before the ring reached the field (the letters came through the prompt): the question is asked as it stands
    if ((k === 'return' || k === 'enter') && !typed) return { box: none, work: () => { moveGen++; void askHere($, draft) } }
    return { box: none, work: () => toAsk($, draft + typed) }
  }
  // a letter typed while a key of the panel's own waits (t, m): that key began a question, and it does nothing
  const held = pendingHost
  if (held && !held.cancelled && now - held.at < WORD_MS && /^[\p{L}' ]$/u.test(typed)) {
    held.cancelled = true
    pendingHost = null
    return { box: none, work: () => { lastKey = null; toAsk($, `${held.key}${typed}`) } }
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
        if (back.pane) { if (back.undo) await setPaneState($, back.pane.pane, back.pane.args, back.undo, 'terminal'); return }
        if (!sel) return
        if (back.undo) { await setPaneState($, 'detail', { id: sel.id }, back.undo, 'terminal'); await mirror($) }
        // the version the key showed (h on "how…"): the card as it was, with its part, so the question is about it
        if (back.sel) {
          const now = ((await $.state.get(SEL)).value as Detail | null)
          if (now && !now.cite && !now.cites && now.id === back.sel.id && now.root === back.sel.root && now.v !== back.sel.v) {
            await selectSoon($, { ...now, v: back.sel.v, ex: back.sel.ex, all: back.sel.all, region: back.sel.region })
          }
        }
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
  if (!pane && sel) {
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
  }
  // the program's keys: the detail's, or the pane's. esc, ↑ and the like never reach here: Claude Code keeps them (the
  // panel's close and ring do them)
  const ev = { type: 'key', key: k === 'enter' ? 'return' : k }
  const prog = pane ? { name: pane.pane, args: pane.args } : { name: 'detail', args: { id: sel!.id } as Record<string, unknown> }
  if (await paneTakes($, prog.name, prog.args, ev)) {
    return { box: none, work: async () => {
      const before = { ...(await paneState($, prog.name, prog.args)) }
      const took = pane ? await paneFire($, pane.pane, pane.args, ev) : await detailFire($, ev)
      const letter = /^[a-z]$/.test(k)
      lastKey = took ? { key: k, at: now, undo: letter ? before : null, ...(pane ? { pane } : {}), ...(letter && !pane && sel ? { sel } : {}) } : null
      regrab($)
    } }
  }
  // the panel's own keys, each acting once WORD_MS has passed with no letter after it: t the thread list, m the
  // thread's last answer to main
  if (k === 't' && threadCount() > 0 && pane?.pane !== 'threads') return hostKey($, 't', now, async () => { await openThreads($, { push: true }) })
  if (k === 'm') {
    const key = pane ? paneSubject(pane)?.key ?? null : threadFor({ object: sel!.id })?.key ?? null
    const t = key ? threadOf(key) : null
    if (t && t.turns.some(x => x.role === 'claude' && x.text)) return hostKey($, 'm', now, async () => { $.ui.toast(await sendToMain($, t.key)) })
  }
  // a letter (or a paste) that is no key begins a question in the input bar
  if (typed.trim()) return { box: none, work: () => { lastKey = null; toAsk($, typed) } }
  return { box: null, work: () => { lastKey = null } }
}

/** A key of the panel's own: taken now, acting once WORD_MS has passed with no letter typed after it (a letter makes
 *  it the start of a question instead). */
function hostKey($: Engine, key: string, now: number, run: () => Promise<void>): KeyTurn {
  return { box: { text: '', cursor: 0 }, work: () => {
    lastKey = null
    const p = { key, at: now, cancelled: false }
    pendingHost = p
    $.clock.after(WORD_MS, () => {
      if (p.cancelled || pendingHost !== p) return
      pendingHost = null
      void run().catch(() => undefined)
    })
  } }
}

/** A key typed while the side panel is open, as it landed: a prompt emptied gives the keys back to the card or pane. */
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
      // a pane in the panel: the ring on one of its parts is the program's focus event (the part is selected); the
      // input bar keeps the ring while a question is typed, as on a card
      if (showing === 'pane') {
        if (!paneDrawn) return next(e)
        if (!person && isAsk(ringAt) && (el.startsWith('r|side|') || (isAsk(el) && el !== askKey()))) {
          const r = await next({ ...e, element: askKey() })
          if (!r.deny) landed = askKey()
          return r
        }
        if (!person && isAsk(el) && !isAsk(ringAt) && !draft) {
          const to = selectedGutter()
          if (to) {
            const r = await next({ ...e, element: to })
            if (!r.deny) { ringAt = to; ringY = Number(to.split('|')[2]) }
            return r
          }
        }
        const part = el.startsWith('r|side|') ? regionOfKey(el) : null
        if (person && part) {
          // a part of several rows is one stop of the ring: a move onto another of its rows goes on to the next part
          // that way, and the ring stands on the first row of the part it selects
          const y = Number(el.split('|')[2])
          let to = part
          if (part === paneDrawn.selected && !!ringAt && ringAt.startsWith('r|side|') && y !== ringY) {
            const i = paneDrawn.order.indexOf(part)
            to = paneDrawn.order[i + (y > ringY ? 1 : -1)] ?? part
          }
          if (to !== paneDrawn.selected) await paneFire($, paneDrawn.name, paneDrawn.args, { type: 'focus', region: to })
          const key = paneDrawn.buttons.get(to)
          landed = null
          if (key) {
            const r = await next({ ...e, element: key })
            if (!r.deny) { ringAt = key; ringY = Number(key.split('|')[2]) }
            return r
          }
          // not drawn (out of the window): the window goes back to it, and the drawing that brings it puts the ring there
          ringAt = null
          win.by = 0
          $.ui.invalidate('ui.render')
          return {}
        }
        const was = isAsk(ringAt)
        const r = await next(e)
        if (!r.deny) { ringAt = el || null; landed = el === askKey() ? el : null; if (el.startsWith('r|')) ringY = Number(el.split('|')[2]) }
        if (isAsk(ringAt) !== was) askRedraw($)
        return r
      }
      if (!person || !drawn) {
        // while a question is being typed, a drawing from before it (its autoFocus on the card) never takes the ring
        // from the input bar
        // nor does a field drawn before the one the question is in now (a busy terminal hands the ring to the drawing it
        // has): the ring goes to the field drawn last, and the letters typed there are kept
        if (!person && isAsk(ringAt) && (el.startsWith('g|') || (isAsk(el) && el !== askKey()))) {
          const r = await next({ ...e, element: askKey() })
          if (!r.deny) landed = askKey()
          return r
        }
        // and with no question begun (esc let one go), a drawing from before (its autoFocus still on the input bar) never
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
      // the input bar, a version or the close mark, reached any other way: the ring goes there and the selection stays
      if (!g && !part && !wrap) { const was = isAsk(ringAt); const r = await next(e); if (!r.deny) { ringAt = el || null; landed = el === askKey() ? el : null } if (isAsk(ringAt) !== was) askRedraw($); return r }
      const y = g || m ? Number((g ?? m)![1]) : ringY
      const cur = drawn.selected ?? sel.region ?? null
      const dir = wrap || (ringY < 0 ? 1 : y < ringY ? -1 : 1)
      const step = () => { const i = cur ? ids.indexOf(cur) : -1; return ids.length ? ids[i < 0 ? 0 : (i + dir + ids.length) % ids.length]! : null }
      let id: string | null
      // back from the input bar: the selected part
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

  // the wheel over the panel (or its scroll keys) moves the page's window, or the conversation's while the input bar
  // holds the keys: the panel draws its own rows of each, so the engine has none to move
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if ((e.origin as { kind?: string }).kind !== 'person' || (showing === 'pane' ? !paneDrawn : !drawn) || !isOpen) return next(e)
    if (isAsk(ringAt) || draft || !pageCut) convBy -= Number(e.by) || 0
    else win.by += Number(e.by) || 0
    $.ui.invalidate('ui.render')
    return {}
  }).catch(($, e, next) => next(e))

  // esc in the input bar empties it and gives the keys back to the card or pane (with nothing typed in it, esc goes on);
  // then esc closes what its program opened
  // (the detail's bar and program, a citation's section), then goes back to what the panel showed before, then closes
  // the panel
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const person = (e.origin as { kind?: string }).kind === 'person'
    if (person) keysMoved(await $.clock.now())
    // (the input bar holding the keys with nothing typed in it: esc goes on, as if the card or pane had them)
    if (person && isOpen && isAsk(ringAt) && !draft) { askGen++; ringAt = null; landed = null; moveGen++ }
    if (person && isOpen && draft) {
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
    const view = await sideNow($)
    const sel = (await $.state.get(SEL)).value as Detail | null
    if (person && isOpen && view?.kind === 'pane' && (await paneTakes($, view.pane, view.args, { type: 'key', key: 'esc' }))) {
      await paneFire($, view.pane, view.args, { type: 'key', key: 'esc' })
      regrab($)
      return { value: undefined } as Any
    }
    if (view?.kind !== 'pane' && sel && !sel.cite && !sel.cites && (sel.prog || sel.bar) && person) {
      await detailFire($, { type: 'key', key: 'esc' })
      // a refused close gives the keys back to the prompt: the pane takes them again, so the next esc reaches it
      regrab($)
      return { value: undefined } as Any
    }
    // back to what the panel showed before (a citation opened from an answer goes back to the card)
    if (person && isOpen && (await sideBack($))) {
      regrab($)
      return { value: undefined } as Any
    }
    await closed($)
    return next(e)
  })

  // a prompt typed in the composer while the panel is open (rare: letters normally go to the input bar) asks the
  // panel's thread too. It never reaches main: Claude Code shows it as dropped, with where it went.
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    if (!isOpen || e.command || e.isMeta || !String(e.text || '').trim()) return next(e)
    // the pane may have gone without its close reaching this module (a re-render marked it open again): a prompt goes
    // to the panel's thread only while the pane is really there, else to Claude as always
    if (!(await paneShown($))) { await closed($); return next(e) }
    const view = await sideNow($)
    const sel = (await $.state.get(SEL)).value as Sel | null
    if (view?.kind !== 'pane' && (!sel || sel.cite || sel.cites)) return next(e)
    // ↵ on a question typed through the prompt (its letters came before the ring reached the input bar): the prompt may
    // still show a few of its letters, the answers to their keys not applied yet; the question is the one typed, whole
    if (draft.trim() && takenTail(draft, String(e.text))) {
      const q = draft
      moveGen++
      await askHere($, q)
      $.clock.after(30, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
      return { drop: `asked the ${lastWhose} thread about ${cut(lastAbout, 40)}` }
    }
    const asked = await askSide($, e.text)
    if (asked === NO_CARD) return next(e)
    if (asked) return { drop: `${asked}. Your words are back in the prompt; esc closes the panel, and the prompt then goes to Claude here.` }
    $.clock.after(30, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
    return { drop: `asked the ${lastWhose} thread about ${cut(lastAbout, 40)}` }
  }).catch(($, e, next) => next(e))
}

const NO_CARD = 'no card'
let lastAbout = ''
// whose thread was asked last, in the words of the row Claude Code shows for a dropped prompt: `the card's thread`
let lastWhose = "card's"

/** Ask the thread of what the panel shows: a pane's (its subject, side.ts), else the card's. Null when asked, else the
 *  problem in a few words (NO_CARD: nothing to ask). */
async function askSide($: Engine, text: string): Promise<string | null> {
  const view = await sideNow($)
  if (view?.kind !== 'pane') { lastWhose = "card's"; return askCard($, text) }
  const subject: Subject | null = paneSubject(view)
  if (!subject) return NO_CARD
  const root = subject.root ?? (await paneWhereRoot($))
  const r = await askThread($, { text, scope: subject.scope, refs: subject.refs, root, anchor: subject.anchor, ...(subject.about ? { about: subject.about } : {}), ...(subject.card ? { card: subject.card } : {}) })
  lastAbout = aboutOf(subject.scope)
  lastWhose = view.pane === 'mark' ? 'citation\'s' : view.pane === 'threads' ? 'selected' : `${view.pane}'s`
  return r.problem ?? null
}

/** The folder the session's data is in (where a pane's thread keeps its file). */
async function paneWhereRoot($: Engine): Promise<string> {
  return (await paneWhere($)).root || String(await $.session.cwd())
}

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
  const r = await askThread($, { text, scope, refs, root: sel.root, card: { id: o.id, v: o.version, title: o.title, file: `${sel.root}/thimble/objects/${o.id}.json` }, anchor: { kind: 'card', id: sel.id, v: null, root: sel.root, region: region ?? null } })
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

/** Whether the side panel is open (for the shell and the tests). */
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
  paneDrawn = null
  showing = 'card'
  convBy = 0
  pendingHost = null
  lastKey = null
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
