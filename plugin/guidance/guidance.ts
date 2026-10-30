// guidance.ts: thimble's guidance (prompts/guidance.md) in every conversation, as context beside the person's prompt
// (prompt.submit `context`), never through the Skill tool. A prompt that starts a turn of main's carries it when the
// conversation's next request does not hold it yet: the first prompt, and the first one after a compaction, which
// replaces the copy with its summary. A resumed session keeps its one copy, and a fork of the conversation inherits it.
//
// Not prompt.context: where an organization manages Claude Code, Claude Code's built-in cc-plugin-sec-default sends
// that event past the plugins a person installs, and prompt.submit's context reaches Claude on every machine.
//
// The temp folder's path is filled in, for the tools that do not expand `$TMPDIR`. The `## ` section of a
// switched-off feature is left out; while Claude does not cite (Citations manual or off), the citations in the other
// sections' examples read as plain words. A mode that changes what the analyst does adds one sentence at the end (modesNow):
// Citations manual, and Minimal. A switch changed later makes a different text, which the next prompt carries beside
// the copy the conversation holds.
import type { EngineInterface, Register } from 'claude-code'

import { tempDir } from '../core/home'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { choiceOf, claudeCites, featureOn, minimalOn } from '../settings/features.mjs'

type Engine = EngineInterface

/** The `## ` section of guidance.md that teaches each feature a person can switch off; `cites`: Claude cites its
 *  claims (Citations auto cite + verify, or auto cite). */
const SECTIONS: Record<string, string> = { cites: 'Citing claims', cards: 'Cards' }

/** Whether a feature of SECTIONS is on now. */
const sectionOn = (feature: string) => (feature === 'cites' ? claudeCites() : featureOn(feature))

/** A citation in the guidance's examples: a markdown link to `#`. */
const MARK = /\[([^\]]*)\]\(#\)/g

/** guidance.md as a conversation gets it, with `on(feature)` saying which features are on, and `modes` the sentences
 *  that say which modes are on (modesNow). */
export function guidanceFor(text: string, on: (feature: string) => boolean, modes: string[] = []): string {
  const off = new Set(Object.keys(SECTIONS).filter(f => !on(f)).map(f => SECTIONS[f]))
  const kept = text.split(/^(?=## )/m).filter(part => !off.has(/^## (.+)/.exec(part)?.[1]?.trim() ?? '')).join('')
  const out = (on('cites') ? kept : kept.replace(MARK, '$1')).trim()
  return modes.length ? `${out}\n\n${modes.join(' ')}` : out
}

/** One sentence on what comes only when the analyst asks for it, so Claude can say how thimble works now; with
 *  Minimal on, that nothing runs after Claude's replies. */
export function modesNow(): string[] {
  const asked = [
    choiceOf('citations') === 'manual' && 'citations (they select words and press c)',
    choiceOf('explain') === 'on demand' && 'explainers (e)',
    choiceOf('details') === 'on demand' && 'heads-ups (h)',
  ].filter(Boolean) as string[]
  if (!asked.length) return []
  const list = asked.length > 1 ? `${asked.slice(0, -1).join(', ')} and ${asked.at(-1)}` : asked[0]
  return [`${minimalOn() ? 'Minimal mode is on: nothing runs after your replies. ' : ''}These come only when the analyst asks: ${list}.`]
}

/** The guidance's `## Cards` section, its temp folder filled in: what the critique of a card that does not fit holds
 *  the card to (cards/fit.ts). */
export async function cardsGuidance($: Engine): Promise<string> {
  const text = fill(await promptText($, 'guidance'), { TMPDIR: await tempDir($) })
  const part = text.split(/^(?=## )/m).find(p => /^## (.+)/.exec(p)?.[1]?.trim() === SECTIONS.cards)
  return (part ?? '').replace(/^## .*\n/, '').trim()
}

/** Whether the conversation's next request already holds this text (as context the engine framed around it). */
async function holds($: Engine, text: string): Promise<boolean> {
  const messages = await $.session.messages({ as: 'api' })
  if (!Array.isArray(messages)) return false
  return messages.some(m => m.role === 'user' && m.content.some(b => b.type === 'text' && typeof b.text === 'string' && b.text.includes(text)))
}

export const registerGuidance: Register = on => {
  // a prompt that starts or joins a turn of main's; a slash command's line, and a prompt the engine does not let a
  // hook change (isMeta), carry nothing: the next prompt does
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    let text = ''
    try {
      text = guidanceFor(fill(await promptText($, 'guidance'), { TMPDIR: await tempDir($) }), sectionOn, modesNow())
      if (text && (await holds($, text))) text = ''
    } catch {
      text = ''
    }
    return next(text ? { ...e, context: [...(e.context ?? []), text] } : e)
  }).catch(($, e, next) => next(e))
}
