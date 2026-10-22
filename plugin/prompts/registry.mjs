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
