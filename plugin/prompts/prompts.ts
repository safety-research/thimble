// prompts.ts: the prompt registry (registry.mjs) from the hooks module. Each text a model reads is one file, read once
// per load of the module. Once per session the plugin's version is a line in the session's events, so a record says
// which texts were read.
import type { EngineInterface, Register } from 'claude-code'

import { record } from '../telemetry/telemetry'
import { TEXTS, fileOf } from './registry.mjs'

type Engine = EngineInterface

export type PromptName = 'guidance' | 'card-tool' | 'checker' | 'designer' | 'labels'

const texts = new Map<string, string>()

function rootOf($: Engine): string {
  return $.plugin.root.replace(/\/+$/, '')
}

/** The plugin's version, from its manifest. */
async function pluginVersion($: Engine): Promise<string | null> {
  try { return String(JSON.parse(String(await $.fs.read(`${rootOf($)}/.claude-plugin/plugin.json`))).version || '') || null } catch { return null }
}

/** A text: its file's words. A record names the text by its name. */
export async function promptText($: Engine, name: PromptName): Promise<string> {
  if (!TEXTS[name]) throw new Error(`no prompt text ${name}`)
  if (!texts.has(name)) texts.set(name, String(await $.fs.read(`${rootOf($)}/${fileOf(name)}`)))
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
