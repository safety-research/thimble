// Text the paper made hard to read, given the ink that reads (I26). A custom card's page and a matplotlib figure are
// written for a light page: black text on white. On a dark paper, text that sets no color takes the paper's light ink,
// which vanishes on a box the page filled white, and text the page colored dark vanishes on the paper. mendInk reads
// each text's color and what is behind it: the nearest ancestor with an opaque background, else the paper; for an SVG
// text, the shape drawn under it. Where the text reads under 3:1 there but read better on a light page, it takes the
// paper's dark or light ink, whichever reads. A pairing the page chose both halves of keeps its colors, so text a card
// makes faint stays faint, and on a light paper nothing changes. The custom card's frame runs it after its page draws
// (inkScript), and an inlined figure runs it after it draws and when the paper changes (Outputs InlineSvg).
// mendInk reads nothing outside its own body, since inkScript writes its source into a frame.

/** What mendInk knows of the paper: its card's color, its ink and the ink's inverse (the two inks a mended text may
 * take), and the colors of its text tokens (a text in one of them follows the paper). Each is a CSS color. */
export type Inks = { paper: string; inks: [string, string]; tokens: string[] }

/** The text tokens a page's text may follow the paper by. */
export const TEXT_TOKENS = ['--text-primary', '--text-secondary', '--text-tertiary', '--text-placeholder', '--viz-ink-1', '--viz-ink-2', '--viz-ink-3', '--viz-ink-4']

/** The attribute that keeps what a mended element's own style said before (unmendInk). */
export const MENDED = 'data-thimble-ink'

/** Gives each text under `root` that the paper made hard to read the ink that reads (module note); returns how many it
 * changed. Needs a browser's layout for an SVG text's place. */
