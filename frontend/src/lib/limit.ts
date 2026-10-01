// A browser holds at most six connections to the server at once, one of them the workspace's event stream. A view's
// data calls have no time limit, so a page whose views make several at once could hold every other connection for
// minutes, and everything else the page sends, such as an answer to a permission request or the chat list, would wait
// behind them. At most HEAVY_MAX of those calls are on their way at once, and the others wait here, in order.

export const HEAVY_MAX = 3

/** A gate that lets at most `max` calls run at once: each call passed to it starts when a place is free, in the order
 * they came. A call whose `signal` aborts before it starts never starts, and answers with the abort's reason. */
export function limiter(max: number): <T>(start: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []
  const done = () => {
    running--
    waiting.shift()?.()
  }
  return <T>(start: () => Promise<T>, signal?: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', drop)
        running++
        let call: Promise<T>
        try {
          call = start()
        } catch (e) {
          call = Promise.reject(e)
        }
        call.then(resolve, reject).finally(done)
      }
      const drop = () => {
        const k = waiting.indexOf(go)
        if (k >= 0) waiting.splice(k, 1)
        reject(signal?.reason ?? new DOMException('The call was cancelled.', 'AbortError'))
      }
      if (signal?.aborted) return drop()
      if (running < max) return go()
      signal?.addEventListener('abort', drop, { once: true })
      waiting.push(go)
    })
}

/** The gate of the calls that can take minutes: a view's data calls. */
export const heavy = limiter(HEAVY_MAX)
