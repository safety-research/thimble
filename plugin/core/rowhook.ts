// rowhook.ts: the ui.render hooks on AssistantMessage, which three modules chain (core/answerview.ts wraps
// cards/register.ts, which wraps marks/register.ts), each draw around the drawing beneath them and fail safe: a throw in
// one hook's own drawing answers the drawing beneath it, so the others' drawings stay whole, and the drawing beneath is
// asked for once, never a second time after a throw. Each hook is written
//
//   on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
//     const below = askOnce(e, next)
//     try { ...its drawing, with `await below()` for the one beneath... } catch { return below() }
//   }).catch(($, e, next) => next(e))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The drawing beneath a hook, asked once: `below()` with the event as given, `below(x)` with another; a later ask
 *  answers the first one's drawing. */
export type Below = (x?: Any) => Promise<Any>

export function askOnce(e: Any, next: (x: Any) => Promise<Any>): Below {
  let asked: Promise<Any> | null = null
  return x => (asked ??= next(x ?? e))
}
