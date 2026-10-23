// The tour's freeze: listeners on the window, in the capture phase, registered when the page loads and before any of
// the app's own, so that while the tour runs it sees every input first and can stop it before the app does. Without a
// tour they do nothing. The tour itself (./engine) is loaded only when it runs and installs its guard here.

export type Guard = (e: Event) => void

/** The inputs the tour may stop. */
export const FROZEN = [
  'keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
  'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dragstart', 'wheel', 'touchmove',
] as const

let guard: Guard | null = null

/** Install the running tour's guard, or none. */
export function setGuard(fn: Guard | null): void {
  guard = fn
}

if (typeof window !== 'undefined') {
  for (const type of FROZEN) window.addEventListener(type, (e) => guard?.(e), { capture: true, passive: false })
}
