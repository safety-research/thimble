// registry.mjs: the prompt registry. Every text a model reads is a version of a feature, one file each:
// prompts/<feature>/<version>.md (a skill's current text stays in its SKILL.md, where Claude Code finds it, and is the
// version `skill`). The table below names each feature, its default and what reads it; a file dropped into a feature's
// folder is a new version with no change here. Which version is active, per feature, comes from the plugin's Prompts
// setting and the LEAN_PROMPTS environment variable (the variable wins), each a list such as
// "forms:principles, observer:attention-v1". A lens can be turned off with the version `off`.
//
// Pure: no file system. The hooks module reads the files with $.fs (prompts.ts), Node with node:fs (node.mjs).

/** @typedef {{about: string, default: string, reads: string, skill?: string, optional?: boolean, base?: string,
 *    versions?: Record<string, {about?: string, file?: string, mode?: string, base?: string}>}} Feature */

/** @type {Record<string, Feature>} */
export const FEATURES = {
  observer: {
    about: "the post-turn pass: its frame, which holds the shared principles and composes the enabled lenses",
    reads: 'observer/observer.ts, after each turn of work',
    default: 'v2',
    versions: {
      v1: { about: 'one prompt in a fork of the whole session, as before lenses', mode: 'fork' },
      v2: { about: 'the frame for the lenses: one call over the new turn and a digest of the state', mode: 'lenses' },
      'attention-v1': { about: "v2 with the draft principles of when something is worth the person's attention", mode: 'lenses' },
    },
  },
  'observer-turn': { about: "the pass's message: the new turn, its objects and the digest of the state", reads: 'observer/observer.ts', default: 'v1' },
  question: { about: "the question step: the answer against the person's literal question, and a stated decision", reads: 'observer/observer.ts', default: 'v1' },
  'lens-notes': { about: 'lens: notes to Claude', reads: 'the pass', default: 'v1', optional: true },
  'lens-line': { about: 'lens: the rare line above the prompt', reads: 'the pass', default: 'v1', optional: true },
  'lens-actions': {
    about: 'lens: the actions it lights (v with named proposals)', reads: 'the pass', default: 'v2', optional: true,
    versions: { v1: { about: "observer:v1's words on lit verbs" }, v2: { about: 'v lit with a named card when a claim would be clearer seen than read' } },
  },
  'lens-squeeze': { about: "lens: where the answer stands on squeeze's chips", reads: 'the pass', default: 'v1', optional: true },
  'lens-explain': {
    about: 'lens: explain marks on terms that would stop the reader', reads: 'the pass', default: 'v2', optional: true,
    versions: { v1: { about: "observer:v1's words on glosses" }, v2: { about: 'marks on terms of art and coined names a claim turns on' } },
  },
  'lens-claims': { about: "lens: the turn's claims, with what each means", reads: 'the pass', default: 'v1', optional: true },
  squeeze: {
    about: "squeeze's rewrite along its chips", reads: 'verbs/squeeze (term.ts, run.mjs)', default: 'v2',
    versions: { v1: { about: 'prompt.md as before' }, v2: { about: 'v1, keeping corrections, caveats and the words the person asked for' } },
  },
  forms: {
    versions: { v1: { about: 'FORMS.md as v read it: the card forms, for another view' }, v2: { about: 'v1 for any card: the one Claude adds and the one v asks for' }, principles: { about: 'the draft principles of a great output, no examples (ablation variant a)' } },
    about: 'the card guidance: what makes a card good', reads: '`lean guide cards`, before Claude draws a card (proactive or v)', default: 'v2',
    base: 'verbs/visualize',
  },
  thread: { about: "a side thread's instructions", reads: 'shell/thread.ts', default: 'v1' },
  lean: { about: 'the lean skill', reads: 'the skill, when Claude loads it', default: 'skill', skill: 'lean', versions: { skill: { file: 'skills/lean/SKILL.md', about: 'as SKILL.md says now' }, v1: { about: 'SKILL.md before the card guidance moved to `lean guide cards`' } } },
  claims: { about: 'the corpus orientation (a subagent reads it)', reads: 'verbs/claims/run.mjs, /verb claims orient', default: 'skill', skill: 'claims', versions: { skill: { file: 'verbs/claims/SKILL.md' } } },
  map: { about: 'the map skill', reads: 'the skill', default: 'skill', skill: 'map', versions: { skill: { file: 'verbs/map/SKILL.md' } } },
  explore: { about: 'the explore skill', reads: 'the skill', default: 'skill', skill: 'explore', versions: { skill: { file: 'verbs/explore/SKILL.md' } } },
  trace: { about: 'the trace skill', reads: 'the skill, and the trace verb', default: 'skill', skill: 'trace', versions: { skill: { file: 'verbs/trace/SKILL.md' } } },
}

/** Other names a person or Claude may use for a feature. */
export const ALIASES = { cards: 'forms', 'card-forms': 'forms', observe: 'observer' }

