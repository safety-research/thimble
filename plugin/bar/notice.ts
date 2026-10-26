// notice.ts: the failure line, the one way thimble tells the person that something failed. One line above the prompt
// (bar.tsx draws it), the whole notice in red, until the person types their next prompt, or until what failed works
// again (failCleared, by the notice's `about`: a card that draws again). noticeLine is the same line, not in red, for
// what is not thimble's failure (a model's safeguards, a package the machine lacks). hintLine is a hint that only says
// how to do something (select words first, click the bar in a narrow terminal): the bar shows it in place of its keys
// (`Hint: …`, bar.tsx), not above, and it goes on its own after HINT_MS, or at the next key thimble takes.
//
//   state: failLine (a failure, a notice, or a hint)
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

const FAIL = { plugin: 'thimble', key: 'failLine' } as const

export type FailLine = { kind: 'failed' | 'notice'; text: string; about?: string; hint?: string }

/** How long a hint shows. */
export const HINT_MS = 8000

/** A failure the person should know of: one line above the prompt (bar.tsx), the whole text in red, until the
 *  person's next prompt. `about` names what failed (`card:<id>`), so the line goes when it works
 *  again (failCleared). */
export function failNotice($: Engine, text: string, about?: string): void {
  const t = String(text || '').trim()
  if (!t) return
  void $.state.set(FAIL, { kind: 'failed', text: t, ...(about ? { about } : {}) }).catch(() => undefined)
}

/** A notice the person should read, not in red: the failure line's place, until the person's next prompt, or until
 *  what it is about is done (failCleared with the same `about`). */
export function noticeLine($: Engine, text: string, about?: string): void {
  const t = String(text || '').trim()
  if (t) void $.state.set(FAIL, { kind: 'notice', text: t, ...(about ? { about } : {}) }).catch(() => undefined)
}

/** The hints this load showed, by id: a hint of an earlier load (its timer gone with it) is gone too. */
const hints = new Set<string>()
/** The hint this load showed last, while it may show. */
let lastHint: string | null = null

/** A hint: a notice that goes after HINT_MS, or at the next key thimble takes (hintsGone). */
export function hintLine($: Engine, text: string, about?: string): void {
  const t = String(text || '').trim()
  if (!t) return
  const id = `${hints.size + 1}-${Math.random().toString(36).slice(2, 8)}`
  hints.add(id)
  lastHint = id
  void $.state.set(FAIL, { kind: 'notice', text: t, hint: id, ...(about ? { about } : {}) }).catch(() => undefined)
  // the line goes once HINT_MS passed by the engine's clock, whenever its timer fires
  void (async () => {
    const from = Number(await $.clock.now())
    const gone = async (): Promise<void> => {
      if ((await failLineNow($))?.hint !== id) return
      const left = HINT_MS - (Number(await $.clock.now()) - from)
      if (left > 0) { $.clock.after(left, () => { void gone().catch(() => undefined) }); return }
      await $.state.set(FAIL, null)
      $.ui.invalidate('ui.render')
    }
    $.clock.after(HINT_MS, () => { void gone().catch(() => undefined) })
  })().catch(() => undefined)
}

/** A key thimble takes: a hint showing goes (the key may give its own). Reads no state unless this load showed one. */
export async function hintsGone($: Engine): Promise<void> {
  if (!lastHint) return
  const id = lastHint
  lastHint = null
  if ((await failLineNow($))?.hint === id) await $.state.set(FAIL, null)
}

/** What a failure line or a notice was about works again: the line goes, when it is still about that. */
export async function failCleared($: Engine, about: string): Promise<void> {
  if ((await failLineNow($))?.about === about) await $.state.set(FAIL, null)
}

/** The failure line or notice the bar shows now, if any: a hint an earlier load of the plugin showed is gone (its
 *  timer went with that load). */
export async function failLineNow($: Engine): Promise<FailLine | null> {
  const line = ((await $.state.get(FAIL)).value ?? null) as FailLine | null
  return line?.hint !== undefined && !hints.has(line.hint) ? null : line
}

/** The hint the bar shows now in place of its keys, if any. */
export async function hintNow($: Engine): Promise<string | null> {
  const line = await failLineNow($)
  return line?.hint !== undefined ? line.text.replace(/^(?!Claude\b)([A-Z])(?=[a-z])/, c => c.toLowerCase()) : null
}

/** The person typed their next prompt: the failure line goes (they have seen it). */
export async function promptTyped($: Engine): Promise<void> {
  if (await failLineNow($)) await $.state.set(FAIL, null)
}
