// The terminal's own failure notices (SPEC-v2 3.20), beside the workspace's (home's state `notices`, panel.tsx
// homeNotices): a press that could not open the browser, a proxy that may stop the link, and the like. Each is a row
// above the prompt (band.tsx), `notice` in red, with the acts that fix it and `dismiss`, each act's words saying what
// its press does (modActWords, noticeActWords, seeWords), and each new key posts one toast; so does each new notice of
// the workspace's. Notices draw with every feature off and never reach the model.
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

/** The words of a terminal notice's act on its row, which say what its press does: `doctor` says in a toast how to
 *  find what is wrong and fix it (`how to fix it`); the others (`try again`, `copy link`) as posted. */
export function modActWords(act: string): string {
  return act === 'doctor' ? 'how to fix it' : act
}

/** The words of a workspace notice's act on its row (panel.tsx NoticeAct), which say what its press does: `settings`
 *  says in a toast where thimble's config is, the terminal's Settings (`how to fix it`); `ticket-open` opens the ticket
 *  in the browser workbench, where the analyst allows it (`allow in the browser ›`); the others (`try again`, `retry`,
 *  `turn off view proposals`) as thimble words them. */
export function noticeActWords(a: { act: string; label: string }): string {
  if (a.act === 'settings') return 'how to fix it'
  if (a.act === 'ticket-open') return 'allow in the browser ›'
  return oneLine(a.label || a.act).toLowerCase()
}

/** The words of the press that opens a notice's thread, which name what opens (the owner's live test, 10-17: `open ›`
 *  opened the orientation's panel unasked): the agent as its notice names it, its kind without its title (`see the
 *  orientation ›`, `see the view build ›`); `see the thread ›` for a side thread. */
export function seeWords(n: { open: string; agent: string }): string {
  if (n.open === 'thread') return 'see the thread ›'
  const who = oneLine(n.agent).split(':')[0]!.trim().toLowerCase().replace(/^the\s+/, '')
  return `see the ${who || 'agent'} ›`
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
    // a notice's text that names thimble first (the activation's notices) toasts as it is, not `thimble: thimble …`
    cx.toast(/^thimble\b/.test(words) ? words : `thimble: ${words}`)
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
 *  which shows as rows; a notice that comes after is new. A notice that joins a row of the same notices (`ids`) adds to
 *  its count and toasts nothing again. */
export function toastNewNotices(cx: Ctx, notices: readonly { id: string; ids?: readonly string[]; text: string }[]): void {
  const idsOf = (n: { id: string; ids?: readonly string[] }) => (n.ids?.length ? n.ids : [n.id])
  if (!seeded) {
    seeded = true
    for (const n of notices) for (const id of idsOf(n)) toasted.add(`ws:${id}`)
    return
  }
  for (const n of notices) {
    const ids = idsOf(n)
    const fresh = ids.every(id => !toasted.has(`ws:${id}`))
    for (const id of ids) toasted.add(`ws:${id}`)
    if (fresh) cx.toast(`thimble: ${oneLine(n.text)}`)
  }
}
