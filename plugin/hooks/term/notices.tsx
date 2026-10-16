// The terminal's own failure notices (SPEC-v2 3.20), beside the workspace's (home's state `notices`, panel.tsx
// homeNotices): a press that could not open the browser, a proxy that may stop the link, and the like. Each is a red row
// above the prompt (band.tsx) with the acts that fix it and `dismiss`, and each new key posts one toast; so does each
// new notice of the workspace's. Notices draw with every feature off and never reach the model.
//
// The rows live in the panel's surface state under NOTICES (so the band draws again when they change); what an act
// does is kept here by the notice's key and the act's words (onNoticeAct).
import type { Ctx } from './ctx'
import { noControls } from './lib'

/** A notice of the terminal's own: its key (`open:failed`), its words, its acts (besides `dismiss`) and when. */
export type ModNotice = { key: string; text: string; acts: string[]; at: number }

/** The surface state key the notices are kept under. */
export const NOTICES = 'mod-notices'

// what each notice's acts do, by its key and the act's words
const actions = new Map<string, Map<string, () => Promise<void> | void>>()
// the notice keys a toast said already, the terminal's own and the workspace's (`ws:<id>`)
const toasted = new Set<string>()
let seeded = false

/** What `act` of notice `key` does from now on. */
export function onNoticeAct(key: string, act: string, run: () => Promise<void> | void): void {
  const m = actions.get(key) ?? new Map<string, () => Promise<void> | void>()
  m.set(act, run)
  actions.set(key, m)
}

/** The terminal's notices as the band draws them, newest first. */
export async function modNotices(cx: Ctx): Promise<ModNotice[]> {
  const got = await cx.surface(NOTICES)
  const v = got?.ok ? (got.value as ModNotice[]) : []
  return Array.isArray(v) ? [...v].sort((a, b) => b.at - a.at) : []
}

/** Words for a row or a toast: one line, no control characters. */
function oneLine(text: string): string {
  return noControls(text).replace(/\s+/g, ' ').trim()
}

/** A notice posted (SPEC-v2 C13): a row above the prompt until it is dismissed or posted again, and one toast the
 *  first time its key is posted while it is not shown. */
export function postNotice(cx: Ctx, key: string, text: string, acts: string[]): void {
  const words = oneLine(text)
  if (!toasted.has(key)) {
    toasted.add(key)
    cx.toast(`thimble: ${words}`)
  }
  void (async () => {
    const now = await cx.now()
    const rest = (await modNotices(cx)).filter(n => n.key !== key)
    await cx.setSurface(NOTICES, { ok: true, value: [...rest, { key, text: words, acts: acts.filter(a => a !== 'dismiss'), at: now }] })
  })()
}

/** A notice gone; its key toasts again if it is posted again later. */
export async function dismissModNotice(cx: Ctx, key: string): Promise<void> {
  toasted.delete(key)
  actions.delete(key)
  await cx.setSurface(NOTICES, { ok: true, value: (await modNotices(cx)).filter(n => n.key !== key) })
}

/** An act of a terminal notice pressed: what onNoticeAct set for it; `doctor` says where to look. */
export async function runNoticeAct(cx: Ctx, n: ModNotice, act: string): Promise<void> {
  const run = actions.get(n.key)?.get(act)
  if (run) return void (await run())
  if (act === 'doctor') return cx.toast('thimble: run `thimble doctor` in a shell: it says what is wrong and how to fix it')
  cx.toast(`thimble: "${act}" cannot run from here`)
}

/** One toast for each workspace notice not toasted yet. The first look of a session only notes what is there already,
 *  which shows as rows; a notice that comes after is new. */
export function toastNewNotices(cx: Ctx, notices: readonly { id: string; text: string }[]): void {
  if (!seeded) {
    seeded = true
    for (const n of notices) toasted.add(`ws:${n.id}`)
    return
  }
  for (const n of notices) {
    if (toasted.has(`ws:${n.id}`)) continue
    toasted.add(`ws:${n.id}`)
    cx.toast(`thimble: ${oneLine(n.text)}`)
  }
}
