// A sandboxed iframe's document painted on the card, not on a white sheet of its own: the page's colour scheme (an
// iframe whose scheme differs from its parent's gets an opaque backdrop), a transparent body in the card's text colour,
// the theme's tokens as CSS variables for the html to use, and the page's own faces. Shared by the custom card, kernel
// html outputs and the views' pages.
import { useEffect, useState } from 'react'
import type { Resolved } from './theme'
import { token } from './vizTheme'

/** The frame's style: `fonts` is the page's faces as @font-face rules (useFrameFonts), which a sandboxed document with
 * an opaque origin cannot load from the app by URL. */
export function frameStyle(scheme: Resolved, tokens: Readonly<Record<string, string>>, fonts: string = ''): string {
  const vars = Object.entries(tokens)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  return `<style>${fonts}:root{color-scheme:${scheme};${vars}}body{background:transparent!important;color:var(--text-primary, inherit)!important;font-family:var(--font-body, system-ui, sans-serif)!important;font-size:13px;line-height:1.5}code,pre,kbd,samp{font-family:var(--font-mono, ui-monospace, monospace)}</style>`
}

/** The html with the frame style at its head (inside `<head>` when there is one, else first). */
export function withFrameStyle(html: string, style: string): string {
  const at = html.search(/<head[^>]*>/i)
  if (at >= 0) {
    const end = html.indexOf('>', at) + 1
    return html.slice(0, end) + style + html.slice(end)
  }
  return style + html
}

export const FRAME_TOKENS = ['--text-primary', '--text-secondary', '--text-tertiary', '--surface-card', '--bg-sub', '--bg-sunken', '--border-subtle', '--accent', '--font-body', '--font-mono']

/** The current values of the frame tokens, read from the document. */
export function frameTokens(): Record<string, string> {
  return Object.fromEntries(FRAME_TOKENS.map((k) => [k, token(k)]))
}

/** The tokens a view's page reads (views.frame_document; plugin/viewers use them with light fallbacks), those the parts
 * of backend/app/viewer_kit.css are drawn in, and the label palette the marks of the labels that are on are drawn in
 * (viewer_bridge.js), so they match the Labels pane's. */
export const VIEW_TOKENS = [
  ...FRAME_TOKENS,
  '--ink-rgb',
  '--accent-hover',
  '--text-accent',
  '--text-on-accent',
  '--text-on-inverse',
  '--text-placeholder',
  '--surface-hover',
  '--surface-selected',
  '--surface-inverse',
  '--raised-bg',
  '--raised-ring',
  '--track-bg',
  '--chip-edge',
  '--chip-bg',
  '--chip-edge-hover',
  '--chip-bg-hover',
  '--text-xs',
  '--text-ui-sm',
  '--text-sm',
  '--text-lg',
  '--text-mono',
  '--text-mono-sm',
  '--h-chip',
  '--h-control',
  '--control-sm',
  '--h-row',
  '--radius-chip',
  '--radius-seg',
  '--radius-ui',
  '--radius-card',
  '--transition-color',
  '--accent-soft',
  '--border-hairline',
  '--border-strong',
  '--bg-panel',
  '--status-positive',
  '--status-negative',
  '--status-warning',
  '--viz-1',
  '--viz-2',
  '--viz-3',
  '--viz-4',
  '--viz-5',
  '--viz-ink-1',
  '--viz-ink-2',
  '--viz-ink-3',
  '--viz-ink-4',
  '--label-1',
  '--label-2',
  '--label-3',
  '--label-4',
  '--label-5',
  '--label-6',
  '--label-7',
  '--label-8',
  '--label-9',
  '--label-10',
  '--label-11',
  '--label-12',
  '--label-none',
]

/** The theme for a view's page: the colour scheme and the tokens as CSS variables, and no font import, because the
 * page's policy lets it reach no host. */
export function viewStyle(scheme: Resolved): string {
  const vars = VIEW_TOKENS.map((k) => [k, token(k)] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  return `<style>:root{color-scheme:${scheme};${vars}}</style>`
}

/** the families the page serves itself (styles/fonts.css) */
const PAGE_FAMILIES = ['Hanken Grotesk', 'Geist Mono']

/** The page's own faces among @font-face rules as the browser writes them back (CSSFontFaceRule.cssText), each
 * {decls: its declarations with the src left out, url: its woff2}: the families of styles/fonts.css, their latin and
 * latin-ext subsets (the files are named by subset, and the others, cyrillic and vietnamese, would only add weight to
 * every frame). Pure, so tests run it. */
export function pageFaces(rules: readonly string[]): { decls: string; url: string }[] {
  const out: { decls: string; url: string }[] = []
  for (const rule of rules) {
    const body = /@font-face\s*\{([\s\S]*)\}/.exec(rule)?.[1]
    if (!body) continue
    const family = /font-family:\s*["']?([^;"']+)["']?/.exec(body)?.[1]?.trim()
    if (!family || !PAGE_FAMILIES.includes(family)) continue
    const url = /url\(\s*["']?([^)"']+?\.woff2[^)"']*)["']?\s*\)/.exec(body)?.[1]
    if (!url || !/-latin-/.test(url)) continue
    out.push({ decls: body.replace(/src:[^;]*;?/, '').trim(), url })
  }
  return out
}

let facesOnce: Promise<string> | null = null
/** the rules once fetched, for a frame built after that to have them at once */
let facesDone: string | null = null

/** @font-face rules with the page's two faces inlined as data URLs, read from the page's own stylesheets and fetched
 * once per page: a sandboxed frame has an opaque origin, so it can load no font from the app by URL, and without them
 * its text would fall back to the system face. '' when there are none or they cannot be fetched (the frame then keeps
 * the fallback). */
export function frameFonts(): Promise<string> {
  if (facesOnce) return facesOnce
  facesOnce = (async () => {
    try {
      const texts: string[] = []
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try {
          rules = sheet.cssRules
        } catch {
          continue // a sheet from another origin cannot be read
        }
        for (const r of Array.from(rules)) if (r.cssText.startsWith('@font-face')) texts.push(r.cssText)
      }
      const rules = await Promise.all(
        pageFaces(texts).map(async ({ decls, url }) => {
          const buf = new Uint8Array(await (await fetch(new URL(url, document.baseURI))).arrayBuffer())
          let bin = ''
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
          return `@font-face{${decls}${decls.endsWith(';') ? '' : ';'}src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2');}`
        }),
      )
      return rules.join('')
    } catch {
      return ''
    }
  })().then((r) => (facesDone = r))
  return facesOnce
}

/** The page's faces for a frame's document: null until they are read, then the rules (or '' when there are none). A
 * frame waits for them, so it is drawn once, in them. */
export function useFrameFonts(): string | null {
  const [fonts, setFonts] = useState<string | null>(facesDone)
  useEffect(() => {
    if (fonts != null) return
    let alive = true
    void frameFonts().then((f) => alive && setFonts(f))
    return () => {
      alive = false
    }
  }, [fonts])
  return fonts
}

/** The page's faces for a view's page, in a style element. */
export async function viewFonts(): Promise<string> {
  const rules = await frameFonts()
  return rules ? `<style>${rules}</style>` : ''
}
