// HTML and SVG that a model or a corpus wrote, made safe to put in the page itself (DOMPurify). The API is
// unauthenticated and answers the page's own origin, so injected script could call any route, and remote resources
// could leak what the page shows. Kept: markup, links, data:, blob: or media-route images, and in HTML the inline style
// properties of text, colour, spacing, borders and size (STYLE_KEPT) and pandas' `dataframe` class. Removed: script and
// event attributes, <style>, forms, every URL to another host, every URL to the app's own routes but the two that serve
// media (even a GET to some routes changes state), and in HTML any style that would place the output elsewhere in the
// page (position, z-index, transform), the app's classes and data-* attributes; ids are prefixed, so an output can
// neither draw over the app nor dress up as its parts. HTML that carries script runs in a sandboxed frame instead
// (components/Outputs HtmlFrame). This also applies under Vite, which serves no CSP.
import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify'

/** The paths of the routes that serve media: the corpus's (`/api/ws/<c>/media`) and a view's
 * (`/api/ws/<c>/views/<slug>/media`), as lib/media and the views build them. */
const MEDIA_ROUTE = /^\/api\/ws\/[^/]+\/(?:views\/[^/]+\/)?media$/

/** Whether markup may load `url`: a data: URL, a fragment, a blob: URL the page made, or one of the media routes on
 * `origin` (the page's own by default) named by an absolute path or a full URL. A relative path is refused, since the
 * browser resolves it against the document, not the root. Pure given `origin`. */
export function isLocalUrl(url: string, origin: string = typeof location === 'undefined' ? '' : location.origin): boolean {
  const u = url.trim()
  if (!u) return false
  if (/^data:/i.test(u) || u.startsWith('#')) return true
  if (!origin) return false
  let parsed: URL
  try {
    parsed = new URL(u, origin + '/')
  } catch {
    return false
  }
  if (parsed.protocol === 'blob:') return parsed.origin === origin
  if (parsed.origin !== origin) return false
  if (!(/^\/(?![/\\])/.test(u) || u.toLowerCase().startsWith(origin.toLowerCase() + '/'))) return false
  if (/%2f|%5c/i.test(parsed.pathname)) return false
  return MEDIA_ROUTE.test(parsed.pathname)
}

/** Whether a style attribute's value loads anything markup may not (a url() that is not isLocalUrl, or an image-set()). */
export function styleReachesOut(style: string, origin?: string): boolean {
  if (/image-set\(|@import|expression\(/i.test(style)) return true
  for (const m of style.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) if (!isLocalUrl(m[2], origin)) return true
  return false
}

const URL_ATTRS = ['src', 'href', 'xlink:href', 'poster', 'background', 'action', 'data']

/** The inline style properties HTML output keeps: its text, colours, spacing, borders and size. */
export const STYLE_KEPT =
  /^(color|opacity|visibility|display|background(-color)?|font(-(family|size|style|weight|variant))?|line-height|letter-spacing|word-(spacing|break)|white-space|overflow-wrap|vertical-align|text-(align|indent|transform|overflow|decoration(-[a-z]+)?)|(padding|margin)(-(top|right|bottom|left))?|border(-(top|right|bottom|left))?(-(width|style|color))?|border(-(top|bottom)-(left|right))?-radius|border-(collapse|spacing)|(min-|max-)?(width|height)|list-style(-[a-z]+)?|table-layout|caption-side|empty-cells)$/
/** The classes HTML output keeps: pandas' table, which the outputs' styles draw. */
const CLASS_KEPT = new Set(['dataframe'])

/** An HTML element's style and classes cut to what STYLE_KEPT and CLASS_KEPT allow. */
function keepOwnLook(el: Element): void {
  const style = (el as HTMLElement).style
  if (style && el.hasAttribute('style')) {
    const drop: string[] = []
    for (let i = 0; i < style.length; i++) if (!STYLE_KEPT.test(style[i])) drop.push(style[i])
    for (const prop of drop) style.removeProperty(prop)
    if (!style.length) el.removeAttribute('style')
  }
  const cls = el.getAttribute('class')
  if (cls != null) {
    const kept = cls.split(/\s+/).filter((c) => CLASS_KEPT.has(c))
    if (kept.length) el.setAttribute('class', kept.join(' '))
    else el.removeAttribute('class')
  }
}

/** The attributes of `el` that would load or send what isLocalUrl refuses, removed; a link stays and opens in a new tab. */
function keepLocal(el: Element): void {
  for (const name of URL_ATTRS) {
    const v = el.getAttribute(name)
    if (v == null) continue
    // a link is followed only when the reader clicks it, so its target may be anywhere; it never replaces the app
    if (name === 'href' && el.localName === 'a') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noreferrer noopener')
      continue
    }
    if (!isLocalUrl(v)) el.removeAttribute(name)
  }
  const style = el.getAttribute('style')
  if (style != null && styleReachesOut(style)) el.removeAttribute('style')
}

let instance: Purifier | null = null
// whether the sanitize under way is of HTML, whose look is cut (keepOwnLook), or of an SVG figure, which keeps its own
let cuttingLook = false

/** One DOMPurify for the page, with the hook above; null where there is no DOM (DOMPurify would then hand the input back
 * unchanged, so its callers return nothing instead). */
function purifier(): Purifier | null {
  if (instance) return instance
  if (typeof window === 'undefined') return null
  const p = DOMPurify(window)
  if (!p.isSupported) return null
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeType !== 1) return
    keepLocal(node as Element)
    if (cuttingLook) keepOwnLook(node as Element)
  })
  instance = p
  return p
}

const FORMS = ['form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'datalist']

const HTML: Config = {
  FORBID_TAGS: ['style', 'link', 'meta', 'base', ...FORMS],
  FORBID_ATTR: ['srcset', 'formaction', 'form', 'ping'],
  ALLOW_DATA_ATTR: false,
  SANITIZE_NAMED_PROPS: true,
}

const SVG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['style', 'foreignObject', 'a', 'script'],
  FORBID_ATTR: ['srcset'],
  ADD_ATTR: ['role'],
}

/** A kernel's or a model's HTML (a table, a formatted summary) made safe to inline (module note); '' without a DOM. */
export function purifyHtml(html: string): string {
  const p = purifier()
  if (!p) return ''
  cuttingLook = true
  try {
    return p.sanitize(html, { ...HTML, RETURN_TRUSTED_TYPE: false }) as string
  } finally {
    cuttingLook = false
  }
}

/** An SVG figure's markup made safe to inline: SVG elements only, no <style>, no foreignObject (whose HTML would leave
 * the figure), no link and no URL to another host; '' without a DOM. */
export function purifySvg(svg: string): string {
  const p = purifier()
  return p ? (p.sanitize(svg, { ...SVG, RETURN_TRUSTED_TYPE: false }) as string) : ''
}
