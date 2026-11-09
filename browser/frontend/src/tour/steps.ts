// The tour's steps (the shape engine.ts takes): which surface each needs, what it points at, where its popover sits,
// what it says and what it brings; and what the welcome before them says. Every example is the tour's own
// (examples.json, captured from real thimble markup: a live page, and thimble's own components for the marks, comments,
// Labels sidebar and Color by menu; all but the views step's are marked Example); a step that asks the analyst to act
// acts only on that example, so nothing reaches the server.
import { placeBeside } from '../components/Menu'
import { TIP_DELAY_MS } from '../components/Tooltip'
import { fitChips } from '../files/ColorBy'
import { shownIn } from '../files/Reader'
import { TRACK_LANES } from '../files/Ruler'
import { frameOf } from '../files/Tracks'
import { setMarkup, type Api, type Example, type Step } from './engine'
import reportFigs from './report-figs.json'

const canvasPanel = '[data-panel="canvas"].shell-panel'
const filesPanel = '[data-panel="files"].shell-panel'
const reportPanel = '[data-panel="report"].shell-panel'
const chatSel = '.chat[data-panel="chat"]'

// ---------- the chat: an example exchange in main's chat. The answer's three times are citations, drawn as
// marks/Mark.tsx draws them (examples.json, drawn by that component): first checking, then
// checked, each one confirmed, so no line under the answer counts any. On the next step Explainers'
// comment tints "UK time" (chatExplained), and its comment card opens beside the chat (chatComment).
const QUESTION = 'When did payments 4.12.0 go out, and was it still live when INC-312 opened?'
const chatHtml = `<div class="chat-flow" style="min-height:0">
  <div class="chat-msg chat-user"><p class="msg-user chat-message">${QUESTION}</p></div>
  <div class="chat-msg chat-calls"><div class="chat-callrun" data-calls="2" data-state="done"><span class="chat-callrun-head"><button type="button" class="chat-callchip chat-callrun-chip" aria-expanded="false"><span class="chat-callrun-tools"><span class="chat-callrun-tool"><span class="chat-callrun-name">Bash</span><span class="chat-callrun-n">2</span></span></span><svg class="icon icon-chevron-right chat-callchip-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button></span></div></div>
  <div class="chat-msg chat-assistant"><div class="chat-text"></div></div>
</div>`
/** The answer's states: its citations being checked, checked, and checked with Explainers' tint. */
type AnswerState = 'chatChecking' | 'chatChecked' | 'chatExplained'
/** The example answer (in `flow`, the example's chat list) drawn in `state`; each citation names its label in `pops`
 * (`chat:<k>`). */
const showAnswer = (api: Api, state: AnswerState, flow = api.els.flow as HTMLElement | undefined) => {
  const reply = flow?.querySelector<HTMLElement>('.chat-assistant')
  if (!reply || reply.dataset.state === state) return
  reply.dataset.state = state
  const text = reply.querySelector<HTMLElement>('.chat-text')!
  text.replaceChildren(...api.snap(state).childNodes)
  text.querySelectorAll('.mark').forEach((m, k) => m.setAttribute('data-tour-ref', `chat:${k}`))
}
/** The answer's citations, in order. */
const answerMarks = (api: Api) => [...((api.els.flow as HTMLElement | undefined)?.querySelectorAll<HTMLElement>('.chat-assistant .mark') ?? [])]
/** Explainers' tint on the answer. */
const answerTint = (api: Api) => (api.els.flow as HTMLElement | undefined)?.querySelector<HTMLElement>('.chat-assistant mark.answer-tint') ?? null
/** A citation or tint the analyst rests on: the demo stops and the answer stands checked, then its label or comment
 * opens. */
const onAnswerChip = (state: AnswerState) => (api: Api, chip: Element) => {
  api.stopDemo()
  const ref = chip.getAttribute('data-tour-ref')
  const before = (api.els.flow as HTMLElement | undefined)?.querySelector('.chat-assistant')?.getAttribute('data-state')
  if (before === 'chatChecking') showAnswer(api, state)
  const now = (chip.isConnected ? chip : ref && answerMarks(api).find((m) => m.dataset.tourRef === ref)) || null
  if (!now) return
  if (now.matches('mark.answer-tint')) showComment(api, now)
  else api.showSource(now)
}
/** Explainers' comment card on `tint`, as the chat opens it (chat/AnswerComment.tsx): right of the chat's column, its
 * top on the passage's line. */
const showComment = (api: Api, tint: Element, demo = false) => {
  const card = api.snap('chatComment').firstElementChild as HTMLElement
  const C = api.rectOf(api.q(chatSel)),
    T = api.rectOf(tint)
  return api.showBeside(tint, card, { x: (C ? C.x + C.width : 0) + 16, y: (T ? T.y : 0) - 2 }, { demo })
}
const sessionExample = (api: Api): Example => {
  const list = api.q(`${chatSel} .chat-list`) || api.q(chatSel)
  // the example is the real chat's markup in a column of the chat panel's own width (real chat-list, chat-flow and
  // message classes), inset 12px on each side: the real list reaches 2px past the panel on each side and its user
  // bubble ends flush with the panel's right edge, which would leave nothing of the highlight around it
  const ex = document.createElement('div')
  ex.className = 'tour-ex-chat'
  // its background covers the real chat beneath, under the dim, below the cutout too
  ex.dataset.ground = '1'
  ex.style.background = api.groundOf(list)
  const inner = document.createElement('div')
  inner.className = 'chat-list'
  inner.style.cssText = 'margin: 0; padding: 14px 12px 12px; overflow: hidden'
  setMarkup(inner, chatHtml)
  inner.prepend(api.tag(inner))
  ex.append(inner)
  api.ex.append(ex)
  const layout = () => {
    const C = api.rectOf(api.q(chatSel)),
      L = api.rectOf(list),
      F = api.rectOf(api.q(`${chatSel} .chat-foot`))
    if (!C || !L) return
    Object.assign(ex.style, { left: `${C.x}px`, top: `${L.y}px`, width: `${C.width}px`, height: `${(F ? F.y : C.y + C.height) - L.y}px` })
  }
  showAnswer(api, 'chatChecking', inner)
  return { els: { chat: ex, flow: inner, chipsIn: inner }, layout }
}
// the chat as the step shows it: the chat panel's own width, from its head to 14px past the end of the example exchange
const chatContent = (api: Api) => {
  const C = api.rectOf(api.q(chatSel)),
    flow = (api.els.flow as HTMLElement | undefined)?.querySelector('.chat-flow')
  const F = flow && api.rectOf(flow)
  if (!C || !F) return null
  return { x: C.x, y: C.y, width: C.width, height: Math.min(C.y + C.height, F.y + F.height + 14) - C.y }
}

// ---------- Files: the file browser. The File browser stays on through the Files steps (Files, Labels, Views): a view
// the analyst left open is closed for them, and opened again once the tour moves to another step or ends. The Files
// and Labels steps share one example, an agent's transcript (txExample): plain in Files, colored by a label in Labels.
const viewTabs = (bar: Element | null) => [...(bar?.querySelectorAll<HTMLElement>('.seg-opt') ?? [])]
let held: { el: HTMLElement; anchor: string | null } | null = null
const holdsBrowser = (s: Step | undefined) => !!s?.example && [txExample, viewsExample].includes(s.example)
/** The File browser on for the step. */
const holdBrowser = (api: Api) => {
  const tabs = viewTabs(api.q('.files-views'))
  const was = tabs.find((e) => e.classList.contains('active'))
  const browser = tabs.find((e) => /File browser/.test(e.textContent ?? ''))
  if (browser && was && was !== browser) {
    held = { el: was, anchor: was.getAttribute('data-anchor') }
    browser.click()
  }
}
/** A Files step's leave, whether or not its example was drawn: the view opens again unless the next step is a Files
 * step too. The engine moves to the next step right after a step's leave, so that step is known a microtask later. */
