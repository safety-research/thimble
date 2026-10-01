// Reads of one resource that overlap, such as the chat list read again on each stream event while an earlier read is
// still under way: an answer older than one already used is dropped, so a slow earlier answer never puts back what a
// newer one took away (an answered permission request, a finished chat).

export const STALE: unique symbol = Symbol('stale')

/** A guard for one resource's reads: each read passed through it answers with its value, or with STALE when a read
 * started after it has answered already. */
export function newest<T>(): (read: Promise<T>) => Promise<T | typeof STALE> {
  let asked = 0
  let used = 0
  return (read) => {
    const n = ++asked
    return read.then((v) => {
      if (n < used) return STALE
      used = n
      return v
    })
  }
}
