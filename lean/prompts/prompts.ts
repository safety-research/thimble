// prompts.ts: the prompt registry (registry.mjs) from the hooks module. Once per session it finds the versions on disk,
// picks the active one of each feature (the defaults, or THIMBLE_PROMPTS), sets THIMBLE_PROMPTS for the session's
// commands to the same choice (so a verb's child reads the same versions), names the versions in use in the session's
// events, and says in one line when a named version does not exist (it keeps the default).
//
// The card guide (feature `forms`: skills/thimble/cards.md) comes once per session as context beside the result of
// Claude's first data command (`thimble run`, `rows`, `resolve` or `sources`, whichever comes first): Claude queries
// before it draws, so the guide is there before the first card, and a session that never queries never reads it.
// Claude reading the guide itself (v's request names its file) counts as given, so it never comes twice; a compaction
// may drop it, so it can come again after one. The person never sees it. The session's events name the version given
// and the command it came with.
//
import type { EngineInterface } from 'claude-code'

import { record } from '../telemetry/telemetry'
import { FEATURES, bodyOf, choose, idOf, indexOf, specOf } from './registry.mjs'
import { sessionKey } from '../hooks/conversation'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Active = { version: string; file: string | null; source: string; off?: boolean }

const R = {
  session: '',
  idx: null as Any,
  active: {} as Record<string, Active>,
  problems: [] as string[],
  texts: new Map<string, string>(),
  cardsGiven: false,
  resolving: null as Promise<void> | null,
}

/** Claude's first data command of a session brings the card guide: `thimble run`, `rows`, `resolve` or `sources`. */
const DATA = /(^|[\s;&|(])thimble\s+(run|q|rows|resolve|sources)\b/
/** The card guide's own file, which Claude may read itself (v's request names it). */
const GUIDE = /(^|[\s/'"])skills\/thimble\/cards\.md\b/

const rootOf = ($: Engine) => $.plugin.root.replace(/\/+$/, '')

async function resolve($: Engine): Promise<void> {
  const root = rootOf($)
  const found: Record<string, string[]> = {}
  for (const name of Object.keys(FEATURES)) {
    try { found[name] = (await $.fs.list(`${root}/prompts/${name}`)).filter(x => x.kind === 'file').map(x => x.name) } catch { found[name] = [] }
  }
  R.idx = indexOf(found)
  // THIMBLE_PROMPTS as Claude Code was started with it (a person's experiment with other versions; no setting)
  const env = String((await $.env.get('THIMBLE_PROMPTS')) || '')
  const c = choose(R.idx, { env })
  R.active = c.active
  R.problems = c.problems
  R.texts.clear()
  try { await $.env.set('THIMBLE_PROMPTS', specOf(R.active, R.idx)) } catch { /* the children read the defaults */ }
  const active = Object.fromEntries(Object.entries(R.active).map(([n, a]) => [n, a.version]))
  await record($, { kind: 'prompts', active, changed: specOf(R.active, R.idx) || null, problems: R.problems })
  if (R.problems.length) $.ui.toast(`thimble prompts: ${R.problems[0]}${R.problems.length > 1 ? ` (and ${R.problems.length - 1} more: thimble prompts)` : ''}`)
}

/** The registry for this session: resolved once, again when the session changes. */
export async function registry($: Engine): Promise<{ idx: Any; active: Record<string, Active>; problems: string[] }> {
  const id = await sessionKey($)
  if (id !== R.session || !R.idx) {
    R.session = id
    R.cardsGiven = false
    R.resolving = resolve($)
  }
  if (R.resolving) await R.resolving
  return { idx: R.idx, active: R.active, problems: R.problems }
}

/**
 * The active text of a feature, as {text, version, id, off}. A version file that cannot be read falls back to the
 * default once, with one line that says so; a skill's in-place version is its body.
 */
export async function promptText($: Engine, feature: string): Promise<{ text: string; version: string; id: string; off: boolean }> {
  const { idx, active } = await registry($)
  const a = active[feature]
  if (!a) throw new Error(`no prompt feature ${feature}`)
  if (a.off) return { text: '', version: a.version, id: idOf(feature, a.version), off: true }
  const key = `${feature}:${a.version}`
  if (!R.texts.has(key)) {
    try {
      const raw = String(await $.fs.read(`${rootOf($)}/${a.file}`))
      R.texts.set(key, a.file?.endsWith('SKILL.md') ? bodyOf(raw) : raw)
    } catch (err) {
      const def = idx[feature].default
      if (a.version === def) throw err
      $.ui.toast(`thimble prompts: ${feature}:${a.version} could not be read, so ${feature} uses ${def}`)
      R.active[feature] = { version: def, file: idx[feature].versions[def].file, source: 'default' }
      return promptText($, feature)
    }
  }
  return { text: R.texts.get(key)!, version: a.version, id: key, off: false }
}

/** The ids of the versions in use for some features: {feature: 'feature:version'}. */
export async function promptIds($: Engine, features: string[]): Promise<Record<string, string>> {
  const { active } = await registry($)
  return Object.fromEntries(features.filter(f => active[f]).map(f => [f, idOf(f, active[f].version)]))
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
      const note = `The card guide (${t.id}, ${rootOf($)}/skills/thimble/cards.md), which thimble adds once per session with your first data command, so you have it before you draw a card.\n\n${t.text}`
      return { ...r, context: [...(r.context ?? []), note] }
    } catch {
      return r
    }
  }).catch(($: Engine, e: Any, next: Any) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetPrompts(): void {
  Object.assign(R, { session: '', idx: null, active: {}, problems: [], texts: new Map(), cardsGiven: false, resolving: null })
}
