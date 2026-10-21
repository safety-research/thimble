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
//              a card's detail: a header (the title, the card's id, "edited"), the takeaway, the card enlarged with its
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
//   keys       the panel takes the keyboard when it opens (a pane opened with focus) and keeps it until it closes, the
//              same way whatever it shows (holdKeys: a request Claude Code refuses is made again). A card's detail
//              opens on its input bar, so every character typed is the question's (a `?` too, which an empty prompt
//              takes for Claude Code's shortcuts); ↑ goes up from it to the parts, ↑ ↓ and tab walk them, ↵ presses
//              the one the ring is on, and esc empties the question, then goes back. Every part is a press too,
//              so the panel works with clicks alone, and it names no keys: the way back is a press at its top
//              (`‹ labels`, doing what esc does), and what the thread offers (a card's rows, its code) is a row of
//              presses above the input bar. A letter starts a question in the input bar; a card's own keys (its
//              program's k.on) come first, and a key that began a word gives its letter back to the input bar. One
//              selection, one highlight: on a card the ring stands in the gutter on the selected part's first row (a
//              ▸), and the part is shaded; a move of the ring is the program's focus event, and after each drawing the
//              ring is put back on the selected part. `esc` empties the input bar, then closes what the program opened,
//              then goes back to what the panel showed before (a citation opened from an answer goes back to the
//              card), then closes the panel. The thread list opens from the prompt (t, the bar), never from here
//   window     a page taller than its rows shows the rows around the selected part; once the person opens the bar
//              under the card (↵ details, e examples, a flip) it shows the bar, and the wheel moves it from there.
//              While the input bar holds the keys the wheel scrolls the thread's conversation instead
// A card reached with ] names `a ask`, which opens its detail here; 1 on an empty prompt opens the latest card's detail.
import type { EngineInterface, Register } from 'claude-code'

import type { Sel } from '../types'
import { renderTerm } from '../draw/term.js'
import { actionsOf, backOf, belowAt, hostKeys, takes, turnWords } from '../panes/host.js'
import { paintRegions, regionOfKey } from './cells'
import { quiet } from '../draw/hover.js'
import { askMerge, beganWord, editsOf, examplesView, PAGES_DEFAULT, partsOf } from './carddetail.js'
import { allKnob, ownPart, pageAt, pageId, pageKnob, pageOf } from '../draw/handoff.js'
import { chainWords, objectRefs, regionMeta, regionRefs } from './object.js'
import { barPreviewEl, citeLabels, currentTheme, escTop, healOfText, keysMoved, loadObject, openDetail, panelClosed, paneWhere, popFocus, prepared, preparedNow, pushFocus, select } from './shell'
import { askThread, noteSelection, restoreThreads, setThreadWindow, threadFor, threadOf } from './thread'
import { cardEvent, cardKey, ownState, pressTaken, readCardState, readEdits, writeCardState } from './runtime'
import type { CardAsk } from './runtime'
import { type KeyEdit, type KeyTurn } from './keys'
import { paneFire, paneOf, paneRun, paneState, paneTakes, patchPaneState, setPaneState } from './panes'
import type { Scope } from './thread'
import { aboutOf, nameOf } from './threads.js'
import { check as checkLabel, checksDone, labelGen } from './labels'
import { conversation, entry, ENTRY_ROWS, fitItems, type Item } from './conversation'
import { openMark, paneSubject, sideBack, sideClosed, sideDepth, sideNow, sidePrev, sideTitle, type Subject } from './side'
import { openLabel } from './dock'
import { failNotice } from './fix'
import { cardLabels } from './labeluse'
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

// the module's memory of the detail: whether it is open, what it drew last (for the ring and the keys), the key that
// acted last (for a word it began), the agent in the main view, and the latest version seen of each card
let isOpen = false
let drawn: { id: string; parts: Any[]; from: number; rows: number; pixel: Set<number>; w: number; h: number; on?: Any[]; card: Any; gutter: Map<number, string[]>; selected: string | null; below: number } | null = null
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
const latestSeen = new Map<string, number>()
// a pane the panel shows (not a card): what it drew last, for the ring (the button of each part) and the keys
// `walks`: the program walks its parts with ↑↓ (ringStart 'part' and its own up and down); `at`: where each press of
// the page stands, `row|id` -> [row, column], to tell which way the ring moved. (← and → are never the pane's: Claude
// Code gives them to the prompt while a pane holds the keys, see detailKeys)
let paneDrawn: { name: string; args: Record<string, unknown>; selected: string | null; buttons: Map<string, string>; first: string | null; order: string[]; below: number; walks: boolean; at: Map<string, [number, number]>; gutter: Map<number, string[]> } | null = null
// what the panel draws now, as its latest drawing began (a card's drawing still under way when the panel turned to a
// pane must not take the ring from the pane's parts)
let showing: 'card' | 'pane' = 'card'
// a step of a pane's walk waits this long for the press a click brings with its move of the ring (which cancels it)
const WALK_MS = 40
// the ring is put on the selected part once more this long after a drawing changed the presses before it
const REFOCUS_MS = 80
let walkGen = 0
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
// the part a pane's last drawing selected: a drawing that selects another puts the ring on it again, even where the
// ring was last put there, since a drawing that adds or drops presses can leave Claude Code's ring on the part it left
let drawnPart: string | null = null
// the presses drawn before the input bar's field, in order, as the last drawing had them (pressesBefore)
let drawnAbove = ''
// the presses a pane's last drawing put before the selected part's press: when they change, Claude Code may keep the
// ring at its place in the order, on another press, so the ring is put on the part again
let drawnBefore = ''
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

/** The columns a docked pane of ours asks for, leaving the chat its share (a narrow strip, for a pane that wants the
 *  room). */
export function paneColumns(): number {
  return dockColumns()
}

/** The chat's columns beside the docked detail: about two fifths of the terminal, 48 to 80, so its lines read. */
export function chatColumns(cols: number): number {
  return Math.max(48, Math.min(80, Math.round(cols * 0.4)))
}

/** The columns the detail asks for: the terminal less the chat's share (a card needs 60 at least). */
export function detailColumns(cols: number): number {
  return cols > 0 ? Math.max(60, cols - chatColumns(cols)) : 96
}

/** The columns a pane that wants the room asks for (its module's `wide`, such as the Claims graph): the terminal less a
 *  narrow strip of the chat, so the pane is nearly the whole terminal wide. The strip is the least Claude Code leaves the
 *  transcript beside a docked pane (24 columns): a wider ask is cut to it. */
