// The tour's steps (the shape engine.ts takes): which surface each needs, what it points at, where its popover sits,
// what it says and what it brings; and what the welcome before them says. Every example is the tour's own, marked
// Example but for the views step's. Most are captured from real thimble markup (examples.json: a live page, and
// thimble's own components for the marks and comments); a step that asks the analyst to act acts only on that example,
// so nothing reaches the server. The Files, Labels and Report steps show thimble's own Files pane, Labels sidebar,
// Report and Comments sidebar over the tour's example folder (src/example), whose requests are answered inside its
// frame.
import { askKeyLabel, isMacPlatform } from '../lib/platform'
import { TIP_DELAY_MS } from '../components/Tooltip'
import { PANES_KEY, type Box, type ExampleFrame, type ExamplePanes, type PaneKind } from '../example/panes'
import { setMarkup, type Api, type Example, type Rect, type Step } from './engine'

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
// its own section. A step whose example has a sidebar opens the page's own on that section with its button, so the
// panes make room for it as they do for the analyst, and lays the example's over it (frameExample). The step's end puts
// the sidebar back as the analyst had it.
type SideSection = 'labels' | 'comments'
const realSide = () => [...document.querySelectorAll<HTMLElement>('aside.lside')].find((e) => !e.closest('.tour-root')) ?? null
const sideButton = (section: string) => document.querySelector<HTMLElement>(`.shell-side-btn[data-side="${section}"]`)

// ---------- Files, Labels and Report: thimble's own panes over the tour's example folder, three made-up agents fixing a
// tea shop's checkout (src/example), in a frame laid over the page's own: the Files pane and, while it is open on its
// labels, the Labels sidebar, for the Files and Labels steps; the Report and, while it is open on its comments, the
// Comments sidebar, for the Report step. The analyst uses them as in a workspace: every click, scroll, menu, mode and
// edit works, on the example's files, its label "what the step does" and the report main wrote about them, and the
// frame answers its requests itself. The page's own sidebar opens and closes with the example's (the top bar's button,
// the example's ×, a label's name in Files), so the panes make room for it as they do for the analyst; until the frame
// draws, each pane's place shows the pane's plain paper, never the analyst's own. Once the tour leaves these steps, the
// sidebar is as the analyst had it.

/** Each frame's place: the page's pane it lies over, and the section of the sidebar it opens. */
const FRAMES: Record<PaneKind, { panel: string; section: SideSection; title: string }> = {
  files: { panel: filesPanel, section: 'labels', title: 'Files (example)' },
  report: { panel: reportPanel, section: 'comments', title: 'Report (example)' },
}

