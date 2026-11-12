// The card harness's page (render.html; backend/app/render.py keeps a few open in headless Chromium): one card drawn
// with the canvas's own CardFace, width, theme and stylesheet, so the picture the card check reads is what the analyst
// sees; or, for an export, the card's art alone as a report figure draws it (report/FigureArt), on the export's paper,
// and for an export of the card alone (`whole`) the figure whole: its question over the art and its takeaway beside the
// rule under it. The page calls no API: each request carries the card with its refs resolved, cited calls, card and
// label names (and a label card's `label` data, a custom card's libraries), and a fetch stub answers the page's
// requests from them, listing any it could not. A figure's files besides the picture (backend card_export.py) come from
// the same drawing: its chart as an SVG file of its own (chartSvg, in the result), the picture as WebP (webp) and the
// page set for the harness's print of the figure alone as a PDF (print).
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import './styles/index.css'
import { ChatMarkdown, ChipContext } from './chat/markdown'
import { bodyHeight, bodyWidth } from './canvas/bodyHeight'
import { CardFace } from './canvas/CardFace'
import { CARD_PAD_X } from './canvas/Cell'
import { CanvasContext, type CanvasCtx } from './canvas/context'
import { kindOf } from './canvas/layout'
import { apiPath } from './lib/browserKey'
import { registerCells, registerConcepts } from './lib/cellName'
import { inlineFaces, pageFaceRules, pageFaces } from './lib/frame'
import { getAccent, getPaper, holdTheme, type Accent, type Paper } from './lib/theme'
import type { Cell, Concept, ConceptDetail } from './lib/types'
import { drawnView } from './lib/vegaDraw'
import { FigureArt } from './report/FigureArt'
import { readableText } from './report/model'

export interface RenderRequest {
  ws: string
  card: Cell
  /** every ref the card cites, as GET /corpora/{c}/ref returns it; {error, status} for one that does not resolve */
  citations: Record<string, unknown>
  names: { id: string; notebook?: string; title: string }[]
  /** the labels the card uses, for the tags in the Labels row under its question (canvas/CardFace CardLabels): each
   * one's name, and what its colour is read from (files/labels mainColour), as GET /ws/{c}/concepts lists it */
  labels?: ({ id: string; name: string } & Partial<Pick<Concept, 'unit' | 'marks' | 'labels' | 'classes'>>)[]
  theme: { paper: Paper; accent: Accent }
  width: number
  /** a label card's label as the API returns it: GET /concepts/{id}, and the workspace's settings */
  label?: LabelData | null
  /** a custom card's libraries by its `libs` query, as GET /ws/{c}/card-libs returns them */
  cardLibs?: Record<string, { head: string; problems: string[] }>
  /** draw the card's art as a report figure shows it, `width` wide, in place of the card face: the picture an export
   * shows for the figure, whole where a wide table or chart would scroll on the page */
  figure?: boolean
  /** with `figure`, how many times larger than its layout the art is drawn, so the picture stays sharp printed or on a
   * slide */
  zoom?: number
  /** with `figure`, the figure whole as one picture `width` wide: the card's question over its art and its takeaway
   * beside the rule under it, as an export of the card alone shows it */
  whole?: boolean
  /** with `figure`, what to make of the drawing besides its picture: `svg` here, the others by the harness after its
   * shot */
  files?: FigureFile[]
}

/** A figure's file besides its picture (backend render.FIGURE_FILES). */
export type FigureFile = 'webp' | 'pdf' | 'svg'

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
  /** the chart as an SVG file of its own, when the request's `files` name `svg` (chartSvg); null for a figure with no
   * chart */
  svg?: string | null
  ms: { settle: number }
}

