// The product tour's engine: an overlay over the live workbench. The page is dimmed except for one or more cutouts; a
// popover beside the first holds a title, a sentence or two, the step count, Skip tour on the first step or Back on the
// others, and Next (Done on the last step). While the tour runs the page is frozen (./freeze): no click, key or scroll
// reaches it, cutouts included. The exceptions: on a step with `allow`, clicks and typing inside the element it names
// reach the page; on a step with `scroll`, the wheel over the element it names scrolls it; on a step with `interact`,
// the frame it names takes the pointer and the wheel; on a step marked `try`, holding ⌘ (Ctrl off a Mac) and moving
// over its cutout highlights what is under the pointer, a ⌘-click or ⌘-drag there reaches the page, and once the ask box
// is open, typing in it does; on a step with `chips`, hovering an underlined value in its card shows that value's
// source. Esc closes the tour; while an ask box or a source is open, Esc closes only that.
//
// Examples are the tour's own markup (./examples.json, ./steps), laid over the page under the dim and removed when
// their step ends. Nothing the tour shows reaches the server.
import { isMacPlatform, isPointKey, pointKeyHeld } from '../lib/platform'
import { setGuard } from './freeze'
import './tour.css'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export type Anchor = string | Element | Rect | null | undefined
type Place = 'right' | 'left' | 'top' | 'bottom'

/** What an example puts on the page: its elements (steps read them through api.els), a layout run every frame, and
 * what to undo when it is removed. */
export interface Example {
  els?: Els
  layout?: () => void
  cleanup?: () => void
}
export type Els = Record<string, any>

export interface Step {
  /** the surface the step shows */
  tab?: 'files' | 'canvas' | 'report'
  /** a selector, element or rect, or a list of them (one cutout each), or a function of the api returning that */
  anchor?: Anchor | Anchor[] | ((api: Api) => Anchor | Anchor[])
  /** a selector the cutouts are kept inside */
  clip?: string
  pad?: number
  radius?: number
  /** where the popover sits beside the first cutout; a list is tried in order, and the first side where the popover
   * fits in the window without covering a cutout wins (else the side, of all four, where it covers least) */
  place?: Place | Place[]
  align?: 'start' | 'center' | 'end'
  title: string
  body: string | ((api: Api) => string)
  /** added to the body once the demo ends */
  after?: string
  note?: string
  /** shares the previous step's number, reached through advanceOn */
  sub?: boolean
  /** moves the tour to the next (sub) step once truthy */
  advanceOn?: (api: Api) => unknown
  /** moves on once the cutout goes */
  nextWhenGone?: boolean
  /** with nextWhenGone: an ask box closed with Esc goes back to the main step */
  backOnEsc?: boolean
  /** content the tour brings, kept through the step's sub steps and through the next step that brings the same example */
  example?: (api: Api) => Example
  /** an animation, stopped when the tour moves */
  demo?: (api: Api, signal: AbortSignal) => Promise<void>
  /** an element whose clicks and typing reach the page */
  allow?: (api: Api) => Element | null
  /** an element the wheel scrolls */
  scroll?: (api: Api) => HTMLElement | null
  /** the element the wheel must be over to scroll `scroll` (else `scroll` itself) */
  scrollOver?: (api: Api) => Element | null
  /** a frame that takes the pointer and the wheel */
  interact?: (api: Api) => Element | null
  /** the cutout takes a ⌘-click or ⌘-drag */
  try?: boolean
  /** a hover on an underlined value of the example's card */
  chips?: (api: Api, chip: Element) => void
  /** no Next until the try was made */
  gateNext?: boolean
  /** run when the tour moves off the step */
  leave?: (api: Api) => void
  /** the terminal window of the session example slides in on this step */
  terminal?: boolean
  /** the step shows the chat column, so a layout without one leaves it out */
  needsChat?: boolean
}

type Demo = 'none' | 'waiting' | 'playing' | 'done' | 'stopped'
interface Run {
  group: number
  ac: AbortController
  demoAc: AbortController | null
  cleanups: (() => void)[]
  layout: (() => void) | null
  els: Els
  demo: Demo
  after: boolean
  ready: boolean
  tried?: boolean
  warned?: boolean
}

export interface StartOptions {
  /** the step to start on */
  at?: number
  /** the first launch: a small card asks first whether to take the tour */
  welcome?: boolean
  /** the tour was asked for again (Settings) */
  replay?: boolean
  /** shows a surface (the shell's own tab switch) */
  showTab?: (tab: 'files' | 'canvas' | 'report') => void
  /** called once the tour has closed, however it closed */
  onEnd?: () => void
}

export interface Snaps {
  [name: string]: string | Record<string, string>
}

export interface Api {
  MAC: boolean
  pointHeld: (e: MouseEvent | KeyboardEvent) => boolean
  rectOf: (el: Element | null | undefined) => Rect | null
  unionOf: (rs: (Rect | null)[]) => Rect | null
  q: (sel: string) => HTMLElement | null
  realBox: () => HTMLElement | null
  liveMock: () => HTMLElement | null
  readonly ex: HTMLElement
  readonly fx: HTMLElement
  readonly host: HTMLElement
  readonly els: Els
  readonly run: Run | null
  readonly replay: boolean
  step: () => Step | undefined
  sleep: (ms: number) => Promise<void>
  snap: (name: string | null, wrapCls?: string | null, raw?: string, opts?: { keepAnchors?: boolean }) => HTMLDivElement
  tag: (el: HTMLElement, text?: string) => HTMLSpanElement
  groundOf: (el: Element | null) => string
  cursor: Cursor
  mockAsk: (target: Element, opts?: { live?: boolean; region?: boolean; text?: string | null }) => Mock | null
  mockAskRange: (range: Range, opts?: { text?: boolean }) => Mock | null
  closeMock: () => void
  showSource: (chip: Element, opts?: { demo?: boolean }) => HTMLElement | null
  closeSource: () => void
  type: (input: HTMLInputElement | HTMLTextAreaElement, text: string, ms?: number) => Promise<void>
  stopDemo: () => void
  /** close the tour */
  end: () => void
}

