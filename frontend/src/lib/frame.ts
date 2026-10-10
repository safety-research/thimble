// A sandboxed iframe's document painted on the card, not on a white sheet of its own: the page's colour scheme (an
// iframe whose scheme differs from its parent's gets an opaque backdrop), a transparent body in the card's text colour,
// the theme's tokens as CSS variables for the html to use, and the page's own faces. Shared by the custom card, kernel
// html outputs and the views' pages. A custom card's frame also gets the chart style as a script (chartScript) and the
// libraries the card names (useCardLibs).
import { useEffect, useState } from 'react'
import { api } from './api'
import type { Resolved } from './theme'
import { token, vegaConfig, VIZ_DIV, VIZ_INK, VIZ_SEQ, VIZ_SERIES } from './vizTheme'

/** Takes WebRTC away from a frame before its own scripts run, since no content security policy covers it. A frame the
 * page opens inside itself has it again, so this is no boundary; the headless shots take it from every frame
 * (scripts/view_shot.mjs). */
export const NO_RTC = "<script>for(const k of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel'])try{Object.defineProperty(window,k,{value:undefined})}catch{}</script>"

/** The frame's head: NO_RTC, then the style. `fonts` is the page's faces as @font-face rules (useFrameFonts), which a
 * sandboxed document with an opaque origin cannot load from the app by URL. */
export function frameStyle(scheme: Resolved, tokens: Readonly<Record<string, string>>, fonts: string = ''): string {
  const vars = Object.entries(tokens)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  return `${NO_RTC}<style>${fonts}:root{color-scheme:${scheme};${vars}}body{background:transparent!important;color:var(--text-primary, inherit)!important;font-family:var(--font-body, system-ui, sans-serif)!important;font-size:13px;line-height:1.5}code,pre,kbd,samp{font-family:var(--font-mono, ui-monospace, monospace)}</style>`
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

/** The chart style (tokens.css, lib/vizTheme) a frame's html can draw a chart in: the series in order, the sequential and
 * diverging ramps, the muted "other" and the highlight, the inks, the chrome, the faces and sizes, and a label's
 * colors for a chart colored by a label. A custom card's scripts also get the colors as thimble.colors (chartScript). */
export const CHART_TOKENS = [
  ...VIZ_SERIES,
  ...VIZ_SEQ,
  ...VIZ_DIV,
  '--viz-other',
  '--viz-highlight',
  ...VIZ_INK,
  '--viz-grid',
  '--viz-axis',
  '--viz-label',
  '--viz-annotation',
  '--viz-font',
  '--viz-font-label',
  '--viz-size',
  '--viz-size-title',
  '--viz-line',
  ...Array.from({ length: 18 }, (_, i) => `--label-${i + 1}`),
  '--label-none',
]

export const FRAME_TOKENS = ['--text-primary', '--text-secondary', '--text-tertiary', '--surface-card', '--bg-sub', '--bg-sunken', '--border-subtle', '--accent', '--font-body', '--font-mono', ...CHART_TOKENS]

/** The current values of the frame tokens, read from the document. */
export function frameTokens(): Record<string, string> {
  return Object.fromEntries(FRAME_TOKENS.map((k) => [k, token(k)]))
}

/** The tokens a view's page reads (views.frame_document; plugin/viewers use them with light fallbacks), those the parts
 * of backend/app/viewer_kit.css are drawn in (its Color by menu among them), and, with the frame's, the chart style and
 * the label palette the marks of the labels that are on are drawn in (viewer_bridge.js, from FRAME_TOKENS' CHART_TOKENS), so they match the Labels pane's. */
export const VIEW_TOKENS = [
  ...FRAME_TOKENS,
  '--ink-rgb',
  '--accent-hover',
  '--text-accent',
  '--text-link',
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
  '--hl-bg',
  '--hl-bg-strong',
  '--border-hairline',
  '--border-strong',
  '--bg-panel',
  '--overlay-bg',
  '--overlay-edge',
  '--shadow-popover',
  '--text-eyebrow',
  '--radius-hl',
  '--status-positive',
  '--status-negative',
  '--status-warning',
]

/** The head for a view's page: NO_RTC, then the colour scheme and the tokens as CSS variables, and no font import,
 * because the page's policy lets it load nothing from another host. */
export function viewStyle(scheme: Resolved): string {
  const vars = VIEW_TOKENS.map((k) => [k, token(k)] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  return `${NO_RTC}<style>:root{color-scheme:${scheme};${vars}}</style>`
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

/** Text for an inline <script> or JSON in one: a `<` can end no element. */
const scriptSafe = (text: string) => text.replace(/</g, '\\u003c')

/** thimble's chart style for a custom card's scripts, read from the document as the tokens are: `thimble.colors`, the
 * series in order (series), the sequential and diverging ramps (seq, div), the muted other and the highlight, and the
 * ink ramp (ink), and `thimble.vegaConfig`, the config of the canvas's own Vega-Lite charts (vizTheme vegaConfig), for
 * vega-embed. */
export function chartScript(): string {
  const colors = { series: VIZ_SERIES.map(token), seq: VIZ_SEQ.map(token), div: VIZ_DIV.map(token), other: token('--viz-other'), highlight: token('--viz-highlight'), ink: VIZ_INK.map(token) }
  const style = { colors, vegaConfig: vegaConfig() }
  return `<script>window.thimble=Object.assign(window.thimble||{},${scriptSafe(JSON.stringify(style))})</script>`
}

const cardLibs = new Map<string, Promise<string>>()
/** the lists kept, newest last: vega's three builds are 830 kB, and the card harness's page draws each card under a
 * workspace key of its own (render.tsx) */
const CARD_LIBS_KEPT = 8

/** A custom card's libraries (backend card_libs) as one head of inline scripts and styles, fetched once per workspace
 * and list; an answer with a problem (a package not bundled yet) or a failed fetch is asked again by the next frame,
 * and draws the frame with the problem in its console. */
function loadCardLibs(ws: string, query: string): Promise<string> {
  const key = `${ws}\n${query}`
  let got = cardLibs.get(key)
  if (!got) {
    const fail = (why: string) => {
      cardLibs.delete(key)
      return `<script>console.error(${scriptSafe(JSON.stringify(why))})</script>`
    }
    got = api.cardLibs(ws, query).then(
      (r) => {
        if (r.problems?.length) cardLibs.delete(key)
        return r.head ?? ''
      },
      (e: unknown) => fail(`the libraries ${query} did not load: ${(e as Error)?.message ?? String(e)}`),
    )
    cardLibs.set(key, got)
    for (const old of cardLibs.keys()) if (cardLibs.size > CARD_LIBS_KEPT) cardLibs.delete(old)
  }
  return got
}

/** The head of the libraries a custom card names, for its frame: '' when it names none, null until they are fetched,
 * so the frame is drawn once, with them. */
export function useCardLibs(ws: string, libs: readonly string[] | undefined): string | null {
  const query = (libs ?? []).join(',')
  const key = `${ws}\n${query}`
  const [got, setGot] = useState<{ key: string; head: string } | null>(null)
  useEffect(() => {
    if (!query) return
    let alive = true
    void loadCardLibs(ws, query).then((head) => alive && setGot({ key, head }))
    return () => {
      alive = false
    }
  }, [ws, query, key])
  if (!query) return ''
  return got?.key === key ? got.head : null
}

/** The page's faces for a view's page, in a style element. */
export async function viewFonts(): Promise<string> {
  const rules = await frameFonts()
  return rules ? `<style>${rules}</style>` : ''
}
