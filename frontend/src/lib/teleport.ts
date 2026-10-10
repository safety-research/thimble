// Chips teleport: a ref opens the surface that owns it and brings the element into view.
import { bus } from './bus'
import { plainRef, surfaceOf } from './refs'

/** Open the surface that owns `ref` at it; with `browser`, a file's ref opens in the File browser rather than in a view
 * that claims the file; with `focus`, a canvas card's or frame's ref opens focus mode on the first card of its frame
 * (a canvas group's chip: Canvas, bus openRef); with `still`, a canvas card is opened neither selected nor flashed.
 * Files shows itself once it knows where the ref opens, since a pane that shows a view on its own may take it instead
 * (FilesTab). */
export function teleport(ref: string, opts: { browser?: boolean; focus?: boolean; still?: boolean } = {}): void {
  const r = plainRef(ref.trim())
  if (!r) return
  const tab = surfaceOf(r)
  if (tab && tab !== 'files') bus.emit('showTab', { tab })
  bus.emit('openRef', { ref: r, ...(opts.browser ? { browser: true } : {}), ...(opts.focus ? { focus: true } : {}), ...(opts.still ? { still: true } : {}) })
}

/** The element `?ref=<ref>` in the page's URL names, which the shell opens once it is mounted (Shell): the screenshot
 * tool loads the workspace at one card this way (backend tools._shot_card), to picture it as the analyst sees it, so
 * the card opens still, with no selection ring and no flash in the picture. */
export function refFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const v = new URLSearchParams(window.location.search).get('ref')?.trim() ?? ''
  return v || null
}

/** Scroll the element carrying `data-anchor=ref` into view and flash it; false when none is mounted. */
export function revealAnchor(ref: string, root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLElement>(`[data-anchor="${cssEscape(ref)}"]`)
  if (!el) return false
  el.scrollIntoView({ block: 'center' })
  el.classList.add('anchor-flash')
  window.setTimeout(() => el.classList.remove('anchor-flash'), 1600)
  return true
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}