const releaseBrowser = (api: Api) =>
  queueMicrotask(() => {
    if (holdsBrowser(api.step()) || !held) return
    const { el, anchor } = held
    held = null
    const tab = (anchor && api.q(`.files-views .seg-opt[data-anchor="${CSS.escape(anchor)}"]`)) || el
    if (tab instanceof HTMLElement && tab.isConnected && !tab.classList.contains('active')) tab.click()
  })
// the Files panel's status strip as an example shows it, saying `meta`, over thimble's own, which names the analyst's
// open file
const statusExample = (api: Api, meta: string) => {
  const real = () => api.q('[data-panel="files"] .pane-status')
  const wrap = document.createElement('div')
  wrap.className = 'tour-ex-status'
  wrap.dataset.ground = '1'
  const strip = document.createElement('div')
  strip.className = 'pane-status'
  for (const [cls, text] of [['pane-status-name', 'Files'], ['pane-status-meta', meta]]) {
    const span = document.createElement('span')
    span.className = cls
    span.textContent = text
    strip.append(span)
  }
  wrap.append(strip)
  const layout = () => {
    const el = real()
    const S = api.rectOf(el)
    wrap.style.display = S ? '' : 'none'
    if (!S || !el) return
    // the strip's glass over the ground of the panel beneath it, as thimble draws it
    const ground = api.groundOf(el.parentElement)
    Object.assign(wrap.style, { left: `${S.x}px`, top: `${S.y}px`, width: `${S.width}px`, height: `${S.height}px`, background: ground, borderRadius: getComputedStyle(el).borderRadius })
  }
  return { wrap, layout }
}

// ---------- Views: an example Timeline view over the Files body, with a views bar that has it on. Inside it the analyst
// may hover, click and scroll (it writes nothing); Esc there still closes the tour.
const viewsExample = (api: Api): Example => {
  const realBar = () => api.q('.files-views'),
    realBody = () => api.q('[data-panel="files"] .files-body')
  const bar = api.snap('timelineBar', 'tour-ex-viewsbar')
  bar.style.background = api.groundOf(realBar())
  const body = document.createElement('div')
  body.className = 'tour-ex-viewbody'
  body.style.background = api.groundOf(realBody())
  // the example view (public/tour/timeline/): a Timeline over a made-up incident's records. view.html is the view pane
  // with thimble's head (scope-head.js, mock.js) and the view's own page (page.html, data.js) in its frame; it is never
  // registered as a view in any workspace
  const frame = document.createElement('iframe')
  frame.src = `${import.meta.env.BASE_URL}tour/timeline/view.html?v=12`
  frame.title = 'Timeline (example)'
  Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0' })
  body.append(frame)
  const escape = (win: Window | null) => {
    try {
      if (!win) return
      win.addEventListener('keydown', (e) => e.key === 'Escape' && api.end(), true)
      win.document.querySelectorAll('iframe').forEach((f) => {
        f.addEventListener('load', () => escape(f.contentWindow))
        if (f.contentDocument?.readyState === 'complete') escape(f.contentWindow)
      })
    } catch {
      // a frame of another origin keeps its own keys
    }
  }
  frame.addEventListener('load', () => escape(frame.contentWindow))
  const status = statusExample(api, 'view · Timeline')
  api.ex.append(bar, body, status.wrap)
  const layout = () => {
    const B = api.rectOf(realBar()),
      D = api.rectOf(realBody())
    if (B) Object.assign(bar.style, { left: `${B.x}px`, top: `${B.y}px`, width: `${B.width}px`, height: `${B.height}px` })
    if (D) Object.assign(body.style, { left: `${D.x}px`, top: `${D.y}px`, width: `${D.width}px`, height: `${D.height}px` })
    status.layout()
    return !!(B && D)
  }
  holdBrowser(api)
  return { els: { bar, body, frame, status: status.wrap }, layout }
}

// ---------- the card steps: the example card (the top card of an orientation's deck, captured, in plain words), scaled
// so it reads comfortably at the window's size. Where a card of width w0 and height h0 goes on the Canvas: as large as
// fits beside the popover, at most 1100px wide.
const fitCard = (api: Api, w0: number, h0: number) => {
  const P = api.rectOf(api.q(canvasPanel))
  if (!P) return null
  const availW = P.width - 280 - 14 - 64,
    availH = P.height - 28 - 96
  const w = Math.max(320, Math.min(availW, (availH * w0) / h0, 1100))
  const h = (w * h0) / w0
  return { w, h, x: P.x + Math.max(32, (P.width - (w + 14 + 280)) / 2), y: P.y + Math.max(40, (P.height - 28 - h) / 2) }
}
const cardExample = (api: Api): Example => {
  // placed in the layer thimble's own ⌘ pointer reaches, with the card's anchors and parts as thimble drew them, so a
  // ⌘-click picks a row, a click on text picks its line and a ⌘-drag picks the words, as on a real card. The ask box
  // on it sends nothing (the engine's guard)
  const w = api.snap('card', 'tour-ex-card', undefined, { keepAnchors: true })
  const art = w.querySelector('article')!
  const cell = document.createElement('div')
  cell.className = 'bcell bcell-kind-timeline is-sized'
  cell.style.width = '720px'
  cell.append(art)
  w.replaceChildren(cell)
  Object.assign(w.style, { width: '720px', transformOrigin: '0 0' })
  Object.assign(api.tag(w).style, { left: '50%', right: 'auto', transform: 'translateX(-50%)' })
  api.host.append(w)
  // drawn larger than its layout, a box that clips would hide the lower part of the card from the pointer, so nothing
  // in the example clips
  for (const el of [w, ...w.querySelectorAll<HTMLElement>('*')]) {
    const cs = getComputedStyle(el)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') el.style.overflow = 'visible'
  }
  let key = ''
  // placed again whenever the window, the Canvas panel or the card's height changes; false until it can be placed
  const layout = () => {
    const h0 = art.offsetHeight || cell.offsetHeight
    const P = api.rectOf(api.q(canvasPanel))
    const size = P ? `${innerWidth}x${innerHeight}|${[P.x, P.y, P.width, P.height].map(Math.round).join()}|${h0}` : ''
    if (size && size === key) return
    const f = fitCard(api, 720, h0)
    if (!f || !h0) return false
    key = size
    Object.assign(w.style, { left: `${f.x}px`, top: `${f.y}px`, height: `${h0}px`, transform: `scale(${f.w / 720})` })
  }
  return { els: { card: art, wrap: w }, layout }
}

