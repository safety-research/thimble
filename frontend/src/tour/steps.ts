// The tour's steps (the shape engine.ts takes): which surface each needs, what it points at, where its popover sits,
// what it says and what it brings. Every example is the tour's own (examples.json, captured from real thimble markup;
// all but the views step's are marked Example); a step that asks the analyst to act acts only on that example, so
// nothing reaches the server.
import { setMarkup, type Api, type Example, type Step } from './engine'
import reportFigs from './report-figs.json'

const canvasPanel = '[data-panel="canvas"].shell-panel'
const filesPanel = '[data-panel="files"].shell-panel'
const reportPanel = '[data-panel="report"].shell-panel'
const chatSel = '.chat[data-panel="chat"]'

// ---------- the chat and the terminal: an example exchange in main's chat, and on the next step the same exchange in a
// Claude Code terminal that slides in from the right edge as a window of its own
const cite = (v: string) => `<span class="refchip refchip-value refchip-citation">${v}</span>`
const QUESTION = 'When did payments 4.12.0 go out, and was it still live when INC-312 opened?'
const ANSWER = (c: (v: string) => string) =>
  `It went out at ${c('02:06')} UTC (deploys.csv writes UK time, so 03:06 there) and was still live when INC-312 opened at ${c('08:02')}. The rollback to 4.11.3 began at ${c('08:28')}.`
const chatHtml = `<div class="chat-flow" style="min-height:0">
  <div class="chat-msg chat-user"><p class="msg-user chat-message">${QUESTION}</p></div>
  <div class="chat-msg chat-calls"><div class="chat-callrun" data-calls="2" data-state="done"><span class="chat-callrun-head"><button type="button" class="chat-callchip chat-callrun-chip" aria-expanded="false"><span class="chat-callrun-tools"><span class="chat-callrun-tool"><span class="chat-callrun-name">Bash</span><span class="chat-callrun-n">2</span></span></span><svg class="icon icon-chevron-right chat-callchip-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button></span></div></div>
  <div class="chat-msg chat-assistant"><div class="chat-text"><p>${ANSWER(cite)}</p></div></div>
</div>`
const termHtml = `<div class="tour-term-bar"><i></i><i></i><i></i><span>Your Claude Code terminal</span></div>
<div class="tour-term-body">
  <div class="t-line"><span class="t-logo"> ▐▛███▛█</span>   <b>Claude Code</b></div>
  <div class="t-line"><span class="t-logo">▝▜██████▀</span>  <span class="t-dim">Opus 5.5</span></div>
  <div class="t-line"><span class="t-logo"> ▝▝   ▝▝</span>   <span class="t-dim">~/incident-timeline</span></div>
  <div class="t-gap"></div>
  <div class="t-line t-you"><span class="t-caret">❯</span> ${QUESTION}</div>
  <div class="t-gap"></div>
  <div class="t-line t-hang">● <b>Bash</b>(grep -n "4.12.0" deploys.csv)</div>
  <div class="t-line t-out t-dim">⎿  4:2026-05-16T03:06:02+01:00,dep-19,started,payments,4.12.0,…<br>   5:2026-05-16T03:11:31+01:00,dep-19,finished,payments,4.12.0,…<br>   … +2 lines (ctrl+o to expand)</div>
  <div class="t-gap"></div>
  <div class="t-line t-hang">● <b>Bash</b>(grep -m1 -n "INC-312" agents.log)</div>
  <div class="t-line t-out t-dim">⎿  7:2026-05-16T08:02:04Z INFO pagerbot action=open incident=INC-312 …</div>
  <div class="t-gap"></div>
  <div class="t-line t-hang">● ${ANSWER((v) => v)}</div>
  <div class="t-gap"></div>
  <div class="t-line t-dim">✻ Worked for 9s</div>
  <div class="t-rule"></div>
  <div class="t-line"><span class="t-caret2">❯</span> <span class="t-cursor"></span></div>
  <div class="t-rule"></div>
</div>`

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
  const term = document.createElement('div')
  term.className = 'tour-term'
  setMarkup(term, termHtml)
  api.tag(term.querySelector<HTMLElement>('.tour-term-bar')!)
  Object.assign(term.style, { visibility: 'hidden', opacity: '0' })
  api.ex.append(ex, term)
  let shown = false
  const layout = () => {
    const C = api.rectOf(api.q(chatSel)),
      L = api.rectOf(list),
      F = api.rectOf(api.q(`${chatSel} .chat-foot`))
    if (!C || !L) return
    Object.assign(ex.style, { left: `${C.x}px`, top: `${L.y}px`, width: `${C.width}px`, height: `${(F ? F.y : C.y + C.height) - L.y}px` })
    const width = Math.round(Math.max(440, Math.min(720, innerWidth * 0.4)))
    Object.assign(term.style, { left: `${innerWidth - width - 28}px`, top: `${C.y + 28}px`, width: `${width}px` })
    const want = !!api.step()?.terminal
    if (want !== shown) {
      shown = want
      if (want) {
        Object.assign(term.style, { transition: 'none', transform: `translateX(${width + 60}px)`, visibility: 'visible', opacity: '1' })
        term.getBoundingClientRect()
        Object.assign(term.style, { transition: '', transform: 'translateX(0)' })
      } else Object.assign(term.style, { transform: `translateX(${width + 60}px)`, opacity: '0', visibility: 'hidden' })
    }
  }
  return { els: { chat: ex, flow: inner, term }, layout }
}
// the chat as the step shows it: the chat panel's own width, from its head to 14px past the end of the example exchange
const chatContent = (api: Api) => {
  const C = api.rectOf(api.q(chatSel)),
    flow = (api.els.flow as HTMLElement | undefined)?.querySelector('.chat-flow')
  const F = flow && api.rectOf(flow)
  if (!C || !F) return null
  return { x: C.x, y: C.y, width: C.width, height: Math.min(C.y + C.height, F.y + F.height + 14) - C.y }
}

