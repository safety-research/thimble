// The links toggle in the top bar: whether citation chips show anywhere (the chat's prose, a cell's takeaway, the
// report). Off sets `data-links="off"` on <html> and styles/refchip.css hides every citation: a chip goes, a cited
// number stays as plain text. It holds for the page's life; a reload shows the links again.
import { useSyncExternalStore } from 'react'

let visible = true
const listeners = new Set<() => void>()

export const linksVisible = (): boolean => visible

export function setLinksVisible(on: boolean): void {
  if (on === visible) return
  visible = on
  if (typeof document !== 'undefined') {
    if (on) document.documentElement.removeAttribute('data-links')
    else document.documentElement.setAttribute('data-links', 'off')
  }
  listeners.forEach((fn) => fn())
}

export const toggleLinks = (): void => setLinksVisible(!visible)

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useLinksVisible(): boolean {
  return useSyncExternalStore(subscribe, linksVisible, () => true)
}
