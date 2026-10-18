// prompts.ts: the prompt registry (registry.mjs) from the hooks module. Once per session it finds the versions on disk,
// picks the active one of each feature (the plugin's Prompts setting, then LEAN_PROMPTS), sets LEAN_PROMPTS for the
// session's commands to the same choice (so `lean guide` and a verb's child read the same versions), names the versions
// in use in the session's events, and says in one line when a named version does not exist (it keeps the default).
//
// The card guidance (feature `forms`): Claude reads the drawing toolkit (draw/TOOLKIT.md) before it writes a card's
// program, as the lean skill says; the first such read in a session carries the guidance's active version as context
// beside the file (the person never sees it, and it is never in the conversation at rest). v's request asks for it
// with `lean guide cards` when it was not read yet.
//
// Skills: Claude Code finds a skill's SKILL.md where it is, and that text is the version `skill`. When another version
// of a skill's feature is active, the skill.prompt hook serves it in place of the file's text. The same hook makes sure
// a verb's skill never replaces the lean skill: when Claude loads one of thimble's other skills (map, explore, trace,
// claims) before the lean skill in a session, the lean skill's text comes first in what it reads.
import type { EngineInterface } from 'claude-code'

import { record } from '../telemetry/telemetry'
import { FEATURES, bodyOf, choose, featureOfSkill, idOf, indexOf, specOf } from './registry.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Active = { version: string; file: string | null; source: string; off?: boolean }

const R = {
  setting: '',
  session: '',
  idx: null as Any,
  active: {} as Record<string, Active>,
  problems: [] as string[],
  texts: new Map<string, string>(),
  leanLoaded: false,
  cardsGiven: false,
  resolving: null as Promise<void> | null,
}

/** The plugin's Prompts setting (register's options). */
export function setPromptSetting(v: unknown): void {
  R.setting = typeof v === 'string' ? v : ''
}

const rootOf = ($: Engine) => $.plugin.root.replace(/\/+$/, '')

async function resolve($: Engine): Promise<void> {
  const root = rootOf($)
  const found: Record<string, string[]> = {}
  for (const name of Object.keys(FEATURES)) {
    try { found[name] = (await $.fs.list(`${root}/prompts/${name}`)).filter(x => x.kind === 'file').map(x => x.name) } catch { found[name] = [] }
  }
  R.idx = indexOf(found)
  // LEAN_PROMPTS as Claude Code was started with it; once set below it holds the setting too, which choose() reads
  // again as the same choice
  const env = String((await $.env.get('LEAN_PROMPTS')) || '')
  const c = choose(R.idx, { setting: R.setting, env })
  R.active = c.active
  R.problems = c.problems
  R.texts.clear()
  try { await $.env.set('LEAN_PROMPTS', specOf(R.active, R.idx)) } catch { /* the children read the defaults */ }
  const active = Object.fromEntries(Object.entries(R.active).map(([n, a]) => [n, a.version]))
  await record($, { kind: 'prompts', active, changed: specOf(R.active, R.idx) || null, problems: R.problems })
  if (R.problems.length) $.ui.toast(`thimble prompts: ${R.problems[0]}${R.problems.length > 1 ? ` (and ${R.problems.length - 1} more: lean prompts)` : ''}`)
}

/** The registry for this session: resolved once, again when the session changes. */
export async function registry($: Engine): Promise<{ idx: Any; active: Record<string, Active>; problems: string[] }> {
  const id = String(await $.session.id())
  if (id !== R.session || !R.idx) {
    R.session = id
    R.leanLoaded = false
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

/** The text Claude Code computed for a skill, its first line (the skill's base folder) kept, its body replaced. */
function withBody(computed: string, body: string): string {
  const m = /^(Base directory for this skill:[^\n]*\n+)/.exec(computed)
  return (m ? m[1] : '') + body
}

export function registerPrompts(on: Any, options: Any): void {
  setPromptSetting(options?.prompts)

  on('session.start', { cwd: /./ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    try { await registry($) } catch { /* the defaults are read where they are needed */ }
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  // a compaction may drop the lean skill from the conversation: the next verb skill brings it again
  on('session.compact', async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    R.leanLoaded = false
    R.cardsGiven = false
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  // the toolkit read before a card: the card guidance comes beside it, once per session
  on('tool.call', { tool: 'Read' }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    try {
      if (!r || r.deny !== undefined || r.isError || e.agentId !== undefined) return r
      const file = String(e.file_path || '')
      if (!/(^|\/)draw\/TOOLKIT\.md$/.test(file) || !file.startsWith(rootOf($))) return r
      await registry($)
      if (R.cardsGiven) return r
      const t = await promptText($, 'forms')
      if (t.off || !t.text.trim()) return r
      R.cardsGiven = true
      const base = (FEATURES.forms.versions as Any)?.[t.version]?.base || FEATURES.forms.base
      await record($, { kind: 'prompt', feature: 'forms', prompt: t.id, via: 'read of draw/TOOLKIT.md' })
      const note = `The card guidance (${t.id}), which thimble adds when you read the toolkit before a card. Paths in it are relative to ${rootOf($)}/${base}.\n\n${t.text}`
      return { ...r, context: [...(r.context ?? []), note] }
    } catch {
      return r
    }
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  on('skill.prompt', async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    const name = String(e.skill || '').split(':').pop() || ''
    const ours = e.pluginName === 'thimble-lean' || String(e.skill || '').startsWith('thimble-lean:')
    if (!ours) return r
    try {
      let text = String(r?.text ?? e.text ?? '')
      const feature = featureOfSkill(name)
      let id: string | null = null
      if (feature) {
        const { idx, active } = await registry($)
        const a = active[feature]
        id = idOf(feature, a.version)
        // another version than the file's own: its text in place of the body
        if (a.file !== idx[feature].versions.skill?.file) text = withBody(text, (await promptText($, feature)).text)
      }
      let leanFirst = false
      if (name === 'lean') R.leanLoaded = true
      else if (!R.leanLoaded) {
        // a verb's skill loaded before the lean skill: the lean skill's text first, so citing and saving still hold
        const lean = await promptText($, 'lean')
        text = `${lean.text.trim()}\n\n(The lean skill's base folder: ${rootOf($)}/skills/lean.)\n\n---\n\nThe ${name} skill, which builds on the lean skill above:\n\n${text}`
        R.leanLoaded = true
        leanFirst = true
      }
      await record($, { kind: 'prompt', feature: feature ?? name, prompt: id, via: `skill ${name}`, ...(leanFirst ? { with_lean: true } : {}) })
      return { text }
    } catch {
      return r
    }
  }).catch(($: Engine, e: Any, next: Any) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetPrompts(): void {
  Object.assign(R, { setting: '', session: '', idx: null, active: {}, problems: [], texts: new Map(), leanLoaded: false, cardsGiven: false, resolving: null })
}
