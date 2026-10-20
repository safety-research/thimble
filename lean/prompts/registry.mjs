// registry.mjs: the prompt registry. Every text a model reads is a version of a feature, one file each:
// prompts/<feature>/<version>.md (a skill's current text stays in its SKILL.md, where Claude Code finds it, and is the
// version `skill`). The table below names each feature, its default and what reads it; a file dropped into a feature's
// folder is a new version with no change here. Which version is active, per feature, comes from the plugin's Prompts
// setting and the THIMBLE_PROMPTS environment variable (the variable wins), each a list such as
// "forms:principles, observer:attention-v1". A lens can be turned off with the version `off`.
//
// Pure: no file system. The hooks module reads the files with $.fs (prompts.ts), Node with node:fs (node.mjs).

/** @typedef {{about: string, default: string, reads: string, skill?: string, optional?: boolean, base?: string,
 *    versions?: Record<string, {about?: string, file?: string, mode?: string, base?: string}>}} Feature */

/** The principles every variant of the card ablation shares: the thimble skill's card section (the card runtime's
 *  principles, read where it stands) and the principles of a great output. A part may keep only some of a file's ###
 *  subsections: `only` names them by the start of their headings, `pick: n` takes n of them, chosen by the session. */
const ABLATION = [{ file: 'skills/thimble/SKILL.md', section: 'Cards' }, { file: 'prompts/forms/parts/principles.md' }]
/** The same, with the principles' second version: parts are labelled with what they stand for, each part is drawn from
 *  its row (a stacked bar's parts too), and when interaction earns its place (a part that stands for many things; a
 *  case the person asks to see). */
const ABLATION_V2 = [{ file: 'skills/thimble/SKILL.md', section: 'Cards' }, { file: 'prompts/forms/parts/principles-v2.md' }]