export const OFF = 'off'

/** "forms:principles, observer:attention-v1" -> {pairs: {forms: 'principles', ...}, problems: [...]}. Whitespace, a
 *  trailing comma and `=` for `:` are fine. */
export function parseSpec(spec) {
  const pairs = {}
  const problems = []
  for (const raw of String(spec || '').split(/[,;\n]+/)) {
    const s = raw.trim()
    if (!s) continue
    const m = /^([A-Za-z0-9_.-]+)\s*[:=]\s*([A-Za-z0-9_.-]+)$/.exec(s)
    if (!m) { problems.push(`"${s}" is not feature:version`); continue }
    pairs[ALIASES[m[1]] || m[1]] = m[2]
  }
  return { pairs, problems }
}

/**
 * The index of every feature and its versions: the table, plus the versions found on disk (`found`: {feature: [file
 * names in prompts/<feature>/]}). A version is {file: its path from the plugin's root, ...the table's notes}.
 */
export function indexOf(found = {}) {
  const idx = {}
  for (const [name, f] of Object.entries(FEATURES)) {
    const versions = {}
    for (const [v, meta] of Object.entries(f.versions || {})) versions[v] = { file: meta.file || `prompts/${name}/${v}.md`, ...meta }
    for (const file of found[name] || []) {
      const v = String(file).replace(/\.md$/, '')
      if (!String(file).endsWith('.md') || v.startsWith('.') || v === OFF) continue
      versions[v] = { ...(versions[v] || {}), file: `prompts/${name}/${file}` }
    }
    if (!versions[f.default]) versions[f.default] = { file: `prompts/${name}/${f.default}.md` }
    idx[name] = { ...f, name, versions }
  }
  return idx
}

/**
 * The active version of each feature: the default, then the setting, then the environment, each pair checked. A
 * version that does not exist keeps the one before it, and says so in one line with its fix.
 * @returns {{active: Record<string, {version: string, file: string | null, source: string, off?: boolean}>, problems: string[]}}
 */
export function choose(idx, { setting = '', env = '' } = {}) {
  const active = {}
  for (const [name, f] of Object.entries(idx)) active[name] = { version: f.default, file: f.versions[f.default]?.file ?? null, source: 'default' }
  const problems = []
  for (const [source, spec] of [['setting', setting], ['LEAN_PROMPTS', env]]) {
    const p = parseSpec(spec)
    for (const x of p.problems) problems.push(`${source}: ${x}; write it as feature:version, such as forms:principles`)
    for (const [name, v] of Object.entries(p.pairs)) {
      const f = idx[name]
      if (!f) { problems.push(`${source}: no prompt feature "${name}"; the features are ${Object.keys(idx).join(', ')}`); continue }
      if (v === OFF && f.optional) { active[name] = { version: OFF, file: null, source, off: true }; continue }
      if (!f.versions[v]) {
        problems.push(`${source}: no version ${name}:${v}, so ${name} stays at ${active[name].version}; its versions are ${Object.keys(f.versions).join(', ')}${f.optional ? ', off' : ''}`)
        continue
      }
      active[name] = { version: v, file: f.versions[v].file, source }
    }
  }
  return { active, problems }
}

/** The id a record names a prompt by: "observer:v2". */
export const idOf = (feature, version) => `${feature}:${version}`

/** The versions in use that are not the defaults, as one spec ("forms:principles,observer:attention-v1"), so a child
 *  process (a verb, `lean guide`) picks the same ones. */
export function specOf(active, idx) {
  return Object.entries(active).filter(([n, a]) => idx[n] && a.version !== idx[n].default).map(([n, a]) => idOf(n, a.version)).join(',')
}

/** The feature whose text a skill serves (`lean` -> lean, `cards` -> forms), or null. */
export function featureOfSkill(skill) {
  const name = String(skill || '').split(':').pop()
  for (const [n, f] of Object.entries(FEATURES)) if (f.skill === name) return n
  return null
}

/** A skill file's text without its frontmatter. */
export function bodyOf(text) {
  const s = String(text ?? '')
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(s)
  return m ? s.slice(m[0].length) : s
}

/** Fill {{NAME}} placeholders from `vals` (a function value is called); unknown ones stay as written. */
export function fill(text, vals) {
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => (k in vals ? String(typeof vals[k] === 'function' ? vals[k]() : vals[k] ?? '') : all))
}

/** The registry in lines, for `lean prompts` and /observe: each feature, its versions, the active one marked. */
export function listing(idx, active) {
  const lines = []
  for (const [name, f] of Object.entries(idx)) {
    const a = active[name]
    const vs = Object.keys(f.versions).map(v => (a && a.version === v ? `[${v}]` : v))
    if (f.optional) vs.push(a && a.off ? `[${OFF}]` : OFF)
    lines.push(`${name.padEnd(14)} ${vs.join(' ')}${a && a.source !== 'default' ? `  (${a.source})` : ''}  · ${f.about}`)
  }
  return lines
}