export function wideColumns(cols: number): number {
  return cols > 0 ? Math.max(detailColumns(cols), cols - WIDE_CHAT) : 96
}
const WIDE_CHAT = 24
// whether what the panel shows wants the room (set as it opens)
let wideDock = false
const dockColumns = () => (wideDock ? wideColumns(viewCols) : detailColumns(viewCols))

/** Whether a pane wants nearly the whole terminal (its module's `wide`). */
function wantsRoom(v: SideView | null): boolean {
  if (!v || v.kind !== 'pane') return false
  try {
    const w = paneOf(v.pane).wide
    return typeof w === 'function' ? !!w(v.args || {}) : !!w
  } catch {
    return false
  }
}

const GUTTER = (y: number) => `g|pane|${y}`
// a pane's gutter cell in the side panel, where the ring stands on the part whose first row it is
const SIDE_GUTTER = (y: number) => `g|side|${y}`
/** A gutter cell: on the selected part's first row a cell of the ring's color, the same with the ring on it or not
 *  (Claude Code draws the ring inverse, and a cell of one color reads the same inverse), else a blank. */
function gutterMark(Text: Any, color: string, on: boolean): Any {
  return on ? Text({ color, backgroundColor: color, children: '▸' }) : Text({ children: ' ' })
}

/** The part a pane's gutter cell stands for: the selected one where it is on that row, else the row's first. */
function gutterPart(key: string): string | null {
  const m = /^g\|side\|(\d+)$/.exec(key)
  const ids = m && paneDrawn ? paneDrawn.gutter.get(Number(m[1])) : null
  if (!ids || !ids.length) return null
  return ids.includes(paneDrawn!.selected ?? '') ? paneDrawn!.selected! : ids[0]!
}
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
// never drawn afresh, since the letters typed into it meanwhile would be lost with it. The ring can leave the field
// again without a move of ours (keys typed at once go to the prompt, and take the keys there): `landed` is only what
// the last move said, so a letter that comes through the prompt asks the panel whether it still holds the keys
let moveGen = 0
let moving = false
let landed: string | null = null
// what each field showed when it was last drawn without the ring: what it reports counts from that
const fields = new Map<string, { seen: string }>()
// the latest request for the keys (focusEntry): only its later checks run
let keysAsked = 0
// a question on its way to its thread (askHere)
let sending = false
let askDrawn = 0
function askRedraw($: Engine): void {
  void $.state.set(ASKLINE, ++askDrawn).catch(() => undefined)
}

// ------------------------------------------------------------------------------------------------ opening

/** Open the side panel on what side.ts says it shows: the pane docked beside the transcript, leaving the chat its
 *  share, holding the keys while the input bar is empty. False when the terminal had no room for it. `keys: false`
 *  leaves the keys with the prompt until giveKeys (a key's pane shown while the key may still begin a word: esc at the
 *  idle, empty prompt still closes it). */
export async function openDock($: Engine, title: string, o: { keys?: boolean } = {}): Promise<boolean> {
  const was = isOpen
  isOpen = true
  setThreadWindow(true)
  await pushFocus($, 'detail')
  // something else in the panel: its conversation starts at its end, and a question begun about what it showed goes
  if (was) {
    convBy = 0; win.by = 0; win.follow = 'part'
    // (a field drawn afresh, so no word of it stays)
    if (draft) { draft = ''; askGen++; landed = null }
    if (!isAsk(ringAt)) ringAt = null
  }
  wideDock = wantsRoom(await sideNow($))
  const r = await $.ui.open({ id: PANE, title, ...(o.keys === false ? {} : { focus: true as const }), closeOnEscape: true, columns: dockColumns() }).catch((err: unknown) => ({ isPlaced: false, reason: String((err as Error)?.message || err).slice(0, 160) }))
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
  // the input bar takes the keys: every character typed reaches it (a `?` too, which an empty prompt would take for
  // its shortcuts), ↑ goes up to the parts and esc goes back. Asked from a key, the open lands while the key is still
  // in the prompt: the keys are asked for again once it is gone
  if (o.keys !== false) void takeKeys($)
  return true
}