interface Mock {
  hl: HTMLElement
  box: HTMLElement
  input: HTMLTextAreaElement
  remove: () => void
}

interface Cursor {
  show: (x: number, y: number) => void
  move: (x: number, y: number, ms?: number) => Promise<void>
  cmd: (on: boolean, at?: { x: number; y: number } | null) => void
  click: () => Promise<void>
  hide: () => void
  readonly pos: { x: number; y: number }
}

export interface Geometry {
  holes: Box[]
  targets: Box[]
  pad: number
  pop: Box | null
  caret: Box | null
  viewport: { w: number; h: number }
}

export interface TourState {
  i: number
  title: string | undefined
  n: number
  total: number
  rect: Rect | null
  holes: number
  demo: Demo
  after: boolean
  welcome: boolean
}

export interface Tour {
  start: (steps: Step[], opts?: StartOptions) => void
  end: () => number
  api: Api
  geometry: () => Geometry | null
  state: () => TourState
  running: () => boolean
}

const MAC = isMacPlatform()
const pointHeld = (e: MouseEvent | KeyboardEvent) => pointKeyHeld(e, MAC)
const KEYS = new Set(['keydown', 'keyup', 'keypress'])
const SCROLLS = new Set(['wheel', 'touchmove'])
const CONTAINED = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'wheel']
// the attributes the app reads (anchors, refs, telemetry), renamed data-tour-* in a snapshot so the app takes none of it
// for its own
const RENAME = new Set(['data-anchor', 'data-anchor-text', 'data-anchor-parts', 'data-anchor-cell', 'data-cell', 'data-ref', 'data-tel', 'data-panel', 'data-chat-current', 'data-cite-home'])
const ARROW = 'M3 2 L3 18 L7.2 11.4 L16 13 Z'
const POINTER = 'M4 2 L4 19 L8.3 14.9 L11.2 21.4 L14 20.2 L11.2 13.8 L17 13.8 Z'
const FULL = '<rect x="0" y="0" width="100%" height="100%" fill="#fff"/>'

const abortError = () => new DOMException('aborted', 'AbortError')
const sleepFor = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((res, rej) => {
    if (signal?.aborted) return rej(abortError())
    const t = window.setTimeout(res, ms)
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(t)
        rej(abortError())
      },
      { once: true },
    )
  })
const frames = (n: number) =>
  new Promise<void>((res) => {
    const f = () => (n-- <= 0 ? res() : requestAnimationFrame(f))
    f()
  })
const rectOf = (el: Element | null | undefined): Rect | null => {
  if (!el || !el.getBoundingClientRect) return null
  const b = el.getBoundingClientRect()
  return b.width > 0 && b.height > 0 ? { x: b.left, y: b.top, width: b.width, height: b.height } : null
}
const unionOf = (list: (Rect | null)[]): Rect | null => {
  const rs = list.filter((r): r is Rect => !!r)
  if (!rs.length) return null
  const x = Math.min(...rs.map((r) => r.x)),
    y = Math.min(...rs.map((r) => r.y))
  return { x, y, width: Math.max(...rs.map((r) => r.x + r.width)) - x, height: Math.max(...rs.map((r) => r.y + r.height)) - y }
}
const clipTo = (r: Rect, c: Rect): Rect => {
  const x = Math.max(r.x, c.x),
    y = Math.max(r.y, c.y)
  return { x, y, width: Math.min(r.x + r.width, c.x + c.width) - x, height: Math.min(r.y + r.height, c.y + c.height) - y }
}
const inBox = (b: Box | null, x: number, y: number) => !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h
/** The page's own element for a selector, never the tour's copy of one. */
const q = (sel: string): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => !e.closest('.tour-root')) || null
const isRect = (a: unknown): a is Rect => !!a && typeof (a as Rect).width === 'number' && !(a instanceof Element)
const textRows = (rects: Iterable<DOMRect>) => {
  const rows: { top: number; left: number; right: number; h: number }[] = []
  for (const b of rects) {
    if (b.width < 2) continue
    const row = rows.find((o) => Math.abs(o.top - b.top) < 3)
    if (row) {
      row.left = Math.min(row.left, b.left)
      row.right = Math.max(row.right, b.right)
      row.h = Math.max(row.h, b.height)
    } else rows.push({ top: b.top, left: b.left, right: b.right, h: b.height })
  }
  return rows
}

/** The tour's one way to draw markup: its own strings and the examples bundled with it (examples.json), never anything
 * the server, a model or the corpus wrote. */
export function setMarkup(el: Element, markup: string): void {
  el.innerHTML = markup
}

