// The tour's steps (the shape engine.ts takes): which surface each needs, what it points at, where its popover sits,
// what it says and what it brings; and what the welcome before them says. Every example is the tour's own, marked
// Example but for the views step's. Most are captured from real thimble markup (examples.json: a live page, and
// thimble's own components for the marks and comments); a step that asks the analyst to act acts only on that example,
// so nothing reaches the server. The Files and Labels steps show thimble's own Files pane and Labels sidebar over the
// tour's example folder (src/example), whose requests are answered inside its frame.
import { askKeyLabel, isMacPlatform } from '../lib/platform'
import { TIP_DELAY_MS } from '../components/Tooltip'
import { PANES_KEY, type Box, type ExamplePanes } from '../example/panes'
import { setMarkup, type Api, type Example, type Rect, type Step } from './engine'
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

// ---------- Files: the File browser stays on for the Views step, whose example lies over the Files body: a view the
// analyst left open is closed for it, and opened again once the tour moves to another step or ends.
const viewTabs = (bar: Element | null) => [...(bar?.querySelectorAll<HTMLElement>('.seg-opt') ?? [])]
let held: { el: HTMLElement; anchor: string | null } | null = null
const holdsBrowser = (s: Step | undefined) => !!s?.example && s.example === viewsExample
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
/** The Views step's leave, whether or not its example was drawn: the view opens again unless the next step holds the
 * File browser too. The engine moves to the next step right after a step's leave, so that step is known a microtask
 * later. */
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
// as they do for the analyst, and lays its example over it: the Report step's captured one (examples.json), the Labels
// step the example panes' own (panesExample). The step's end puts the sidebar back as the analyst had it.
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
  '<button type="button" class="lside-add"><svg class="icon icon-plus" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Ask for comments</button>'
/** The example sidebar on `section`, laid over the real one while it is open; the comment categories end in + Ask for
 * comments, as thimble's do. */
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

// ---------- Files and Labels: thimble's own Files pane and Labels sidebar over the tour's example folder, three made-up
// agents fixing a tea shop's checkout (src/example), in a frame laid over the page's own Files pane and, while it is
// open on its labels, the page's own Labels sidebar. The analyst uses them as in a workspace: every click, scroll, menu
// and mode works, on the example's files and its label "what the step does", and the frame answers its requests
// itself. The page's own sidebar opens and closes with the example's (the top bar's Labels button, the example's ×, a
// label's name in Files), so the panes make room for it as they do for the analyst; until the frame draws, each pane's
// place shows the pane's plain paper, never the analyst's files. Once the tour leaves these steps, the sidebar is as the
// analyst had it.

/** The box of `r` inside `outer`, in the frame's px. */
const inside = (r: Rect, outer: Rect): Box => ({ x: r.x - outer.x, y: r.y - outer.y, width: r.width, height: r.height })
/** `el` laid over `r`, or hidden without it. */
const lay = (el: HTMLElement, r: Rect | null) => {
  el.style.display = r ? '' : 'none'
  if (r) Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
}
/** The real sidebar is open on its labels. */
const labelsOpen = () => realSide()?.dataset.section === 'labels'

