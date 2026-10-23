// notice.ts: the failure line, the one way thimble tells the person that something failed. One line above the prompt
// (bar.tsx draws it), the whole notice in red, until the person types their next prompt, or until what failed works
// again (failCleared, by the notice's `about`: a card that draws again). noticeLine is the same line, not in red, for
// what is not thimble's failure (a model's safeguards, a package the machine lacks).
//
//   state: failLine (a failure, or a notice)
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

const FAIL = { plugin: 'thimble', key: 'failLine' } as const

export type FailLine = { kind: 'failed' | 'notice'; text: string; about?: string }

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

/** What a failure line or a notice was about works again: the line goes, when it is still about that. */
export async function failCleared($: Engine, about: string): Promise<void> {
  if ((await failLineNow($))?.about === about) await $.state.set(FAIL, null)
}

/** The failure line or notice the bar shows now, if any. */
export async function failLineNow($: Engine): Promise<FailLine | null> {
  return ((await $.state.get(FAIL)).value ?? null) as FailLine | null
}

/** The person typed their next prompt: the failure line goes (they have seen it). */
export async function promptTyped($: Engine): Promise<void> {
  if (await failLineNow($)) await $.state.set(FAIL, null)
}
