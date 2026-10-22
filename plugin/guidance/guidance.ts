// guidance.ts: thimble's guidance (prompts/guidance.md) in every conversation, as one context block named `thimble`
// (prompt.context), never through the Skill tool. Claude Code sends a block it does not route in one copy, made when
// the conversation holds none: with the first request, and again after a compaction. A resumed session keeps its one
// copy, and a fork of the conversation inherits it.
//
// The temp folder's path is filled in, for the tools that do not expand `$TMPDIR`. The `## ` section of a
// switched-off feature is left out; with marks off, the marks in the other sections' examples
// read as plain words. The block is made when the conversation starts, so a switch changed later counts from the next
// conversation or compaction.
import type { Register } from 'claude-code'

import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { featureOn } from '../settings/features.mjs'

/** The `## ` section of guidance.md that teaches each feature a person can switch off. */
const SECTIONS: Record<string, string> = { marks: 'Marking claims', cards: 'Cards' }

/** A mark in the guidance's examples: a markdown link to `#`. */
const MARK = /\[([^\]]*)\]\(#\)/g

/** guidance.md as a conversation gets it, with `on(feature)` saying which features are on. */
export function guidanceFor(text: string, on: (feature: string) => boolean): string {
  const off = new Set(Object.keys(SECTIONS).filter(f => !on(f)).map(f => SECTIONS[f]))
  const kept = text.split(/^(?=## )/m).filter(part => !off.has(/^## (.+)/.exec(part)?.[1]?.trim() ?? '')).join('')
  return (on('marks') ? kept : kept.replace(MARK, '$1')).trim()
}

export const registerGuidance: Register = on => {
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const tmp = String((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
    const text = guidanceFor(fill(await promptText($, 'guidance'), { TMPDIR: tmp }), featureOn)
    return { ...r, blocks: [...r.blocks.filter(b => b.name !== 'thimble'), { name: 'thimble', text }] }
  }).catch(($, e, next) => next(e))
}
