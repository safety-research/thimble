// tell.ts: what Claude reads of thimble's work outside its own turns, as rows of main's transcript the person does not
// see ($.session.append). Two ways:
//
//   tellAtNextPrompt($, key, text)  kept until the person's next prompt, then appended just before it is stored: one
//                                   text per key, the latest wins (a mark corrected twice is told once, as it ends)
//   tellNow($, text)                appended at once
//
// The texts that wait are kept in $.state, so a reload of the plugin does not lose them.
import type { EngineInterface, Register } from 'claude-code'

type Engine = EngineInterface

const WAITING = { plugin: 'thimble', key: 'tell' } as const

export async function tellNow($: Engine, text: string): Promise<void> {
  const t = String(text || '').trim()
  if (!t) return
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: t }] } })
}

export async function tellAtNextPrompt($: Engine, key: string, text: string): Promise<void> {
  const cur = ((await $.state.get(WAITING)).value ?? {}) as Record<string, string>
  await $.state.set(WAITING, { ...cur, [key]: String(text || '') })
}

/** The texts that wait, appended now in the order they were first kept, and forgotten. */
async function flush($: Engine): Promise<void> {
  const cur = ((await $.state.get(WAITING)).value ?? {}) as Record<string, string>
  const texts = Object.values(cur).map(t => t.trim()).filter(Boolean)
  if (!Object.keys(cur).length) return
  await $.state.set(WAITING, {})
  if (texts.length) await tellNow($, texts.join('\n\n'))
}

export const registerTell: Register = on => {
  // a prompt that starts a turn of main's (the person's, or one a key of thimble's sends): what waits goes just
  // before it. A fork's report, a peer's message or a slash command carries nothing.
  on('prompt.submit', { origin: { kind: /^(composer|bridge|plugin)$/ } }, async ($, e, next) => {
    if (!e.command && !e.isMeta) {
      try { await flush($) } catch { /* the texts wait for the next prompt */ }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
