// The shell's panes, for code outside the shell: which surfaces the panes show (so a ref for a view shown in a pane
// opens there), the pane a press last landed in (so what it opens goes beside that pane), the start of a drag that
// takes a surface to a pane, and the place in Files' pane head where Files draws its views while it shows beside another
// pane. The shell writes the surfaces, the drag and the place.
import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'

let shown: readonly string[] = []
const listeners = new Set<() => void>()
let dragStart: ((e: ReactPointerEvent, surface: string) => void) | null = null
let pressed: { pane: string; at: number } | null = null

/** How long after a press a request to show a surface counts as coming from the press's pane. A request that waits on
 * the server (Files placing a ref) takes the pane when it is asked, not when it is answered. */
export const FROM_PANE_MS = 1500

export function setShownSurfaces(surfaces: readonly string[]): void {
  if (surfaces.length === shown.length && surfaces.every((s, i) => s === shown[i])) return
  shown = surfaces
  listeners.forEach((l) => l())
}

export function surfaceShown(surface: string): boolean {
  return shown.includes(surface)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The surfaces the panes show, as state that changes with them. */
export function useShownSurfaces(): readonly string[] {
  return useSyncExternalStore(subscribe, () => shown)
}

/** A press on `el`: its pane, or none when it lies outside every pane (the chat, the top bar). */
export function notePress(el: Element | null): void {
  const pane = el?.closest?.('[data-pane]')?.getAttribute('data-pane')
  pressed = pane ? { pane, at: Date.now() } : null
}

/** A press in a layer outside the shell (a popover or menu portaled to the body) counts for the pane pressed before it,
 * which opened the layer. */
export function renewPress(): void {
  if (pressed) pressed = { ...pressed, at: Date.now() }
}

/** The pane the last press landed in, while it is recent (FROM_PANE_MS); null otherwise. */
export function pressedPane(): string | null {
  return pressed && Date.now() - pressed.at < FROM_PANE_MS ? pressed.pane : null
}

export function setSurfaceDrag(start: ((e: ReactPointerEvent, surface: string) => void) | null): void {
  dragStart = start
}

/** Begin dragging `surface` toward a pane (shell/PaneArea usePaneDrag); a press that does not move stays a click. */
export function startSurfaceDrag(e: ReactPointerEvent, surface: string): void {
  dragStart?.(e, surface)
}

let viewsSlot: HTMLElement | null = null
const slotListeners = new Set<() => void>()

/** The place in Files' pane head for its views (shell/PaneArea), or null while Files' pane has no head (one pane). */
export function setFilesViewsSlot(el: HTMLElement | null): void {
  if (el === viewsSlot) return
  viewsSlot = el
  slotListeners.forEach((l) => l())
}

/** Where Files draws its views: its pane head's place for them, else null, and Files draws them as a row at its top. */
export function useFilesViewsSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (l) => {
      slotListeners.add(l)
      return () => {
        slotListeners.delete(l)
      }
    },
    () => viewsSlot,
  )
}
