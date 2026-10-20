// prompts.ts: the prompt registry (registry.mjs) from the hooks module. Each text a model reads is one file. Once per
// session it reads which texts THIMBLE_PROMPTS turns off, sets THIMBLE_PROMPTS for the session's commands to the same
// (so a verb's child reads the same texts), names the plugin's version and the texts turned off in the session's events,
// and says in one line when THIMBLE_PROMPTS holds a pair it cannot read.
//
// A context block (text `context`) goes with each conversation's first message: thimble is on here, so Claude loads the
// thimble skill for a question about these files, a codebase included.
//
// The card guide (text `forms`: skills/thimble/cards.md) comes once per session as context beside the result of
// Claude's first data command (`thimble run`, `rows`, `resolve` or `sources`, whichever comes first): Claude queries
// before it draws, so the guide is there before the first card, and a session that never queries never reads it.
// Claude reading the guide itself (v's request names its file) counts as given, so it never comes twice; a compaction
// may drop it, so it can come again after one. The person never sees it. The session's events name the text given and
// the command it came with.
//
import type { EngineInterface } from 'claude-code'

import { record } from '../telemetry/telemetry'
import { TEXTS, bodyOf, fileOf, offOf, specOf } from './registry.mjs'
import { sessionKey } from '../hooks/conversation'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const R = {
  session: '',
  ready: false,
  off: [] as string[],
  problems: [] as string[],
  texts: new Map<string, string>(),
  cardsGiven: false,
  resolving: null as Promise<void> | null,
}

/** Claude's first data command of a session brings the card guide: `thimble run`, `rows`, `resolve` or `sources`. */
const DATA = /(^|[\s;&|(])thimble\s+(run|q|rows|resolve|sources)\b/
/** The card guide's own file, which Claude may read itself (v's request names it). */
const GUIDE = /(^|[\s/'"])skills\/thimble\/cards\.md\b/

function rootOf($: Engine): string {
  return $.plugin.root.replace(/\/+$/, '')
}

/** The plugin's version, from its manifest: the events name it, so a record says which texts were read. */
async function pluginVersion($: Engine): Promise<string | null> {
  try { return String(JSON.parse(String(await $.fs.read(`${rootOf($)}/.claude-plugin/plugin.json`))).version || '') || null } catch { return null }
}

async function resolve($: Engine): Promise<void> {
  // THIMBLE_PROMPTS as Claude Code was started with it (a person's experiment with a text turned off; no setting)
  const c = offOf(String((await $.env.get('THIMBLE_PROMPTS')) || ''))
  R.off = c.off
  R.problems = c.problems
  R.texts.clear()
  R.ready = true
  try { await $.env.set('THIMBLE_PROMPTS', specOf(R.off)) } catch { /* the children read every text */ }
  await record($, { kind: 'prompts', plugin: await pluginVersion($), off: R.off, problems: R.problems })
  if (R.problems.length) $.ui.toast(`thimble prompts: ${R.problems[0]}${R.problems.length > 1 ? ` (and ${R.problems.length - 1} more: thimble dev prompts)` : ''}`)
}

/** The registry for this session: read once, again when the session changes. */
export async function registry($: Engine): Promise<{ off: string[]; problems: string[] }> {
  const id = await sessionKey($)
  if (id !== R.session || !R.ready) {
    R.session = id
    R.cardsGiven = false
    R.resolving = resolve($)
  }
  if (R.resolving) await R.resolving
  return { off: R.off, problems: R.problems }
}

/** A text, as {text, id, off}: its file's words (a skill's body), or none when THIMBLE_PROMPTS turned it off. The
 *  id a record names it by is its name. */
export async function promptText($: Engine, name: string): Promise<{ text: string; id: string; off: boolean }> {
  const { off } = await registry($)
  if (!TEXTS[name as keyof typeof TEXTS]) throw new Error(`no prompt text ${name}`)
  if (off.includes(name)) return { text: '', id: name, off: true }
  if (!R.texts.has(name)) {
    const file = fileOf(name)
    const raw = String(await $.fs.read(`${rootOf($)}/${file}`))
    R.texts.set(name, file.endsWith('SKILL.md') ? bodyOf(raw) : raw)
  }
  return { text: R.texts.get(name)!, id: name, off: false }
}

/** A text's file, for a text a model reads by its path (a subagent's guide): {file, id}. */
export async function promptFile($: Engine, name: string): Promise<{ file: string; id: string }> {
  return { file: `${rootOf($)}/${fileOf(name)}`, id: name }
}

export function registerPrompts(on: Any, _options?: Any): void {

  on('session.start', { cwd: /./ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    try { await registry($) } catch { /* the defaults are read where they are needed */ }
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  // a compaction may drop the card guide from the conversation: the next data command brings it again
  on('session.compact', async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    R.cardsGiven = false
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  // once per conversation, a context block that says thimble is on here: the thimble skill's description alone does not
  // bring the skill for a question about a codebase, so Claude answered as in a plain session, with nothing cited
  on('prompt.context', async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    try {
      const t = await promptText($, 'context')
      if (t.off || !t.text.trim()) return r
      await record($, { kind: 'prompt', feature: 'context', prompt: t.id })
      return { ...r, blocks: [...(r?.blocks ?? []).filter((b: Any) => b.name !== 'thimble'), { name: 'thimble', text: t.text.trim() }] }
    } catch {
      return r
    }
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  // the first data command: the card guide comes beside its result, once per session; Claude reading the guide itself
  // (a Read of it, or the file in a Bash command) counts as given
  on('tool.call', { tool: /^(Read|Bash)$/ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    try {
      if (!r || r.deny !== undefined || r.isError || e.agentId !== undefined) return r
      const command = String(e.command || '')
      const readsGuide = (e.tool === 'Read' && GUIDE.test(String(e.file_path || ''))) || (e.tool === 'Bash' && GUIDE.test(command) && !/\bthimble\s/.test(command))
      if (readsGuide) { await registry($); R.cardsGiven = true; return r }
      const data = e.tool === 'Bash' ? DATA.exec(command) : null
      if (!data) return r
      await registry($)
      if (R.cardsGiven) return r
      const t = await promptText($, 'forms')
      if (t.off || !t.text.trim()) return r
      R.cardsGiven = true
      await record($, { kind: 'prompt', feature: 'forms', prompt: t.id, via: `thimble ${data[2]}` })
      const note = `The card guide (${rootOf($)}/skills/thimble/cards.md), which thimble adds once per session with your first data command, so you have it before you draw a card.\n\n${t.text}`
      return { ...r, context: [...(r.context ?? []), note] }
    } catch {
      return r
    }
  }).catch(($: Engine, e: Any, next: Any) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetPrompts(): void {
  Object.assign(R, { session: '', ready: false, off: [], problems: [], texts: new Map(), cardsGiven: false, resolving: null })
}
