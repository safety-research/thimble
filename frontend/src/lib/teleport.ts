// Chips teleport: a ref opens the surface that owns it and brings the element into view. The refs the terminal opens the
// page at (`thimble open --ref`, the 0.9.0 contract C12) include some that name no element (pageRef): `home`, `checks`,
// `files:<folder>`, `ticket:<id>` and `answer:<turn>#s<n>`.
import { api } from './api'
import { bus } from './bus'
import { plainRef, surfaceOf } from './refs'

/** Open one of the page's own refs (module note), and whether `ref` was one: `home` opens nothing more; `checks` the
 * report with its Checks pane; `files:<folder>` the File browser at the folder (`files:` alone, at the corpus);
 * `ticket:<id>` the thread that ran the code ticket; `answer:<turn>#s<n>` main's chat, where the passage comes into view
 * with its comment open (chat/Rows). */
export function pageRef(ref: string): boolean {
  if (ref === 'home') return true
  if (ref === 'checks') {
    bus.emit('showTab', { tab: 'report' })
    return true
  }
  if (ref.startsWith('files:')) {
    const folder = ref.slice('files:'.length).replace(/^\.?\/*/, '').replace(/\/+$/, '')
    bus.emit('showTab', { tab: 'files' })
    if (folder) bus.emit('openRef', { ref: `${folder}/`, browser: true })
    return true
  }
  if (ref.startsWith('ticket:')) {
    const id = ref.slice('ticket:'.length)
    void api
      .ticket(id)
      .then((t) => bus.emit('openChat', { chatId: t.chat || 'main' }))
      .catch(() => bus.emit('openChat', { chatId: 'main' }))
    return true
  }
  if (ref.startsWith('answer:')) {
    bus.emit('openChat', { chatId: 'main' })
    bus.emit('openRef', { ref })
    return true
  }
  return false
}

/** Open the surface that owns `ref` at it; with `browser`, a file's ref opens in the File browser rather than in a view
 * that claims the file; with `focus`, a canvas card's or frame's ref opens focus mode on the first card of its frame
 * (a canvas group's chip: Canvas, bus openRef); with `still`, a canvas card is opened neither selected nor flashed.
 * Files shows itself once it knows where the ref opens, since a pane that shows a view on its own may take it instead
 * (FilesTab). */
export function teleport(ref: string, opts: { browser?: boolean; focus?: boolean; still?: boolean } = {}): void {
  const r = plainRef(ref.trim())
  if (!r || pageRef(r)) return
  const tab = surfaceOf(r)
  if (tab && tab !== 'files') bus.emit('showTab', { tab })
  bus.emit('openRef', { ref: r, ...(opts.browser ? { browser: true } : {}), ...(opts.focus ? { focus: true } : {}), ...(opts.still ? { still: true } : {}) })
}

/** The element `?ref=<ref>` in the page's URL names, which the shell opens once it is mounted (Shell): the screenshot
 * tool loads the workspace at one card this way (backend tools._shot_card), to picture it as the analyst sees it, so
 * the card opens still, with no selection ring and no flash in the picture, and no tour welcome over it (TourHost). */
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
