// actions.ts: what the person does, in one place: step through the marks, open one in the bottom panel, press a verb
// under a message, press a squeeze chip, ask. Everything that changes the session goes to the terminal as a line
// (api.back); the page shows that it was sent, and the records show what came of it.
import { back, serverModule, type Scope } from './api'
import { prepare } from './marks'
import { getState, setState, type Row, type TrayEntry, type Verb } from './store'

/** Every mark of the main thread's messages, in reading order: [{row, i}]. */
export function allMarks(rows: Row[]): { row: string; i: number }[] {
  const out: { row: string; i: number }[] = []
  for (const r of rows) {
    if (r.kind !== 'assistant' || !r.record) continue
    prepare(r.record).marks.forEach((_, i) => out.push({ row: r.row, i }))
  }
  return out
}

/** The next mark (dir 1) or the one before (dir -1), opened in the bottom panel; from none, the latest message's first. */
export function stepMark(list: { row: string; i: number }[], dir: number): void {
  if (!list.length) return
  const s = getState()
  const at = s.focus ? list.findIndex((p) => p.row === s.focus!.row && p.i === s.focus!.i) : -1
  let next: { row: string; i: number }
  if (at < 0) {
    const last = list[list.length - 1].row
    next = dir > 0 ? list.find((p) => p.row === last)! : list[list.length - 1]
  } else next = list[(at + (dir > 0 ? 1 : -1) + list.length) % list.length]
  openMark(next)
  requestAnimationFrame(() => document.querySelector(`[data-row="${CSS.escape(next.row)}"] [data-mark="${next.i}"]`)?.scrollIntoView({ block: 'nearest' }))
}

// the tray's own module (panes/tray.js), as the terminal runs it: a mark as a frame of the tray
let trayMod: Promise<any> | null = null
const trayModule = () => (trayMod ??= serverModule('code/panes/tray.js'))

/** A mark the page shows ({row, i}: its place among the marks the page prepared) as a frame of the tray: the record's
 *  own mark, as the terminal opens it, or a citation no mark covers. */
async function frameAt(at: { row: string; i: number }): Promise<TrayEntry | null> {
  const rec = getState().rows.find((r) => r.row === at.row)?.record
  if (!rec) return null
  const p = prepare(rec).marks[at.i]
  if (!p) return null
  const k = (rec.marks || []).findIndex((m: any) => m && m.start === p.start && m.end === p.end)
  if (k >= 0) return (await trayModule()).frameOf(rec, k)
  return { kind: p.kind === 'spark' ? 'spark' : 'cite', ref: p.ref, label: p.label }
}

/** The mark the page shows for a tray frame (to light it in the text), or null. */
export function markOfFrame(rows: Row[], f: TrayEntry | undefined): { row: string; i: number } | null {
  if (!f || f.row == null || f.i == null) return null
  const rec = rows.find((r) => r.row === f.row)?.record
  const m = rec?.marks?.[f.i]
  if (!rec || !m) return null
  const i = prepare(rec).marks.findIndex((x) => x.start === m.start && x.end === m.end)
  return i >= 0 ? { row: f.row, i } : null
}

/** Open a mark of a message as the panel's first card (the terminal's tray opens it too). */
export function openMark(at: { row: string; i: number }): void {
  setState({ focus: at, trayAsk: false, thread: 'main' })
  void frameAt(at).then((f) => {
    if (f) setState({ tray: [f], trayAsk: false })
  })
}

/** Open a citation inside a card, over the card it is in. */
export function pushCite(entry: TrayEntry): void {
  const s = getState()
  const top = s.tray[s.tray.length - 1]
  if (top && top.ref && entry.ref && top.ref === entry.ref && top.row == null) return
  setState({ tray: [...s.tray, entry].slice(-12), trayAsk: false })
}

/** The verbs of the row under each message, as 0.9's browser names them: v visualize · s squeeze · c claims. The key
 * sent is the registry's own. */
export interface RowVerb {
  key: string
  name: string
  send: string
  line: string
}
export function rowVerbs(verbs: Verb[]): RowVerb[] {
  const by = (names: string[]) => verbs.find((v) => names.includes(v.name))
  const claims = by(['claims'])
  return [
    { key: 'v', name: 'visualize', send: by(['visualize'])?.key || 'v', line: by(['visualize'])?.line || 'make a card of this message' },
    { key: 's', name: 'squeeze', send: by(['squeeze'])?.key || 's', line: by(['squeeze'])?.line || 'rewrite this message: shorter, more or less narrative' },
    { key: 'c', name: 'claims', send: claims?.key || 'c', line: claims?.line || 'the claims made in this session, with where each was said and its sources' },
  ]
}

/** Press a verb under a message: v opens its proposals when it has some, s opens the squeeze chips, c opens Claims (the
 * session's claims, kept as the turns go); otherwise the press goes to the terminal. */
export async function pressVerb(row: string, key: string, proposal?: string): Promise<void> {
  const s = getState()
  const rec = s.rows.find((r) => r.row === row)?.record
  const v = rowVerbs(s.verbs).find((x) => x.key === key)
  if (!v) return
  // v opens its line of views under the message, as in the terminal (one option when none was proposed)
  if (key === 'v' && !proposal && rec) {
    setState({ propsOpen: s.propsOpen === row ? null : row, squeezeOpen: null })
    return
  }
  if (key === 's') {
    setState({ squeezeOpen: s.squeezeOpen === row ? null : row, propsOpen: null })
    return
  }
  if (key === 'c') {
    setState({ surface: 'files', filesView: 'claims', card: null, propsOpen: null, squeezeOpen: null })
    return
  }
  setState({ propsOpen: null })
  const r = await back({ verb: v.send, row, ...(proposal ? { proposal } : {}) })
  said(r.error ? `not sent: ${r.error}` : `${v.key} ${v.name} pressed in the terminal session`, r.error)
}

/** Press a squeeze chip's level, a custom chip, or back to the original. */
export async function squeeze(row: string, what: { chip?: string; name?: string; level?: number; levelName?: string; custom?: string; reset?: boolean }): Promise<void> {
  const line: { row: string; chip?: string; level?: number; custom?: string; reset?: boolean; name?: string; label?: string } = { row }
  if (what.reset) line.reset = true
  else if (what.custom) line.custom = what.custom.slice(0, 300)
  else {
    line.chip = what.chip
    line.level = what.level
    if (what.name) line.name = what.name
    if (what.levelName) line.label = what.levelName
  }
  const r = await back({ squeeze: line } as never)
  said(r.error ? `not sent: ${r.error}` : what.reset ? 'back to the original, in the terminal session' : 'squeeze sent to the terminal session', r.error)
}

/** Ask: a prompt to main, or a question in a side thread when the scope names a card, a mark or a thread. */
export async function ask(text: string, scope: Scope = {}): Promise<boolean> {
  const t = text.trim()
  if (!t) return false
  const r = await back({ ask: t, scope })
  said(r.error ? `not sent: ${r.error}` : scope.object || scope.mark || scope.thread ? 'asked in a side thread' : 'sent to the terminal session', r.error)
  return !r.error
}

function said(text: string, error?: string) {
  setState({ sent: { text, at: Date.now(), ...(error ? { error } : {}) } })
  window.setTimeout(() => {
    if (getState().sent?.text === text) setState({ sent: null })
  }, error ? 9000 : 3500)
}