// ---------- the right sidebar (shell/LabelsSidebar.tsx), which the top bar's Labels and Comments buttons open, each on
// its own section. A step about it opens the real one on its section with that button, so the panes make room for it
// as they do for the analyst, and lays its example (examples.json, captured) over it; the step's end puts the sidebar
// back as the analyst had it.
type SideSection = 'labels' | 'comments'
const realSide = () => [...document.querySelectorAll<HTMLElement>('aside.lside')].find((e) => !e.closest('.tour-root')) ?? null
const sideButton = (section: string) => document.querySelector<HTMLElement>(`.shell-side-btn[data-side="${section}"]`)
/** The sidebar open on `section`; what it returns puts it back as it was. */
const holdSide = (section: SideSection) => {
  const was = realSide()?.dataset.section ?? null
  if (was !== section) sideButton(section)?.click()
  return () => {
    const now = realSide()?.dataset.section ?? null
    // a click on the open section's button closes the sidebar, a click on the other's shows that one
    if (now !== was) sideButton(was ?? now ?? section)?.click()
  }
}
/** The categories' last row as the sidebar draws it now (LabelsSidebar.tsx NewCheck), which the capture predates. */
const NEW_CHECK =
  '<button type="button" class="lside-add"><svg class="icon icon-plus" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>New check</button>'
/** The example sidebar on `section`, laid over the real one while it is open; the comment categories end in + New
 * check, as thimble's do. */
const sideExample = (api: Api, section: SideSection) => {
  const wrap = api.snap(section === 'labels' ? 'labelsSide' : 'commentsSide', 'tour-ex-side')
  const aside = wrap.firstElementChild as HTMLElement
  aside.removeAttribute('data-section')
  if (section === 'comments') {
    const add = document.createElement('div')
    add.className = 'lside-new'
    setMarkup(add, NEW_CHECK)
    aside.querySelector('.lside-section')?.append(add)
  }
  Object.assign(aside.style, { width: '100%', maxWidth: 'none', height: '100%', margin: '0' })
  // the badge in the head's empty middle, clear of the heading and of the Label tool switch
  Object.assign(api.tag(wrap).style, { top: '14px', left: '50%', right: 'auto', transform: 'translateX(-50%)' })
  const layout = () => {
    const S = api.rectOf(realSide())
    wrap.style.display = S ? '' : 'none'
    if (S) Object.assign(wrap.style, { left: `${S.x}px`, top: `${S.y}px`, width: `${S.width}px`, height: `${S.height}px` })
    return !!S
  }
  return { wrap, aside, layout }
}

// ---------- Files and Labels: one agent's transcript in the Transcript mode, captured colored by one label of a few
// values: what each step does (reads code, changes code, runs tests, talks to other agents; other, in no color). The
// Files step shows it plain, as with Color by Off. In the Labels step Color by picks the label: each record's bar and
// its row take its value's color, resting on a record names its label and value, as thimble's own hover does (`tips`),
// and the strip beside the transcript shows the colors down the whole file; then the Labels sidebar that lists the
// label opens over the real one. What thimble fits to the window (Color by's chips, the strip's thumb) the step fits as
// thimble does.

/** the transcript's lines (agent-05.jsonl, as the Labels sidebar counts its records), which its strip stands for, the
 * records the Transcript mode hides included */
const TX_LINES = 76
/** the line the transcript opens at, where the agent claims a pull request on the board the agents share, reads the
 * code, runs the tests and changes the code: every value's color within its first ten records, so on screen in a short
 * window too */
const TX_OPEN = 16
/** the values whose records the demo rests on, the first two of these with a record on screen, each its first there, in
 * the order they stand */
const TIP_DEMO = ['what the step does: runs tests', 'what the step does: talks to other agents', 'what the step does: changes code']

/** The label's lane on the example transcript's strip, drawn from the records it shows as thimble's strip draws a label
 * (files/Tracks.tsx paintLane): one lane on its stripe (TRACK_LANES), and on it a mark over each run of records whose
 * bar is in one color. The lane is a grid of a row per line of the file's `total`, and a mark spans its records' rows in
 * their bars' color, so the strip spans the track at any height, with no gap between two marks that meet, and shows the
 * records' colors in either theme. */
function drawStrip(reader: HTMLElement, total: number): void {
  const track = reader.querySelector('.track-over')
  if (!track) return
  const runs: { from: number; to: number; color: string }[] = []
  for (const rec of reader.querySelectorAll<HTMLElement>('.reader-record[data-line]')) {
    const line = Number(rec.dataset.line)
    const color = rec.querySelector<HTMLElement>('.reader-bands > .reader-band')?.style.background ?? ''
    if (!color) continue
    const last = runs[runs.length - 1]
    if (last && last.to === line - 1 && last.color === color) last.to = line
    else runs.push({ from: line, to: line, color })
  }
  const { lane: width, inset } = TRACK_LANES
  const lane = document.createElement('div')
  lane.className = 'tour-strip-lane'
  Object.assign(lane.style, { position: 'absolute', top: '0', bottom: '0', left: `${inset}px`, width: `${width}px`, display: 'grid', gridTemplateRows: `repeat(${total}, minmax(0, 1fr))`, background: 'rgba(var(--ink-rgb), 0.035)' })
  for (const r of runs) {
    const mark = document.createElement('div')
    Object.assign(mark.style, { gridRow: `${r.from} / ${r.to + 1}`, background: r.color })
    lane.append(mark)
  }
  track.prepend(lane)
}

/** The example reader's badge, centered in the first free room of its rows wide enough for it: its bar's, between its
 * tabs and its first control, as the report's badge sits in its bar's empty middle; else, in a narrow Files panel, the
 * transcript's top row's, left of its chips. */
function placeTag(rd: HTMLElement, tag: HTMLElement): void {
  const box = (sel: string) => rd.querySelector(sel)?.getBoundingClientRect() ?? null
  const bar = box('.reader-bar'),
    tabs = box('.reader-bar > .reader-tabs-wrap > .reader-tabs'),
    find = box('.reader-bar > .reader-find-open'),
    row = box('.reader-viewbar'),
    chip = box('.reader-viewbar > *')
  const rooms: { y: number; h: number; from: number; to: number }[] = []
  if (bar && tabs && find) rooms.push({ y: bar.top, h: bar.height, from: tabs.right, to: find.left })
  // the row's padding and the gap before its chips (files.css .reader-viewbar)
  if (row) rooms.push({ y: row.top, h: row.height, from: row.left + 14, to: chip ? chip.left - 10 : row.right - 14 })
  const w = tag.offsetWidth,
    h = tag.offsetHeight
  const room = rooms.find((r) => r.to - r.from >= w + 16) ?? rooms[rooms.length - 1]
  if (!room || !w) return
  const R = rd.getBoundingClientRect()
  const left = `${Math.round((room.from + room.to - w) / 2 - R.left)}px`,
    top = `${Math.round(room.y + (room.h - h) / 2 - R.top)}px`
  if (tag.style.left !== left || tag.style.top !== top) Object.assign(tag.style, { left, top, right: 'auto' })
}

/** The colors of the example transcript (`reader`, as captured, colored), which `plain` takes off as Color by Off does
 * and `color` puts back: the records' bars, tints and names, the strip's lane, and Color by's value, label icon and chips. */
