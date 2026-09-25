// HTML and SVG that a model or a corpus wrote, made safe to put in the page itself (DOMPurify). The API is
// unauthenticated and answers the page's own origin, so injected script could call any route, and remote resources
// could leak what the page shows. Kept: markup, classes, inline style, links, and local or data: images. Removed:
// script and event attributes, <style>, forms, and every URL to another host. HTML that carries script runs in a
// sandboxed frame instead (components/Outputs HtmlFrame). This also applies under Vite, which serves no CSP.
import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify'

/** Whether `url` stays on the machine: a data: URL, a fragment, or a URL (relative or absolute) whose origin is
 * `origin`, the page's own by default. Pure given `origin`. */
export function isLocalUrl(url: string, origin: string = typeof location === 'undefined' ? '' : location.origin): boolean {
  const u = url.trim()
  if (!u) return false
  if (/^data:/i.test(u) || u.startsWith('#')) return true
  if (!origin) return false
  try {
    return new URL(u, origin + '/').origin === origin
  } catch {
    return false
  }
}

/** Whether a style attribute's value loads anything from another host (a url() or an image-set() that is not local). */
export function styleReachesOut(style: string, origin?: string): boolean {
  if (/image-set\(|@import|expression\(/i.test(style)) return true
  for (const m of style.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) if (!isLocalUrl(m[2], origin)) return true
  return false
}

const URL_ATTRS = ['src', 'href', 'xlink:href', 'poster', 'background', 'action', 'data']

/** The attributes of `el` that would load from, or send to, another host, removed; a link that stays opens in a new tab. */
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

/** One DOMPurify for the page, with the hook above; null where there is no DOM (DOMPurify would then hand the input back
 * unchanged, so its callers return nothing instead). */
function purifier(): Purifier | null {
  if (instance) return instance
  if (typeof window === 'undefined') return null
  const p = DOMPurify(window)
  if (!p.isSupported) return null
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeType === 1) keepLocal(node as Element)
  })
  instance = p
  return p
}

const FORMS = ['form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'datalist']

const HTML: Config = {
  FORBID_TAGS: ['style', 'link', 'meta', 'base', ...FORMS],
  FORBID_ATTR: ['srcset', 'formaction', 'form', 'ping'],
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
  return p ? (p.sanitize(html, { ...HTML, RETURN_TRUSTED_TYPE: false }) as string) : ''
}

/** An SVG figure's markup made safe to inline: SVG elements only, no <style>, no foreignObject (whose HTML would leave
 * the figure), no link and no URL to another host; '' without a DOM. */
export function purifySvg(svg: string): string {
  const p = purifier()
  return p ? (p.sanitize(svg, { ...SVG, RETURN_TRUSTED_TYPE: false }) as string) : ''
}
