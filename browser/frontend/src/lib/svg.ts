// A matplotlib figure inlined on the card as SVG with real text, instead of an <img>, so the page's fonts and CSS apply
// and a check can measure its text. The kernel writes text as <text> (backend matplotlibrc: svg.fonttype none), and here
// the figure is made safe and fitted to the page:
//   - nothing that runs or reaches out survives (scripts, foreignObject, event attributes, external hrefs), then
//     DOMPurify's SVG profile (lib/sanitize) over the whole;
//   - no <style>, which would restyle every svg on the page; a `*` rule's stroke and fill move to the root;
//   - ids are prefixed per figure, so figures never share clip paths or glyphs;
//   - fonts and thimble's matplotlibrc colours become the page's tokens; a white background is dropped;
//   - it keeps its aspect and never grows past its natural width.
// The DOM half needs a browser (DOMParser); restyle and rootDecls are pure.
import { purifySvg } from './sanitize'

/** matplotlib's default families, and the ones thimble's matplotlibrc names, as the page's own faces */
const SANS_FIRST = /^\s*['"]?(?:DejaVu Sans|Bitstream Vera Sans|Hanken Grotesk|Arial|Helvetica|sans-serif)['"]?\s*(?:,|$)/i
const MONO_FIRST = /^\s*['"]?(?:DejaVu Sans Mono|Bitstream Vera Sans Mono|Geist Mono|monospace)['"]?\s*(?:,|$)/i

/** matplotlibrc's color cycle (the Warm paper's --viz-1 to --viz-7 with the default accent), in order: each becomes its
 * series token, so a figure's series follow the paper and the accent as a Vega chart's do */
export const MPL_CYCLE = ['#5e4bd6', '#018d82', '#e26101', '#306602', '#0471c8', '#c8367b', '#a08319']
/** the colors thimble.colours gives a figure colored by a label (kernel_thimble LABEL_COLOURS: --label-none, then
 * --label-1 to --label-18), each its label token, so the figure's classes follow the paper as the Labels pane's do */
export const MPL_LABELS = ['#a09c93', '#025ac3', '#d0750a', '#06572a', '#1392d4', '#7d6702', '#009c85', '#844500', '#013c77', '#2aa02b', '#025a7c', '#622b01', '#0389a0', '#d0342c', '#8a1c1c', '#7b4fd6', '#4c2a91', '#d23f8b', '#8d1d5c']

const both = (v: string) => ({ fill: v, stroke: v })

/** thimble's matplotlibrc colors, the label colors and neutral inks of thimble.colours (kernel_thimble NEUTRAL_COLOURS,
 * the third of which is the grid's below), and matplotlib's own black and white, by the token each becomes. */
const COLOURS: Record<string, { fill: string; stroke: string }> = {
  ...Object.fromEntries(MPL_LABELS.map((hex, i) => [hex, both(`var(--label-${i || 'none'})`)])),
  ...Object.fromEntries(MPL_CYCLE.map((hex, i) => [hex, both(`var(--viz-${i + 1})`)])),
  '#1b1a18': both('var(--viz-ink-1)'),
  '#6b675f': both('var(--viz-ink-2)'),
  '#64625b': { fill: 'var(--viz-label)', stroke: 'var(--viz-label)' },
  '#a19d94': { fill: 'var(--viz-ink-3)', stroke: 'var(--viz-axis)' },
  '#cfcbc2': { fill: 'var(--viz-ink-4)', stroke: 'var(--viz-grid)' },
  '#000000': { fill: 'var(--text-primary)', stroke: 'var(--viz-ink-1)' },
  '#000': { fill: 'var(--text-primary)', stroke: 'var(--viz-ink-1)' },
  black: { fill: 'var(--text-primary)', stroke: 'var(--viz-ink-1)' },
}

/**
 * A figure element's style attribute rewritten for the page (module note): the families in the page's faces, the
 * matplotlibrc colours as theme tokens, and, when `background` (a figure or axes patch), white fill dropped. Pure.
 */
export function restyle(style: string, background = false): string {
  return style
    .split(';')
    .map((decl) => {
      const at = decl.indexOf(':')
      if (at < 0) return decl
      const prop = decl.slice(0, at).trim().toLowerCase()
      const value = decl.slice(at + 1).trim()
      const v = value.toLowerCase()
      if (prop === 'font-family') {
        if (MONO_FIRST.test(value)) return ` font-family: var(--font-mono)`
        if (SANS_FIRST.test(value)) return ` font-family: var(--font-body)`
        return decl
      }
      if (prop === 'font') {
        // the shorthand `font: 10px 'DejaVu Sans'`: its family part in the page's face
        const m = /^((?:[\w.%-]+\s+)*?[\d.]+(?:px|pt|em|rem|%)(?:\/[\w.%]+)?)\s+(.+)$/.exec(value)
        if (m && MONO_FIRST.test(m[2])) return ` font: ${m[1]} var(--font-mono)`
        if (m && SANS_FIRST.test(m[2])) return ` font: ${m[1]} var(--font-body)`
        return decl
      }
      if ((prop === 'fill' || prop === 'stroke') && COLOURS[v]) return ` ${prop}: ${COLOURS[v][prop]}`
      if (prop === 'fill' && background && (v === '#ffffff' || v === '#fff' || v === 'white')) return ' fill: none'
      return decl
    })
    .join(';')
}

/** The stroke and fill declarations of the `* { … }` rules in a figure's stylesheet (matplotlib writes
 * `*{stroke-linejoin: round; stroke-linecap: butt}`), for the root's style attribute; any other rule is dropped. Pure. */
export function rootDecls(css: string): string {
  const out: string[] = []
  for (const m of css.matchAll(/(?:^|[}\s])\*\s*\{([^{}]*)\}/g))
    for (const decl of m[1].split(';')) {
      const at = decl.indexOf(':')
      if (at < 0) continue
      const prop = decl.slice(0, at).trim().toLowerCase()
      const value = decl.slice(at + 1).trim()
      if (/^(?:stroke|fill)(?:-[a-z]+)?$/.test(prop) && /^[\w\s.#%,-]+$/.test(value)) out.push(`${prop}: ${value}`)
    }
  return out.join('; ')
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const DANGEROUS = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'set', 'animateTransform', 'animateMotion']
const LENGTH = /^\s*([\d.]+)\s*(pt|px)?\s*$/

/** A length in CSS px (matplotlib writes its size in pt). */
function px(v: string | null): number | null {
  const m = v ? LENGTH.exec(v) : null
  if (!m) return null
  const n = parseFloat(m[1])
  return m[2] === 'pt' ? (n * 4) / 3 : n
}

/**
 * The figure's markup made safe and fitted to the page (module note), with every id prefixed by `prefix`; null when
 * it is not an SVG document or there is no DOM to make it safe with. Needs a DOMParser.
 */
export function inlineSvg(text: string, prefix: string): { markup: string; width: number | null; height: number | null } | null {
  if (typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = doc.documentElement
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return null
  for (const tag of DANGEROUS) for (const el of Array.from(svg.getElementsByTagName(tag))) el.remove()
  // an element of another namespace (an XHTML <div> inside the figure) would end the <svg> where the page parses the
  // markup, and what follows it would lose the figure
  for (const el of Array.from(svg.getElementsByTagName('*'))) if (el.namespaceURI !== SVG_NS) el.remove()
  for (const el of Array.from(svg.getElementsByTagName('metadata'))) el.remove()
  const styles = Array.from(svg.getElementsByTagName('style'))
  const inherited = styles.map((st) => rootDecls(st.textContent ?? '')).filter(Boolean).join('; ')
  for (const st of styles) st.remove()
  if (inherited) svg.setAttribute('style', [svg.getAttribute('style'), inherited].filter(Boolean).join('; '))
  // links keep their content, not their target
  for (const a of Array.from(svg.getElementsByTagName('a'))) {
    while (a.firstChild) a.parentNode?.insertBefore(a.firstChild, a)
    a.remove()
  }
  const ids = new Set<string>()
  const all = [svg, ...Array.from(svg.getElementsByTagName('*'))]
  for (const el of all) {
    const id = el.getAttribute('id')
    if (id) ids.add(id)
  }
  const ref = (s: string) => s.replace(/url\(\s*#([^)\s]+)\s*\)/g, (m, id: string) => (ids.has(id) ? `url(#${prefix}${id})` : 'none'))
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
        continue
      }
      if (name === 'href' || name === 'xlink:href') {
        const v = attr.value.trim()
        if (v.startsWith('#') && ids.has(v.slice(1))) el.setAttribute(attr.name, `#${prefix}${v.slice(1)}`)
        else if (!/^data:image\/(?:png|jpe?g|gif|webp);/i.test(v)) el.removeAttribute(attr.name)
        continue
      }
      if (name === 'id') el.setAttribute('id', prefix + attr.value)
      else if (name === 'style') {
        const g = el.parentElement
        const background = el.nodeName === 'path' && !!g && /^patch_\d+$/.test(g.getAttribute('id') ?? '') && !!g.parentElement && /^(?:figure|axes)_\d+$/.test(g.parentElement.getAttribute('id') ?? '')
        el.setAttribute('style', ref(restyle(attr.value, background)))
      } else if (attr.value.includes('url(')) el.setAttribute(attr.name, ref(attr.value))
    }
  }
  const width = px(svg.getAttribute('width'))
  const height = px(svg.getAttribute('height'))
  if (!svg.getAttribute('viewBox') && width && height) svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  // its size in px, which the stylesheet scales to the room (width 100%, height from the viewBox), so a measure of
  // the drawing reads the figure's own px
  if (width && height) {
    svg.setAttribute('width', String(Math.round(width)))
    svg.setAttribute('height', String(Math.round(height)))
  } else {
    svg.removeAttribute('width')
    svg.removeAttribute('height')
  }
  svg.setAttribute('class', 'outputs-svg-figure')
  svg.setAttribute('role', 'img')
  const markup = purifySvg(new XMLSerializer().serializeToString(svg))
  return markup ? { markup, width, height } : null
}
