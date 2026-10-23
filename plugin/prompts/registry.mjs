// registry.mjs: the prompt registry. Every text a model reads is one file: prompts/<text>.md. Edit the file to change
// the text; git keeps its history. The table below names each text, what it is, the module that reads it and how.
//
// Pure: no file system. The hooks module reads the files with $.fs (prompts.ts), Node with node:fs (node.mjs).

/** @typedef {{about: string, reader: string, use: string}} Text */

/** @type {Record<string, Text>} */
export const TEXTS = {
  guidance: {
    about: 'what thimble is, how to cite claims, when to draw a card or make a label',
    reader: 'guidance/guidance.ts',
    use: 'context beside the first prompt of every conversation, sent again after a compaction',
  },
  'card-tool': {
    about: 'how a card reads its rows and draws them, and how to test it',
    reader: 'cards/tool.ts',
    use: 'the description of the card tool',
  },
  checker: {
    about: 'check each citation of a reply with evidence, and correct or fail it',
    reader: 'marks/checker.ts',
    use: 'the prompt of the checker fork after each reply',
  },
  designer: {
    about: 'list forms for the answer, pick one, draw it as a card, read it back and fix it',
    reader: 'designer/v.ts',
    use: 'the prompt of the designer fork that v starts',
  },
  labels: {
    about: "the classifier that reads a --prompt label's records",
    reader: 'labels/labels.ts',
    use: 'one model call per batch of up to 50 records',
  },
  observer: {
    about: "the observer's frame: the shared principles of the look after each answer, with the enabled lenses' sections",
    reader: 'observer/observer.ts',
    use: "the first part of the prompt of one fork of main's conversation after each answer",
  },
  'observer-turn': {
    about: 'what follows the frame: the messages to read, the cards and what the session read, what thimble already gave',
    reader: 'observer/observer.ts',
    use: "the second part of the look's prompt",
  },
  'lens-explain': {
    about: 'explainers on the terms of an answer that would stop the reader',
    reader: 'observer/observer.ts',
    use: "a section of the look's prompt while Explainers is on",
  },
  'lens-heads': {
    about: 'an important detail of the answer: an orange mark that opens a heads-up card',
    reader: 'observer/observer.ts',
    use: "a section of the look's prompt while Important details is on",
  },
  'lens-claims': {
    about: "the turn's claims, each placed by a quote, in a cluster",
    reader: 'observer/observer.ts',
    use: "a section of the look's prompt while Claims is on",
  },
  'explain-expand': {
    about: 'an explainer written again at more length, over the term, the answer and the files it cites',
    reader: 'explain/expand.ts',
    use: 'one model call when the person asks for a longer explainer',
  },
  squeeze: {
    about: 'an answer rewritten at the levels the person picked on its chips, or a catch-up of the replies they missed',
    reader: 'squeeze/term.ts',
    use: 'one model call per change of the chips',
  },
  thread: {
    about: "a side thread's instructions",
    reader: 'threads/thread.ts',
    use: "the prompt of the fork that answers a side thread's question",
  },
  fixer: {
    about: 'make the change the person asked for to their thimble, in a scratch copy, test it, and say what it does',
    reader: 'fix/fixer.ts',
    use: 'the system prompt of the thimble:fixer subagent that /thimble-fix starts',
  },
  'fix-draft': {
    about: "a pull request's title and summary for one of the person's fixes, before the privacy scan",
    reader: 'fix/submit.ts',
    use: 'one model call per fix the person submits',
  },
  'update-pending': {
    about: 'apply the fixes that did not fit a new release on top of it, one commit per fix, then record them',
    reader: 'engine/kernel/fixes.py',
    use: 'the prompt of the Claude Code session that the command thimble update prints opens in live',
  },
}

/** A text's file, as a path from the plugin's root. */
export const fileOf = name => `prompts/${name}.md`

/** Fill {{NAME}} placeholders from `vals` (a function value is called); unknown ones stay as written. */
export function fill(text, vals) {
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => (k in vals ? String(typeof vals[k] === 'function' ? vals[k]() : vals[k] ?? '') : all))
}

/** The registry in lines, for `thimble dev prompts`: each text, its file, what reads it, and what it is. */
export function listing() {
  const rows = Object.entries(TEXTS).map(([name, t]) => [name, fileOf(name), t.reader, `${t.use}: ${t.about}`])
  const w = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length)))
  return rows.map(r => r.map((c, i) => (i < 3 ? c.padEnd(w[i]) : c)).join('  '))
}
