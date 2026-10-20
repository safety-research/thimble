// Whether the product tour runs now (shell/TourHost sets it from the welcome to the tour's end). While it runs, the
// chat shows no view proposal above its composer (chat/ProposalCard), so only the tour's examples show.
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
