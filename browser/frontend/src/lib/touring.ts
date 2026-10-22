// Whether the product tour runs now (shell/TourHost sets it from the welcome to the tour's end). While it runs, the
// chat shows no view proposal above its composer (chat/ProposalCard), so only the tour's examples show.

let touring = false
const subs = new Set<() => void>()

/** Record that the tour started or ended. */
export function setTouring(on: boolean): void {
  if (touring === on) return
  touring = on
  for (const f of subs) f()
}

