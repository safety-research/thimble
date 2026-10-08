// Whether the product tour runs now (shell/TourHost sets it from the welcome to the tour's end). While it runs, main's
// chat draws no Start gate (chat/StartGate startGateShown): the tour's orientation step shows its own example in the
// gate's place, and its other steps show no Start card at all.
import { useSyncExternalStore } from 'react'

let touring = false
const subs = new Set<() => void>()

/** Record that the tour started or ended. */
export function setTouring(on: boolean): void {
  if (touring === on) return
  touring = on
  for (const f of subs) f()
}

/** Whether the tour runs now. */
export const isTouring = (): boolean => touring

/** Whether the tour runs now, as a component reads it. */
export function useTouring(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => void subs.delete(f)
    },
    isTouring,
    () => false,
  )
}