/** @type {Record<string, Feature>} */
export const FEATURES = {
  observer: {
    about: "the post-turn pass: its frame, which holds the shared principles and composes the enabled lenses",
    reads: 'observer/observer.ts, after each turn of work',
    default: 'v3-low',
    versions: {
      v1: { about: 'one prompt in a fork of the whole session, as before lenses', mode: 'fork' },
      v2: { about: 'the frame for the lenses: one call over the new turn and a digest of the state', mode: 'lenses' },
      'attention-v1': { about: "v2 with the draft principles of when something is worth the person's attention", mode: 'lenses' },
      'v2-low': { about: 'v2 at low effort: the same frame, with less thinking before the reply', file: 'prompts/observer/v2.md', mode: 'lenses', effort: 'low' },
      v3: { about: "v2 with thimble's purpose in the 0.9 preamble's words, and cards for objects", mode: 'lenses' },
      'v3-low': { about: 'v3 at low effort, as v2-low is v2', file: 'prompts/observer/v3.md', mode: 'lenses', effort: 'low' },
    },
  },
  'observer-turn': {
    about: "the pass's message: the new turn, its cards and the digest of the state", reads: 'observer/observer.ts', default: 'v2',
    versions: { v1: { about: 'as before' }, v2: { about: 'v1 with the analyst for the person' } },
  },
  question: {
    about: "the question step: the answer against the person's literal question, and a stated decision", reads: 'observer/observer.ts', default: 'v2',
    versions: { v1: { about: 'as before' }, v2: { about: "v1 with thimble's purpose in the 0.9 preamble's words, and cards for objects" } },
  },
  'lens-notes': {
    about: 'lens: notes to Claude', reads: 'the pass', default: 'v2', optional: true,
    versions: { v1: { about: 'as before' }, v2: { about: 'v1 written clean in the 0.9 style: two principles and one example, good and bad' } },
  },
  'lens-line': {
    about: 'lens: the rare line above the prompt', reads: 'the pass', default: 'v2', optional: true,
    versions: { v1: { about: 'as before' }, v2: { about: 'v1 written clean in the 0.9 style: three principles and one example, good and bad' } },
  },
  'lens-actions': {
    about: 'lens: the actions it lights (v with named proposals)', reads: 'the pass', default: 'v4', optional: true,
    versions: { v1: { about: "observer:v1's words on lit verbs" }, v2: { about: 'v lit with a named card when a claim would be clearer seen than read' }, v3: { about: "v2 from the principles of what is worth the person's attention: dim by default, lit only for a claim no card shows" }, v4: { about: 'v3 written clean in the 0.9 style: two principles and one example, good and bad' } },
  },
  'lens-squeeze': {
    about: "lens: where the answer stands on squeeze's chips", reads: 'the pass', default: 'v2', optional: true,
    versions: { v1: { about: 'as before' }, v2: { about: 'v1 written clean in the 0.9 style' } },
  },
  'lens-explain': {
    about: 'lens: explain marks on terms that would stop the reader', reads: 'the pass', default: 'v3', optional: true,
    versions: { v1: { about: "observer:v1's words on glosses" }, v2: { about: 'marks on terms of art and coined names a claim turns on' }, v3: { about: "v2 written clean in the 0.9 style, opened with the 0.9 rule for terms (explain a term the analyst has not used the first time)" } },
  },
  'lens-claims': {
    about: "lens: the turn's claims, with what each means", reads: 'the pass', default: 'v3', optional: true,
    versions: { v1: { about: 'every part of each claim from the pass' }, v2: { about: "v1, terse: the quote names the claim, \"based on\" comes from the cited rows, the digest holds the claims that bear on the turn, a turn with no claims gives none" }, v3: { about: 'v2 written clean in the 0.9 style, at half the length' } },
  },
  squeeze: {
    about: "squeeze's rewrite along its chips", reads: 'verbs/squeeze (term.ts, run.mjs)', default: 'v6',
    versions: { v1: { about: 'prompt.md as before' }, v2: { about: 'v1, keeping corrections, caveats and the words the person asked for' }, v3: { about: "v2, and a correction of Claude's own earlier answer kept at every level" }, v4: { about: 'v3, with the corrections in the original named in the request and put back when a rewrite leaves one out: a correction may be shortened, never dropped', keep: true }, v5: { about: 'v4, with the terms of the explain marks named in the request and kept in their words where the text keeps what they name', keep: true, terms: true }, v6: { about: "v5 with thimble's purpose and the 0.9 Communicating words (answer directly, literal words, explain a term the first time)", keep: true, terms: true } },
  },
  forms: {
    versions: {
      runtime: {
        about: "the thimble skill's card section (read where it stands) and the worked forms (forms:v2's examples)",
        parts: [{ file: 'skills/thimble/SKILL.md', section: 'Cards' }, { file: 'prompts/forms/v2.md', section: 'Worked examples' }],
      },
      v3: {
        about: "the 0.9 card guidance adapted to cards that are programs (question, content and takeaway; the four takeaway failures; several cards), with its worked takeaways and three worked programs: the thimble skill's card section (read where it stands) and forms/v3.md's 'Making a card'",
        parts: [{ file: 'skills/thimble/SKILL.md', section: 'Cards' }, { file: 'prompts/forms/v3.md', section: 'Making a card' }],
      },
      v1: { about: 'FORMS.md as v read it: the card forms, for another view' },
      v2: { about: 'v1 for any card: the one Claude adds and the one v asks for' },
      // the card ablation: the same principles in all five, which differ only in what steers quality
      principles: { about: "ablation a: the runtime's principles (the thimble skill's card section) and the principles of a great output, no examples", parts: ABLATION },
      few: { about: 'ablation b: a, and 3 worked examples from the pool', parts: [...ABLATION, { file: 'prompts/forms/parts/examples.md', only: ['Heat strips', 'Brushable timeline', 'Curves with a knob'] }] },
      many: { about: 'ablation c: a, and the whole pool of worked examples', parts: [...ABLATION, { file: 'prompts/forms/parts/examples.md' }] },
      rotate: { about: "ablation d: a, and 3 worked examples from the pool, a different 3 per session (the session's id picks them)", parts: [...ABLATION, { file: 'prompts/forms/parts/examples.md', pick: 3 }] },
      sketches: { about: 'ablation e: a, and the pool as sketches (the picture, its encoding, its interaction), no programs', parts: [...ABLATION, { file: 'prompts/forms/parts/sketches.md' }] },
      // the interaction pass: the same two versions with the principles' second version
      'principles-v2': { about: 'a with the principles v2: label parts with what they stand for, draw each part from its row, and when a zoom or examples earn their place', parts: ABLATION_V2 },
      'sketches-v2': { about: 'e with the principles v2', parts: [...ABLATION_V2, { file: 'prompts/forms/parts/sketches.md' }] },
    },
    about: 'the card guidance: what makes a card good',
    reads: 'beside the toolkit when Claude reads it before a card, and `thimble guide cards` (v asks for it)', default: 'v3',
    base: 'verbs/visualize',
  },
  card: {
    about: "the card after the answer: a fork of the session that shares main's prompt cache draws the answer's card after its text, so main neither reads the card guidance nor writes the program inside its turn",
    reads: 'shell/shell.tsx after a turn that ran thimble, and the thimble skill in place of its card section (prompts.ts)', default: 'off', optional: true,
    versions: {
      v1: { about: 'the fork decides whether a card helps and writes it, with queries for thimble to run first; one fix round when the save or the drawing finds a problem' },
      v2: { about: "v1, and v's card from a fork too: a press of v asks the fork for the card, not main, so main never reads the card guidance unless the person asks for a card in words" },
    },
  },
  thread: {
    about: "a side thread's instructions", reads: 'shell/thread.ts', default: 'v2',
    versions: { v1: { about: 'as before' }, v2: { about: "v1 with thimble's purpose and the 0.9 words on answering and citing" } },
  },
  labels: {
    about: "the classifier a --prompt label's records are read with: one call per batch of up to 50 records", reads: 'verbs/label/run.mjs, for each call of a --prompt label', default: 'v2',
    versions: { v1: { about: 'as coh-labels wrote it, from the 0.9 classifier' }, v2: { about: "v1 with thimble's purpose and the 0.9 classifier's words where they still fit" } },
  },
  thimble: { about: 'the thimble skill', reads: 'the skill, when Claude loads it', default: 'skill', skill: 'thimble', versions: { skill: { file: 'skills/thimble/SKILL.md', about: 'as SKILL.md says now' } } },
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
    for (const [v, meta] of Object.entries(f.versions || {})) versions[v] = { file: meta.parts ? null : meta.file || `prompts/${name}/${v}.md`, ...meta }
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
  for (const [name, f] of Object.entries(idx)) active[name] = f.default === OFF ? { version: OFF, file: null, source: 'default', off: true } : { version: f.default, file: f.versions[f.default]?.file ?? null, ...(f.versions[f.default]?.parts ? { parts: f.versions[f.default].parts } : {}), source: 'default' }
  const problems = []
  for (const [source, spec] of [['setting', setting], ['THIMBLE_PROMPTS', env]]) {
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
      active[name] = { version: v, file: f.versions[v].file, ...(f.versions[v].parts ? { parts: f.versions[v].parts } : {}), source }
    }
  }
  return { active, problems }
}

