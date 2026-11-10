// The card harness's page (render.html; backend/app/render.py keeps a few open in headless Chromium): one card drawn
// with the canvas's own CardFace, width, theme and stylesheet, so the picture the card check reads is what the analyst
// sees; or, when the request names a figure, the card as a figure in a figure style (figures/Figure), on a white sheet,
// whose own box is the picture. The page calls no API: each request carries the card with its refs resolved, cited
// calls, card and label names (and a label card's `label` data, a custom card's libraries), and a fetch stub answers
// the page's requests from them, listing any it could not.
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import './styles/index.css'
import { ChipContext } from './chat/markdown'
import { bodyHeight, bodyWidth } from './canvas/bodyHeight'
import { CardFace } from './canvas/CardFace'
import { CARD_PAD_X } from './canvas/Cell'
import { CanvasContext, type CanvasCtx } from './canvas/context'
import { kindOf } from './canvas/layout'
import { Figure, type FigurePart } from './figures/Figure'
import { apiPath } from './lib/browserKey'
import { registerCells, registerConcepts } from './lib/cellName'
import { readFigures, setAccent, setFigures, setPaper, type Accent, type FigureStyle, type Paper } from './lib/theme'
import type { Cell, Concept, ConceptDetail } from './lib/types'

export interface RenderRequest {
  ws: string
  card: Cell
  /** every ref the card cites, as GET /corpora/{c}/ref returns it; {error, status} for one that does not resolve */
  citations: Record<string, unknown>
  names: { id: string; notebook?: string; title: string }[]
  /** the labels the card uses, for the tags in the Labels row under its question (canvas/CardFace CardLabels): each
   * one's name, and what its colour is read from (files/labels mainColour), as GET /ws/{c}/concepts lists it */
  labels?: ({ id: string; name: string } & Partial<Pick<Concept, 'unit' | 'marks' | 'labels' | 'classes'>>)[]
  /** the theme the analyst's browser last reported; a figure style it does not name is thimble's */
  theme: { paper: Paper; accent: Accent; figures?: FigureStyle }
  width: number
  /** a label card's label as the API returns it: GET /concepts/{id}, and the workspace's settings */
  label?: LabelData | null
  /** a custom card's libraries by its `libs` query, as GET /ws/{c}/card-libs returns them */
  cardLibs?: Record<string, { head: string; problems: string[] }>
  /** the card as a figure (figures/Figure) in `style`: its chart (`part` 'figure', the default) or a Paper figure's
   * legend, in `columns` columns (all in one row when not given), with a report's caption when `caption` numbers it;
   * thimble's figure is the card face. Without it the page draws the card face. */
  figure?: { style: FigureStyle; part?: FigurePart; columns?: number; caption?: number }
}

export interface LabelData {
  concept: ConceptDetail
  settings?: Record<string, unknown>
}

type Box = { x: number; y: number; width: number; height: number }

export interface RenderResult {
  box: Box | null
  /** the height the card's body draws at the card's width, px: a custom card's page whole, past the part the canvas
   * shows at rest, and a table's rows past the ones it shows first (bodyHeight) */
  body?: number
  /** the widest content of the body that lays out wider than its room, px, and that room (bodyWidth); none when all of
   * it fits */
  wide?: { width: number; frame: number }
  fonts: boolean
  requests: string[]
  error?: string
  ms: { settle: number }
}

/** the longest a card may take to settle before it is shot as it stands, ms */
const SETTLE_MAX_MS = 5000
/** the DOM must stay unchanged this long, ms, with no body saying it is still drawing */
const QUIET_MS = 60
/** where the card sits on the page: clear of the edges, so its hairline ring is in the picture */
const MARGIN = 16
const FACES = ['400 13px "Hanken Grotesk"', '500 13px "Hanken Grotesk"', '400 12px "Geist Mono"']
/** the faces of a card drawn in the Blog figure style, its charts' and its figure's headline */
const BLOG_FACES = ['400 12px "DM Sans"', '600 13px "DM Sans"', '700 26px "DM Sans"']

let current: RenderRequest | null = null
let unanswered: string[] = []
let n = 0

// the page's own fetches, answered from the request: a ref's resolution, the cards' and the labels' names;
// anything else is refused and listed, so a card that needs more than the request carries is visible in the result
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
  url.pathname = apiPath(url.pathname) // a path under a browser's key (lib/browserKey) stands for its API path
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init)
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (/^\/api\/corpora\/[^/]+\/ref$/.test(url.pathname)) {
    const ref = url.searchParams.get('ref') ?? ''
    const hit = current?.citations?.[ref] as { error?: string; status?: number } | undefined
    if (hit && typeof hit === 'object' && typeof hit.error === 'string' && typeof hit.status === 'number') return json(hit.status, { detail: hit.error })
    if (hit) return json(200, hit)
  } else if (/^\/api\/ws\/[^/]+\/cells\/names$/.test(url.pathname)) {
    return json(200, current?.names ?? [])
  } else if (/^\/api\/ws\/[^/]+\/concepts$/.test(url.pathname)) {
    return json(200, current?.labels ?? [])
  } else if (current?.label && /^\/api\/ws\/[^/]+\/concepts\/[^/]+$/.test(url.pathname)) {
    return json(200, current.label.concept)
  } else if (current?.label && /^\/api\/ws\/[^/]+\/settings$/.test(url.pathname)) {
    return json(200, current.label.settings ?? {})
  } else if (/^\/api\/ws\/[^/]+\/card-libs$/.test(url.pathname)) {
    const hit = current?.cardLibs?.[url.searchParams.get('libs') ?? '']
    if (hit) return json(200, hit)
  }
  unanswered.push(url.pathname + url.search)
  return json(404, { detail: 'the render page answers only what its request carries' })
}

