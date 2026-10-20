// registry.mjs: the prompt registry. Every text a model reads is a version of a feature, one file each:
// prompts/<feature>/<version>.md (the card guide is skills/thimble/cards.md, where the skill points to it). The table
// below names each feature, its default and what reads it; a file dropped into a feature's folder is a new version
// with no change here. Which version is active, per feature, comes from the THIMBLE_PROMPTS environment variable, a
// list such as "squeeze:v7, lens-explain:off"; with none, the defaults. A lens can be turned off with the version `off`.
//
// Pure: no file system. The hooks module reads the files with $.fs (prompts.ts), Node with node:fs (node.mjs).

/** @typedef {{about: string, default: string, reads: string, skill?: string, optional?: boolean, base?: string,
 *    versions?: Record<string, {about?: string, file?: string, mode?: string, base?: string}>}} Feature */

/** @type {Record<string, Feature>} */
export const FEATURES = {
  observer: {
    about: "the post-turn pass: its frame, which holds the shared principles and composes the enabled lenses",
    reads: 'observer/observer.ts, after each turn of work',
    default: 'v3-low',
    versions: {
      v3: { about: "the frame for the lenses (one call over the new turn and a digest of the state), with thimble's purpose in the 0.9 preamble's words, and cards for objects", mode: 'lenses' },
      'v3-low': { about: 'v3 at low effort: the same frame, with less thinking before the reply', file: 'prompts/observer/v3.md', mode: 'lenses', effort: 'low' },
    },
  },
  'observer-turn': {
    about: "the pass's message: the new turn, its cards and the digest of the state", reads: 'observer/observer.ts', default: 'v2',
    versions: { v2: { about: 'the new turn with the analyst for the person' } },
  },
  'lens-notes': {
    about: 'lens: notes to Claude', reads: 'the pass', default: 'v2', optional: true,
    versions: { v2: { about: 'written clean in the 0.9 style: two principles and one example, good and bad' } },
  },
  'lens-actions': {
    about: 'lens: the actions it lights (v with named proposals)', reads: 'the pass', default: 'v4', optional: true,
    versions: { v4: { about: "dim by default, lit only for a claim no card shows; written clean in the 0.9 style: two principles and one example, good and bad" } },
  },
  'lens-squeeze': {
    about: "lens: where the answer stands on squeeze's chips", reads: 'the pass', default: 'v2', optional: true,
    versions: { v2: { about: 'written clean in the 0.9 style' } },
  },
  'lens-explain': {
    about: 'lens: explain marks on terms that would stop the reader', reads: 'the pass', default: 'v3', optional: true,
    versions: { v3: { about: "written clean in the 0.9 style, opened with the 0.9 rule for terms (explain a term the analyst has not used the first time)" } },
  },
  squeeze: {
    about: "squeeze's rewrite along its chips", reads: 'verbs/squeeze (term.ts, run.mjs)', default: 'v6',
    versions: { v6: { about: "v5 with thimble's purpose and the 0.9 Communicating words (answer directly, literal words, explain a term the first time)", keep: true, terms: true } },
  },
  forms: {
    about: 'the card guide: what makes a good card, the toolkit, and worked examples',
    reads: 'beside the result of the first data command of a session (prompts.ts); v asks Claude to read it', default: 'v3',
    versions: { v3: { about: "skills/thimble/cards.md, in the 0.9 words", file: 'skills/thimble/cards.md' } },
  },
  thread: {
    about: "a side thread's instructions", reads: 'shell/thread.ts', default: 'v2',
    versions: { v2: { about: "v1 with thimble's purpose and the 0.9 words on answering and citing" } },
  },
  labels: {
    about: "the classifier a --prompt label's records are read with: one call per batch of up to 50 records", reads: 'verbs/label/run.mjs, for each call of a --prompt label', default: 'v2',
    versions: { v2: { about: "v1 with thimble's purpose and the 0.9 classifier's words where they still fit" } },
  },
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
    if (!versions[f.default] && f.default !== OFF) versions[f.default] = { file: `prompts/${name}/${f.default}.md` }
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
  // a feature that is off by default (an optional one whose default is `off`) is off until a setting names a version
  for (const [name, f] of Object.entries(idx)) active[name] = f.default === OFF ? { version: OFF, file: null, source: 'default', off: true } : { version: f.default, file: f.versions[f.default]?.file ?? null, source: 'default' }
  const problems = []
  for (const [source, spec] of [['setting', setting], ['THIMBLE_PROMPTS', env]]) {
    const p = parseSpec(spec)
    for (const x of p.problems) problems.push(`${source}: ${x}; write it as feature:version, such as lens-explain:off`)
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
 *  process (a verb's child) picks the same ones. */
export function specOf(active, idx) {
  return Object.entries(active).filter(([n, a]) => idx[n] && a.version !== idx[n].default).map(([n, a]) => idOf(n, a.version)).join(',')
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

/** The registry in lines, for `thimble prompts` and /observe: each feature, its versions, the active one marked. */
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
