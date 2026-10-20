// registry.mjs: the prompt registry. Every text a model reads is a version of a feature, one file each:
// prompts/<feature>/<version>.md (the card guide is skills/thimble/cards.md, where the skill points to it). The table
// below names each feature, its default and what reads it; a file dropped into a feature's folder is a new version
// with no change here. Which version is active, per feature, comes from the THIMBLE_PROMPTS environment variable, a
// list such as "squeeze:v7, lens-explain:off"; with none, the defaults. A lens can be turned off with the version `off`.
//
// Pure: no file system. The hooks module reads the files with $.fs (prompts.ts), Node with node:fs (node.mjs).

/** @typedef {{about: string, default: string, reads: string, skill?: string, optional?: boolean, base?: string,
 *    versions?: Record<string, {about?: string, file?: string, mode?: string, turn?: string, effort?: string, base?: string}>}} Feature */

/** @type {Record<string, Feature>} */
export const FEATURES = {
  observer: {
    about: "the observer's frame, which holds the shared principles and composes the enabled lenses",
    reads: "observer/observer.ts, after each of Claude's messages",
    default: 'v6',
    versions: {
      v3: { about: "the frame for the lenses (one call over the new turn and a digest of the state), with thimble's purpose in the 0.9 preamble's words, and cards for objects", mode: 'lenses', turn: 'v2' },
      'v3-low': { about: 'v3 at low effort: the same frame, with less thinking before the reply', file: 'prompts/observer/v3.md', mode: 'lenses', effort: 'low', turn: 'v2' },
      v4: { about: "v3 in coverage's words: a file is seen when some of its lines entered Claude's context; one only computed over, counted, listed or searched is not; and v3's word on explainers (they wait until opened, so give one for a term the analyst has not used)", mode: 'lenses', turn: 'v2' },
      'v4-low': { about: 'v4 at low effort: the same frame, with less thinking before the reply', file: 'prompts/observer/v4.md', mode: 'lenses', effort: 'low', turn: 'v2' },
      v5: { about: "v4 as the prompt of a fork that shares the session: it reads each of Claude's messages with the whole session, the messages to read named at the end; when to give each part is left to the lenses", mode: 'fork', turn: 'v3' },
      v6: { about: "v5 with the request framed as a side request whose one reply goes to thimble, in place of the sentence that it has no tools (the fork keeps main's tools for the cache), and its parts going mostly to the analyst's screen", mode: 'fork', turn: 'v3' },
    },
  },
  'observer-turn': {
    about: "what follows the frame: the messages to read, the cards and what the session read, and the state the transcript lacks", reads: 'observer/observer.ts', default: 'v3',
    versions: {
      v2: { about: 'the new turn with the analyst for the person (the earlier pass, which reads no session)' },
      v3: { about: "for the fork: the messages to read named by their first words, the cards' lineage, coverage, each lens's digest and rules, and the reply's skeleton" },
    },
  },
  'lens-notes': {
    about: 'lens: notes to Claude', reads: 'the pass', default: 'v2', optional: true,
    versions: { v2: { about: 'written clean in the 0.9 style: two principles and one example, good and bad' } },
  },
  'lens-actions': {
    about: 'lens: the actions it lights (v with named proposals)', reads: 'the pass', default: 'v5', optional: true,
    versions: {
      v4: { about: "dim by default, lit only for a claim no card shows; written clean in the 0.9 style: two principles and one example, good and bad" },
      v5: { about: "v4 with its principle as when a view is worth it (a claim a view shows faster than words, no card yet), its list of what needs no view gone" },
    },
  },
  'lens-squeeze': {
    about: "lens: where the answer stands on squeeze's chips", reads: 'the pass', default: 'v3', optional: true,
    versions: { v2: { about: 'written clean in the 0.9 style' }, v3: { about: 'the chips as squeeze v7 names them: Interpretation (facts only · some meaning · full meaning) and Background (new · learning · working · expert), each in one sentence' } },
  },
  'lens-heads': {
    about: 'lens: an important detail of the answer, an orange mark that opens a heads-up card', reads: 'the pass', default: 'v2', optional: true,
    versions: {
      v1: { about: "a detail the analyst should know before they rely on the answer: one principle (mark it when missing it would change what they conclude or do) and one example" },
      v2: { about: "v1 with one line of purpose: mark for this analyst, from what the session shows they know and care about (their questions, what they opened, their side threads)" },
    },
  },
  'explain-expand': {
    about: "an explainer written again at more length (e on an explainer): one side call over the term, the answer and the files it cites", reads: 'shell/expand.ts', default: 'v1',
    versions: { v1: { about: 'what it is, what it does here and how it connects, cited, with an example of a drawn explanation' } },
  },
  'lens-explain': {
    about: 'lens: explain marks on terms that would stop the reader', reads: 'the pass', default: 'v6', optional: true,
    versions: {
      v3: { about: "written clean in the 0.9 style, opened with the 0.9 rule for terms (explain a term the analyst has not used the first time)" },
      v4: { about: "v3 with names from the files (a function, a hook, a field) among the words that stop a reader, a code example, and a backoff that gives one" },
      v5: { about: "v4 with its lists of words and counts gone: the 0.9 principle and its reason, a body with no length, and an example with a drawn explainer beside one in words" },
      v6: { about: "v5 with one line of purpose (explain for this analyst, from what the session shows they know and care about), and no backoff and no count of explainers" },
    },
  },
  'lens-claims': {
    about: "lens: the turn's claims (statements), each placed by a quote, in a cluster", reads: 'the pass', default: 'v5', optional: true,
    versions: {
      v3: { about: "written clean in the 0.9 style from v2 (the quote names the claim, the digest holds the claims that bear on the turn): five principles and one example, good and bad; a part only when the claim's words leave it open" },
      v4: { about: "one kind, a statement: four short principles (what a claim is, found by its words, its history, clusters) and one example, good and bad; no kinds, parts, counts or case rules" },
      v5: { about: "v4 with every claim a full sentence that reads alone (the analyst reads it away from its message), and the quote only what finds it; the example's claims each given in words, its bad one a fragment" },
    },
  },
  'claims-folder': {
    about: 'the guide of the subagent that maps the claims of the whole folder', reads: 'claims/term.ts: the brief main hands the subagent names its file', default: 'v2',
    versions: {
      v1: { about: "the coh-atlas skill in the 0.9 style, for thimble's five commands: the map saved as the card folder-claims, its citations checked by the save" },
      v2: { about: 'v1 as short principles: one kind, a statement; no kinds, relations, counts or step lists; the pane shows the map as a graph in clusters' },
    },
  },
  squeeze: {
    about: "squeeze's rewrite along its chips", reads: 'squeeze/term.ts', default: 'v7',
    versions: {
      v6: { about: "v5 with thimble's purpose and the 0.9 Communicating words (answer directly, literal words, explain a term the first time)", keep: true, terms: true },
      v7: { about: 'each chip in a sentence or two of what it is, no layout: Length with the original in its middle (one line · short · as written · longer · much longer), Interpretation, Background, and a chip the analyst types; the principles cut to the general ones', keep: true, terms: true },
    },
  },
  context: {
    about: "the block thimble adds to a conversation's first message: thimble is on here, so load its skill for a question about these files",
    reads: 'prompts/prompts.ts (prompt.context), once per conversation', default: 'v3', optional: true,
    versions: {
      v1: { about: "thimble's purpose in the 0.9 preamble's words, and the skill to load before an answer about the files, code included" },
      v2: { about: 'v1 without naming code: before any answer about the files' },
      v3: { about: 'the two facts alone: thimble is on here, and load its skill before the first answer about these files; the note is for Claude' },
    },
  },
  forms: {
    about: 'the card guide: what makes a good card, the toolkit, and worked examples',
    reads: 'beside the result of the first data command of a session (prompts.ts); v asks Claude to read it', default: 'v6',
    versions: {
      v3: { about: 'the card guide in the 0.9 words, with its four takeaway failures and four programs (kept as prompts/forms/v3.md)' },
      v4: { about: "the 0.9 principles in fewer words, one takeaway example, guides as pages, seven worked programs and one sequence of cards (kept as prompts/forms/v4.md)" },
      v5: { about: "v4 without its list of forms, its pages and the links in a card's words; six worked programs (kept as prompts/forms/v5.md)" },
      v6: { about: "skills/thimble/cards.md: v5 with k.graph in the toolkit, and five worked programs that each answer another kind of question with a form made for it (a code path as a diagram, one run's anatomy, a grid of small multiples, two versions side by side, a threshold as a knob), opened by why a picture can beat a chart", file: 'skills/thimble/cards.md' },
    },
  },
  thread: {
    about: "a side thread's instructions", reads: 'shell/thread.ts', default: 'v2',
    versions: { v2: { about: "v1 with thimble's purpose and the 0.9 words on answering and citing" } },
  },
  labels: {
    about: "the classifier a --prompt label's records are read with: one call per batch of up to 50 records", reads: 'shell/labels.ts, for each call of a --prompt label', default: 'v2',
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