/** The panel opened with `keys: false` takes the keys now, as an open does. */
export async function giveKeys($: Engine): Promise<void> {
  if (isOpen) await takeKeys($)
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

/** The panel takes the keys: on its input bar, or on the part selected when what it shows has no thread (the thread
 *  list). */
async function takeKeys($: Engine): Promise<void> {
  const v = await sideNow($)
  if (v?.kind === 'pane' && (!paneSubject(v) || ringOnPart(v))) {
    // (a question begun about what the panel showed before is gone with it: the ring is the part's)
    if (isAsk(ringAt) && !draft) { ringAt = null; landed = null }
    regrab($)
  } else focusEntry($)
}

/** Which way the person moved the ring in a pane, from the press `from` to `to`: 1 on (lower, or further right on the
 *  row), -1 back. A press under the page (the actions, the input bar) is after every part; one of Claude Code's own
 *  stops (the close mark, top right) before them. With the ring on no press (`from` null: a drawing took its element
 *  away), Claude Code's arrows and Tab take the first press, a step on; any other press is measured from the part
 *  selected (`selected`), where the ring is going. */
export function walkDir(drawn: { first: string | null; below: number; at: Map<string, [number, number]>; selected?: string | null; gutter?: Map<number, string[]> }, from: string | null, to: string, selected: string | null = null): number {
  // (from nowhere onto the first part: its gutter cell, or a press on that row)
  const rowOf = (k: string | null) => (k ? Number(k.split('|')[2]) : NaN)
  if (!from && (to === drawn.first || rowOf(to) === rowOf(drawn.first))) return 1
  from = from || selected
  if (!from) return 1
  const where = (key: string): [number, number] => {
    if (!key) return [-1, 0]
    // a gutter cell stands where its part is: the selected one on its row, else the row's first
    const g = /^g\|[^|]+\|(\d+)$/.exec(key)
    if (g) {
      const ids = drawn.gutter?.get(Number(g[1])) ?? []
      const id = ids.includes(drawn.selected ?? '') ? drawn.selected! : ids[0]
      return (id && drawn.at.get(`${g[1]}|${id}`)) || [Number(g[1]), -1]
    }
    const m = /^r\|[^|]+\|(\d+)\|(.+?)(?:\|#\d+)?$/.exec(key)
    if (!m || Number(m[1]) >= drawn.below) return [Infinity, 0]
    return drawn.at.get(`${m[1]}|${m[2]}`) ?? [Number(m[1]), 0]
  }
  const a = where(from), b = where(to)
  return b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? 1 : -1
}

/** Whether the pane's ring starts on the part its program selected, rather than on the input bar (its module's
 *  `ringStart`): a pane whose parts the person walks first, such as the Claims graph, where the first ↑ or ↓ moves on
 *  from the selected dot. A letter typed there still starts a question in the input bar. */
function ringOnPart(view: PaneView): boolean {
  try {
    const r = paneOf(view.pane).ringStart
    return (typeof r === 'function' ? r(view.args || {}) : r) === 'part'
  } catch {
    return false
  }
}

/** The input bar takes the keys now, holding what is typed in it so far (a thread opened to be asked, a question typed
 *  through the prompt). */
export function focusEntry($: Engine): void {
  holdKeys($, 'ask')
}

// when the panel asks for the keys again after a request, while it does not have them (holdKeys): soon, so an arrow
// typed straight after the key that opened a pane reaches the pane, later again for a click that holds the keys, and
// then each second until it has them (a terminal busy drawing a large pane answers the opening key late)
const KEYS_AGAIN_MS = [60, 250, 900, 1600]
const KEYS_EVERY_MS = 1000

/** The panel takes the keys, whatever it shows (a card, any pane): on its input bar (`ask`, holding what is typed so
 *  far), or on the part selected (`part`). Claude Code gives a pane the keys only while the prompt holds them over an
 *  empty composer. So a request made while a key is still in the prompt (the key that opened the panel, a key of the
 *  program's that came through the prompt), or while a click holds the keys, is refused, and every key after it goes
 *  to the prompt: → takes the prompt's suggestion, ↑ its history, ↵ and esc act there. Each request is therefore made
 *  again a little later, while the panel is open and does not have the keys. The latest request wins, and a question
 *  begun meanwhile keeps the keys in the input bar. */
function holdKeys($: Engine, to: 'ask' | 'part'): void {
  const mine = ++keysAsked
  const gen = moveGen
  if (to === 'ask') toAsk($, draft)
  else grabPart($)
  const again = (more: boolean) => { void (async () => {
    if (!isOpen || mine !== keysAsked) return
    let held: boolean
    if (to === 'ask') {
      if (!isAsk(ringAt) || gen !== moveGen) return
      if (!(await panelHasKeys($))) landed = null
      held = landed === askKey()
      if (!held) moveSoon($)
    } else {
      if (isAsk(ringAt) || draft) return
      held = await panelHasKeys($)
      if (!held) grabPart($)
    }
    if (more && !held) $.clock.after(KEYS_EVERY_MS, () => again(true))
  })().catch(() => undefined) }
  KEYS_AGAIN_MS.forEach((ms, i) => $.clock.after(ms, () => again(i === KEYS_AGAIN_MS.length - 1)))
}

/** Whether the panel holds the keys, as Claude Code says now (when it cannot say, as the module last knew). */
async function panelHasKeys($: Engine): Promise<boolean> {
  const here = (await $.ui.panes().catch(() => [] as Any[])).find((x: Any) => x.id === PANE)
  return !(here && here.isFocused === false)
}

/** Letters of the question that came through the prompt: the input bar did not have the keys when they were typed. Keys
 *  typed at once go to the prompt even after the ring landed on the input bar, and the keys stay there. Unless the
 *  panel holds them again, the field has lost the ring: one drawn afresh holds the whole question, and the input bar
 *  asks for the keys, now and a little later, so the ↵ that follows reaches it (Claude Code keeps ↵ at an empty
 *  prompt, so a ↵ typed there is lost). */
async function typedInPrompt($: Engine, text: string): Promise<void> {
  if (landed && !(await panelHasKeys($))) landed = null
  draft = text
  focusEntry($)
}

async function closed($: Engine, keep = false): Promise<void> {
  isOpen = false
  panelClosed()
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
  drawnAbove = ''
  moveGen++
  // what the panel showed, and the way back through it, end with it (kept when it could not be placed: /threads opens it).
  // First, so a drawing of the panel while it closes finds it showing nothing (noticeOpen)
  if (!keep) await sideClosed($)
  await popFocus($, 'detail')
  // the labels the person checked are counted again, their cards drawn again, and Claude hears of the checks
  $.clock.after(0, () => { void checksDone($).catch(() => undefined) })
}

/** The keys back to the card or pane, on the part selected (holdKeys). */
function regrab($: Engine): void {
  holdKeys($, 'part')
}

/** The pane takes the keyboard (granted only over an empty composer), the ring on the part. A question begun since it
 *  was asked keeps the keys: the person is typing in the input bar. */
function grabPart($: Engine): void {
  $.clock.after(0, () => {
    void (async () => {
      if (!isOpen || isAsk(ringAt)) return
      await $.ui.open({ id: PANE, focus: true, closeOnEscape: true, columns: dockColumns() }).catch(() => undefined)
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
  // (a selected part out of the window has no press now: none, rather than another part)
  if (showing === 'pane') return !paneDrawn ? null : paneDrawn.selected ? paneDrawn.buttons.get(paneDrawn.selected) ?? null : paneDrawn.first
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
        await $.ui.open({ id: PANE, focus: true, closeOnEscape: true, columns: dockColumns() }).catch(() => undefined)
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
  // the card as first made and after each change the analyst asked for, which Earlier version steps back through; never the versions
  // saved for any other reason (runtime.ts readEdits)
  const v = sel.v ?? latest?.version ?? null
  return {
    object, drawing: p ? (p.error ? { error: { name: 'Error', message: p.error } } : p.drawing) : null,
    versions: editsOf(latest, await readEdits($, sel.root, sel.id)), v, state: ownState(sel.state), labelGen: await labelGen($),
    // the labels its data came through, named in its subject (labeluse.ts)
    labels: (await cardLabels($, sel.id, object?.version ?? v, sel.root, p && !p.error ? p.grid : null)) ?? [],
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
    // a record of the selected part's rows, as a citation over the card
    case 'open':
      if (a.mark && typeof a.mark === 'object') await openMark($, a.mark as Any, { push: true })
      return
    // a label the card rests on, in the panel (with a value: its records)
    case 'label':
      if (typeof a.name === 'string') await openLabel($, a.name, typeof a.value === 'string' ? a.value : null)
      return
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
    failNotice($, `× The card could not answer ${event.type === 'key' ? `the key ${event.key}` : 'that'}: ${got?.drawing?.error ? `${got.drawing.error.name} · fix: ${got.drawing.error.fix || 'its program'}` : 'its program did not run'}`)
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
    if (r.problem) failNotice($, `× ${r.problem}`)
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

  // the rows: the input bar at the bottom, the card's actions above it and what one opened above them (its rows, its
  // code), the thread's conversation above that (two fifths of the panel, three fifths while a question is typed), the
  // page in the rest
  const conv = await convOf($, els, thread, nameOf({ scope: { object: sel.id }, card: latest?.title || sel.id }), C - 1, { id: sel.id, root: sel.root })
  // the way back at the top (what esc goes back to)
  const back = await backEls($, els, null)
  const d = await paneRun($, 'detail', { id: sel.id }, { w: C - 1, h: R })
  const grid = renderTerm(d, { w: C - 1 })
  const split = belowAt(grid)
  const belowRows = Math.min(grid.h - split, Math.max(4, Math.floor(R * 0.45)))
  const T = Math.min(convRows(conv, R), Math.max(0, R - ENTRY_ROWS - 2 - back.length - belowRows - (belowRows ? 1 : 0) - 6))
  const pageRows = Math.max(6, R - ENTRY_ROWS - 2 - T - back.length - belowRows - (belowRows ? 1 : 0))
  room = { w: C - 3, h: Math.max(10, pageRows - 8) }
  const card = (await shownCard($, sel, room.w, room.h)) ?? (lastCard && lastCard.key === `${sel.root}|${sel.id}|${sel.v ?? ''}` ? lastCard.p : null)
  const parts = partsOf({ ...grid, regions: grid.regions.filter((r: Any) => !/^ver-\d+$/.test(r.id) && r.id !== 'side:opened') })
  const region = typeof d.selected === 'string' ? d.selected : null
  const part = parts.find((x: Any) => x.id === region) ?? null
  // a page taller than its rows: the rows around the selected part; the wheel moves the window from there until the
  // selection changes. (What an action opened is drawn apart, above the actions)
  if (region !== win.region) { win.region = region; win.by = 0; win.follow = 'part' }
  let rows = Math.min(split, pageRows)
  let from = 0
  if (split > rows) {
    const top = bodyTop(part)
    const end = split - rows
    // a page's heading (every page at once) goes to the top, so the page reads from its start
    const lead = part && pageOf(part.id)?.id === '' ? 0 : Math.floor(rows / 3)
    const at = Math.max(0, Math.min(end, (top ? top.y : 0) - lead))
    from = Math.max(0, Math.min(end, at + win.by))
    win.by = from - at
  } else win.by = 0
  rows = Math.min(rows, split - from)
  pageCut = split > pageRows
  const pixel = new Set<number>()
  for (let y = 0; y < grid.h; y++) if (grid.rows[y].some((c: Any) => c.px) && !grid.rows[y].some((c: Any) => c.b || c.ref || c.w2)) pixel.add(y)
  // each part's first row in the window holds a gutter cell the ring can stand on (one per row, in reading order)
  const gutter = new Map<number, string[]>()
  for (const x of parts) {
    const top = bodyTop(x)
    if (!top || top.y < from || top.y >= from + rows) continue
    gutter.set(top.y, [...(gutter.get(top.y) ?? []), x.id])
  }
  drawn = { id: sel.id, parts, from, rows, pixel, w: room.w, h: room.h, on: card?.drawing?.on || [], card: card?.drawing ?? null, gutter, selected: region, below: split }
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
    const mark = gutterMark(Text, ind, !!top && top.y === y)
    if (!ids) return Text({ key: `gt${y}`, children: [mark] })
    const at = ids.includes(region ?? '') ? region! : ids[0]!
    const label = String(parts.find((x: Any) => x.id === at)?.label || at)
    // the selected part's cell takes the ring whenever the pane takes the keyboard (an open, a key that gave it back),
    // except while a question is being typed: then the input bar takes it
    return Button({ key: GUTTER(y), plain: true, label, onPress: () => onPress(at), hover: quiet(GUTTER(y), { underline: false, bold: true }), children: [mark], ...(ids.includes(region ?? '') && !isAsk(ringAt) ? { autoFocus: true } : {}) })
  })
  const kids: Any[] = [...back, Box({ flexDirection: 'row', children: [
    Box({ flexDirection: 'column', width: 1, flexShrink: 0, children: gcells }),
    // the pane's background is the theme's: its ink is the theme's text color
    paintRegions(grid, els, { theme, selected: region, key: 'pane', from, rows, onPress, painted: true }),
  ] })]
  kids.push(...convEls(els, conv, T))
  // what an action opened (the selected part's rows, the code), right above the actions and the input bar
  if (belowRows) kids.push(Text({ key: 'below-gap', children: ' ' }), Box({ key: 'below', marginLeft: 1, children: [paintRegions(openedOnly(grid), els, { theme, selected: region, key: 'pane', from: split, rows: belowRows, onPress, painted: true })] }))
  const about = sel.ask ? String(sel.ask.label) : part ? String(part.label || part.id) : 'this card'
  // what it offers above the input bar: the detail's actions, then the card's own keys with their words, each a press
  const own = ownActions(card?.drawing)
  kids.push(...entryEls($, els, about, C, !!e.props.isFocused, [...actionsOf(d), ...own], ev => {
    const k = /^key:(.+)$/.exec(ev)
    void (k ? cardAct($, { type: 'key', key: k[1], ...(sel.region ? { region: sel.region } : {}) }) : detailFire($, { type: ev })).then(() => focusEntry($))
  }))
  // the ring follows the selection: after a drawing that moved the part (a scroll, a zoom, a key), it is put back on
  // the selected part's gutter cell, unless the person is typing in the input bar
  const want = selectedGutter()
  // which part each gutter cell stands for: when that changes (a zoom, the bar opening, a scroll), the ring's cell may
  // stand for another part now, so it is put back on the selected one
  const sig = [...gutter].map(([y, ids]) => `${y}:${ids.join('/')}`).join(',')
  // presses added or gone before the ring move it in Claude Code's order (the ring keeps its place in the order, so a
  // press drawn above it hands it to another element): the input bar asks for it again, and a part's ring goes back
  // on the selected part
  if (sig !== drawnSig) { drawnSig = sig; if (!isAsk(ringAt)) ringAt = null; else if (landed) { landed = null; moveSoon($) } }
  ringAbove($, kids)
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
  return Math.min(total, Math.max(4, Math.floor(R * (draft ? 0.6 : 0.4))))
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
  // each answer's citations healed once its turn has ended (the last answer of a running thread still writes)
  const heals = new Map<string, { heal: Any | null; checking: boolean }>()
  for (const [i, t] of (thread.turns as Any[]).entries()) {
    if (t && typeof t.text === 'string' && t.text && !heals.has(t.text)) heals.set(t.text, await healOfText($, t.text, { settled: !(String(thread.status || '') === 'running' && i === thread.turns.length - 1) }))
  }
  return conversation(els, {
    thread, name, w, theme, key: 'conv', now: Date.now(),
    heal: (text: string) => heals.get(text) ?? null,
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

/** The input bar: what is typed in it so far, and ↵ asks the thread of what the panel shows about `about`. What the
 *  thread offers (`acts`: a card's rows, its code) stands right above it, a row of presses. `keys`: whether the panel
 *  is drawn holding the keys. */
function entryEls($: Engine, els: Any, about: string, C: number, keys: boolean, acts: { event: string; words: string; on?: boolean }[] = [], fire: (event: string) => unknown = () => undefined): Any[] {
  const key = askKey()
  // what the field holds, as it was drawn and then reported: a field with the ring keeps its own text when drawn
  // again, so a letter the question took through the prompt meanwhile is not in it; a field without the ring shows the
  // question it is drawn with, and what it reports later counts from that
  let base = fields.get(key)
  if (!base) { base = { seen: draft }; fields.set(key, base); if (fields.size > 8) fields.delete(fields.keys().next().value!) }
  else if (!(keys && landed === key)) base.seen = draft
  // (cut to the room the field has beside `Ask about ` and `⏎ ask`, so a record's place or line stays in it)
  const what = cut(about, Math.max(40, C - 24))
  const b = base
  const bar = entry(els, {
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
  // (the input bar's first row is a blank one: the actions go after it, on the rule's row above the field)
  return acts.length ? [bar[0], ...actionEls(els, acts, fire).slice(1), ...bar.slice(1)] : bar
}

/** What a thread offers, as a row of presses in plain words (`rows behind it · how it was drawn`): a blank row, then
 *  the row. Each press is the program's event `act:<id>`. */
function actionEls(els: Any, acts: { event: string; words: string; on?: boolean }[], fire: (event: string) => unknown): Any[] {
  const { Box, Button, Text } = els
  const color = IND[currentTheme()]
  // (the one open now is bold: what it opened stands right above; a press again closes it)
  const kids = acts.flatMap((a, i) => [
    ...(i ? [Text({ key: `act-sep-${i}`, dimColor: true, children: ' · ' })] : []),
    Button({ key: `side-${a.event.replace(/:on$/, '')}`, plain: true, label: a.on ? `${a.words} (open: press to close)` : a.words, onPress: () => fire(a.event), hover: quiet(`side-${a.event}`), children: [Text({ color, ...(a.on ? { bold: true, underline: true } : {}), children: a.words })] }),
  ])
  return [Text({ key: 'act-gap', children: ' ' }), Box({ key: 'side-acts', flexDirection: 'row', flexWrap: 'wrap', marginLeft: 1, children: kids })]
}

/** A card's own keys (its program's k.on) that name what they do, as presses above the input bar (`key:<key>`): the
 *  keys the host keeps never reach the card, and keys that share their words are one press. */
function ownActions(drawing: Any): { event: string; words: string; on?: boolean }[] {
  const kept = hostKeys('detail', 'terminal')
  const out: { event: string; words: string }[] = []
  for (const h of (Array.isArray(drawing?.on) ? drawing.on : []) as { name?: string; label?: string }[]) {
    const name = String(h?.name || '')
    // (a key that turns a knob says which way: `next chapter`)
    const words = turnWords(h, drawing)
    if (!words || !name || name in kept || /^(press|brush|hover|focus|key|tick|input|act)(:|$)/.test(name) || out.some(x => x.words === words)) continue
    out.push({ event: `key:${name}`, words })
  }
  return out
}

/** The way back at the top of the panel, when esc goes back rather than closing it: a press that does what esc does,
 *  named by where it goes (`‹ labels`: a pane's own level, as its esc names it; else what the panel showed before),
 *  and a blank row under it. Nothing when esc would close the panel. */
async function backEls($: Engine, els: Any, pane: { view: PaneView; drawing: Any } | null): Promise<Any[]> {
  const { Button, Text } = els
  const own = pane ? backOf(pane.drawing) : null
  const prev = own ? null : await sidePrev($)
  const words = own ?? (prev ? (prev.kind === 'card' ? 'the card' : sideTitle(prev)) : null)
  if (!words) return []
  const go = async () => {
    if (pane && own) await paneFire($, pane.view.pane, pane.view.args, { type: 'key', key: 'esc' })
    else await sideBack($)
    await takeKeys($)
  }
  return [
    els.Box({ key: 'side-back-row', marginLeft: 1, children: [Button({ key: 'side-back', plain: true, label: `back to ${words}`, onPress: () => { void go() }, hover: quiet('side-back'), children: [Text({ color: IND[currentTheme()], children: `‹ ${words}` })] })] }),
    Text({ key: 'side-back-gap', children: ' ' }),
  ]
}

/** A pane of thimble's in the panel: its program at the panel's width (its parts presses the ring walks, the part it
 *  selected shaded), its thread's conversation under it, and the input bar, unless the pane has no thread now. */
async function panePane($: Engine, e: Any, els: Any, view: PaneView, C: number, R: number): Promise<Any> {
  const { Box, Text } = els
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
  // the way back at the top (what esc goes back to), the pane's actions above the input bar, and what one opened
  // (its `side:opened` region) above them
  const back = await backEls($, els, { view, drawing: d })
  const acts = actionsOf(d)
  // over the program, what its module asks the host to draw: the bar as the settings leave it (`above: 'bar'`)
  const above = paneOf(view.pane).above === 'bar' ? await barPreviewEl($, els, C - 1, e?.props?.placement === 'dock' ? e.viewport?.columns : undefined) : null
  const grid = renderTerm(d, { w: C - 1 })
  const split = belowAt(grid)
  const belowRows = Math.min(grid.h - split, Math.max(4, Math.floor(R * 0.45)))
  const lift = above ? ABOVE_ROWS : 0
  const T = Math.min(convRows(conv, R), Math.max(0, R - (subject ? ENTRY_ROWS : 0) - back.length - lift - (acts.length ? 2 : 0) - belowRows - (belowRows ? 1 : 0) - 4))
  const rows0 = Math.max(4, R - (subject ? ENTRY_ROWS : 0) - T - back.length - lift - (acts.length ? 2 : 0) - belowRows - (belowRows ? 1 : 0))
  const region = typeof d?.selected === 'string' ? d.selected : null
  if (region !== win.region) { win.region = region; win.by = 0; win.follow = 'part' }
  // a program taller than its rows: the rows around the part selected; the wheel moves the window from there
  let rows = Math.min(split, rows0)
  let from = 0
  const tops = new Map<string, number>()
  for (const r of grid.regions as Any[]) if (r.rects?.length && !r.link && r.id !== 'side:opened') tops.set(r.id, Math.min(...r.rects.map((q: Any) => q.y)))
  if (split > rows) {
    const end = split - rows
    const at = Math.max(0, Math.min(end, (region && tops.has(region) && tops.get(region)! < split ? tops.get(region)! : 0) - Math.floor(rows / 3)))
    from = Math.max(0, Math.min(end, at + win.by))
    win.by = from - at
  } else win.by = 0
  rows = Math.min(rows, split - from)
  pageCut = split > rows0
  // where the ring stands on each part: the gutter cell of its first row in the window, as on a card, so the part is
  // shaded and marked ▸ rather than drawn inverse (which would turn its bars into blocks)
  const buttons = new Map<string, string>()
  const gutter = new Map<number, string[]>()
  let first: string | null = null
  for (const [id, y] of [...tops].sort((a, b) => a[1] - b[1])) {
    if (y < from || y >= from + rows || y >= split) continue
    buttons.set(id, SIDE_GUTTER(y))
    gutter.set(y, [...(gutter.get(y) ?? []), id])
    first = first ?? SIDE_GUTTER(y)
  }
  const at = new Map<string, [number, number]>()
  for (const r of grid.regions as Any[]) for (const q of (r.rects || []) as Any[]) for (let y = q.y; y < q.y + q.h; y++) { const was = at.get(`${y}|${r.id}`); if (!was || q.x < was[1]) at.set(`${y}|${r.id}`, [y, q.x]) }
  const walks = ringOnPart(view) && takes(d, { type: 'key', key: 'up' }) && takes(d, { type: 'key', key: 'down' })
  paneDrawn = { name: view.pane, args: view.args, selected: region, buttons, first, order: [...tops].filter(([, y]) => y < split).sort((a, b) => a[1] - b[1]).map(([id]) => id), below: split, walks, at, gutter }
  // (a press is a click: the move of the ring that came with it is no step of the walk)
  const onPress = (id: string, dir?: number) => { walkGen++; void paneFire($, view.pane, view.args, { type: 'press', region: id, ...(dir ? { dir } : {}) }) }
  // (one column in from the panel's edge, as a card's page stands beside its gutter, so every subject lines up)
  const top = region ? tops.get(region) : undefined
  const gcells = Array.from({ length: rows }, (_, i) => {
    const y = from + i
    const ids = gutter.get(y)
    const mark = gutterMark(Text, IND[theme], top === y)
    if (!ids) return Text({ key: `sg${y}`, children: [mark] })
    const id = ids.includes(region ?? '') ? region! : ids[0]!
    const label = String((grid.regions as Any[]).find(r => r.id === id)?.meta?.label || id)
    return els.Button({ key: SIDE_GUTTER(y), plain: true, label, onPress: () => onPress(id), hover: quiet(SIDE_GUTTER(y), { underline: false, bold: true }), children: [mark] })
  })
  const kids: Any[] = [...back, ...(above ? [above, els.Text({ key: 'above-gap', children: ' ' })] : []), Box({ flexDirection: 'row', children: [
    Box({ flexDirection: 'column', width: 1, flexShrink: 0, children: gcells }),
    paintRegions(grid, els, { theme, selected: region, key: 'side', from, rows, onPress, painted: true }),
  ] })]
  kids.push(...convEls(els, conv, T))
  // what an action opened, right above the actions and the input bar
  if (belowRows) kids.push(Text({ key: 'below-gap', children: ' ' }), Box({ key: 'below', marginLeft: 1, children: [paintRegions(openedOnly(grid), els, { theme, selected: region, key: 'side', from: split, rows: belowRows, onPress, painted: true })] }))
  const fireAct = (ev: string) => { void paneFire($, view.pane, view.args, { type: ev }).then(() => takeKeys($)) }
  if (subject) kids.push(...entryEls($, els, subject.label, C, !!e.props.isFocused, acts, fireAct))
  else if (acts.length) kids.push(...actionEls(els, acts, fireAct))
  // the ring follows the selection, as on a card
  const want = selectedGutter()
  const sig = [...buttons].map(([id, k]) => `${id}:${k}`).join(',')
  // presses added or gone before the ring move it in Claude Code's order (the ring keeps its place in the order, so a
  // press drawn above it hands it to another element): the input bar asks for it again, and a part's ring goes back
  // on the selected part
  if (sig !== drawnSig) { drawnSig = sig; if (!isAsk(ringAt)) ringAt = null; else if (landed) { landed = null; moveSoon($) } }
  if (region !== drawnPart) { drawnPart = region; if (!isAsk(ringAt)) ringAt = null }
  // (a focus asked for now may land on the drawing before this one, the part's press being there too, and this one then
  // keeps the ring at its place in the order: the ring is put on the part once more after this drawing is shown)
  const before = want ? pressesBefore(kids, want) : ''
  if (before !== drawnBefore) {
    drawnBefore = before
    if (want && !isAsk(ringAt)) {
      ringAt = null
      $.clock.after(REFOCUS_MS, () => { if (!isAsk(ringAt) && selectedGutter() === want) { ringAt = null; void focusPart($) } })
    }
  }
  ringAbove($, kids)
  if (e.props.isFocused && !paneFocused && !isAsk(ringAt)) ringAt = null
  paneFocused = !!e.props.isFocused
  if (want && e.props.isFocused && !isAsk(ringAt) && ringAt !== want && !refocus) {
    refocus = true
    $.clock.after(0, () => { void focusPart($).finally(() => { refocus = false }) })
  }
  return Box({ flexDirection: 'column', width: C, children: kids })
}

/** The keys of the presses (and fields) a drawing holds before the element keyed `field`, in order. */
function pressesBefore(tree: Any, field: string): string {
  const out: string[] = []
  let done = false
  const walk = (n: Any): void => {
    if (done || n == null || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) walk(x); return }
    if (n.props?.key === field) { done = true; return }
    if (n.type === 'Button' || n.type === 'Input' || n.type === 'Select') out.push(String(n.props?.key ?? ''))
    walk(n.children)
    walk(n.props?.children)
  }
  walk(tree)
  return out.join(',')
}

/** Claude Code keeps the ring at its place in the order of the presses: a press added or gone before the input bar's
 *  field hands the ring on the field to another element, where ↵ would press it. That happens while a question is
 *  typed (the conversation takes more rows then, and shows more of its citations) and when an answer brings its
 *  citations. So when the presses before the field change while it has the ring, the input bar asks for the ring
 *  again. */
function ringAbove($: Engine, kids: Any[]): void {
  const above = pressesBefore(kids, askKey())
  if (above === drawnAbove) return
  drawnAbove = above
  if (isAsk(ringAt) && landed) { landed = null; moveSoon($) }
}

/** The rows the bar's preview takes over a pane (shell.tsx barPreviewEl): its title, its frame, and a blank row. */
const ABOVE_ROWS = 5

/** Whether the pane the panel shows leaves the bar its own keys (its module's `keepBar`, as the settings panel's):
 *  the pane says its keys itself, and a key typed while it is shown does what it does at rest. */
function keepsBar(view: SideView | null): boolean {
  if (view?.kind !== 'pane') return false
  try { return !!paneOf(view.pane).keepBar } catch { return false }
}

/** What an action opened, to paint: its own parts only (a record, next ›). The `side:opened` region that holds them is
 *  where the opened area starts, never a press of its own (its blank rows would take the ring). */
function openedOnly(grid: Any): Any {
  return { ...grid, regions: (grid.regions || []).filter((r: Any) => r.id !== 'side:opened') }
}

/** A question typed in the input bar: the thread of what the panel shows is asked about the part selected, and the
 *  ring goes back to the thing. */
async function askHere($: Engine, text: string): Promise<void> {
  if (!String(text || '').trim()) return
  // the question stays in the input bar while its thread's agent starts: a second ↵ then sends nothing more
  if (sending) return
  sending = true
  let problem: string | null
  try { problem = await askSide($, text) } finally { sending = false }
  if (problem) { failNotice($, `× ${problem}`); return }
  // the line empties: a field drawn afresh, so no word of the question stays in it
  draft = ''
  askGen++
  ringAt = null
  landed = null
  moveGen++
  convBy = 0
  $.ui.invalidate('ui.render')
  // the input bar keeps the keys for the next question
  focusEntry($)
}

/** Where a part's body starts: its biggest rect (a citation of it in the takeaway is a rect of it too, a small one). */
function bodyTop(part: Any): { x: number; y: number } | null {
  if (!part || !part.rects?.length) return null
  return part.rects.reduce((a: Any, q: Any) => (q.w * q.h > a.w * a.h ? q : a), part.rects[0])
}

/** What the bar says while the panel is open: what esc does there, and nothing else. The panel names no keys (its
 *  parts are presses, the way back is one at its top, its actions are presses above the input bar). */
export async function detailKeys($: Engine): Promise<string | null> {
  if (!isOpen) return null
  await $.state.get(ASKLINE)
  // a pane that says its keys itself leaves the bar its own (the settings panel: the person sees the bar change)
  if (keepsBar(await sideNow($))) return null
  if (draft) return 'esc clears the question'
  return `esc ${await backWord($)}`
}

/** What esc does: back a level of the pane's own (its esc handler: a file open in Coverage, a label open in Labels),
 *  back to what the panel showed before, or close it. The esc hook asks in the same order. */
async function backWord($: Engine): Promise<string> {
  const view = await sideNow($)
  if (view?.kind === 'pane' && (await paneTakes($, view.pane, view.args, { type: 'key', key: 'esc' }))) return 'back'
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
export async function detailKey($: Engine, e: KeyEdit): Promise<KeyTurn | null> {
  if (!isOpen) return { box: null }
  // a pane that leaves the bar its keys: a key typed meanwhile does what the bar says it does (none: the shell's own)
  if (keepsBar(await sideNow($))) return null
  // a paste (or keys typed faster than the terminal sends them one by one) with no key: a question too
  const paste = !e.key && !!e.inputText
  // a question begun, and the prompt still showing letters it took: when the terminal is busy, the prompt takes the
  // answers to keys later than the keys come, so a key can come on a prompt that still holds letters of the question.
  // Those letters and this key are the question's (the answer empties the prompt), never the start of a prompt for main
  const leftover = e.text !== '' && (isAsk(ringAt) || !!draft) && takenTail(draft, e.text)
  if ((!e.key && !paste) || e.key?.ctrl || e.key?.meta || (e.text !== '' && !leftover)) return { box: null }
  const none = { text: '', cursor: 0 }
  // (the question as it stands when the key's work runs: the work of the keys before it has run by then)
  if (paste) { const more = String(e.inputText); return { box: none, work: () => typedInPrompt($, draft + more) } }
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
    if (k === 'backspace' && !typed) return { box: none, work: () => typedInPrompt($, draft.slice(0, -1)) }
    // ↵ before the ring reached the field (the letters came through the prompt): the question is asked as it stands
    if ((k === 'return' || k === 'enter') && !typed) return { box: none, work: () => { moveGen++; void askHere($, draft) } }
    return { box: none, work: () => typedInPrompt($, draft + typed) }
  }
  // a letter typed straight after a key that acted: that key began a word, and what it changed goes back
  const back = lastKey
  if (back && beganWord(back.key, now - back.at, typed)) {
    return { box: none, work: async () => {
      lastKey = null
      // the question at once, so the letters after it join it; what the key changed goes back after, outside the key's
      // own work (the next key waits for that work)
      await typedInPrompt($, `${back.key}${typed}`)
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
  // a letter (or a paste) that is no key begins a question in the input bar
  if (typed.trim()) return { box: none, work: () => { lastKey = null; return typedInPrompt($, typed) } }
  return { box: null, work: () => { lastKey = null } }
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
        if (!person && isAsk(ringAt) && (el.startsWith('r|side|') || el.startsWith('g|side|') || (isAsk(el) && el !== askKey()))) {
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
        const part = el.startsWith('r|side|') ? regionOfKey(el) : el.startsWith('g|side|') ? gutterPart(el) : null
        const onPage = (key: string | null) => !!key && (key.startsWith('r|side|') || key.startsWith('g|side|')) && Number(key.split('|')[2]) < paneDrawn!.below
        const chosen = paneDrawn.selected ? paneDrawn.buttons.get(paneDrawn.selected) ?? null : null
        // the ring put on the page by anything but the person (the pane taking the keys as it opens, a drawing's
        // autoFocus, a focus asked for before the pane drew) starts on the part selected, never on another
        if (!person && part && onPage(el) && chosen && el !== chosen && part !== paneDrawn.selected) {
          const was = isAsk(ringAt)
          const r = await next({ ...e, element: chosen })
          if (!r.deny) { ringAt = chosen; ringY = Number(chosen.split('|')[2]); landed = null }
          if (was !== isAsk(ringAt)) askRedraw($)
          return r
        }
        // a pane whose program walks its parts with ↑↓ (the Claims graph): from the part selected, the person's move is
        // one step of the program's own walk, in its order. Claude Code's arrows take the nearest press that way and its
        // Tab the next one in reading order, which may be a dot of another cluster, the head's press or the actions
        // under the page, so where the ring would land says only which way it moved. A click comes with its press,
        // which cancels the step; and back from the input bar or the actions the ring goes to the part selected
        if (person && paneDrawn.walks && !draft && chosen && el !== chosen) {
          // (from the input bar, the actions or the rows under the page, onto the page)
          const back = !!ringAt && !onPage(ringAt) && !!part && onPage(el)
          if (ringAt === chosen || !ringAt || back) {
            const step = !back
            const dir = walkDir(paneDrawn, ringAt, el, chosen)
            const gen = ++walkGen
            const pane = { name: paneDrawn.name, args: paneDrawn.args }
            $.clock.after(WALK_MS, () => { void (async () => {
              if (gen !== walkGen || !isOpen || showing !== 'pane') return
              if (step) await paneFire($, pane.name, pane.args, { type: 'key', key: dir > 0 ? 'down' : 'up' })
              // the drawing that shows the part selected now puts the ring on it (panePane)
              ringAt = null
              landed = null
              $.ui.invalidate('ui.render')
            })() })
            return {}
          }
        }
        // a press in what an action opened (drawn under the conversation): the ring stands there, the selection stays
        if (person && part && Number(el.split('|')[2]) >= paneDrawn.below) { const r = await next(e); if (!r.deny) { ringAt = el; landed = null } return r }
        if (person && part) {
          // a part of several rows is one stop of the ring: a move onto another of its rows goes on to the next part
          // that way, and the ring stands on the first row of the part it selects
          const y = Number(el.split('|')[2])
          let to = part
          if (part === paneDrawn.selected && !!ringAt && (ringAt.startsWith('r|side|') || ringAt.startsWith('g|side|')) && y !== ringY) {
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
        if (!r.deny) { ringAt = el || null; landed = el === askKey() ? el : null; if (el.startsWith('r|') || el.startsWith('g|')) ringY = Number(el.split('|')[2]) }
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
      const m = /^[rt]\|pane\|(\d+)\|([^|]+)(?:\|(?:down|at|up|#\d+))?$/.exec(el)
      // a record or a line of what an action opened (drawn under the conversation): the ring stands there, as on any
      // press, and the selection stays
      if (m && Number(m[1]) >= drawn.below) { const r = await next(e); if (!r.deny) { ringAt = el; landed = null } return r }
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

  // While the panel is open the prompt shows no suggestion: Claude Code gives → to the prompt even while a pane holds
  // the keys, and → there takes the suggestion into the prompt, which then keeps the keys from the panel
  on('prompt.suggest', async ($, e, next) => (isOpen ? { isShown: false } : next(e))).catch(($, e, next) => next(e))

  // A key that reached the prompt while the panel is open and put text there with no edit the panel answers (↑ recalled
  // the history before the panel had the keys, → took a suggestion shown before it opened): the prompt is emptied
  // again and the panel takes the keys back, so esc, the arrows and the letters after it are the panel's
  on('prompt.change', ($, e, next) => {
    if (isOpen && (e.origin as { kind?: string })?.kind !== 'plugin' && String(e.text || '') !== '') {
      $.clock.after(0, () => { void (async () => {
        if (!isOpen) return
        await $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined)
        await takeKeys($)
      })().catch(() => undefined) })
    }
    return next(e)
  })

  // the wheel over the panel (or its scroll keys) moves the page's window, or the conversation's while a question is
  // being typed: the panel draws its own rows of each, so the engine has none to move
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if ((e.origin as { kind?: string }).kind !== 'person' || (showing === 'pane' ? !paneDrawn : !drawn) || !isOpen) return next(e)
    if (draft || !pageCut) convBy -= Number(e.by) || 0
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
    // esc at the prompt with a surface opened over the panel since (the tray, the chips): that surface closes, and the
    // panel stays (shell.tsx escTop)
    if (person && isOpen && !paneFocused && !draft && (await escTop($))) return { value: undefined } as Any
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
      // an empty input bar, holding the keys
      toAsk($, '')
      return { value: undefined } as Any
    }
    const view = await sideNow($)
    const sel = (await $.state.get(SEL)).value as Detail | null
    if (person && isOpen && view?.kind === 'pane' && (await paneTakes($, view.pane, view.args, { type: 'key', key: 'esc' }))) {
      await paneFire($, view.pane, view.args, { type: 'key', key: 'esc' })
      await takeKeys($)
      return { value: undefined } as Any
    }
    if (view?.kind !== 'pane' && sel && !sel.cite && !sel.cites && (sel.prog || sel.bar) && person) {
      await detailFire($, { type: 'key', key: 'esc' })
      // a refused close gives the keys back to the prompt: the pane takes them again, so the next esc reaches it
      focusEntry($)
      return { value: undefined } as Any
    }
    // back to what the panel showed before (a citation opened from an answer goes back to the card)
    if (person && isOpen && (await sideBack($))) {
      await takeKeys($)
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

/** A drawing of the panel: the panel is open again in this module's memory only while the side state holds what it
 *  shows and Claude Code lists it as shown (a reload of the module while it stayed open). A drawing that comes after
 *  the panel closed, such as a slow read's redraw, finds neither, so a closed panel never holds the keys or the bar. */
export async function noticeOpen($: Engine): Promise<void> {
  if (isOpen) return
  if ((await sideNow($)) && (await paneShown($))) markOpen(true)
}

/** For tests: the module's memory, cleared. */
export function resetDetail(): void {
  isOpen = false
  sending = false
  drawn = null
  paneDrawn = null
  showing = 'card'
  convBy = 0
  lastKey = null
  ringY = -1
  ringAt = null
  draft = ''
  refocus = false
  paneFocused = false
  drawnSig = ''
  drawnPart = null
  drawnAbove = ''
  win.follow = 'part'; win.bar = ''; win.region = null; win.by = 0
  viewCols = 0
  latestSeen.clear()
  lastCard = null
}
