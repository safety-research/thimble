// prompts.ts: the prompt registry (registry.mjs) from the hooks module. Once per session it finds the versions on disk,
// picks the active one of each feature (the plugin's Prompts setting, then THIMBLE_PROMPTS), sets THIMBLE_PROMPTS for the
// session's commands to the same choice (so `thimble guide` and a verb's child read the same versions), names the versions
// in use in the session's events, and says in one line when a named version does not exist (it keeps the default).
//
// The card guidance (feature `forms`) comes once per session as context beside the result of Claude's first data
// command (`thimble run`, `rows`, `resolve` or `sources`, whichever comes first): Claude queries before it draws, so the
// guidance is there before the first card, and a session that never queries never reads it. A read of the drawing
// toolkit (draw/TOOLKIT.md) before any data command brings it too. The person never sees it. The default version,
// `runtime`, is the thimble skill's card section (the card runtime's principles) and the worked forms: when the thimble
// skill is loaded, its section is in the conversation already, so only the worked forms come. v's request asks for
// the guidance with `thimble guide cards` when it was not read yet; once the skill is loaded, THIMBLE_SKILL_LOADED tells
// that command to leave the skill's section out too. The session's events name the version given, the
// command it came with and when (a hook on turn.start would also see the observer's forks, so the step is read from
// the time).
//
// Skills: Claude Code finds a skill's SKILL.md where it is, and that text is the version `skill`. When another version
// of a skill's feature is active, the skill.prompt hook serves it in place of the file's text. The same hook makes sure
// a verb's skill never replaces the thimble skill: when Claude loads one of thimble's other skills (map, explore, trace,
// claims) before the thimble skill in a session, the thimble skill's text comes first in what it reads.
//
// The card after the answer (feature `card`, off by default): while it is on, main does not draw the answer's card in
// its turn (a fork draws it after the answer, shell.tsx), so the thimble skill comes with its card parts replaced by the
// version's own (shell/cardfork.mjs skillWithCards), and the first data command brings no card guidance. A toolkit
// read and `thimble guide cards` (the person asked for a card, or pressed v) still bring it.
import type { EngineInterface } from 'claude-code'

import { skillWithCards } from '../shell/cardfork.mjs'
import { record } from '../telemetry/telemetry'
import { FEATURES, bodyOf, choose, featureOfSkill, idOf, indexOf, partsChoice, specOf } from './registry.mjs'
import { sessionKey } from '../hooks/conversation'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Active = { version: string; file: string | null; source: string; off?: boolean; parts?: { file: string; section?: string }[] }

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