/** The id a record names a prompt by: "observer:v2". */
export const idOf = (feature, version) => `${feature}:${version}`

/** The versions in use that are not the defaults, as one spec ("forms:principles,observer:attention-v1"), so a child
 *  process (a verb, `thimble guide`) picks the same ones. */
export function specOf(active, idx) {
  return Object.entries(active).filter(([n, a]) => idx[n] && a.version !== idx[n].default).map(([n, a]) => idOf(n, a.version)).join(',')
}

/** The feature whose text a skill serves (`thimble` -> thimble, `cards` -> forms), or null. */
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

/**
 * One section of a markdown text, by its heading's words: from that heading to the next heading of the same level or
 * higher, the heading kept. '' when the text has no such heading. A version made of parts reads other texts where
 * they stand (the thimble skill's card section), so nothing has a second copy.
 */
export function sectionOf(text, heading) {
  const lines = String(text ?? '').split('\n')
  const at = lines.findIndex(l => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim().toLowerCase().startsWith(String(heading).toLowerCase()))
  if (at < 0) return ''
  const level = /^#+/.exec(lines[at])[0].length
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i])
    if (m && m[1].length <= level) { end = i; break }
  }
  return lines.slice(at, end).join('\n').trim()
}

/** A text's ### subsections: what stands before the first of them (`intro`), and each one as {heading, text}. */
export function subsectionsOf(text) {
  const lines = String(text ?? '').split('\n')
  const items = []
  const intro = []
  let cur = null
  for (const l of lines) {
    if (/^###\s/.test(l)) { cur = { heading: l.replace(/^###\s*/, '').trim(), lines: [l] }; items.push(cur) } else if (cur) cur.lines.push(l)
    else intro.push(l)
  }
  return { intro: intro.join('\n').trim(), items: items.map(x => ({ heading: x.heading, text: x.lines.join('\n').trim() })) }
}

/** A number from 0 to 1, the same for the same seed each time (a session's id picks the same examples in the hooks
 *  and in `thimble guide`). */
function seeded(seed) {
  let a = 2166136261 >>> 0
  for (const ch of String(seed)) { a ^= ch.codePointAt(0); a = Math.imul(a, 16777619) >>> 0 }
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The subsections a part keeps, in the order of its file: `only` (by the start of their headings), `pick` n of them
 *  chosen by `seed`, or null when it keeps the whole text. */
export function chosenOf(part, items, seed = '') {
  if (Array.isArray(part.only)) {
    const want = part.only.map(h => String(h).toLowerCase())
    return items.filter(x => want.some(w => x.heading.toLowerCase().startsWith(w)))
  }
  if (part.pick > 0) {
    const r = seeded(`${seed}|${part.file}`)
    const order = items.map((_, i) => i)
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
    const keep = new Set(order.slice(0, part.pick))
    return items.filter((_, i) => keep.has(i))
  }
  return null
}

/** One part's text, and the headings of the subsections it chose (null when it keeps the whole text). */
function pieceOf(p, read, seed) {
  const raw = read(p.file)
  const body = String(p.file).endsWith('SKILL.md') ? bodyOf(raw) : raw
  const text = p.section ? sectionOf(body, p.section) : String(body).trim()
  if (!Array.isArray(p.only) && !(p.pick > 0)) return { text, chosen: null }
  const { intro, items } = subsectionsOf(text)
  const chosen = chosenOf(p, items, seed)
  return { text: [intro, ...chosen.map(x => x.text)].filter(Boolean).join('\n\n'), chosen: chosen.map(x => x.heading) }
}

/** A version made of parts, from the texts of its files (`read(file)`): each part's section, or the whole body, or the
 *  subsections it keeps (`seed`: the session, for a part that picks). */
export function partsText(parts, read, skip = () => false, seed = '') {
  return partsChoice(parts, read, skip, seed).text
}

/** partsText, and the headings of the examples the parts chose (null when no part chooses), for the session's record. */
export function partsChoice(parts, read, skip = () => false, seed = '') {
  const pieces = parts.filter(p => !skip(p)).map(p => pieceOf(p, read, seed))
  const chosen = pieces.some(x => x.chosen) ? pieces.flatMap(x => x.chosen || []) : null
  return { text: pieces.map(x => x.text).filter(Boolean).join('\n\n') + '\n', chosen }
}

/** Fill {{NAME}} placeholders from `vals` (a function value is called); unknown ones stay as written. */
export function fill(text, vals) {
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => (k in vals ? String(typeof vals[k] === 'function' ? vals[k]() : vals[k] ?? '') : all))
}

/**
 * `fill` as the blocks of a $.model.complete prompt: the words before the first placeholder, which are the same on
 * every call, in a block of their own marked for the prompt cache, then the rest filled. The next call within five
 * minutes reads that first block from the cache. Joined, the blocks are `fill(text, vals)` to the character: the model
 * reads the same words in the same order. A text that opens with a placeholder is one block, with no mark.
 * @returns {{text: string, cache?: true}[]}
 */
export function fillBlocks(text, vals) {
  const s = String(text)
  const at = s.search(/\{\{[A-Z_]+\}\}/)
  if (at <= 0) return [{ text: fill(s, vals) }]
  const rest = fill(s.slice(at), vals)
  return rest ? [{ text: s.slice(0, at), cache: true }, { text: rest }] : [{ text: s.slice(0, at) }]
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
