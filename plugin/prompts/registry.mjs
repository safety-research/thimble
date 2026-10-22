// registry.mjs: the prompt registry. Every text a model reads is one file: prompts/<text>.md. Edit the file to change
// the text; git keeps its history. The table below names each text, what it is and what reads it.
//
// Pure: no file system. The hooks module reads the files with $.fs (prompts.ts), Node with node:fs (node.mjs).

/** @typedef {{about: string, reads: string}} Text */

/** @type {Record<string, Text>} */
export const TEXTS = {
  guidance: {
    about: "the thimble block in every conversation: what thimble is, how to mark claims, when to draw a card or make a label",
    reads: 'guidance/guidance.ts (prompt.context), as one context block, again after a compaction',
  },
  'card-tool': {
    about: 'the description of the card tool: how a card reads its rows and draws them, and how to test it',
    reads: 'cards/tool.ts, as the tool text the model sees',
  },
  checker: {
    about: "the checker's instructions: check each mark of a reply with evidence, and correct or fail it",
    reads: 'marks/checker.ts, as the prompt of the checker fork after each reply',
  },
  designer: {
    about: "v's instructions: list forms for the answer, pick one, draw it as a card, read it back and fix it",
    reads: 'designer/v.ts, as the prompt of the designer fork',
  },
  labels: {
    about: "the classifier a --prompt label's records are read with: one call per batch of up to 50 records",
    reads: 'labels/labels.ts, for each call of a --prompt label',
  },
}

/** A text's file, as a path from the plugin's root. */
export const fileOf = name => `prompts/${name}.md`

/** Fill {{NAME}} placeholders from `vals` (a function value is called); unknown ones stay as written. */
export function fill(text, vals) {
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => (k in vals ? String(typeof vals[k] === 'function' ? vals[k]() : vals[k] ?? '') : all))
}

/** The registry in lines, for `thimble dev prompts`: each text, its file, and what it is. */
export function listing() {
  const w = Math.max(...Object.keys(TEXTS).map(n => n.length))
  return Object.entries(TEXTS).map(([name, t]) => `${name.padEnd(w)}  ${fileOf(name)}  · ${t.about}`)
}