// ---------- the orientation: the example Start gate over the chat's foot. Its Start starts nothing: the step shows at
// once what a started orientation looks like (captured from a real run), the note in the chat and the strip over the
// reply box
const startOf = (g: Element | null | undefined) => [...(g?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Start') || null
const orientExample = (api: Api): Example => {
  const chat = api.q(chatSel),
    ground = api.groundOf(chat)
  const g = api.snap('gate', 'tour-ex-gate')
  ;(g.firstElementChild as HTMLElement).style.margin = '0'
  g.style.background = ground
  Object.assign(api.tag(g).style, { top: '8px', right: '10px' })
  const foot = api.snap('orientFoot', 'tour-ex-orient-foot')
  const note = api.snap('orientNote', 'tour-ex-orient-note')
  for (const e of [foot, note]) {
    e.style.background = ground
    e.style.display = 'none'
  }
  foot.dataset.ground = '1'
  ;(note.firstElementChild as HTMLElement).style.padding = '8px 2px'
  // laid out in its own box: the real foot is placed at the chat's bottom by the chat's own layout
  const footEl = foot.querySelector<HTMLElement>('.chat-foot')
  if (footEl) Object.assign(footEl.style, { position: 'static', inset: 'auto' })
  api.ex.append(g, foot, note)
  const els = { gate: g, foot, note, started: false }
  startOf(g)?.addEventListener('click', () => {
    els.started = true
    g.remove()
    foot.style.display = ''
    note.style.display = ''
  })
  const layout = () => {
    const C = api.rectOf(api.q(chatSel)),
      L = api.rectOf(api.q(`${chatSel} .chat-list`))
    if (!C) return
    if (g.isConnected) Object.assign(g.style, { left: `${C.x}px`, width: `${C.width}px`, top: `${C.y + C.height - g.offsetHeight}px` })
    // over the whole of the gate's place, so nothing of the gate shows above the shorter foot
    const RF = api.rectOf(api.q(`${chatSel} .chat-foot`))
    const fh = Math.max(RF ? RF.height : 0, (foot.firstElementChild as HTMLElement | null)?.offsetHeight || 0)
    Object.assign(foot.style, { left: `${C.x}px`, width: `${C.width}px`, height: `${fh}px`, top: `${C.y + C.height - fh}px`, flexDirection: 'column', justifyContent: 'flex-end' })
    if (foot.style.display !== 'none') foot.style.display = 'flex'
    if (L) Object.assign(note.style, { left: `${C.x}px`, width: `${C.width}px`, top: `${L.y}px` })
  }
  return { els, layout }
}

// ---------- Files: the file browser (a view left open is closed for the step, and opened again after it)
const viewTabs = (bar: Element | null) => [...(bar?.querySelectorAll<HTMLElement>('.seg-opt') ?? [])]
const filesExample = (api: Api): Example => {
  const tabs = viewTabs(api.q('.files-views'))
  const was = tabs.find((e) => e.classList.contains('active'))
  const browser = tabs.find((e) => /File browser/.test(e.textContent ?? ''))
  if (browser && was !== browser) browser.click()
  return {
    cleanup: () => {
      if (was && was !== browser && was.isConnected && !was.classList.contains('active')) was.click()
    },
  }
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
  api.ex.append(bar, body)
  const layout = () => {
    const B = api.rectOf(realBar()),
      D = api.rectOf(realBody())
    if (B) Object.assign(bar.style, { left: `${B.x}px`, top: `${B.y}px`, width: `${B.width}px`, height: `${B.height}px` })
    if (D) Object.assign(body.style, { left: `${D.x}px`, top: `${D.y}px`, width: `${D.width}px`, height: `${D.height}px` })
    return !!(B && D)
  }
  return { els: { bar, body, frame }, layout }
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
  return { els: { card: art, wrap: w, real: false }, layout }
}

// ---------- Labels: one agent's transcript in the Transcript view with two labels on it, each in colours of its own:
// what each step does (four values) and whether it coordinates with other agents (yes/no); the ruler beside it shows
// both down the whole file. Captured, with the Labels pane that lists them.
const labelsExample = (api: Api): Example => {
  const realReader = () => api.q('[data-panel="files"] .reader')
  const rd = api.snap('txReader', 'tour-ex-reader')
  const reader = rd.firstElementChild as HTMLElement
  reader.querySelectorAll('.reader-tab:not(.active)').forEach((t) => t.remove())
  Object.assign(rd.style, { display: 'flex', flexDirection: 'column', background: api.groundOf(realReader() || api.q(filesPanel)) })
  Object.assign(reader.style, { flex: '1', minHeight: '0', overflow: 'hidden' })
  Object.assign(api.tag(rd).style, { left: '50%', right: 'auto', transform: 'translateX(-50%)' })
  const lab = api.snap('txLabels', 'tour-ex-labels')
  lab.style.background = api.groundOf(api.q('.files-labels'))
  Object.assign(api.tag(lab).style, { right: '40px' })
  api.ex.append(rd, lab)
  // the transcript opens at line 22 and stays there while the panel's size changes, until anything else scrolls it
  let pinned = true,
    setTo: number | null = null
  const layout = () => {
    let r = api.rectOf(realReader())
    if (!r) {
      const p = api.rectOf(api.q(filesPanel)),
        sd = api.rectOf(api.q('.files-side'))
      if (p && sd) r = { x: sd.x + sd.width, y: sd.y, width: p.x + p.width - sd.x - sd.width, height: sd.height }
    }
    // in a narrow Files panel thimble hides its sidebar: the example's Labels pane then takes the reader's left 250 px
    const L = api.rectOf(api.q('.files-labels'))
    if (r && !L) {
      Object.assign(lab.style, { left: `${r.x}px`, width: '250px', top: `${r.y + r.height - lab.offsetHeight}px` })
      r = { x: r.x + 251, y: r.y, width: r.width - 251, height: r.height }
    }
    if (!r) return false
    Object.assign(rd.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
    if (L) Object.assign(lab.style, { left: `${L.x}px`, width: `${L.width}px`, top: `${L.y + L.height - lab.offsetHeight}px` })
    const sc = rd.querySelector<HTMLElement>('.reader-body')
    if (!sc || !sc.clientHeight) return
    if (pinned && setTo != null && Math.abs(sc.scrollTop - setTo) > 1) pinned = false
    if (pinned) {
      const row = rd.querySelector('[data-line="22"]')
      if (row) {
        sc.scrollTop += row.getBoundingClientRect().top - sc.getBoundingClientRect().top - 6
        setTo = sc.scrollTop
      }
    }
    // the ruler's thumb frames the span on screen, as thimble's does
    const bar = rd.querySelector<HTMLElement>('.reader-ruler-bar'),
      thumb = rd.querySelector<HTMLElement>('.reader-ruler-thumb')
    if (bar && thumb) {
      const span = sc.scrollHeight - sc.clientHeight
      const h = Math.max(32, (bar.clientHeight * sc.clientHeight) / sc.scrollHeight)
      Object.assign(thumb.style, { height: `${h}px`, transform: `translateY(${span > 0 ? ((bar.clientHeight - h) * sc.scrollTop) / span : 0}px)` })
    }
  }
  return { els: { reader: rd, labels: lab }, layout }
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
    const cap = fig.querySelector<HTMLElement & { value?: string }>('.wu-fig-caption')
    const text = 'The database came close to its limit only while version 4.12.0 was running.'
    if (cap) {
      cap.textContent = text
      if ('value' in cap) cap.value = text
    }
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
  const checkRow = [...w.querySelectorAll<HTMLElement>('.wu-check')].find((e) => /Alternative explanations/.test(e.textContent ?? ''))
  const checksCount = w.querySelector('.wu-checks-head .wu-count')
  const els = {
    root: w,
    page: w.querySelector<HTMLElement>('.wu-page'),
    real: false,
    k: 1,
    checkRow,
    checksCount,
    checksShown: false,
    hideChecks: () => {},
    showMargin: () => {},
    showChecks: () => {},
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
    if (checkRow) checkRow.style.display = 'none'
    if (checksCount) checksCount.textContent = '3'
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
    if (checkRow) checkRow.style.display = ''
    if (checksCount) checksCount.textContent = '4'
  }
  els.hideChecks()
  const layout = () => {
    const r = api.rectOf(panel())
    if (!r) return false
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
  return { els, layout }
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

/** The tour, for a pointer key written `key` (⌘ on a Mac, Ctrl elsewhere). With the chat column folded (`chat` false)
 * the steps about the chat are left out. */
export function tourSteps(key: string, chat = true): Step[] {
  const steps: Step[] = [
    {
      tab: 'files', needsChat: true, example: sessionExample, anchor: chatContent, place: 'right', align: 'start', pad: 0, radius: 12,
      title: 'Your Claude Code session',
      body: 'This chat is your Claude Code session: ask it anything about the files.',
    },
    {
      tab: 'files', needsChat: true, terminal: true, example: sessionExample, place: ['left', 'bottom'], align: 'start', pad: 0, radius: 10,
      anchor: (api) => [api.els.term, chatContent(api)],
      title: 'Your terminal',
      body: 'The session also runs in the terminal where you started thimble. It shows the same conversation, and you can type in either.',
    },
    {
      tab: 'files', needsChat: true, example: orientExample, place: 'right', align: 'end', pad: 0, radius: 12, gateNext: true,
      allow: (api) => (api.els.gate?.isConnected ? startOf(api.els.gate) : null),
      anchor: (api) => {
        if (!api.els.started) return api.els.gate
        if (api.run) api.run.tried = true
        const foot = api.els.foot.querySelector('.chat-foot') || api.els.foot
        return [foot, api.els.note]
      },
      title: 'The orientation',
      body: (api) =>
        api.els.started
          ? 'The orientation has started. It can take a while, depending on your dataset, prompt and model.'
          : 'A background agent explores your files and drafts an analysis for you to review. Press Start to begin it now.',
    },
    {
      tab: 'files', example: filesExample, anchor: filesPanel, place: 'left', align: 'start', pad: 0, radius: 12,
      title: 'Files',
      body: `${chat ? 'In the meantime, you can explore the files and views. ' : ''}The files browser exposes global views on the corpus.`,
    },
    {
      tab: 'files', example: labelsExample, place: 'left', align: 'end', pad: 0, radius: 0,
      anchor: (api) => [api.els.labels, api.els.reader],
      scroll: (api) => api.els.reader?.querySelector('.reader-body') ?? null,
      scrollOver: (api) => api.els.reader?.querySelector('.reader-main') ?? null,
      title: 'Labels',
      body: 'Labels are custom classifiers that are applied to files.',
    },
    {
      tab: 'files', example: viewsExample, anchor: filesPanel, place: 'left', align: 'start', pad: 0, radius: 12,
      interact: (api) => api.els.frame ?? null,
      title: 'Views',
      body: 'The orientation also proposes views, custom-generated just for your corpus, like this Timeline of every event.',
    },
    {
      tab: 'canvas', example: cardExample, clip: canvasPanel, place: 'right', align: 'center', pad: 6,
      anchor: (api) => api.els.card,
      title: 'Cards on the Canvas',
      body: 'Cards help make agents’ work visible. Hover over an underlined value to see its source.',
      // the analyst's own hover on a value shows its source, as the demo does
      chips: (api, chip) => {
        api.stopDemo()
        api.showSource(chip)
      },
      // twice: a pointer rests on the card's 08:04 and its source shows
      demo: async (api) => {
        for (let k = 0; k < 2; k++) {
          const card = api.els.card as HTMLElement
          const chip = [...card.querySelectorAll('.refchip-value')].find((c) => c.textContent?.trim() === '08:04') || card.querySelector('.refchip-value')
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
        if (api.realBox()) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        api.closeMock()
      },
      title: `${key}-click to ask`,
      body: 'Type a question and press Enter. On a real card, the answer comes in a new thread in the chat.',
    },
    {
      // the whole Report surface: its bar (with Export), the cards and checks, and the page
      tab: 'report', example: reportExample, anchor: reportPanel, place: 'left', align: 'start', pad: 0, radius: 12,
      title: 'The Report',
      body: 'It is written from your cards and threads, with the cards as its figures. You can edit it and export it.',
      scroll: (api) => api.els.page ?? null,
      // the check is made on the next step: until then the report shows none of its comments
      demo: async (api) => api.els.hideChecks?.(),
    },
    {
      tab: 'report', example: reportExample, anchor: reportPanel, place: 'left', align: 'start', pad: 0, radius: 12,
      title: 'Checks',
      body: 'Checks read the report and comment on its passages. Press + in Checks and describe what to look for, in a line.',
      note: 'Reopen this tour from Settings.',
      scroll: (api) => api.els.page ?? null,
      // + in the Checks pane opens a new check, which is named and described; it runs, and its comments sit beside the
      // passages they are about
      demo: async (api) => {
        const plus = inReport(api, '.wu-checks-add')
        const p = api.rectOf(plus)
        if (!plus || !p) return
        if (api.els.checksShown) return
        api.els.hideChecks()
        api.cursor.show(p.x + 180, p.y - 140)
        await api.sleep(500)
        await api.cursor.move(p.x + p.width / 2, p.y + p.height / 2, 900)
        await api.sleep(250)
        await api.cursor.click()
        const card = api.snap('checkCard').firstElementChild as HTMLElement
        card.dataset.demo = '1'
        card.classList.add('tour-in')
        api.fx.append(card)
        const aside = api.rectOf(plus.closest('aside') || plus.parentElement)
        const left = (aside ? aside.x + aside.width : p.x + p.width) + 10
        Object.assign(card.style, { position: 'absolute', left: `${Math.min(left, innerWidth - 352)}px`, top: `${Math.max(12, Math.min(innerHeight - card.offsetHeight - 12, p.y - 70))}px` })
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
        // the check is in the pane and its comments appear beside their passages, and stay; then the page goes to the first
        api.els.showChecks()
        const row = api.els.checkRow as HTMLElement | undefined
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