function txColors(reader: HTMLElement) {
  const colorBy = reader.querySelector<HTMLElement>('.colorby')
  const name = colorBy?.querySelector('.colorby-trigger b')
  const said = name?.textContent ?? ''
  const icon = colorBy?.querySelector('.colorby-trigger .colorby-name-ico')
  const parts = [...(colorBy?.querySelectorAll<HTMLElement>(':scope > .colorby-chips') ?? [])]
  const lane = reader.querySelector<HTMLElement>('.tour-strip-lane')
  const track = lane?.parentElement
  const records = [...reader.querySelectorAll<HTMLElement>('.reader-record')].map((el) => ({
    el,
    cls: ['has-cb', 'has-cb-tint'].filter((c) => el.classList.contains(c)),
    attrs: ['style', 'data-tip', 'aria-description'].map((a) => [a, el.getAttribute(a)] as const),
    bands: el.querySelector(':scope > .reader-bands'),
  }))
  return {
    plain() {
      if (name) name.textContent = 'Off'
      icon?.remove()
      parts.forEach((e) => e.remove())
      lane?.remove()
      for (const r of records) {
        r.el.classList.remove(...r.cls)
        for (const [a] of r.attrs) r.el.removeAttribute(a)
        r.bands?.remove()
      }
    },
    color() {
      if (name) name.textContent = said
      if (icon) name?.before(icon)
      colorBy?.append(...parts)
      if (lane && track) track.prepend(lane)
      for (const r of records) {
        r.el.classList.add(...r.cls)
        for (const [a, v] of r.attrs) if (v != null) r.el.setAttribute(a, v)
        if (r.bands) r.el.prepend(r.bands)
      }
    },
  }
}

/** Color by's menu as it opens under `trigger` (files/ColorBy.tsx, captured with Color by Off and the label among the
 * file's labels), the demo's: it goes with the demo. */
function openColorMenu(api: Api, trigger: HTMLElement): HTMLElement {
  const menu = api.snap('colorByMenu').firstElementChild as HTMLElement
  menu.dataset.demo = '1'
  menu.style.width = '300px'
  api.fx.append(menu)
  const t = trigger.getBoundingClientRect()
  const at = placeBeside(t, menu.offsetWidth, menu.offsetHeight, innerWidth, innerHeight, 'start')
  Object.assign(menu.style, { left: `${at.left}px`, top: `${at.top}px` })
  trigger.setAttribute('aria-expanded', 'true')
  return menu
}
/** The label checked in Color by's menu, and Off no longer, as the menu draws a checked label. */
function checkLabel(menu: HTMLElement): void {
  const off = menu.querySelector('[data-by="off"]'),
    row = menu.querySelector('[data-by^="l:"]'),
    box = row?.querySelector('.colorby-box')
  const tick = off?.querySelector('.colorby-tick svg')
  off?.classList.remove('checked')
  off?.setAttribute('aria-checked', 'false')
  row?.classList.add('checked')
  row?.setAttribute('aria-checked', 'true')
  box?.classList.add('on')
  if (box && tick) {
    tick.setAttribute('width', '10')
    tick.setAttribute('height', '10')
    box.append(tick)
  }
}