const stage = document.createElement('div')
stage.className = 'board-stage render-stage'
stage.style.cssText = `position:absolute;left:0;top:0;overflow:visible;display:block;flex:none;padding:${MARGIN}px;min-width:100%;box-sizing:border-box`
document.body.appendChild(stage)
const host = document.createElement('div')
stage.appendChild(host)
let root: Root = createRoot(host)

const now = () => performance.now()
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect()
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
}

/** Resolves once the card is drawn: no body is still drawing (`data-settled="false"`) and the DOM has been still for
 * QUIET_MS; false when SETTLE_MAX_MS passed first. */
async function settled(el: HTMLElement): Promise<boolean> {
  let last = now()
  const mo = new MutationObserver(() => (last = now()))
  mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true })
  const start = now()
  try {
    await document.fonts.ready
    for (;;) {
      await frame()
      const pending = el.querySelector('[data-settled="false"], [data-settling]') || Array.from(el.querySelectorAll('.outputs-vega')).some((c) => !c.querySelector('svg, canvas') && !c.parentElement?.querySelector('.outputs-error'))
      if (!pending && now() - last >= QUIET_MS) return true
      if (now() - start > SETTLE_MAX_MS) return false
    }
  } finally {
    mo.disconnect()
  }
}

/** Whether the faces the card is drawn in are loaded (a fallback face would change every width on the card). */
async function fontsLoaded(faces: readonly string[]): Promise<boolean> {
  try {
    await Promise.all(faces.map((f) => document.fonts.load(f)))
    return faces.every((f) => document.fonts.check(f))
  } catch {
    return false
  }
}

async function render(req: RenderRequest): Promise<RenderResult> {
  const t0 = now()
  current = req
  unanswered = []
  n += 1
  // a key of its own per render: the page's caches of resolved refs are per workspace, and a card's refs may resolve
  // differently after an edit
  const ws = `render-${n}`
  history.replaceState(null, '', `?ws=${ws}`)
  // thimble's figure is the card face; a figure of another style is a white sheet, its charts in a light paper's inks
  const figure = req.figure && req.figure.style !== 'thimble' ? req.figure : null
  if (figure) setPaper('neutral')
  else if (req.theme?.paper) setPaper(req.theme.paper)
  if (req.theme?.accent) setAccent(req.theme.accent)
  // the charts in the figure's style, else the reported one; the page is kept for the next card, so a request that
  // names no style draws in thimble's, not the last card's
  const figures = readFigures(req.figure?.style ?? req.theme?.figures ?? null)
  setFigures(figures)
  registerCells((req.names ?? []).map((c) => ({ id: c.id, title: c.title })))
  registerConcepts(req.labels ?? [])
  const cell: Cell = req.card
  const width = req.width > 0 ? req.width : 720
  const concept = req.label?.concept ?? null
  // the labels the card uses, as the board's list has them, so its tags show each name and colour; a label card's own
  // label in full
  const concepts = new Map<string, Concept>((req.labels ?? []).map((k) => [k.id, k as Concept]))
  if (concept) concepts.set(concept.id, concept)
  const ctx: CanvasCtx = {
    ws,
    filters: null,
    keep: null,
    concepts,
    threadOf: () => ({ chatId: null, name: '', writable: false }),
    unread: new Set(),
    refresh: () => undefined,
    openThread: () => undefined,
  }
  root.unmount()
  root = createRoot(host)
  try {
    flushSync(() =>
      root.render(
        <CanvasContext.Provider value={ctx}>
          <ChipContext.Provider value={{ workspace: ws, broken: new Set(), anchor: true }}>
            {figure ? (
              <Figure cell={cell} style={figure.style} part={figure.part} columns={figure.columns} caption={figure.caption} label={{ concept, error: null } as never} />
            ) : (
              <div className={`bcell bcell-kind-${kindOf(cell)}`} style={{ position: 'relative', width }}>
                <CardFace cell={cell} width={width - CARD_PAD_X} label={{ concept, error: null } as never} />
              </div>
            )}
          </ChipContext.Provider>
        </CanvasContext.Provider>,
      ),
    )
  } catch (e) {
    return { box: null, fonts: false, requests: unanswered, error: `the card did not render: ${(e as Error).message}`, ms: { settle: 0 } }
  }
  const card = host.querySelector<HTMLElement>(figure ? '.figure' : 'article.canvas-card')
  if (!card) return { box: null, fonts: false, requests: unanswered, error: 'the card did not render', ms: { settle: 0 } }
  // a card still drawing after SETTLE_MAX_MS is shot as it stands
  await settled(card)
  const fonts = await fontsLoaded(figures === 'blog' ? [...FACES, ...BLOG_FACES] : FACES)
  // a figure is measured by its own box alone: no body past what it shows, nothing wider than its room
  if (figure) return { box: boxOf(card), fonts, requests: [...unanswered], ms: { settle: Math.round(now() - t0) } }
  const wide = bodyWidth(card)
  return { box: boxOf(card), body: bodyHeight(card), ...(wide ? { wide } : {}), fonts, requests: [...unanswered], ms: { settle: Math.round(now() - t0) } }
}

declare global {
  interface Window {
    __thimbleRender: { ready: boolean; render: typeof render; settled: typeof settled }
  }
}

// `settled` is there for the harness's parity test, which waits for the canvas's own card the same way
window.__thimbleRender = { ready: true, render, settled }
