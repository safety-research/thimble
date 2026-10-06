// Drawings of one site, one at a time (pure, no `$`). Two drawings of a pane in flight at once can settle out of order,
// and Claude Code then keeps the earlier one, whose buttons' handles the later one released: every press on it does
// nothing until the pane is drawn again. register.tsx draws its panel through one of these.

/** A timer that calls `fire` after a while, and can be cancelled before then (`$.clock.after`). */
export type Limit = (fire: () => void) => { cancel: () => void }

export type Turns = { run: <T>(fn: () => Promise<T>, limit: Limit) => Promise<T> }

/** Runs each `fn` once the one before it has settled, or once `limit` fires while it has not. */
export function turns(): Turns {
  let last: Promise<void> = Promise.resolve()
  let busy = 0
  return {
    async run(fn, limit) {
      const before = last
      let settled = () => {}
      last = new Promise<void>(r => (settled = r))
      if (busy++) {
        let timer: { cancel: () => void } | undefined
        await Promise.race([before, new Promise<void>(r => (timer = limit(r)))])
        timer?.cancel()
      }
      try {
        return await fn()
      } finally {
        busy--
        settled()
      }
    },
  }
}