const panesExample = (api: Api): Example => {
  // the sidebar as the analyst had it, which the tour puts back once it leaves these steps
  const was = realSide()?.dataset.section ?? null
  // each pane's paper, as the page draws the Files pane and the sidebar
  const paper = (background: string) => {
    const d = document.createElement('div')
    d.className = 'tour-ex-paper'
    Object.assign(d.style, { background, borderRadius: 'var(--radius-pane)' })
    return d
  }
  const filesPaper = paper('var(--bg-panel)'),
    sidePaper = paper('var(--surface-card)')
  const frame = document.createElement('iframe')
  frame.className = 'tour-ex-panes'
  frame.title = 'Files (example)'
  frame.src = `${import.meta.env.BASE_URL}example.html`
  Object.assign(frame.style, { border: '0', background: 'transparent' })
  api.ex.append(filesPaper, sidePaper, frame)
  /** The page's own sidebar on its labels (open) or as the analyst had it. */
  const side = (open: boolean) => {
    if (open !== labelsOpen()) sideButton('labels')?.click()
  }
  const putBack = () => {
    const now = realSide()?.dataset.section ?? null
    if (now !== was) sideButton(was ?? now ?? 'labels')?.click()
  }
  let panes: ExamplePanes | null = null
  /** The panes in the frame, once its page has drawn them. */
  const connect = (): ExamplePanes | null => {
    if (panes) return panes
    try {
      panes = ((frame.contentWindow as unknown as Record<string, ExamplePanes | undefined> | null)?.[PANES_KEY] ?? null) as ExamplePanes | null
    } catch {
      panes = null
    }
    panes?.listen({
      // the analyst's own press, key or wheel in the panes ends a demo that plays
      input: () => api.stopDemo(),
      escape: () => api.end(),
      side,
    })
    return panes
  }
  const els = {
    frame,
    /** the sidebar's place while the example's is open, which the Labels step points at */
    labels: null as HTMLElement | null,
    /** the step on screen, read outside a demo's api, which ends with the demo */
    step: () => api.step(),
    panes: connect,
    /** the panes' part `name` and its box on the page */
    part: (name: Parameters<ExamplePanes['part']>[0]) => {
      const el = connect()?.part(name) ?? null
      const F = api.rectOf(frame)
      const r = el?.getBoundingClientRect()
      return el && F && r && r.width ? { el, at: { x: F.x + r.left + r.width / 2, y: F.y + r.top + r.height / 2 } } : null
    },
    /** colored by the label, the sidebar open on it */
    color: () => {
      connect()?.color()
      side(true)
    },
    /** as the Files step shows the transcript: the label off, the sidebar as the analyst had it */
    plain: () => {
      connect()?.plain()
      putBack()
    },
  }
  const layout = () => {
    const F = api.rectOf(api.q(filesPanel))
    const S = labelsOpen() ? api.rectOf(realSide()) : null
    lay(filesPaper, F)
    lay(sidePaper, S)
    els.labels = S ? sidePaper : null
    if (!F) return false
    const U = api.unionOf([F, S])!
    lay(frame, U)
    const p = connect()
    if (!p) return false
    p.place(inside(F, U), S && inside(S, U))
    return p.ready()
  }
  return { els, layout, cleanup: putBack }
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
  // the Comments sidebar, which the checks step opens: the checks with their comments, + Ask for comments at their end,
  // and the new one among them once made
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
 * has the field it was once edited in); no Comments pane in the sidebar, the checks being in the top bar's
 * Comments; and a comment's head with no "check" after its name. */
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
  w.querySelectorAll('.wu-cm-meta').forEach((m) => m.remove())
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
    'Your Claude Code session',
    'Ask Claude anything here. Claude cites its claims and a second agent verifies them.',
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
  // the shortcuts' key, ⌘ (Ctrl off a Mac), whichever key Settings picks for asking
  const modKey = askKeyLabel(isMacPlatform(), 'meta')
  const steps: Step[] = [
    {
      tab: 'files', needsChat: true, example: sessionExample, anchor: chatContent, place: 'right', align: 'start', pad: 0, radius: 12,
      title: SAID.chat[0],
      body: SAID.chat[1],
      after: 'Hover over a time to see its citation.',
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
      body: 'Explainers tints words you may need explained. Click a tint to read its comment.',
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
      // the Files pane, and the Labels sidebar while the example's is open
      tab: 'files', example: panesExample, anchor: (api) => [filesPanel, api.els.labels], place: 'left', align: 'start', pad: 0, radius: 12,
      interact: (api) => api.els.frame ?? null,
      title: 'Files',
      body: 'The file browser lists the folder’s files. thimble provides custom views for agent transcripts.',
    },
    {
      tab: 'files', example: panesExample, place: 'left', align: 'end', pad: 0, radius: 12,
      // the Files pane, the sidebar once open, and the button that opens it, which takes a click
      anchor: (api) => [filesPanel, api.els.labels, sideButton('labels')],
      interact: (api) => api.els.frame ?? null,
      allow: () => sideButton('labels'),
      title: 'Labels',
      body: 'A label is a classifier Claude defines with a regex, code or a prompt. The file browser can color records by a label.',
      // back to Files, the transcript is plain again
      leave: (api) => api.els.plain?.(),
      // from the transcript as the Files step shows it, Color by picks the label and the records take its colors; the
      // Labels button opens the sidebar that lists it, and the demo ends there. A demo stopped early leaves the step as
      // it ends: colored, the sidebar open
      demo: async (api) => {
        const els = api.els,
          me = api.step()
        const center = (el: Element | null | undefined) => {
          const q = api.rectOf(el)
          return q && { x: q.x + q.width / 2, y: q.y + q.height / 2 }
        }
        type Part = { el: HTMLElement; at: { x: number; y: number } } | null
        const part = (name: 'color-by' | 'color-by-label'): Part => els.part(name)
        try {
          els.panes()?.reset()
          await api.sleep(500)
          const t = part('color-by')
          if (!t) return
          api.cursor.show(t.at.x + 220, t.at.y + 170)
          await api.sleep(450)
          await api.cursor.move(() => part('color-by')?.at ?? null, undefined, 900)
          await api.sleep(250)
          await api.cursor.click()
          part('color-by')?.el.click()
          await api.sleep(800)
          if (!part('color-by-label')) return
          await api.cursor.move(() => part('color-by-label')?.at ?? null, undefined, 800)
          await api.sleep(250)
          await api.cursor.click()
          part('color-by-label')?.el.click()
          await api.sleep(1100)
          // the menu and the label's editor beside it close, as Escape closes them
          await els.panes()?.close()
          // Labels, at the top
          const btn = sideButton('labels')
          await api.cursor.move(() => center(btn), undefined, 900)
          await api.sleep(250)
          await api.cursor.click()
          els.color()
          await api.sleep(600)
          api.cursor.hide()
        } finally {
          if (els.step() === me) els.color()
        }
      },
    },
    {
      tab: 'files', example: viewsExample, leave: releaseBrowser, anchor: filesPanel, place: 'left', align: 'start', pad: 0, radius: 12,
      interact: (api) => api.els.frame ?? null,
      title: 'Views',
      body: 'thimble proposes views built for your own files. This one is a Timeline of every event.',
    },
    {
      tab: 'canvas', example: cardExample, clip: canvasPanel, place: 'right', align: 'center', pad: 6,
      anchor: (api) => api.els.card,
      title: 'Cards on the Canvas',
      body: 'Cards help make agents’ work visible.',
    },
    {
      tab: 'canvas', example: cardExample, clip: canvasPanel, place: 'right', align: 'center', pad: 6, try: true,
      anchor: (api) => api.els.card,
      advanceOn: (api) => api.realBox(),
      title: `${key}-click to ask`,
      body: `Hold <span class="kbd">${key}</span> and click on anything in thimble to chat about it.`,
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
      title: 'Report',
      body: `Write the report yourself or ask Claude to write it. Drag in cards or <span class="kbd">${modKey}+Enter</span> to request one.`,
      note: 'Reopen this tour with /tour in the chat.',
      scroll: (api) => api.els.page ?? null,
      // the report from its top, with none of its comments and no Comments sidebar
      demo: async (api) => {
        api.els.hideSide?.()
        api.els.hideChecks?.()
        const page = api.els.page as HTMLElement | null
        page?.scrollTo({ top: 0 })
        await api.sleep(300)
        page?.scrollTo({ top: 0 })
      },
    },
  ]
  return steps.filter((s) => chat || !s.needsChat)
}