/** The box of `r` inside `outer`, in the frame's px. */
const inside = (r: Rect, outer: Rect): Box => ({ x: r.x - outer.x, y: r.y - outer.y, width: r.width, height: r.height })
/** `el` laid over `r`, or hidden without it. */
const lay = (el: HTMLElement, r: Rect | null) => {
  el.style.display = r ? '' : 'none'
  if (r) Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` })
}

/** The example frame of `kind` (FRAMES), as the example of the steps that show it. */
function frameExample(api: Api, kind: PaneKind): Example {
  const { panel, section, title } = FRAMES[kind]
  /** The real sidebar is open on the frame's section. */
  const sideShown = () => realSide()?.dataset.section === section
  // the sidebar as the analyst had it, which the tour puts back once it leaves these steps
  const was = realSide()?.dataset.section ?? null
  // each pane's paper, as the page draws the pane and the sidebar
  const paper = (background: string) => {
    const d = document.createElement('div')
    d.className = 'tour-ex-paper'
    Object.assign(d.style, { background, borderRadius: 'var(--radius-pane)' })
    return d
  }
  const panePaper = paper('var(--bg-panel)'),
    sidePaper = paper('var(--surface-card)')
  const frame = document.createElement('iframe')
  frame.className = 'tour-ex-panes'
  frame.title = title
  frame.src = `${import.meta.env.BASE_URL}example.html${kind === 'report' ? '?pane=report' : ''}`
  Object.assign(frame.style, { border: '0', background: 'transparent' })
  api.ex.append(panePaper, sidePaper, frame)
  /** The page's own sidebar on the frame's section (open) or as the analyst had it. */
  const side = (open: boolean) => {
    if (open !== sideShown()) sideButton(section)?.click()
  }
  const putBack = () => {
    const now = realSide()?.dataset.section ?? null
    if (now !== was) sideButton(was ?? now ?? section)?.click()
  }
  let panes: ExampleFrame | null = null
  /** The panes in the frame, once its page has drawn them. */
  const connect = (): ExampleFrame | null => {
    if (panes) return panes
    try {
      panes = ((frame.contentWindow as unknown as Record<string, ExampleFrame | undefined> | null)?.[PANES_KEY] ?? null) as ExampleFrame | null
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
  /** The Files frame's panes, which the Labels step's demo drives. */
  const files = () => (kind === 'files' ? (connect() as ExamplePanes | null) : null)
  const els = {
    frame,
    /** the sidebar's place while the example's is open, which the step points at */
    side: null as HTMLElement | null,
    /** the step on screen, read outside a demo's api, which ends with the demo */
    step: () => api.step(),
    panes: files,
    /** the panes' part `name` and its box on the page */
    part: (name: Parameters<ExamplePanes['part']>[0]) => {
      const el = files()?.part(name) ?? null
      const F = api.rectOf(frame)
      const r = el?.getBoundingClientRect()
      return el && F && r && r.width ? { el, at: { x: F.x + r.left + r.width / 2, y: F.y + r.top + r.height / 2 } } : null
    },
    /** colored by the label, the sidebar open on it */
    color: () => {
      files()?.color()
      side(true)
    },
    /** as the Files step shows the transcript: the label off, the sidebar as the analyst had it */
    plain: () => {
      files()?.plain()
      putBack()
    },
  }
  const layout = () => {
    const P = api.rectOf(api.q(panel))
    const S = sideShown() ? api.rectOf(realSide()) : null
    lay(panePaper, P)
    lay(sidePaper, S)
    els.side = S ? sidePaper : null
    if (!P) return false
    const U = api.unionOf([P, S])!
    lay(frame, U)
    const p = connect()
    if (!p) return false
    p.place(inside(P, U), S && inside(S, U))
    return p.ready()
  }
  return { els, layout, cleanup: putBack }
}
/** The Files pane's frame, which the Files and Labels steps share, and the Report's. */
const panesExample = (api: Api) => frameExample(api, 'files')
const reportExample = (api: Api) => frameExample(api, 'report')

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
      tab: 'files', example: panesExample, anchor: (api) => [filesPanel, api.els.side], place: 'left', align: 'start', pad: 0, radius: 12,
      interact: (api) => api.els.frame ?? null,
      title: 'Files',
      body: 'The file browser lists the folder’s files. thimble provides custom views for agent transcripts.',
    },
    {
      tab: 'files', example: panesExample, place: 'left', align: 'end', pad: 0, radius: 12,
      // the Files pane, the sidebar once open, and the button that opens it, which takes a click
      anchor: (api) => [filesPanel, api.els.side, sideButton('labels')],
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
      // the whole Report surface (its bar with History, Export and Revise, the cards, the page), the Comments sidebar
      // once open, and the top bar's button that opens it, which takes a click
      tab: 'report', example: reportExample, anchor: (api) => [reportPanel, api.els.side, sideButton('comments')], place: 'left', align: 'start', pad: 0, radius: 12,
      interact: (api) => api.els.frame ?? null,
      allow: () => sideButton('comments'),
      title: 'Report',
      body: `Write the report yourself or ask Claude to write it. Drag in cards or <span class="kbd">${modKey}+Enter</span> to request one.`,
      note: 'Reopen this tour with /tour in the chat.',
    },
  ]
  return steps.filter((s) => chat || !s.needsChat)
}