const txExample = (api: Api): Example => {
  const realReader = () => api.q('[data-panel="files"] .reader')
  const rd = api.snap('txReader', 'tour-ex-reader')
  const reader = rd.firstElementChild as HTMLElement
  reader.querySelectorAll('.reader-tab:not(.active)').forEach((t) => t.remove())
  drawStrip(reader, TX_LINES)
  const colors = txColors(reader)
  colors.plain()
  Object.assign(rd.style, { display: 'flex', flexDirection: 'column', background: api.groundOf(realReader() || api.q(filesPanel)) })
  Object.assign(reader.style, { flex: '1', minHeight: '0', overflow: 'hidden' })
  const tag = api.tag(rd)
  // the Color by row's value chips, which fit the row as thimble's do
  const chips = reader.querySelector<HTMLElement>('.colorby-chips'),
    more = chips?.querySelector<HTMLElement>('.colorby-more')
  let fitAt = ''
  holdBrowser(api)
  const side = sideExample(api, 'labels')
  let putBack: (() => void) | null = null
  const status = statusExample(api, 'agent-05.jsonl · Transcript')
  api.ex.append(rd, status.wrap)
  const els = {
    reader: rd,
    trigger: reader.querySelector<HTMLElement>('.colorby .colorby-trigger'),
    labels: null as HTMLElement | null,
    status: status.wrap,
    colored: false,
    /** the step on screen, read outside a demo's api, which ends with the demo */
    step: () => api.step(),
    /** colored by the label, Color by's menu closed */
    color: () => {
      if (!els.colored) colors.color()
      els.colored = true
      els.trigger?.setAttribute('aria-expanded', 'false')
      fitAt = ''
    },
    /** the Labels sidebar open on its section, the example over it */
    showSide: () => {
      if (!putBack) putBack = holdSide('labels')
      if (!side.wrap.isConnected) api.ex.append(side.wrap)
      els.labels = side.wrap
    },
    /** as the Files step shows it: plain, no sidebar */
    plain: () => {
      if (els.colored) colors.plain()
      els.colored = false
      els.trigger?.setAttribute('aria-expanded', 'false')
      putBack?.()
      putBack = null
      side.wrap.remove()
      els.labels = null
    },
  }
  // the transcript opens at TX_OPEN and stays there while the panel's size changes, until anything else scrolls it
  let pinned = true,
    setTo: number | null = null
  const layout = () => {
    status.layout()
    if (els.labels && !side.layout()) return false
    let r = api.rectOf(realReader())
    if (!r) {
      const p = api.rectOf(api.q(filesPanel)),
        sd = api.rectOf(api.q('.files-side'))
      // in a narrow Files panel thimble hides its sidebar: the transcript then takes the whole panel
      if (p && sd) r = { x: sd.x + sd.width, y: sd.y, width: p.x + p.width - sd.x - sd.width, height: sd.height }
      else if (p) r = { x: p.x, y: p.y, width: p.width, height: p.height }
    }
    if (!r) return false
    Object.assign(rd.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
    const fit = `${reader.clientWidth}|${document.fonts?.status}`
    if (els.colored && chips && more && reader.clientWidth && fit !== fitAt) {
      fitChips(chips, more, more.querySelector<HTMLElement>('.btn-label > span'))
      fitAt = fit
    }
    placeTag(rd, tag)
    const sc = rd.querySelector<HTMLElement>('.reader-body')
    if (!sc || !sc.clientHeight) return
    if (pinned && setTo != null && Math.abs(sc.scrollTop - setTo) > 1) pinned = false
    if (pinned) {
      // its record just under the bar that stays at the transcript's top
      const row = rd.querySelector(`.reader-record[data-line="${TX_OPEN}"]`),
        bar = rd.querySelector('.reader-viewbar')
      if (row) {
        sc.scrollTop += row.getBoundingClientRect().top - (bar ? bar.getBoundingClientRect().bottom : sc.getBoundingClientRect().top)
        setTo = sc.scrollTop
      }
    }
    // the strip's thumb frames the lines on screen, as thimble's does (Reader shownIn)
    const track = rd.querySelector<HTMLElement>('.track-over'),
      thumb = rd.querySelector<HTMLElement>('.track-frame-over'),
      shown = shownIn(sc, TX_LINES)
    if (track && thumb && shown) {
      const f = frameOf(shown, track.clientHeight)
      const at = `translateY(${f.top}px)`
      if (thumb.style.transform !== at || thumb.style.height !== `${f.height}px`) Object.assign(thumb.style, { height: `${f.height}px`, transform: at })
    }
  }
  return { els, layout, cleanup: () => els.plain() }
}

/** The pointer, already shown, rests on the bar of the first record of two values on screen in turn, and each record's
 * label and value show, as thimble's own hover shows them; then it moves off. */
async function restOnRecords(api: Api): Promise<void> {
  const body = api.els.reader?.querySelector('.reader-body') as HTMLElement | undefined
  const B = body && api.rectOf(body)
  if (!body || !B) return
  // the first record of each value whose head is on screen, below the bar that stays at the transcript's top
  const from = api.rectOf(body.querySelector('.reader-viewbar'))
  const top = from ? from.y + from.height : B.y
  // its name, under the pointer, stays inside the transcript
  const room = 72
  const rows = TIP_DEMO.map((tip) =>
    [...body.querySelectorAll<HTMLElement>('.reader-record[data-tip]')].find((r) => {
      const q = r.getBoundingClientRect()
      return r.dataset.tip === tip && q.top >= top && q.top + room <= B.y + B.height
    }),
  )
    .filter((r): r is HTMLElement => !!r)
    .slice(0, 2)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  const barOf = (row: HTMLElement) => {
    const q = api.rectOf(row)
    return q && { x: q.x + 2, y: q.y + Math.min(14, q.height / 2) }
  }
  for (const [k, row] of rows.entries()) {
    api.fx.querySelectorAll('.tip[data-demo]').forEach((t) => t.remove())
    await api.cursor.move(() => barOf(row), undefined, k ? 650 : 900)
    // the first name waits its moment; the next, a moment after, shows at once, as thimble's own do
    if (!k) await api.sleep(TIP_DELAY_MS)
    const p = barOf(row)
    if (p) api.showTip(row, p.x, p.y)
    await api.sleep(2000)
  }
  api.fx.querySelectorAll('.tip[data-demo]').forEach((t) => t.remove())
  const c = api.cursor.pos
  await api.cursor.move(c.x + 260, c.y - 90, 600)
  api.cursor.hide()
}

// ---------- the Report and its checks: the example (a captured report with its figures and the comments of its check
// "Alternative explanations"), at its own size, or scaled down to a panel narrower than the one it was drawn in
const reportExample = (api: Api): Example => {
  const panel = () => api.q(reportPanel)
  const w = api.snap('reportPanel', 'tour-ex-report')
  const inner = w.firstElementChild as HTMLElement
  const [w0, h0] = (inner.getAttribute('data-size') || '1096x848').split('x').map(Number)
  Object.assign(inner.style, { position: 'absolute', left: '0', top: '0', margin: '0', width: `${w0}px`, height: `${h0}px`, transformOrigin: '0 0' })
  Object.assign(w.style, { background: api.groundOf(panel()), overflow: 'hidden' })
  const spacer = w.querySelector<HTMLElement>('.wu-bar-spacer')
  api.tag(spacer ?? w)
  asReportNow(w)
  // the report's first figure, a dense timeline chart, becomes a small table that makes one point in plain words (the
  // figure markup is the report's own, from its table figure)
  const first = w.querySelector('figure.wu-fig[data-tour-anchor="card:fb1d3ae9"]'),
    model = w.querySelector('figure.wu-fig[data-tour-anchor="card:d800bfeb"]')
  if (first && model) {
    const fig = model.cloneNode(true) as HTMLElement
    fig.setAttribute('data-tour-anchor', 'card:connections-limit')
    const ask = fig.querySelector('.wu-fig-q')
    if (ask) ask.textContent = 'How close did the database come to its limit of 200 connections?'
    const rows = [
      ['02:57, night warning', '181', '4.12.0'],
      ['07:41, morning warning', '176', '4.12.0'],
      ['08:04, outage starts', '200, full', '4.12.0'],
      ['08:40, after the update was undone', '58', '4.11.3'],
    ]
    const table = fig.querySelector('table')
    if (table)
      setMarkup(
        table,
        '<thead><tr><th>When</th><th>Connections in use</th><th>Version running</th></tr></thead><tbody>' + rows.map(([a, b, c]) => `<tr><th>${a}</th><td>${b}</td><td>${c}</td></tr>`).join('') + '</tbody>',
      )
    const cap = fig.querySelector('.wu-fig-caption')
    if (cap) cap.textContent = 'The database came close to its limit only while version 4.12.0 was running.'
    if (table) table.style.width = '100%'
    first.replaceWith(fig)
  }
  api.ex.append(w)
  // each chart drawn at the width its figure has, as thimble's Report draws a chart to its figure's width: of the
  // drawings captured at figure widths from 391 to 688 px (report-figs.json), the nearest, sized to the figure
  type Cap = { content: number; svg: string }
  const charts = Object.entries(reportFigs as Record<string, Cap[]>)
    .map(([id, caps]) => {
      const fig = w.querySelector(`figure.wu-fig[data-tour-anchor="card:${id}"]`)
      const box = fig?.querySelector<HTMLElement>('.outputs-vega'),
        body = fig?.querySelector<HTMLElement>('.wu-fig-body')
      return box && body && caps.length ? { box, body, caps, at: null as Cap | null, cw: 0 } : null
    })
    .filter((c): c is NonNullable<typeof c> => !!c)
  const fitCharts = () => {
    for (const c of charts) {
      const cs = getComputedStyle(c.body)
      const cw = c.body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      if (!(cw > 0) || Math.abs(cw - c.cw) < 0.5) continue
      c.cw = cw
      const cap = c.caps.reduce((a, b) => (Math.abs(b.content - cw) < Math.abs(a.content - cw) ? b : a))
      if (cap !== c.at) {
        setMarkup(c.box, cap.svg)
        c.at = cap
      }
      const svg = c.box.querySelector('svg')
      if (!svg) continue
      const vb = (svg.getAttribute('viewBox') || `0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`).split(/[\s,]+/).map(Number)
      Object.assign(svg.style, { width: `${cw}px`, height: `${(cw * vb[3]) / vb[2]}px` })
    }
  }
  const rail = w.querySelector<HTMLElement>('.wu-rail')
  // the page's ruler: with no comments thimble draws it plain (a 10 px bar and a plain thumb), with them a lane of marks
  const rulerBar = w.querySelector<HTMLElement>('.wu-report > .reader-ruler .reader-ruler-bar'),
    rulerThumb = rulerBar?.querySelector<HTMLElement>('.reader-ruler-thumb'),
    rulerMarks = rulerBar?.querySelector<HTMLElement>('img.reader-ruler-marks')
  const rulerWith = { bar: rulerBar?.style.width || '', thumb: rulerThumb?.className || '' }
  const rulerPlain = (plain: boolean) => {
    if (!rulerBar) return
    rulerBar.style.width = plain ? '10px' : rulerWith.bar
    if (rulerMarks) rulerMarks.style.display = plain ? 'none' : ''
    if (rulerThumb) rulerThumb.className = plain ? 'reader-ruler-thumb plain' : rulerWith.thumb
  }
  // the Comments sidebar, which the checks step opens: the checks with their comments, + New check at their end, and
  // the new one among them once made
  const side = sideExample(api, 'comments')
  const sideRow = side.aside.querySelector<HTMLElement>('[data-category="alternative-explanations"]')
  const sideCount = side.aside.querySelector('.lside-heading .lside-n')
  let putBack: (() => void) | null = null
  const els = {
    root: w,
    page: w.querySelector<HTMLElement>('.wu-page'),
    k: 1,
    sideRow,
    checksShown: false,
    side: null as HTMLElement | null,
    hideChecks: () => {},
    showMargin: () => {},
    showChecks: () => {},
    showSide: () => {},
    hideSide: () => {},
  }
  els.showSide = () => {
    if (!putBack) putBack = holdSide('comments')
    if (!side.wrap.isConnected) api.ex.append(side.wrap)
    els.side = side.wrap
  }
  els.hideSide = () => {
    putBack?.()
    putBack = null
    side.wrap.remove()
    els.side = null
  }
  // the check's comment cards, placed as thimble's margin places them (report/Margin.tsx): each 8px above its passage's
  // first line, stacked 8px apart so no two meet; measured again every frame, since the page's width, its fonts and
  // the figures move the passages
  const placeComments = () => {
    if (!rail) return
    const base = rail.getBoundingClientRect().top
    const want: { card: HTMLElement; top: number; h: number }[] = []
    for (const card of rail.querySelectorAll<HTMLElement>('.wu-cm')) {
      const id = card.getAttribute('data-comment')
      const passage = id && w.querySelector(`[data-cids~="${id}"]`)
      if (passage) want.push({ card, top: (passage.getBoundingClientRect().top - base) / els.k - 8, h: card.offsetHeight })
    }
    want.sort((a, b) => a.top - b.top)
    let floor = -Infinity
    for (const it of want) {
      const top = Math.round(Math.max(it.top, floor))
      it.card.style.top = `${top}px`
      floor = top + it.h + 8
    }
  }
  // with no check comments, thimble's Report has no margin (ReportPage.tsx draws .wu-rail only for comments, or for a
  // check that is on), so the text column takes the page's width; the margin comes with the comments on the next step
  els.hideChecks = () => {
    els.checksShown = false
    w.classList.add('tour-checks-hidden')
    if (rail) rail.style.display = 'none'
    rulerPlain(true)
    if (sideRow) sideRow.style.display = 'none'
    if (sideCount) sideCount.textContent = '0'
  }
  // the margin alone, empty, as thimble stands it while a check is on and before its comments come
  els.showMargin = () => {
    if (rail) rail.style.display = ''
  }
  els.showChecks = () => {
    els.checksShown = true
    w.classList.remove('tour-checks-hidden')
    if (rail) rail.style.display = ''
    rulerPlain(false)
    if (sideRow) sideRow.style.display = ''
    if (sideCount) sideCount.textContent = '4'
  }
  els.hideChecks()
  const layout = () => {
    const r = api.rectOf(panel())
    if (!r) return false
    if (els.side) side.layout()
    Object.assign(w.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
    const k = Math.min(1, r.width / w0)
    els.k = k
    Object.assign(inner.style, { width: `${r.width / k}px`, height: `${r.height / k}px`, transform: k < 1 ? `scale(${k})` : '' })
    fitCharts()
    placeComments()
    // the ruler's thumb frames the span of the page on screen, as thimble's does
    const pg = els.page
    if (rulerBar && rulerThumb && pg?.scrollHeight) {
      const span = pg.scrollHeight - pg.clientHeight,
        H = rulerBar.clientHeight
      const h = Math.min(H, Math.max(els.checksShown ? 96 : 32, (H * pg.clientHeight) / pg.scrollHeight))
      const at = `translateY(${span > 0 ? ((H - h) * pg.scrollTop) / span : 0}px)`
      if (rulerThumb.style.transform !== at) Object.assign(rulerThumb.style, { height: `${h}px`, transform: at })
    }
  }
  return { els, layout, cleanup: () => els.hideSide() }
}
/** The captured Report (examples.json) as the Report stands now: no Slides, Story or Video beside it; the cards an
 * orientation made listed under Your work; a figure's caption whole, as text, with no scroll of its own (the capture
 * has the field it was once edited in); and no Comments pane in the sidebar, the checks being in the top bar's
 * Comments. */
const asReportNow = (w: HTMLElement) => {
  w.querySelectorAll('.wu-types .seg-opt').forEach((b) => {
    if (/^(slides|story|video)$/.test(b.querySelector('[data-doc-chip]')?.getAttribute('data-doc-chip') ?? '')) b.remove()
  })
  const orient = w.querySelector('.wu-sec[data-section="orientation"]'),
    yours = w.querySelector('.wu-sec[data-section="yours"]')
  if (orient && yours) {
    const rows = [...orient.querySelectorAll('.wu-card-row')]
    yours.querySelector('.wu-sec-head')?.after(...rows)
    const n = yours.querySelector('.wu-sec-head .wu-count')
    if (n) n.textContent = String(yours.querySelectorAll('.wu-card-row').length)
    orient.remove()
  }
  w.querySelectorAll<HTMLTextAreaElement>('textarea.wu-fig-caption').forEach((ta) => {
    const cap = document.createElement('div')
    cap.className = 'wu-fig-caption chat-text wu-fig-caption-read'
    const p = document.createElement('p')
    p.textContent = ta.value
    cap.append(p)
    ta.replaceWith(cap)
  })
  w.querySelector('.wu-side .wu-checks')?.remove()
}
// the page scrolled so `el` stands `above` px (as drawn) from the page's top
const scrollTo = (api: Api, el: Element | null | undefined, above = 120, smooth = true) => {
  const page = api.els.page as HTMLElement | null
  if (!page || !el) return
  const k = api.els.k || 1
  const top = (el.getBoundingClientRect().top - page.getBoundingClientRect().top) / k + page.scrollTop - above
  page.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
}
const inReport = (api: Api, sel: string) => (api.els.root as HTMLElement | undefined)?.querySelector<HTMLElement>(sel) ?? null

/** What the steps about the chat and the ⌘-click box say. True however the workbench reaches Claude: an API key,
 * Workload Identity Federation or the Claude Code sign-in. */
const SAID = {
  chat: [
    'Your chat with Claude',
    'Ask Claude anything about the files here. Claude cites the numbers it states, and a second Claude checks each one against your files.',
  ],
  ask: 'Type a question and press Enter. On a real card, the answer comes in a new thread in the chat.',
}

/** What the welcome says before its buttons, a paragraph of markup each: the question and that the tour uses example
 * data. */
export function welcomeTexts(): string[] {
  return ['Would you like a short tour? The demo tour uses <b>example data</b>.']
}

/** The tour, for the ask key written `key` (⌘ or ⌥ on a Mac, Ctrl or Alt elsewhere, as Settings picks). With the chat
 * column folded (`chat` false) the steps about the chat are left out. */
export function tourSteps(key: string, chat = true): Step[] {
  const steps: Step[] = [
    {
      tab: 'files', needsChat: true, example: sessionExample, anchor: chatContent, place: 'right', align: 'start', pad: 0, radius: 12,
      title: SAID.chat[0],
      body: SAID.chat[1],
      after: 'Hover over a time to see its source.',
      chips: onAnswerChip('chatChecked'),
      // the citations are checked and each holds; the pointer rests on the last one and its source shows
      demo: async (api) => {
        api.closeSource()
        showAnswer(api, 'chatChecking')
        await api.sleep(1800)
        showAnswer(api, 'chatChecked')
        await api.sleep(900)
        const mark = answerMarks(api)[2]
        const m = mark && api.rectOf(mark)
        if (!mark || !m) return
        api.cursor.show(m.x + m.width / 2 + 160, m.y - 70)
        await api.sleep(400)
        await api.cursor.move(() => {
          const r = api.rectOf(mark)
          return r && { x: r.x + r.width / 3, y: r.y + r.height * 0.6 }
        }, undefined, 900)
        await api.sleep(300)
        const src = api.showSource(mark, { demo: true })
        await api.sleep(3600)
        await api.cursor.move(m.x + m.width / 2 + 200, m.y - 90, 600)
        src?.remove()
        api.closeSource()
        api.cursor.hide()
      },
    },
    {
      tab: 'files', needsChat: true, example: sessionExample, pad: 0, radius: 12, place: ['bottom', 'right'], align: 'start',
      // the chat, and the comment card beside it once open
      anchor: (api) => {
        const card = api.fx.querySelector('.answer-cm-pop')
        return [chatContent(api), ...(card ? [card] : [])]
      },
      title: 'Explainers',
      body: 'Checks also read Claude’s answers. Explainers tints words you may need explained. Click a tint to read its comment.',
      chips: onAnswerChip('chatExplained'),
      // the explainer's tint comes on the answer, and a click on it opens its comment, which stays open
      demo: async (api) => {
        api.closeSource()
        showAnswer(api, 'chatExplained')
        await api.sleep(900)
        const tint = answerTint(api)
        const t = tint && api.rectOf(tint)
        if (!tint || !t) return
        api.cursor.show(t.x + t.width / 2 + 150, t.y - 80)
        await api.sleep(400)
        await api.cursor.move(() => {
          const r = api.rectOf(tint)
          return r && { x: r.x + r.width / 2, y: r.y + r.height * 0.6 }
        }, undefined, 900)
        await api.sleep(250)
        await api.cursor.click()
        showComment(api, tint)
        await api.sleep(700)
        const c = api.cursor.pos
        await api.cursor.move(c.x + 120, c.y + 90, 600)
        api.cursor.hide()
      },
      leave: (api) => api.closeSource(),
    },
    {
      tab: 'files', example: txExample, leave: releaseBrowser, anchor: filesPanel, place: 'left', align: 'start', pad: 0, radius: 12,
      scroll: (api) => api.els.reader?.querySelector('.reader-body') ?? null,
      scrollOver: (api) => api.els.reader?.querySelector('.reader-main') ?? null,
      title: 'Files',
      body: 'The file browser lists the folder’s files. Click one to read it. A transcript shows each step of an agent.',
    },
    {
      tab: 'files', example: txExample, place: 'left', align: 'end', pad: 0, radius: 12,
      // the Files panel, the sidebar once open, and the button that opens it
      anchor: (api) => [filesPanel, api.els.labels, sideButton('labels')],
      scroll: (api) => api.els.reader?.querySelector('.reader-body') ?? null,
      scrollOver: (api) => api.els.reader?.querySelector('.reader-main') ?? null,
      // resting on a record names its label and value, as thimble's own hover does
      tips: (api) => api.els.reader?.querySelector('.reader-body') ?? null,
      title: 'Labels',
      body: 'A label sorts records into values, by a rule or by Claude’s reading. Color by colors the records by one. Labels, at the top, lists them. Open one to see its records and correct them.',
      // back to Files, the transcript is plain again
      leave: (api) => {
        api.els.plain?.()
        releaseBrowser(api)
      },
      // Color by picks the label and the records take its colors; the Labels button opens the sidebar that lists it;
      // then the pointer rests on a record's bar and its label and value show, then on a record of another value. A
      // demo stopped early leaves the step as it ends: colored, the sidebar open
      demo: async (api) => {
        const els = api.els,
          me = api.step()
        const center = (el: Element | null | undefined) => {
          const q = api.rectOf(el)
          return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }
        }
        try {
          const trigger = els.trigger as HTMLElement | null
          const t = center(trigger)
          if (!trigger || !t) return
          api.cursor.show(t.x + 220, t.y + 170)
          await api.sleep(450)
          await api.cursor.move(() => center(trigger), undefined, 900)
          await api.sleep(250)
          await api.cursor.click()
          const menu = openColorMenu(api, trigger)
          await api.sleep(800)
          const row = menu.querySelector('[data-by^="l:"] .menu-item-label')
          await api.cursor.move(() => center(row), undefined, 800)
          await api.sleep(250)
          await api.cursor.click()
          checkLabel(menu)
          els.color()
          await api.sleep(1100)
          menu.remove()
          // Labels, at the top
          const btn = sideButton('labels')
          await api.cursor.move(() => center(btn), undefined, 900)
          await api.sleep(250)
          await api.cursor.click()
          els.showSide()
          await api.sleep(1200)
          await restOnRecords(api)
        } finally {
          if (els.step() === me) {
            els.color()
            els.showSide()
          }
        }
      },
    },
    {
      tab: 'files', example: viewsExample, leave: releaseBrowser, anchor: filesPanel, place: 'left', align: 'start', pad: 0, radius: 12,
      interact: (api) => api.els.frame ?? null,
      title: 'Views',
      body: 'thimble proposes views built for your own files. This one, on the tour’s example data, is a Timeline of every event.',
    },
    {
      tab: 'canvas', example: cardExample, clip: canvasPanel, place: 'right', align: 'center', pad: 6,
      anchor: (api) => api.els.card,
      title: 'Cards on the Canvas',
      body: 'Cards help make agents’ work visible, and thimble checks each one. Hover over an underlined value to see its source.',
      // the analyst's own hover on a value shows its source, as the demo does
      chips: (api, chip) => {
        api.stopDemo()
        api.showSource(chip)
      },
      // twice: a pointer rests on the card's 08:04 and its source shows
      demo: async (api) => {
        for (let k = 0; k < 2; k++) {
          const card = api.els.card as HTMLElement
          const chip = [...card.querySelectorAll('.mark')].find((c) => c.textContent?.trim() === '08:04') || card.querySelector('.mark')
          const c = chip && api.rectOf(chip)
          if (!chip || !c) return
          api.cursor.show(c.x + c.width / 2 + 170, c.y - 90)
          await api.sleep(450)
          // the pointer follows the value while it glides, should the card move meanwhile
          await api.cursor.move(() => {
            const r = api.rectOf(chip)
            return r && { x: r.x + r.width / 2, y: r.y + r.height * 0.6 }
          }, undefined, 950)
          await api.sleep(300)
          const src = api.showSource(chip, { demo: true })
          await api.sleep(2600)
          await api.cursor.move(c.x + c.width / 2 + 220, c.y - 120, 600)
          src?.remove()
          api.cursor.hide()
          await api.sleep(900)
        }
      },
    },
    {
      tab: 'canvas', example: cardExample, clip: canvasPanel, place: 'right', align: 'center', pad: 6, try: true, gateNext: true,
      anchor: (api) => api.els.card,
      advanceOn: (api) => api.realBox(),
      title: `${key}-click to ask`,
      body: `Hold <span class="kbd">${key}</span> and click on anything in thimble to chat about it.`,
      after: 'Now try it yourself: Next unlocks once you have.',
      // once the demo is over, a cue on the card points at an entry to try it on
      cue: (api) => {
        const card = api.els.card as HTMLElement | undefined
        const row = card && [...card.querySelectorAll('.canvas-tl-row')].find((r) => r.querySelector('.canvas-tl-time')?.textContent?.trim() === '08:29')
        const target = row?.querySelector('.canvas-tl-label')
        return card && target ? { target, within: card, label: `${key}-click here` } : null
      },
      // as the real app does it: the pointer holds ⌘ (its key shown held down) and drags over a few words of one entry of
      // the timeline; the words are selected, lit as thimble lights a selection, and the ask box opens under them with a
      // question typed; then it is the analyst's turn
      demo: async (api) => {
        const card = api.els.card as HTMLElement
        const label = [...card.querySelectorAll('.canvas-tl-row')].find((r) => r.querySelector('.canvas-tl-time')?.textContent?.trim() === '08:04')?.querySelector('.canvas-tl-label')
        const node = label && ([...label.childNodes].find((n) => n.nodeType === 3 && n.textContent?.trim()) as Text | undefined)
        if (!label || !node) return
        // the first few words of the entry, up to its first punctuation
        const words = (node.textContent ?? '').split(/[;,:]/)[0].match(/^\S+(\s+\S+){0,3}/)?.[0] ?? ''
        if (!words) return
        const at = (k: number) => {
          const r = document.createRange()
          r.setStart(node, k)
          r.setEnd(node, Math.min(node.length, k + 1))
          const b = r.getBoundingClientRect()
          return { x: b.left, y: b.top + b.height / 2 }
        }
        const a = at(0),
          z = at(words.length - 1)
        // the key badge beside the drag, never over text: at the row's height, past the end of the longest text in the
        // band it spans, inside the card
        const badgeAt = () => {
          const C = card.getBoundingClientRect(),
            H = 46,
            W = 132
          const top = a.y - H / 2
          let right = 0
          const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim()) continue
            const r = document.createRange()
            r.selectNodeContents(n)
            for (const b of r.getClientRects()) if (b.bottom > top - 4 && b.top < top + H + 4) right = Math.max(right, b.right)
          }
          return { x: Math.min(right + 28, C.right - W - 12), y: top }
        }
        api.cursor.show(a.x + 160, a.y - 150)
        await api.sleep(400)
        await api.cursor.move(a.x, a.y, 900)
        await api.sleep(250)
        api.cursor.cmd(true, badgeAt())
        await api.sleep(700)
        const sel = getSelection()!
        // the words select as they do under a real ⌘-drag: selectable, in the selection's wash
        label.classList.add('tour-selecting')
        const n = 14
        for (let k = 1; k <= n; k++) {
          sel.setBaseAndExtent(node, 0, node, Math.round((words.length * k) / n))
          await api.cursor.move(a.x + ((z.x + 6 - a.x) * k) / n, a.y, 40)
        }
        await api.sleep(750)
        const range = document.createRange()
        range.setStart(node, 0)
        range.setEnd(node, words.length)
        sel.removeAllRanges()
        label.classList.remove('tour-selecting')
        const m = api.mockAskRange(range)
        await api.sleep(250)
        api.cursor.cmd(false)
        await api.sleep(350)
        if (m) await api.type(m.input, 'Why did the database run out of connections?')
        await api.sleep(1800)
        m?.remove()
        api.cursor.hide()
        await api.sleep(250)
      },
      leave: () => {
        getSelection()?.removeAllRanges()
        document.querySelectorAll('.tour-selecting').forEach((e) => e.classList.remove('tour-selecting'))
      },
    },
    {
      sub: true, tab: 'canvas', try: true, nextWhenGone: true, backOnEsc: true, place: ['right', 'left', 'bottom', 'top'], align: 'center', pad: 6,
      // the card with its highlight and the ask box the page's own pointer drew on it
      anchor: (api) => {
        const real = api.realBox()
        if (!real) return null
        const parts = [...document.querySelectorAll('.pointer-hl, .pointer-hl-line')].filter((e) => !e.closest('.tour-root')).concat([real])
        return api.unionOf([api.els.card, ...parts].map(api.rectOf))
      },
      // moving on closes the ask box, which would otherwise stay open over the next surface
      leave: (api) => {
        api.closeBox()
        api.closeMock()
      },
      title: `${key}-click to ask`,
      body: SAID.ask,
    },
    {
      // the whole Report surface: its bar (with Export), the cards, and the page
      tab: 'report', example: reportExample, anchor: reportPanel, place: 'left', align: 'start', pad: 0, radius: 12,
      title: 'The Report',
      body: 'Your report, with cards as its figures. Write it yourself or ask Claude to revise it. Export it when it is done.',
      scroll: (api) => api.els.page ?? null,
      // the check is made on the next step: until then the report shows none of its comments, and no Comments sidebar
      demo: async (api) => {
        api.els.hideSide?.()
        api.els.hideChecks?.()
      },
    },
    {
      // the Report, the Comments sidebar beside it and the button that opens it
      tab: 'report', example: reportExample, place: 'left', align: 'start', pad: 0, radius: 12,
      anchor: (api) => [reportPanel, ...(api.els.side ? [api.els.side, sideButton('comments')] : [])],
      title: 'Checks',
      body: 'Checks read Claude’s answers, the cards and the report, and comment on what they find. Comments, at the top, lists the checks and their comments. Press + New check there to add one: say what to look for, in a line.',
      note: 'Reopen this tour with /tour in the chat.',
      scroll: (api) => api.els.page ?? null,
      leave: (api) => api.els.hideSide?.(),
      // the Comments sidebar opens beside the Report, and its + New check opens a new check, which is named and
      // described; it runs, its comments sit beside the passages they are about, and it is listed with its comments
      demo: async (api) => {
        if (api.els.checksShown) return api.els.showSide()
        api.els.hideChecks()
        api.els.showSide()
        await api.sleep(700)
        const side = api.els.side as HTMLElement | null
        const plus = side?.querySelector<HTMLElement>('.lside-add') ?? null
        const p = api.rectOf(plus)
        if (!plus || !p) return
        api.cursor.show(p.x - 180, p.y - 140)
        await api.sleep(500)
        await api.cursor.move(p.x + p.width / 2, p.y + p.height / 2, 900)
        await api.sleep(250)
        await api.cursor.click()
        const card = api.snap('checkCard').firstElementChild as HTMLElement
        card.dataset.demo = '1'
        card.classList.add('tour-in')
        api.fx.append(card)
        // beside the sidebar, at its left, as thimble opens it
        const aside = api.rectOf(side)
        const left = (aside ? aside.x : p.x) - card.offsetWidth - 10
        Object.assign(card.style, { position: 'absolute', left: `${Math.max(12, left)}px`, top: `${Math.max(12, Math.min(innerHeight - card.offsetHeight - 12, p.y - 70))}px` })
        const name = card.querySelector('input'),
          text = card.querySelector('textarea'),
          runBtn = [...card.querySelectorAll('button')].find((b) => /Run/.test(b.textContent ?? ''))
        await api.sleep(400)
        if (name) await api.type(name, 'Alternative explanations', 45)
        await api.sleep(300)
        if (text) await api.type(text, 'Where the report names a cause, look for another explanation the records support.', 30)
        runBtn?.removeAttribute('disabled')
        const b = api.rectOf(runBtn)
        await api.sleep(400)
        if (b) {
          await api.cursor.move(b.x + b.width / 2, b.y + b.height / 2, 700)
          await api.sleep(200)
          await api.cursor.click()
        }
        card.remove()
        api.cursor.hide()
        // the check is on: thimble stands the margin at once, empty until the comments come
        api.els.showMargin()
        await api.sleep(700)
        // the check is in the sidebar and its comments appear beside their passages, and stay; then the page goes to the
        // first
        api.els.showChecks()
        const row = api.els.sideRow as HTMLElement | null | undefined
        if (row) {
          row.classList.add('anchor-flash')
          window.setTimeout(() => row.classList.remove('anchor-flash'), 1600)
        }
        await api.sleep(1300)
        scrollTo(api, inReport(api, '.wu-cm'), 220)
        await api.sleep(1500)
      },
    },
  ]
  return steps.filter((s) => chat || !s.needsChat)
}