export function mendInk(root: Element, o: Inks): number {
  type RGBA = [number, number, number, number]
  const MIN = 3
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true })
  } catch {
    ctx = null
  }
  const memo = new Map<string, RGBA>()
  // a CSS color as sRGB 0-255 and alpha: rgb() as the browser writes it, any other through a canvas pixel
  const rgba = (s: string): RGBA | null => {
    const got = memo.get(s)
    if (got) return got
    let v: RGBA | null = null
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s.trim())
    if (m) v = [+m[1], +m[2], +m[3], m[4] == null ? 1 : m[5] ? +m[4] / 100 : +m[4]]
    else if (/^(?:none|auto|currentcolor|inherit|initial|unset)?$/i.test(s.trim()) || /url\(/i.test(s)) v = null
    else if (ctx) {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = 'rgba(0, 0, 0, 0)'
      ctx.fillStyle = s
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      v = [d[0], d[1], d[2], d[3] / 255]
    }
    if (v) memo.set(s, v)
    return v
  }
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const lum = (c: RGBA) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
  const ratio = (a: RGBA, b: RGBA) => {
    const x = lum(a)
    const y = lum(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA
  const paper = rgba(o.paper)
  const inks = o.inks.map((s) => ({ s, c: rgba(s) }))
  if (!paper || !inks[0].c || !inks[1].c) return 0
  // a light paper is the page the text was written for
  if (lum(paper) > 0.4) return 0
  const [dark, light] = lum(inks[0].c) <= lum(inks[1].c!) ? inks : [inks[1], inks[0]]
  const tokens = o.tokens.map(rgba).filter((c): c is RGBA => !!c)
  const follows = (c: RGBA) => tokens.some((t) => Math.abs(t[0] - c[0]) + Math.abs(t[1] - c[1]) + Math.abs(t[2] - c[2]) <= 6)

  // what is behind an element: the translucent backgrounds over it, top first, on its nearest opaque background (null:
  // the paper); undefined when a picture or a gradient is behind it, whose color is not known
  type Behind = { layers: RGBA[]; base: RGBA | null }
  const behind = (el: Element | null): Behind | undefined => {
    const layers: RGBA[] = []
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return undefined
      const c = rgba(cs.backgroundColor)
      if (c && c[3] >= 0.98) return { layers, base: c }
      if (c && c[3] > 0.02) layers.push(c)
    }
    return { layers, base: null }
  }
  const flat = (b: Behind, page: RGBA) => b.layers.reduceRight((under, top) => over(top, under), b.base ?? page)

  // the fill of the topmost shape drawn under an SVG text's middle: a color, 'unknown' (a picture, a gradient), or
  // null when nothing is drawn under it
  const SHAPES = 'rect,circle,ellipse,path,polygon,polyline,line,use,image'
  // each drawn shape of an svg once per pass: its computed style and the inverse of its place
  const drawn = new Map<SVGSVGElement, { s: SVGGraphicsElement; cs: CSSStyleDeclaration; inv: DOMMatrix }[]>()
  const shapesOf = (svg: SVGSVGElement) => {
    let got = drawn.get(svg)
    if (got) return got
    got = []
    for (const s of Array.from(svg.querySelectorAll<SVGGraphicsElement>(SHAPES))) {
      if (s.closest('defs,clipPath,mask,marker,pattern,symbol')) continue
      const cs = getComputedStyle(s)
      const sm = s.getCTM()
      if (cs.display === 'none' || cs.visibility === 'hidden' || !sm) continue
      got.push({ s, cs, inv: sm.inverse() })
    }
    drawn.set(svg, got)
    return got
  }
  const under = (t: SVGGraphicsElement): RGBA | 'unknown' | null => {
    const svg = t.ownerSVGElement
    const m = t.getCTM()
    if (!svg || !m) return null
    let box: DOMRect
    try {
      box = t.getBBox()
    } catch {
      return null
    }
    const p = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(m)
    let hit: RGBA | 'unknown' | null = null
    for (const { s, cs, inv } of shapesOf(svg)) {
      if (!(t.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_PRECEDING)) continue
      let q = p.matrixTransform(inv)
      let shape: Element | null = s
      if (s.tagName === 'use') {
        const use = s as SVGUseElement
        const id = (use.href?.baseVal || use.getAttribute('xlink:href') || '').replace(/^#/, '')
        shape = id ? svg.querySelector(`[id="${id.replace(/["\\]/g, '')}"]`) : null
        // the use's x and y place what it draws; its own place (getCTM) leaves them out
        q = new DOMPoint(q.x - use.x.baseVal.value, q.y - use.y.baseVal.value)
        const own = shape && (shape as SVGGraphicsElement).transform?.baseVal?.consolidate()
        if (own) q = q.matrixTransform(own.matrix.inverse())
      }
      let inside = false
      if (s.tagName === 'image') {
        const b = (s as SVGImageElement).getBBox()
        inside = q.x >= b.x && q.x <= b.x + b.width && q.y >= b.y && q.y <= b.y + b.height
        if (inside) hit = 'unknown'
        continue
      }
      if (!shape || typeof (shape as SVGGeometryElement).isPointInFill !== 'function') continue
      try {
        inside = (shape as SVGGeometryElement).isPointInFill(q)
      } catch {
        inside = false
      }
      if (!inside) continue
      if (/url\(/i.test(cs.fill)) {
        hit = 'unknown'
        continue
      }
      const f = rgba(cs.fill)
      const a = (f ? f[3] : 0) * parseFloat(cs.fillOpacity || '1') * parseFloat(cs.opacity || '1')
      if (f && a >= 0.5) hit = [f[0], f[1], f[2], 1]
    }
    return hit
  }

  const mend = (el: HTMLElement | SVGElement, prop: 'color' | 'fill', c: RGBA, b: Behind) => {
    const now = flat(b, paper)
    const seen = ratio(over(c, now), now)
    if (seen >= MIN) return 0
    // the same text on a light page: a color that follows the paper is its dark ink there, and the paper is light
    const page = flat(b, light.c!)
    const ref = follows(c) ? dark.c! : c
    if (ratio(over(ref, page), page) <= seen) return 0
    const ink = ratio(dark.c!, now) >= ratio(light.c!, now) ? dark.s : light.s
    // MENDED, written out: this body is written into a frame alone
    if (!el.hasAttribute('data-thimble-ink')) el.setAttribute('data-thimble-ink', JSON.stringify([prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]))
    el.style.setProperty(prop, ink, 'important')
    return 1
  }

  let n = 0
  const all = [root, ...Array.from(root.querySelectorAll('*'))]
  for (const el of all) {
    if (!(el instanceof HTMLElement || el instanceof SVGElement) || /^(?:script|style|noscript|template|title|desc|defs|metadata)$/i.test(el.tagName)) continue
    if (el instanceof SVGElement) {
      if (el.tagName !== 'text') continue
      const cs = getComputedStyle(el)
      const c = rgba(cs.fill)
      if (!c || c[3] * parseFloat(cs.fillOpacity || '1') < 0.3) continue
      const u = under(el as SVGGraphicsElement)
      if (u === 'unknown') continue
      const b = u ? { layers: [], base: u } : behind(el.ownerSVGElement)
      if (b) n += mend(el, 'fill', [c[0], c[1], c[2], c[3] * parseFloat(cs.fillOpacity || '1')], b)
      continue
    }
    if (el.closest('svg') || !Array.from(el.childNodes).some((k) => k.nodeType === 3 && /\S/.test(k.nodeValue ?? ''))) continue
    const cs = getComputedStyle(el)
    const c = rgba(cs.color)
    const fill = (cs as CSSStyleDeclaration & { webkitTextFillColor?: string }).webkitTextFillColor
    if (!c || c[3] < 0.3 || (fill && rgba(fill)?.join() !== c.join())) continue
    const b = behind(el)
    if (b) n += mend(el, 'color', c, b)
  }
  return n
}

/** Puts back what mendInk changed under `root`. */
export function unmendInk(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll(`[${MENDED}]`))]) {
    const was = el.getAttribute(MENDED)
    if (!was || !(el instanceof HTMLElement || el instanceof SVGElement)) continue
    const [prop, value, priority] = JSON.parse(was) as [string, string, string]
    if (value) el.style.setProperty(prop, value, priority)
    else el.style.removeProperty(prop)
    el.removeAttribute(MENDED)
  }
}

/** The page's paper and inks for mendInk, read from the document's tokens. */
export function paperInks(token: (name: string) => string): Inks {
  return { paper: token('--surface-card'), inks: [token('--text-primary'), token('--text-on-inverse')], tokens: TEXT_TOKENS.map(token).filter(Boolean) }
}

/** A frame's script that runs mendInk over its page once it has drawn and again when its page changes. */
export function inkScript(o: Inks): string {
  const data = JSON.stringify(o).replace(/</g, '\\u003c')
  const src = mendInk.toString().replace(/<\/script/gi, '<\\/script')
  return `<script>(function(){var mend=${src},o=${data},t=0;function run(){t=0;try{if(document.body)mend(document.body,o)}catch(e){}}function later(){if(!t)t=setTimeout(run,100)}addEventListener('load',run);document.addEventListener('DOMContentLoaded',run);new MutationObserver(later).observe(document.documentElement,{childList:true,subtree:true,characterData:true})})()</script>`
}