/** Claude's first data command of a session brings the card guidance: `thimble run`, `rows`, `resolve` or `sources`. */
const LEAN_DATA = /(^|[\s;&|(])thimble\s+(run|q|rows|resolve|sources)\b/

/** Whether the thimble skill is in the conversation, for the session's commands: `thimble guide cards` then leaves out
 *  the skill's card section, which Claude already has (prompts/node.mjs). */
async function markSkill($: Engine, loaded: boolean): Promise<void> {
  try { await $.env.set('THIMBLE_SKILL_LOADED', loaded ? '1' : '') } catch { /* the guide then prints the section again */ }
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
  // THIMBLE_PROMPTS as Claude Code was started with it; once set below it holds the setting too, which choose() reads
  // again as the same choice
  const env = String((await $.env.get('THIMBLE_PROMPTS')) || '')
  const c = choose(R.idx, { setting: R.setting, env })
  R.active = c.active
  R.problems = c.problems
  R.texts.clear()
  try { await $.env.set('THIMBLE_PROMPTS', specOf(R.active, R.idx)) } catch { /* the children read the defaults */ }
  await markSkill($, false)
  const active = Object.fromEntries(Object.entries(R.active).map(([n, a]) => [n, a.version]))
  await record($, { kind: 'prompts', active, changed: specOf(R.active, R.idx) || null, problems: R.problems })
  if (R.problems.length) $.ui.toast(`thimble prompts: ${R.problems[0]}${R.problems.length > 1 ? ` (and ${R.problems.length - 1} more: thimble prompts)` : ''}`)
}

/** The registry for this session: resolved once, again when the session changes. */
export async function registry($: Engine): Promise<{ idx: Any; active: Record<string, Active>; problems: string[] }> {
  const id = await sessionKey($)
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
export async function promptText($: Engine, feature: string, o: { skip?: (part: { file: string }) => boolean } = {}): Promise<{ text: string; version: string; id: string; off: boolean; chosen?: string[] | null }> {
  const { idx, active } = await registry($)
  const a = active[feature]
  if (!a) throw new Error(`no prompt feature ${feature}`)
  if (a.off) return { text: '', version: a.version, id: idOf(feature, a.version), off: true }
  const key = `${feature}:${a.version}`
  if (a.parts) {
    // a version made of parts reads them where they stand, each time (a part may be left out: `skip`); a part that
    // picks some of a file's examples picks them by the session, so `thimble guide` in the same session reads the same
    const texts: Record<string, string> = {}
    for (const p of a.parts) if (!o.skip?.(p)) texts[p.file] = String(await $.fs.read(`${rootOf($)}/${p.file}`))
    const c = partsChoice(a.parts, (f: string) => texts[f] ?? '', o.skip, R.session)
    return { text: c.text, version: a.version, id: key, off: false, chosen: c.chosen }
  }
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

/**
 * The shadow A/B: THIMBLE_PROMPTS_SHADOW names other versions (feature:version pairs, as THIMBLE_PROMPTS does) that the
 * observer runs a second pass with, on the same turn, after the first: recorded in the events with `shadow`, never shown
 * and never merged, so `thimble stats` compares two versions on the same context. Returns the versions the shadow pass
 * uses where they differ from the active ones ({feature: version}), and the spec as given; null when none is set.
 */
export async function shadowVersions($: Engine): Promise<{ spec: string; versions: Record<string, string>; problems: string[] } | null> {
  const spec = String((await $.env.get('THIMBLE_PROMPTS_SHADOW')) || '').trim()
  if (!spec) return null
  const { idx, active } = await registry($)
  const c = choose(idx, { env: spec })
  const versions: Record<string, string> = {}
  for (const [name, a] of Object.entries(c.active as Record<string, Active>)) if (a.source !== 'default' && a.version !== active[name]?.version) versions[name] = a.version
  return { spec, versions, problems: c.problems }
}

/** The text of one version of a feature, whatever is active (the shadow pass reads its versions with it). */
export async function promptTextAt($: Engine, feature: string, version: string): Promise<{ text: string; version: string; id: string; off: boolean }> {
  const { idx, active } = await registry($)
  if (active[feature]?.version === version) return promptText($, feature)
  const id = idOf(feature, version)
  if (version === 'off') return { text: '', version, id, off: true }
  const v = idx[feature]?.versions?.[version]
  if (!v?.file) throw new Error(`no prompt version ${id}`)
  const key = id
  if (!R.texts.has(key)) {
    const raw = String(await $.fs.read(`${$.plugin.root.replace(/\/+$/, '')}/${v.file}`))
    R.texts.set(key, v.file.endsWith('SKILL.md') ? bodyOf(raw) : raw)
  }
  return { text: R.texts.get(key)!, version, id, off: false }
}

/** The card after the answer: its version's text when it is on, else null. */
export async function cardAfter($: Engine): Promise<{ text: string; id: string } | null> {
  try {
    const t = await promptText($, 'card')
    return t.off || !t.text.trim() ? null : { text: t.text, id: t.id }
  } catch {
    return null
  }
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

  // a compaction may drop the thimble skill from the conversation: the next verb skill brings it again
  on('session.compact', async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    R.leanLoaded = false
    R.cardsGiven = false
    await markSkill($, false)
    return r
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  // the first data command (or a toolkit read before it): the card guidance comes beside its result, once per session
  on('tool.call', { tool: /^(Read|Bash)$/ }, async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    try {
      if (!r || r.deny !== undefined || r.isError || e.agentId !== undefined) return r
      const file = String(e.file_path || '')
      const isRead = e.tool === 'Read' && /(^|\/)draw\/TOOLKIT\.md$/.test(file) && file.startsWith(rootOf($))
      const command = String(e.command || '')
      // `thimble guide cards` (v asks for it) printed the guidance itself: it is in the conversation, so no read or save
      // after it brings it a second time
      if (e.tool === 'Bash' && /(^|[\s;&|(])thimble\s+guide\s+(cards|forms|card-forms)\b/.test(command)) {
        await registry($)
        R.cardsGiven = true
        return r
      }
      const isShell = e.tool === 'Bash' && /\bdraw\/TOOLKIT\.md\b/.test(command) && !/\bthimble\s/.test(command)
      const data = e.tool === 'Bash' && !isShell ? LEAN_DATA.exec(command) : null
      if (!isRead && !isShell && !data) return r
      await registry($)
      if (R.cardsGiven) return r
      // the card comes after the answer, from a fork: a data command brings no guidance (a toolkit read still does)
      const after = await cardAfter($)
      if (data && after) return r
      // a part the conversation holds already (the thimble skill's card section, once the thimble skill is loaded, unless the
      // card after the answer took its place) is left out
      const t = await promptText($, 'forms', { skip: p => R.leanLoaded && !after && p.file === 'skills/thimble/SKILL.md' })
      if (t.off || !t.text.trim()) return r
      R.cardsGiven = true
      const base = (FEATURES.forms.versions as Any)?.[t.version]?.base || FEATURES.forms.base
      await record($, { kind: 'prompt', feature: 'forms', prompt: t.id, via: data ? `thimble ${data[2]}` : `${isRead ? 'Read' : 'Bash'} of draw/TOOLKIT.md`, ...(t.chosen ? { examples: t.chosen } : {}) })
      const head = data
        ? `The card guidance (${t.id}), which thimble adds once per session with your first data command, so you have it before you draw a card.`
        : `The card guidance (${t.id}), which thimble adds when you read the toolkit before a card.`
      const note = `${head} Paths in it are relative to ${rootOf($)}/${base}.\n\n${t.text}`
      return { ...r, context: [...(r.context ?? []), note] }
    } catch {
      return r
    }
  }).catch(($: Engine, e: Any, next: Any) => next(e))

  on('skill.prompt', async ($: Engine, e: Any, next: Any) => {
    const r = await next(e)
    const name = String(e.skill || '').split(':').pop() || ''
    const ours = e.pluginName === 'thimble' || String(e.skill || '').startsWith('thimble:')
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
      // the card after the answer: the thimble skill's card parts are the card version's
      const card = name === 'thimble' || !R.leanLoaded ? await cardAfter($) : null
      if (name === 'thimble') {
        R.leanLoaded = true
        await markSkill($, true)
        if (card) text = withBody(text, skillWithCards(bodyOf(text.replace(/^Base directory for this skill:[^\n]*\n+/, '')), card.text))
      } else if (!R.leanLoaded) {
        // a verb's skill loaded before the thimble skill: the thimble skill's text first, so citing and saving still hold
        const lean = await promptText($, 'thimble')
        const leanText = card ? skillWithCards(lean.text, card.text) : lean.text
        text = `${leanText.trim()}\n\n(The thimble skill's base folder: ${rootOf($)}/skills/thimble.)\n\n---\n\nThe ${name} skill, which builds on the thimble skill above:\n\n${text}`
        R.leanLoaded = true
        await markSkill($, true)
        leanFirst = true
      }
      await record($, { kind: 'prompt', feature: feature ?? name, prompt: id, via: `skill ${name}`, ...(leanFirst ? { with_lean: true } : {}), ...(card ? { card: card.id } : {}) })
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