/** the longest a card may take to settle before it is shot as it stands, ms */
const SETTLE_MAX_MS = 5000
/** the DOM must stay unchanged this long, ms, with no body saying it is still drawing */
const QUIET_MS = 60
/** where the card sits on the page: clear of the edges, so its hairline ring is in the picture */
const MARGIN = 16
/** the white around a whole figure's question, art and caption, px (styles/report.css .render-figure-whole) */
const FIGURE_PAD = 20
const FACES = ['400 13px "Hanken Grotesk"', '500 13px "Hanken Grotesk"', '400 12px "Geist Mono"']
/** a figure's WebP: the quality its picture is encoded at */
const WEBP_QUALITY = 0.92

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
const STAGE = `position:absolute;left:0;top:0;overflow:visible;display:block;flex:none;padding:${MARGIN}px;min-width:100%;box-sizing:border-box`
stage.style.cssText = STAGE
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
async function fontsLoaded(): Promise<boolean> {
  try {
    await Promise.all(FACES.map((f) => document.fonts.load(f)))
    return FACES.every((f) => document.fonts.check(f))
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
  // the pool's pages share one storage, so each holds its request's theme to itself rather than store it (lib/theme)
  if (req.theme?.paper || req.theme?.accent) holdTheme(req.theme.paper ?? getPaper(), req.theme.accent ?? getAccent())
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
  const figure = req.figure === true
  const whole = figure && req.whole === true
  const zoom = req.zoom && req.zoom > 0 ? req.zoom : 1
  // a whole figure's caption: the takeaway's words, its citations taken out, since nothing in a file opens them
  const caption = whole ? readableText(cell.takeaway ?? '') : ''
  // a figure's picture stands on the report's paper, past its width too, where a wide table goes on
  stage.style.background = figure ? 'var(--surface-card)' : ''
  root.unmount()
  root = createRoot(host)
  try {
    flushSync(() =>
      root.render(
        <CanvasContext.Provider value={ctx}>
          <ChipContext.Provider value={{ workspace: ws, broken: new Set(), anchor: true }}>
            {whole ? (
              <div className="render-figure render-figure-whole" style={{ width, zoom }}>
                {cell.title ? <div className="wu-fig-q">{cell.title}</div> : null}
                <div className="render-figure-art">
                  <FigureArt ws={ws} cell={cell} width={width - 2 * FIGURE_PAD} />
                </div>
                {caption ? (
                  <div className="wu-fig-take">
                    <div className="wu-fig-caption chat-text">
                      <ChatMarkdown text={caption} />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : figure ? (
              <div className="render-figure" style={{ width, zoom }}>
                <FigureArt ws={ws} cell={cell} width={width} />
              </div>
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
  const svg = async (el: HTMLElement) => (req.files?.includes('svg') ? { svg: await chartSvg(el) } : {})
  if (figure) {
    const art = host.querySelector<HTMLElement>('.render-figure')
    const drawn = whole ? art?.querySelector('.render-figure-art')?.firstElementChild : art?.firstElementChild
    if (!art || !drawn) return { box: null, fonts: false, requests: unanswered, error: 'the card has no figure to draw', ms: { settle: 0 } }
    await settled(art)
    const fonts = await fontsLoaded()
    // the box reaches as far as the art does, zoomed: a table wider than the figure is drawn whole (report.css
    // .render-figure), with a whole figure's white beside it
    const box = boxOf(art)
    const right = Math.max(...Array.from(art.querySelectorAll('*'), (el) => el.getBoundingClientRect().right))
    box.width = Math.max(box.width, right + window.scrollX - box.x + (whole ? FIGURE_PAD * zoom : 0))
    return { box, fonts, requests: [...unanswered], ...(await svg(art)), ms: { settle: Math.round(now() - t0) } }
  }
  const card = host.querySelector<HTMLElement>('article.canvas-card')
  if (!card) return { box: null, fonts: false, requests: unanswered, error: 'the card did not render', ms: { settle: 0 } }
  // a card still drawing after SETTLE_MAX_MS is shot as it stands
  await settled(card)
  const fonts = await fontsLoaded()
  const wide = bodyWidth(card)
  return { box: boxOf(card), body: bodyHeight(card), ...(wide ? { wide } : {}), fonts, requests: [...unanswered], ms: { settle: Math.round(now() - t0) } }
}

/** The color an element is drawn on: the background of the nearest box under it that has one; null for none. */
function backgroundOf(el: Element): string | null {
  for (let at: Element | null = el; at; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor
    if (color && !/^(?:transparent|rgba\(.*,\s*0\))$/.test(color)) return color
  }
  return null
}

/** The faces an SVG file's text names, of thimble's two: their regular and medium weights in the latin subset as
 * @font-face rules with the files inlined (lib/frame), so the file shows thimble's faces wherever it opens; '' when it
 * names neither or a file cannot be read. */
async function svgFaces(svg: string): Promise<string> {
  const named = pageFaces(pageFaceRules()).filter(({ decls, url }) => /-latin-(?:400|500)-normal\b/.test(url) && svg.includes(/font-family:\s*["']?([^;"']+)/.exec(decls)?.[1]?.trim() || '\0'))
  try {
    return await inlineFaces(named)
  } catch {
    return ''
  }
}

/** An SVG document as a file of its own: the faces it names inlined (svgFaces), and a rect of `color` under all it
 * draws (none for no color). */
async function svgFile(svg: string, color: string | null): Promise<string> {
  const faces = await svgFaces(svg)
  const head = (faces ? `<style>${faces}</style>` : '') + (color ? `<rect width="100%" height="100%" fill="${color}"/>` : '')
  return head ? svg.replace(/<svg\b[^>]*>/, (open) => open + head) : svg
}

/** A drawn figure's chart as an SVG file of its own, on the color it is drawn on (a chart itself is transparent): a Vega
 * chart's own (its view's toSVG), else the figure the card drew as SVG (a matplotlib figure, lib/svg) with each of the
 * page's tokens it names written as its value. null for a figure with no chart. */
async function chartSvg(el: HTMLElement): Promise<string | null> {
  const box = el.querySelector('.outputs-vega')
  const view = box ? drawnView(box) : null
  if (box && view) return svgFile(await view.toSVG(), backgroundOf(box))
  const fig = el.querySelector<SVGSVGElement>('svg.outputs-svg-figure')
  if (!fig) return null
  const style = getComputedStyle(fig)
  const values = (text: string) => text.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (all, name: string, fallback?: string) => style.getPropertyValue(name).trim() || fallback?.trim() || all)
  const copy = fig.cloneNode(true) as SVGSVGElement
  for (const node of [copy, ...Array.from(copy.querySelectorAll('*'))])
    for (const attr of Array.from(node.attributes)) if (attr.value.includes('var(')) node.setAttribute(attr.name, values(attr.value))
  copy.removeAttribute('class')
  copy.removeAttribute('role')
  return svgFile(new XMLSerializer().serializeToString(copy), backgroundOf(fig))
}

/** The last render's picture (a PNG, base64) as WebP at WEBP_QUALITY, base64; null when this browser cannot encode
 * WebP. */
async function webp(png: string): Promise<string | null> {
  const image = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (ch) => ch.charCodeAt(0))], { type: 'image/png' }))
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext('2d')?.drawImage(image, 0, 0)
  image.close()
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/webp', WEBP_QUALITY))
  // a browser that cannot encode WebP gives a PNG
  if (!blob || blob.type !== 'image/webp') return null
  const url = await new Promise<string>((done, fail) => {
    const reader = new FileReader()
    reader.onload = () => done(String(reader.result))
    reader.onerror = () => fail(reader.error)
    reader.readAsDataURL(blob)
  })
  return url.slice(url.indexOf(',') + 1)
}

/** The page set for the harness's print of the last picture alone as a PDF (render.py), or set back with null: the
 * picture's box (CSS px, as the shot clipped it) is the whole page, the stage laid out to start at the box and to end
 * with it, all else clipped, on the paper it was drawn on. By layout, not a transform: the print breaks pages and fits
 * the page's width by where boxes are laid out, so a figure laid out past the page's edge would lose what crosses it,
 * or be shrunk to fit. */
function print(box: Box | null): void {
  const paper = stage.style.background
  if (!box) {
    stage.style.cssText = STAGE
  } else {
    // where the picture is in the stage's content
    const x = box.x - MARGIN
    const y = box.y - MARGIN
    stage.style.cssText = `position:absolute;left:${-x}px;top:${-y}px;overflow:hidden;display:block;flex:none;padding:0;width:${x + box.width}px;height:${y + box.height}px;box-sizing:border-box`
  }
  stage.style.background = paper
}

declare global {
  interface Window {
    __thimbleRender: { ready: boolean; render: typeof render; settled: typeof settled; webp: typeof webp; print: typeof print }
  }
}

// `settled` is there for the harness's parity test, which waits for the canvas's own card the same way
window.__thimbleRender = { ready: true, render, settled, webp, print }
