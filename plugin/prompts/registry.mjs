// registry.mjs: the prompt registry. Every text a model reads is one file: prompts/<text>.md (the card guide is
// skills/thimble/cards.md, where the skill points to it). Edit the file to change the text; git keeps its history. The
// table below names each text, what it is and what reads it. A text marked optional can be turned off for a session
// with the THIMBLE_PROMPTS environment variable, a list such as "lens-explain:off, context:off".
//
// Pure: no file system. The hooks module reads the files with $.fs (prompts.ts), Node with node:fs (node.mjs).

/** @typedef {{about: string, reads: string, file?: string, optional?: boolean}} Text */

/** @type {Record<string, Text>} */
export const TEXTS = {
  observer: {
    about: "the observer's frame, which holds the shared principles and composes the enabled lenses",
    reads: "observer/observer.ts, after each of Claude's messages",
  },
  'observer-turn': {
    about: "what follows the frame: the messages to read, the cards and what the session read, and the state the transcript lacks",
    reads: 'observer/observer.ts',
  },
  'lens-actions': { about: 'lens: the actions it lights (v with named proposals)', reads: 'the pass', optional: true },
  'lens-heads': { about: 'lens: an important detail of the answer, an orange mark that opens a heads-up card', reads: 'the pass', optional: true },
  'explain-expand': {
    about: "an explainer written again at more length (e on an explainer): one side call over the term, the answer and the files it cites",
    reads: 'shell/expand.ts',
  },
  'lens-explain': { about: 'lens: explain marks on terms that would stop the reader', reads: 'the pass', optional: true },
  'lens-claims': { about: "lens: the turn's claims (statements), each placed by a quote, in a cluster", reads: 'the pass', optional: true },
  'claims-folder': {
    about: 'the guide of the subagent that maps the claims of the whole folder',
    reads: 'claims/term.ts: the brief main hands the subagent names its file',
  },
  squeeze: { about: "squeeze's rewrite along its chips", reads: 'squeeze/term.ts' },
  context: {
    about: "the block thimble adds to a conversation's first message: thimble is on here, so load its skill for a question about these files",
    reads: 'prompts/prompts.ts (prompt.context), once per conversation',
    optional: true,
  },
  forms: {
    about: 'the card guide: what makes a good card, the toolkit, and worked examples',
    reads: 'beside the result of the first data command of a session (prompts.ts); v asks Claude to read it',
    file: 'skills/thimble/cards.md',
  },
  thread: { about: "a side thread's instructions", reads: 'shell/thread.ts' },
  labels: {
    about: "the classifier a --prompt label's records are read with: one call per batch of up to 50 records",
    reads: 'shell/labels.ts, for each call of a --prompt label',
  },
}

/** Other names a person or Claude may use for a text. */
export const ALIASES = { cards: 'forms', 'card-forms': 'forms', observe: 'observer' }

export const OFF = 'off'

/** A text's file, as a path from the plugin's root. */
export const fileOf = name => TEXTS[name]?.file ?? `prompts/${name}.md`

/**
 * The texts turned off: THIMBLE_PROMPTS ("lens-explain:off, context:off") read and checked. Whitespace, a trailing
 * comma and `=` for `:` are fine. A pair that names no text, a text that cannot be off, or a value other than `off` is
 * a problem, said in one line with its fix, and changes nothing.
 * @returns {{off: string[], problems: string[]}}
 */
export function offOf(spec) {
  const off = []
  const problems = []
  for (const raw of String(spec || '').split(/[,;\n]+/)) {
    const s = raw.trim()
    if (!s) continue
    const m = /^([A-Za-z0-9_.-]+)\s*[:=]\s*([A-Za-z0-9_.-]+)$/.exec(s)
    if (!m) { problems.push(`THIMBLE_PROMPTS: "${s}" is not text:off; write it as lens-explain:off`); continue }
    const name = ALIASES[m[1]] || m[1]
    const t = TEXTS[name]
    if (!t) { problems.push(`THIMBLE_PROMPTS: no text "${m[1]}"; the texts are ${Object.keys(TEXTS).join(', ')}`); continue }
    if (m[2] !== OFF) { problems.push(`THIMBLE_PROMPTS: ${name}:${m[2]} is not read: each text is one file (${fileOf(name)}), so edit it there; only ${name}:off is read`); continue }
    if (!t.optional) { problems.push(`THIMBLE_PROMPTS: ${name} cannot be turned off; the texts that can are ${Object.keys(TEXTS).filter(n => TEXTS[n].optional).join(', ')}`); continue }
    if (!off.includes(name)) off.push(name)
  }
  return { off, problems }
}

/** The texts turned off, as one spec ("lens-explain:off,context:off"), so a child process reads the same. */
export const specOf = off => off.map(n => `${n}:${OFF}`).join(',')

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

/** The registry in lines, for `thimble dev prompts`: each text, its file, whether it is off, and what it is. */
export function listing(off = []) {
  const w = Math.max(...Object.keys(TEXTS).map(n => n.length))
  return Object.entries(TEXTS).map(([name, t]) => `${name.padEnd(w)}  ${fileOf(name)}${off.includes(name) ? '  (off)' : ''}  · ${t.about}`)
}
