// The page's pure helpers: the html as the sandboxed frame shows it (theme scheme and tokens on the root, a default
// body style, the page's own styles untouched) and the frame's height held to a range.
import { FRAME_TOKENS, withFrameStyle } from '../lib/frame'
import type { Resolved } from '../lib/theme'
import { token } from '../lib/vizTheme'

export const PAGE_MIN_HEIGHT = 240
export const PAGE_MAX_HEIGHT = 12000
/** the tokens the page can use, the frame's plus the ones the page prompt names */
export const PAGE_TOKENS = [...FRAME_TOKENS, '--text-link', '--surface-hover']

export function clampPageHeight(h: number): number {
  if (!Number.isFinite(h)) return PAGE_MIN_HEIGHT
  return Math.min(PAGE_MAX_HEIGHT, Math.max(PAGE_MIN_HEIGHT, Math.ceil(h)))
}

/** The page's document for the frame: the app's fonts inlined as @font-face (the sandboxed frame's opaque origin cannot
 * load them by URL), `color-scheme` and tokens on the root, and a non-`!important` body default so the page's own
 * styles win. */
export function pageDocument(html: string, scheme: Resolved, tokens: Readonly<Record<string, string>>, fonts = ''): string {
  const vars = Object.entries(tokens)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  const style = `<style>${fonts}:root{color-scheme:${scheme};${vars}}body{margin:0;color:var(--text-primary,inherit);font-family:var(--font-body,system-ui,sans-serif);font-size:14px;line-height:1.5}code,pre,kbd,samp{font-family:var(--font-mono,ui-monospace,monospace)}</style>`
  return withFrameStyle(html, style)
}

/** The page as a standalone file for Export, with `title` as its <title> when the html has none. */
export function pageFile(html: string, title: string, scheme: Resolved, tokens: Readonly<Record<string, string>>, fonts = ''): string {
  const doc = pageDocument(html, scheme, tokens, fonts)
  if (/<title[\s>]/i.test(html) || !title.trim()) return doc
  const esc = title.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return withFrameStyle(doc, `<title>${esc}</title>`)
}

/** The current values of the page tokens, read from the document (the fallbacks under node). */
export function pageTokens(): Record<string, string> {
  return Object.fromEntries(PAGE_TOKENS.map((k) => [k, token(k)]))
}