/** A tour bound to the bundled snapshots. One runs at a time. */
export function createTour(snaps: Snaps): Tour {
  let root: HTMLDivElement | null = null
  let mask: SVGMaskElement
  let block: HTMLDivElement
  let ex: HTMLDivElement
  let fx: HTMLDivElement
  let pop: HTMLDivElement
  let host: HTMLDivElement
  let steps: Step[] = []
  let i = -1
  let raf = 0
  let last = ''
  let seen = false
  let placed: Rect | null = null
  let holes: Rect[] = []
  let open: Box | null = null
  let leaving = false
  let welcome = false
  let replay = false
  let drawn: { holes: Box[]; targets: Box[]; pad: number } | null = null
  // the ask box was closed with Esc (a `backOnEsc` step then goes back to its main step)
  let escaped = false
  // the example and demo of the step group on screen
  let run: Run | null = null
  let opts: StartOptions = {}

  const realBox = () => q('.pointer-box')
  const liveMock = () => (fx ? fx.querySelector<HTMLElement>('.pointer-box.tour-mock.tour-live') : null)

  const holesOf = (s: Step): Rect[] => {
    const v = typeof s.anchor === 'function' ? s.anchor(api) : s.anchor
    const out: Rect[] = []
    for (const a of ([] as Anchor[]).concat(v ?? [])) {
      let r: Rect | null = null
      if (!a) continue
      if (typeof a === 'string') r = rectOf(q(a))
      else if (a instanceof Element) r = rectOf(a)
      else if (isRect(a)) r = a
      if (r && s.clip) {
        const c = rectOf(q(s.clip))
        if (c) r = clipTo(r, c)
      }
      if (r && r.width > 1 && r.height > 1) out.push(r)
    }
    return out
  }

  // ---- drawing
  const btn = (act: string, cls: string, label: string) =>
    `<button type="button" data-tour="${act}" data-i="${i}" class="btn ${cls} btn-md"><span class="btn-label">${label}</span></button>`
  // a `sub` step shares its main step's number and is reached only through advanceOn
  const numbered = () => steps.filter((s) => !s.sub).length
  const numberOf = (k: number) => steps.slice(0, k + 1).filter((s) => !s.sub).length
  const nextMain = (k: number) => {
    let j = k + 1
    while (j < steps.length && steps[j].sub) j++
    return j
  }
  const prevMain = (k: number) => {
    let j = k - 1
    while (j > 0 && steps[j].sub) j--
    return j
  }
  const groupOf = (k: number) => {
    let g = k
    while (g > 0 && steps[g].sub) g--
    return g
  }
  const bodyOf = (s: Step) => (typeof s.body === 'function' ? s.body(api) : s.body)

  const draw = (s: Step, rs: Rect[], n: number, total: number) => {
    const pad = s.pad ?? 6,
      rad = s.radius ?? 8
    const boxes = rs.map((r) => ({ x: r.x - pad, y: r.y - pad, w: r.width + 2 * pad, h: r.height + 2 * pad }))
    setMarkup(mask, FULL + boxes.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rad}" ry="${rad}" fill="#000"/>`).join(''))
    drawn = { holes: boxes, targets: rs.map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })), pad }
    // the block takes every click, except over an opening: a frame the analyst may use, an allowed element, or a try
    // step's cutout, where the guard lets only a ⌘-click through
    const inter = s.interact ? rectOf(s.interact(api)) : null
    open = inter ? { x: inter.x, y: inter.y, w: inter.width, h: inter.height } : (s.try || (s.allow && s.allow(api))) && boxes[0] ? boxes[0] : null
    if (open) {
      const [a, b, c, d] = [open.x, open.y, open.x + open.w, open.y + open.h]
      block.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${a}px ${b}px, ${a}px ${d}px, ${c}px ${d}px, ${c}px ${b}px, ${a}px ${b}px)`
    } else block.style.clipPath = ''
    const first = i === 0,
      lastStep = n === total && !steps.slice(i + 1).some((x) => !x.sub)
    const after = s.after && run && run.after ? ` <span class="tour-after">${s.after}</span>` : ''
    const html = `<div class="tour-caret"></div>
      <div class="tour-head"><div class="tour-title">${s.title}</div><div class="tour-count">${n} of ${total}</div></div>
      <p class="tour-body">${bodyOf(s)}${after}</p>${s.note ? `<p class="tour-note">${s.note}</p>` : ''}
      <div class="tour-foot">${first ? btn('skip', 'btn-ghost tour-skip', 'Skip tour') : btn('back', 'btn-ghost tour-skip', 'Back')}<span class="tour-spacer"></span>
        ${s.gateNext && !run?.tried ? '' : btn(lastStep ? 'done' : 'next', 'btn-primary', lastStep ? 'Done' : 'Next')}</div>`
    if (pop.dataset.html !== html) {
      const focused = pop.contains(document.activeElement)
      setMarkup(pop, html)
      pop.dataset.html = html
      if (focused || pop.dataset.focusFor !== String(i)) {
        pop.dataset.focusFor = String(i)
        if (!s.try) pop.querySelector<HTMLElement>('.btn-primary')?.focus({ preventScroll: true })
      }
    }
    const box = boxes[0]
    const pw = pop.offsetWidth,
      ph = pop.offsetHeight,
      gap = 14,
      M = 12,
      vw = innerWidth,
      vh = innerHeight
    const caret = pop.querySelector<HTMLElement>('.tour-caret')!
    if (!box) {
      Object.assign(pop.style, { left: `${(vw - pw) / 2}px`, top: `${(vh - ph) / 2}px` })
      caret.style.display = 'none'
      return
    }
    const align = s.align || 'start'
    type Align = NonNullable<Step['align']>
    const at = (side: Place, al: Align = align) => {
      const x = side === 'right' ? box.x + box.w + gap : side === 'left' ? box.x - gap - pw : al === 'center' ? box.x + box.w / 2 - pw / 2 : al === 'end' ? box.x + box.w - pw : box.x
      const y = side === 'bottom' ? box.y + box.h + gap : side === 'top' ? box.y - gap - ph : al === 'center' ? box.y + box.h / 2 - ph / 2 : al === 'end' ? box.y + box.h - ph : box.y
      return { x: Math.max(M, Math.min(vw - pw - M, x)), y: Math.max(M, Math.min(vh - ph - M, y)), fits: x >= M && x + pw <= vw - M }
    }
    // the area of the cutouts the popover would cover there
    const covered = (q: { x: number; y: number }) =>
      boxes.reduce((a, b) => a + Math.max(0, Math.min(q.x + pw, b.x + b.w) - Math.max(q.x, b.x)) * Math.max(0, Math.min(q.y + ph, b.y + b.h) - Math.max(q.y, b.y)), 0)
    const listed = ([] as Place[]).concat(s.place ?? 'right')
    const sides = [...listed, ...(['right', 'left', 'bottom', 'top'] as Place[]).filter((x) => !listed.includes(x))]
    const aligns = [align, ...(['start', 'center', 'end'] as Align[]).filter((x) => x !== align)]
    // the first listed side where it fits and covers nothing, else, of every side and alignment and the window's four
    // corners, the place where it covers least (a cutout as large as the window leaves none free); a corner's caret
    // points up or down into the cutout
    const free = listed.find((side) => {
      const q = at(side)
      return q.fits && covered(q) < 1
    })
    let place: Place = free ?? sides[0]
    let spot = at(place)
    if (!free) {
      let least = covered(spot)
      const tries: { side: Place; q: { x: number; y: number } }[] = sides.flatMap((side) => aligns.map((a) => ({ side, q: at(side, a) })))
      for (const y of [M, vh - ph - M]) for (const x of [M, vw - pw - M]) tries.push({ side: y === M ? 'top' : 'bottom', q: { x, y } })
      for (const t of tries) {
        const c = covered(t.q)
        if (c < least - 1) [place, spot, least] = [t.side, { ...t.q, fits: true }, c]
      }
    }
    const { x: px, y: py } = spot
    Object.assign(pop.style, { left: `${px}px`, top: `${py}px` })
    const cy = Math.max(14, Math.min(ph - 24, (Math.max(box.y, py) + Math.min(box.y + box.h, py + ph)) / 2 - py - 5))
    const cx = Math.max(14, Math.min(pw - 24, (Math.max(box.x, px) + Math.min(box.x + box.w, px + pw)) / 2 - px - 5))
    caret.style.display = ''
    caret.style.inset = ''
    Object.assign(
      caret.style,
      place === 'right' ? { left: '-5px', top: `${cy}px` } : place === 'left' ? { right: '-5px', top: `${cy}px` } : place === 'bottom' ? { top: '-5px', left: `${cx}px` } : { bottom: '-5px', left: `${cx}px` },
    )
    caret.style.transform = `rotate(${{ right: -45, left: 135, bottom: 45, top: -135 }[place]}deg)`
  }

  // the welcome: centred over the whole page, dimmed; not a numbered step
  const drawWelcome = () => {
    setMarkup(mask, FULL)
    block.style.clipPath = ''
    open = null
    pop.classList.add('tour-welcome')
    const html = `<div class="tour-head"><div class="tour-title">Welcome to thimble</div></div>
      <p class="tour-body">Would you like a product tour?</p>
      <div class="tour-foot">${btn('skip', 'btn-ghost tour-skip', 'Skip to the workbench')}<span class="tour-spacer"></span>${btn('begin', 'btn-primary', 'Take the tour')}</div>`
    if (pop.dataset.html !== html) {
      setMarkup(pop, html)
      pop.dataset.html = html
      pop.querySelector<HTMLElement>('.btn-primary')?.focus({ preventScroll: true })
    }
    Object.assign(pop.style, { left: `${(innerWidth - pop.offsetWidth) / 2}px`, top: `${(innerHeight - pop.offsetHeight) / 2}px` })
  }

  // ---- what a step brings: an example (kept through its sub steps) and a demo (its own; stopped when the tour moves)
  const stopDemo = () => {
    if (!run || !run.demoAc) return
    run.demoAc.abort()
    run.demoAc = null
    fx.querySelectorAll('[data-demo]').forEach((e) => e.remove())
    cursor.hide()
    if (run.demo === 'playing') run.demo = 'stopped'
    run.after = true
    last = ''
  }
  const stopRun = () => {
    if (!run) return
    stopDemo()
    run.ac.abort()
    for (const f of run.cleanups.reverse()) {
      try {
        f()
      } catch (e) {
        console.warn('tour cleanup', e)
      }
    }
    ex.replaceChildren()
    fx.replaceChildren()
    host.replaceChildren()
    setHot(null)
    closeSource()
    run = null
  }
  const playDemo = async (r: Run, s: Step) => {
    r.demo = s.demo ? 'waiting' : 'none'
    r.after = !s.demo
    if (!s.demo) return
    await frames(2)
    if (run !== r) return
    const ac = new AbortController()
    r.demoAc = ac
    r.demo = 'playing'
    await s.demo(api, ac.signal)
    if (run === r && r.demoAc === ac) {
      r.demoAc = null
      r.demo = 'done'
      r.after = true
      fx.querySelectorAll('[data-demo]').forEach((e) => e.remove())
      cursor.hide()
      last = ''
    }
  }
  const quiet = (p: Promise<unknown>) =>
    p.catch((e) => {
      if ((e as Error)?.name !== 'AbortError') console.warn('tour step', e)
    })
  // a step's run: its example once its tab has drawn (until then the popover waits hidden), then its demo
  const startRun = (k: number) => {
    const s = steps[k]
    const r: Run = { group: k, ac: new AbortController(), demoAc: null, cleanups: [], layout: null, els: {}, demo: 'none', after: !s.demo, ready: !s.example }
    run = r
    quiet(
      (async () => {
        await frames(2)
        await sleepFor(s.tab ? 380 : 60, r.ac.signal)
        if (s.example) {
          const res = s.example(api) || {}
          r.els = res.els || {}
          r.layout = res.layout || null
          if (res.cleanup) r.cleanups.push(res.cleanup)
          if (r.layout) r.layout()
          r.ready = true
        }
        last = ''
        await playDemo(r, s)
      })(),
    )
  }

  const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5135ff'
  const cursorSvg = (cmd: boolean) => {
    const c = accent()
    const path = cmd ? ARROW : POINTER
    const glow = cmd
      ? `<filter id="tour-glow" filterUnits="userSpaceOnUse" x="-5" y="-5" width="32" height="32"><feDropShadow dx="0" dy="0.6" stdDeviation="1.6" flood-color="${c}" flood-opacity="0.5"/></filter>`
      : ''
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs>${glow}</defs><g ${cmd ? 'filter="url(#tour-glow)"' : ''} transform="translate(5 5)">` +
      `<path d="${path}" fill="none" stroke="#fff" stroke-width="${cmd ? 5 : 3}" stroke-linejoin="round"/>` +
      `<path d="${path}" fill="${cmd ? c : '#111'}" stroke="${cmd ? c : '#111'}" stroke-width="${cmd ? 2 : 1}" stroke-linejoin="round"/></g></svg>`
    )
  }

  // a fake pointer for the demos: glides, holds ⌘ (the accent dart and a ⌘ key), clicks
  const cursor: Cursor = (() => {
    let el: HTMLDivElement | null = null,
      key: HTMLDivElement | null = null,
      x = 0,
      y = 0,
      cmd = false,
      keyAt: { x: number; y: number } | null = null
    const put = () => {
      if (el) el.style.transform = `translate(${x - 8}px, ${y - 7}px)`
      if (key) key.style.transform = keyAt ? `translate(${keyAt.x}px, ${keyAt.y}px)` : `translate(${x + 22}px, ${y + 22}px)`
    }
    return {
      show(nx, ny) {
        if (!el) {
          el = document.createElement('div')
          el.className = 'tour-cursor tour-in'
          el.dataset.demo = '1'
          fx.append(el)
        }
        setMarkup(el, cursorSvg(cmd))
        x = nx
        y = ny
        put()
      },
      async move(nx, ny, ms = 800) {
        const sx = x,
          sy = y,
          t0 = performance.now(),
          sig = run?.demoAc?.signal
        for (;;) {
          if (sig?.aborted) throw abortError()
          const t = Math.min(1, (performance.now() - t0) / ms),
            e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
          x = sx + (nx - sx) * e
          y = sy + (ny - sy) * e
          put()
          if (t >= 1) break
          await frames(1)
        }
      },
      // `at`: where the key badge stands (its top-left), else beside the pointer
      cmd(on, at = null) {
        cmd = on
        keyAt = at
        if (el) setMarkup(el, cursorSvg(on))
        if (on && !key) {
          key = document.createElement('div')
          key.className = 'tour-key tour-in'
          key.dataset.demo = '1'
          setMarkup(key, `<b>${MAC ? '⌘' : 'Ctrl'}</b><span>held down</span>`)
          fx.append(key)
        }
        if (!on && key) {
          key.remove()
          key = null
        }
        put()
      },
      async click() {
        const r = document.createElement('div')
        r.className = 'tour-ripple'
        r.dataset.demo = '1'
        r.style.left = `${x}px`
        r.style.top = `${y}px`
        fx.append(r)
        if (el) el.animate([{ transform: el.style.transform + ' scale(1)' }, { transform: el.style.transform + ' scale(0.86)' }, { transform: el.style.transform + ' scale(1)' }], { duration: 220 })
        window.setTimeout(() => r.remove(), 700)
        await sleepFor(120, run?.demoAc?.signal)
      },
      hide() {
        el?.remove()
        key?.remove()
        el = key = null
        cmd = false
      },
      get pos() {
        return { x, y }
      },
    }
  })()

  const snap: Api['snap'] = (name, wrapCls, raw, { keepAnchors = false } = {}) => {
    const w = document.createElement('div')
    if (wrapCls) w.className = wrapCls
    const own = name ? snaps[name] : ''
    setMarkup(w, raw ?? (typeof own === 'string' ? own : ''))
    for (const el of keepAnchors ? [] : w.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        if (RENAME.has(a.name)) {
          el.setAttribute(`data-tour-${a.name.slice(5)}`, a.value)
          el.removeAttribute(a.name)
        } else if (a.name === 'id' || a.name === 'tabindex' || a.name === 'aria-labelledby' || a.name === 'aria-controls') el.removeAttribute(a.name)
      }
    }
    return w
  }

  const mockAsk: Api['mockAsk'] = (target, { live = false, region = false, text = null } = {}) => {
    const r0 = rectOf(target)
    if (!r0) return null
    // a region is drawn as thimble draws one: its box grown 2px, with the accent ring
    const r = region ? { x: r0.x - 2, y: r0.y - 2, width: r0.width + 4, height: r0.height + 4 } : r0
    const hl = document.createElement('div')
    hl.className = 'pointer-hl tour-mock'
    hl.setAttribute('data-kind', region ? 'region' : 'text')
    hl.setAttribute('data-on', '1')
    Object.assign(hl.style, { transform: `translate3d(${r.x}px, ${r.y}px, 0)`, width: `${r.width}px`, height: `${r.height}px`, borderRadius: '3px', transition: 'none' })
    const range = document.createRange()
    range.selectNodeContents(target)
    for (const o of region ? [] : textRows(range.getClientRects())) {
      const l = document.createElement('div')
      l.className = 'pointer-hl-line'
      Object.assign(l.style, { left: `${o.left - r.x}px`, top: `${o.top - r.y}px`, width: `${o.right - o.left}px`, height: `${o.h}px` })
      hl.append(l)
    }
    const box = snap('box').firstElementChild as HTMLElement
    box.classList.add('tour-mock')
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y + r.height + 8}px`, width: text ? '300px' : '236px' })
    const input = box.querySelector('textarea')!
    if (live) {
      box.classList.add('tour-live')
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          closeMock()
        }
      })
    } else {
      hl.dataset.demo = '1'
      box.dataset.demo = '1'
      input.readOnly = true
    }
    fx.append(hl, box)
    if (live) window.setTimeout(() => input.focus({ preventScroll: true }), 30)
    return { hl, box, input, remove: () => (hl.remove(), box.remove()) }
  }

  const mockAskRange: Api['mockAskRange'] = (range, { text = true } = {}) => {
    const rows = textRows(range.getClientRects())
    if (!rows.length) return null
    const x = Math.min(...rows.map((o) => o.left)) - 2,
      y = Math.min(...rows.map((o) => o.top)) - 1
    const w = Math.max(...rows.map((o) => o.right)) + 2 - x,
      h = Math.max(...rows.map((o) => o.top + o.h)) + 1 - y
    const hl = document.createElement('div')
    hl.className = 'pointer-hl tour-mock'
    hl.setAttribute('data-kind', rows.length === 1 ? 'word' : 'text')
    hl.setAttribute('data-on', '1')
    Object.assign(hl.style, { transform: `translate3d(${x}px, ${y}px, 0)`, width: `${w}px`, height: `${h}px`, borderRadius: '3px', transition: 'none' })
    if (rows.length > 1)
      for (const o of rows) {
        const l = document.createElement('div')
        l.className = 'pointer-hl-line'
        Object.assign(l.style, { left: `${o.left - x}px`, top: `${o.top - y}px`, width: `${o.right - o.left}px`, height: `${o.h}px` })
        hl.append(l)
      }
    const lastRow = rows[rows.length - 1]
    const box = snap('box').firstElementChild as HTMLElement
    box.classList.add('tour-mock')
    Object.assign(box.style, { left: `${lastRow.left}px`, top: `${lastRow.top + lastRow.h + 8}px`, width: text ? '300px' : '236px' })
    const input = box.querySelector('textarea')!
    hl.dataset.demo = '1'
    box.dataset.demo = '1'
    input.readOnly = true
    fx.append(hl, box)
    return { hl, box, input, remove: () => (hl.remove(), box.remove()) }
  }
  const closeMock = () => fx.querySelectorAll('.tour-mock:not([data-demo])').forEach((e) => e.remove())

  const api: Api = {
    MAC,
    pointHeld,
    rectOf,
    unionOf,
    q,
    realBox,
    liveMock,
    get ex() {
      return ex
    },
    get fx() {
      return fx
    },
    // the layer under the tour (above the page, below thimble's ⌘ highlight and ask box), for an example the app's own
    // pointer must reach: the dim covers it like the page, and only a cutout shows it in full
    get host() {
      return host
    },
    get els() {
      return run ? run.els : {}
    },
    get run() {
      return run
    },
    get replay() {
      return replay
    },
    step: () => steps[i],
    sleep: (ms) => sleepFor(ms, run?.demoAc?.signal || run?.ac.signal),
    snap,
    tag(el, text = 'Example') {
      const t = document.createElement('span')
      t.className = 'tour-tag'
      t.textContent = text
      el.append(t)
      return t
    },
    // the background the page shows behind `el`: its own, else its nearest ancestor's that is not transparent
    groundOf(el) {
      for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor
        if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c
      }
      return getComputedStyle(document.body).backgroundColor
    },
    cursor,
    mockAsk,
    mockAskRange,
    closeMock,
    showSource: (chip, o) => showSource(chip, o),
    closeSource: () => closeSource(),
    async type(input, text, ms = 55) {
      for (const ch of text) {
        input.value += ch
        await sleepFor(ms, run?.demoAc?.signal)
      }
    },
    stopDemo,
    end: () => void end(),
  }

  const go = (k: number) => {
    if (k < 0 || k >= steps.length) return void end()
    if (steps[i]?.leave) {
      leaving = true
      try {
        steps[i].leave!(api)
      } finally {
        leaving = false
      }
    }
    const keep = run && groupOf(k) === run.group
    // a step that brings the same example as the one on screen (the two card steps) keeps it and plays its own demo
    const same = !keep && run && run.ready && steps[k].example && !steps[k].sub && steps[run.group]?.example === steps[k].example
    if (keep || same) stopDemo()
    else stopRun()
    i = k
    last = ''
    seen = false
    escaped = false
    const tab = steps[i].tab
    if (tab) opts.showTab?.(tab)
    if (same && run) {
      run.group = k
      quiet(playDemo(run, steps[k]))
    } else if (!keep) startRun(k)
  }

  // each frame: lay out the example, measure the cutouts, redraw when they moved, follow advanceOn / nextWhenGone
  const tick = () => {
    raf = requestAnimationFrame(tick)
    if (welcome) {
      const k = `welcome|${innerWidth}x${innerHeight}`
      if (last !== k) {
        last = k
        drawWelcome()
      }
      return
    }
    const s = steps[i]
    if (!s) return
    // until the step's example is in place: the whole page dimmed and the popover hidden, so nothing flashes
    if (run && !run.ready) {
      if (last !== 'pending') {
        last = 'pending'
        setMarkup(mask, FULL)
        pop.style.visibility = 'hidden'
        block.style.clipPath = ''
        open = null
      }
      return
    }
    if (pop.style.visibility) pop.style.visibility = ''
    if (run?.layout) {
      try {
        run.layout()
      } catch (e) {
        if (!run.warned) {
          run.warned = true
          console.warn('tour layout', e)
        }
      }
    }
    if (s.advanceOn && steps[i + 1]?.sub) {
      if (s.advanceOn(api)) {
        if (run) run.tried = true
        return go(i + 1)
      }
    }
    const rs = holesOf(s)
    if (rs.length) seen = true
    else if (seen && s.nextWhenGone) return go(escaped && s.backOnEsc ? groupOf(i) : nextMain(i))
    const text = bodyOf(s)
    const key = rs.map((r) => [r.x, r.y, r.width, r.height].map(Math.round).join()).join(';') + `|${innerWidth}x${innerHeight}|${run?.after ? 1 : 0}|${run?.tried ? 1 : 0}|${text}`
    if (key === last) return
    last = key
    holes = rs
    placed = rs[0] || null
    draw(s, rs, numberOf(i), numbered())
  }

  // ---- the values of a `chips` step's card: the one under a point (the card may sit under the block, so every layer at
  // the point is looked at), a hover mark on it, and its source
  const chipAt = (x: number, y: number): Element | null => {
    const card = run?.els?.card as Element | undefined
    if (!card) return null
    const stack = document.elementsFromPoint(x, y)
    if (stack[0] && (pop.contains(stack[0]) || fx.contains(stack[0]))) return null
    return stack.find((el) => el.classList?.contains('refchip-value') && card.contains(el)) || null
  }
  let hot: Element | null = null
  const setHot = (chip: Element | null) => {
    if (hot === chip) return
    hot?.classList.remove('tour-hot')
    hot = chip
    hot?.classList.add('tour-hot')
    if (block) block.style.cursor = chip ? 'pointer' : ''
  }
  // hovering a value shows its source after a moment, as thimble's own label does; the source stays while the pointer
  // is on the value or on the source, and goes a moment after it leaves both
  let hoverT = 0,
    hideT = 0,
    shownFor: Element | null = null
  const onHover = (e: MouseEvent) => {
    const s = steps[i]
    if (i < 0 || !s?.chips || !e.isTrusted) {
      if (hot) setHot(null)
      return
    }
    const chip = chipAt(e.clientX, e.clientY)
    setHot(chip)
    const onSrc = document.elementsFromPoint(e.clientX, e.clientY).some((el) => el.closest?.('.tour-fx [data-src]:not([data-demo])'))
    if (chip) {
      window.clearTimeout(hideT)
      if (chip !== shownFor) {
        window.clearTimeout(hoverT)
        hoverT = window.setTimeout(() => {
          if (hot === chip && steps[i]?.chips) {
            steps[i].chips!(api, chip)
            shownFor = chip
          }
        }, 250)
      }
    } else if (!onSrc) {
      window.clearTimeout(hoverT)
      if (shownFor) {
        window.clearTimeout(hideT)
        hideT = window.setTimeout(() => {
          closeSource()
          shownFor = null
        }, 300)
      }
    } else window.clearTimeout(hideT)
  }
  const removeSources = () => fx?.querySelectorAll('[data-src]').forEach((e) => e.remove())
  const closeSource = () => {
    removeSources()
    shownFor = null
  }
  // the source of a value, as thimble shows it: its captured label, below the value. `demo`: the demo's, removed with it
  const showSource = (chip: Element, { demo = false } = {}): HTMLElement | null => {
    removeSources()
    const ref = chip.getAttribute('data-ref') || chip.getAttribute('data-tour-ref') || ''
    const table = (run?.els?.real === false && snaps.popsPlain) || snaps.pops
    const html = table && typeof table === 'object' ? table[ref] : undefined
    if (!html) return null
    const el = snap(null, null, html).firstElementChild as HTMLElement
    el.dataset[demo ? 'demo' : 'src'] = '1'
    if (demo) el.dataset.src = '1'
    el.classList.add('tour-in')
    fx.append(el)
    const c = rectOf(chip)
    if (!c) return el
    // as large as the card is drawn, within reason: the value's own zoom, between 1 and 1.4
    const k = Math.max(1, Math.min(1.4, (chip as HTMLElement).offsetHeight ? c.height / (chip as HTMLElement).offsetHeight : 1))
    Object.assign(el.style, { transformOrigin: '0 0', transform: k > 1.01 ? `scale(${k})` : '' })
    const ew = el.offsetWidth * k,
      eh = el.offsetHeight * k
    const left = Math.max(12, Math.min(innerWidth - ew - 12, c.x - 12))
    const below = c.y + c.height + 6
    const top = below + eh > innerHeight - 12 ? Math.max(12, c.y - eh - 6) : below
    Object.assign(el.style, { left: `${left}px`, top: `${top}px` })
    return el
  }

  // ---- the freeze: every input the page would take is stopped at the window, before the app's own listeners
  const stop = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  }
  const onEsc = (e: KeyboardEvent) => {
    if (realBox()) {
      // the app closes its box; the tour stays
      if (e.type === 'keydown') escaped = true
      return
    }
    stop(e)
    if (e.type !== 'keydown') return
    if (liveMock()) {
      escaped = true
      return closeMock()
    }
    if (fx.querySelector('[data-src]')) return closeSource()
    if (!leaving) end()
  }
  const focusables = () => [...pop.querySelectorAll<HTMLElement>('button'), ...(liveMock() ? [liveMock()!.querySelector('textarea')] : [])].filter((x): x is HTMLElement => !!x)
  const guard = (ev: Event) => {
    if ((i < 0 && !welcome) || !ev.isTrusted || !root) return
    const t = ev.target
    const isKey = KEYS.has(ev.type)
    const ke = ev as KeyboardEvent
    const me = ev as MouseEvent
    if (welcome) {
      const inPop = t instanceof Node && pop.contains(t)
      if (isKey && ke.key === 'Escape') {
        stop(ev)
        if (ev.type === 'keydown') end()
        return
      }
      if (isKey && (ke.key === 'Tab' || ke.key === 'Enter' || ke.key === ' ') && inPop) return
      if (!inPop) stop(ev)
      return
    }
    const inTour = t instanceof Node && root.contains(t) && t !== block
    const inReal = t instanceof Node && !!realBox()?.contains(t)
    const s = steps[i]
    const allowed = s.allow ? s.allow(api) : null
    const inAllowed = !!allowed && t instanceof Node && allowed.contains(t)
    if (isKey) {
      if (ke.key === 'Escape' && !inAllowed) return onEsc(ke)
      if (inAllowed && ke.key !== 'Tab') return
      if (ke.key === 'Tab') {
        if (ev.type === 'keydown') {
          const f = focusables()
          if (f.length) {
            const k = f.indexOf(document.activeElement as HTMLElement)
            f[(k + (ke.shiftKey ? -1 : 1) + f.length) % f.length].focus()
          }
        }
        return stop(ev)
      }
      // on a try step ⌘ itself always reaches the page (its pointer turns on), wherever the focus is
      if (s.try && isPointKey(ke.key, MAC)) {
        if (ev.type === 'keydown' && run?.demo === 'playing') stopDemo()
        return
      }
      if (inTour) return
      // while the tour runs the page's ask box sends nothing: Enter closes it, and the tour moves on
      if (inReal && ke.key === 'Enter' && !ke.shiftKey) {
        stop(ev)
        if (ev.type === 'keydown') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return
      }
      if (inReal) return
      return stop(ev)
    }
    if (SCROLLS.has(ev.type)) {
      if ((inTour && t instanceof Node && pop.contains(t)) || inAllowed) return
      const sc = s.scroll ? s.scroll(api) : null
      const r = sc && rectOf(s.scrollOver?.(api) || sc)
      stop(ev)
      const we = ev as WheelEvent
      if (sc && r && ev.type === 'wheel' && we.clientX >= r.x && we.clientX <= r.x + r.width && we.clientY >= r.y && we.clientY <= r.y + r.height) {
        const k = sc.getBoundingClientRect().height / (sc.clientHeight || 1) || 1
        sc.scrollBy({ top: (we.deltaY * (we.deltaMode === 1 ? 16 : we.deltaMode === 2 ? sc.clientHeight : 1)) / k })
      }
      return
    }
    if (inAllowed) return
    if (s.chips && !pointHeld(me)) {
      const chip = chipAt(me.clientX, me.clientY)
      if (chip) {
        stop(ev)
        if (ev.type === 'click' && chip !== shownFor) {
          s.chips(api, chip)
          shownFor = chip
        }
        return
      }
      if (ev.type === 'mousedown' && !(t instanceof Node && pop.contains(t))) closeSource()
    }
    if (inTour) return
    if (s.try && inBox(open, me.clientX, me.clientY) && (pointHeld(me) || inReal)) return
    if (inReal) return
    stop(ev)
  }
  // what happens inside the tour stays there: the app's own listeners further up never see it
  const contain = (e: Event) => {
    if ((i >= 0 || welcome) && !(steps[i]?.try && KEYS.has(e.type) && isPointKey((e as KeyboardEvent).key, MAC))) e.stopPropagation()
  }

  function start(list: Steps, o: StartOptions = {}) {
    if (root) end()
    steps = list
    opts = o
    root = document.createElement('div')
    root.className = 'tour-root'
    // the examples sit under the dim, like the page, so only the cutouts show them in full
    setMarkup(
      root,
      '<div class="tour-ex"></div><svg class="tour-dim" aria-hidden="true"><defs><mask id="tour-mask" maskUnits="userSpaceOnUse"></mask></defs>' +
      '<rect class="tour-dim-fill" x="0" y="0" width="100%" height="100%" mask="url(#tour-mask)"/></svg>' +
      '<div class="tour-block"></div><div class="tour-fx"></div>' +
      '<div class="tour-pop" role="dialog" aria-label="thimble tour"></div>',
    )
    mask = root.querySelector('mask')!
    block = root.querySelector('.tour-block')!
    ex = root.querySelector('.tour-ex')!
    fx = root.querySelector('.tour-fx')!
    pop = root.querySelector('.tour-pop')!
    pop.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-tour]')
      if (!b || b.dataset.i !== String(i)) return
      const act = b.dataset.tour
      if (act === 'begin') {
        welcome = false
        pop.classList.remove('tour-welcome')
        last = ''
        go(0)
        return
      }
      if (act === 'next') go(nextMain(i))
      else if (act === 'back') go(prevMain(i))
      else if (act === 'skip' || act === 'done') end()
    })
    for (const type of CONTAINED) root.addEventListener(type, contain)
    host = document.createElement('div')
    host.className = 'tour-host'
    document.body.append(host, root)
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur()
    // an ask box the analyst left open closes, so the ⌘-click step starts with none
    if (realBox()) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    setGuard(guard)
    window.addEventListener('mousemove', onHover, { capture: true, passive: true })
    welcome = !!o.welcome
    replay = !!o.replay
    if (welcome) {
      i = -1
      tick()
      return
    }
    go(o.at || 0)
    tick()
  }

  function end(): number {
    const was = i
    if (!root) return was
    cancelAnimationFrame(raf)
    if (steps[i]?.leave && !leaving) {
      leaving = true
      try {
        steps[i].leave!(api)
      } finally {
        leaving = false
      }
    }
    stopRun()
    setGuard(null)
    window.removeEventListener('mousemove', onHover, { capture: true })
    root.remove()
    host.remove()
    root = null
    i = -1
    steps = []
    holes = []
    open = null
    drawn = null
    welcome = false
    const done = opts.onEnd
    opts = {}
    done?.()
    return was
  }

  return {
    start,
    end,
    api,
    running: () => !!root,
    // what the last frame drew: the cutouts (with their padding), the elements they are around, the popover and its caret
    geometry: () => {
      if (!drawn || i < 0 || !root) return null
      const R = (e: Element | null): Box | null => {
        const b = e?.getBoundingClientRect()
        return b && b.width ? { x: b.left, y: b.top, w: b.width, h: b.height } : null
      }
      const caret = pop.querySelector<HTMLElement>('.tour-caret')
      return { ...drawn, pop: R(pop), caret: caret && caret.style.display !== 'none' ? R(caret) : null, viewport: { w: innerWidth, h: innerHeight } }
    },
    state: () => ({ i, title: welcome ? 'Welcome' : steps[i]?.title, n: i >= 0 ? numberOf(i) : 0, total: numbered(), rect: placed, holes: holes.length, demo: run?.demo || 'none', after: !!run?.after, welcome }),
  }
}

type Steps = Step[]
