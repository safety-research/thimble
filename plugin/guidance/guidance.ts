// guidance.ts: thimble's guidance (prompts/guidance.md) in every conversation, as context beside the person's prompt
// (prompt.submit `context`), never through the Skill tool. A prompt that starts a turn of main's carries it when the
// conversation's next request does not hold it yet: the first prompt, and the first one after a compaction, which
// replaces the copy with its summary. A resumed session keeps its one copy, and a fork of the conversation inherits it.
//
// Not prompt.context: where an organization manages Claude Code, Claude Code's built-in cc-plugin-sec-default sends
// that event past the plugins a person installs, and prompt.submit's context reaches Claude on every machine.
//
// The temp folder's path is filled in, for the tools that do not expand `$TMPDIR`. The `## ` section of a
// switched-off feature is left out; with citations off, the citations in the other sections' examples
// read as plain words. A switch changed later makes a different text, which the next prompt carries beside the copy
// the conversation holds.
import type { EngineInterface, Register } from 'claude-code'

import { tempDir } from '../core/home'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { featureOn } from '../settings/features.mjs'

type Engine = EngineInterface

/** The `## ` section of guidance.md that teaches each feature a person can switch off. */
const SECTIONS: Record<string, string> = { marks: 'Citing claims', cards: 'Cards' }

/** A citation in the guidance's examples: a markdown link to `#`. */
const MARK = /\[([^\]]*)\]\(#\)/g

/** guidance.md as a conversation gets it, with `on(feature)` saying which features are on. */
export function guidanceFor(text: string, on: (feature: string) => boolean): string {
  const off = new Set(Object.keys(SECTIONS).filter(f => !on(f)).map(f => SECTIONS[f]))
  const kept = text.split(/^(?=## )/m).filter(part => !off.has(/^## (.+)/.exec(part)?.[1]?.trim() ?? '')).join('')
  return (on('marks') ? kept : kept.replace(MARK, '$1')).trim()
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
      text = guidanceFor(fill(await promptText($, 'guidance'), { TMPDIR: await tempDir($) }), featureOn)
      if (text && (await holds($, text))) text = ''
    } catch {
      text = ''
    }
    return next(text ? { ...e, context: [...(e.context ?? []), text] } : e)
  }).catch(($, e, next) => next(e))
}
