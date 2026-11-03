// prompts.ts: the prompt registry (registry.mjs) from the hooks module. Each text a model reads is one file, read once
// per load of the module as the terminal reads it (compose: with what it includes, and the terminal's words of its
// slots). Once per session the plugin's version is a line in the session's events, so a record says which texts were
// read.
import type { EngineInterface, Register } from 'claude-code'

import { record } from '../telemetry/telemetry'
import { SLOTS_FILE, TEXTS, compose, fileOf } from './registry.mjs'

type Engine = EngineInterface

export type PromptName = 'guidance' | 'card-tool' | 'card-check' | 'checker' | 'designer' | 'artifact' | 'labels' | 'labels-off' | 'observer' | 'observer-turn' | 'lens-explain' | 'lens-heads' | 'lens-claims' | 'explain-expand' | 'heads-expand' | 'squeeze' | 'thread' | 'fix-request' | 'fix-not-given' | 'fixer' | 'fix-draft'

const texts = new Map<string, string>()

function rootOf($: Engine): string {
  return $.plugin.root.replace(/\/+$/, '')
}

/** The plugin's version, from its manifest. */
async function pluginVersion($: Engine): Promise<string | null> {
  try { return String(JSON.parse(String(await $.fs.read(`${rootOf($)}/.claude-plugin/plugin.json`))).version || '') || null } catch { return null }
}

/** A text as the terminal reads it: its file's words, with what it includes and the terminal's words of its slots
 *  (prompts/slots.json). A record names the text by its name. */
export async function promptText($: Engine, name: PromptName): Promise<string> {
  if (!TEXTS[name]) throw new Error(`no prompt text ${name}`)
  if (!texts.has(name)) {
    const read = (n: string) => $.fs.read(`${rootOf($)}/${fileOf(n)}`)
    texts.set(name, await compose(name, 'terminal', read, async () => JSON.parse(String(await $.fs.read(`${rootOf($)}/${SLOTS_FILE}`)))))
  }
  return texts.get(name)!
}

export const registerPrompts: Register = on => {
  on('session.start', { cwd: /./ }, async ($, e, next) => {
    const r = await next(e)
    try { await record($, { kind: 'prompts', plugin: await pluginVersion($) }) } catch { /* the measure only */ }
    return r
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetPrompts(): void {
  texts.clear()
}
