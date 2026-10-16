// Failure notices in the terminal UI (term-panel lane, build spec 3.20): each new failure is a red row in the band with
// the acts that fix it, and one toast.
//
// SCAFFOLD STUB (C13): postNotice shows the toast only. Nothing here runs at import.
import type { Ctx } from './ctx'

/** A notice `key` with its `text` and `acts`: a band row and one toast (the stub: the toast). */
export function postNotice(cx: Ctx, _key: string, text: string, _acts: string[]): void {
  cx.toast(`thimble: ${text}`)
}
