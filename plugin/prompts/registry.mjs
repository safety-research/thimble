// registry.mjs: the prompt registry. Every text a model reads is one file: prompts/<text>.md. Edit the file to change
// the text; git keeps its history. The table below names each text, what it is, the module that reads it in each mode
// and how.
//
// Both modes read a text the same way (compose): its file, with each `{{include:NAME}}` replaced by text NAME, and each
// slot of a mode's own words, `{{NAME}}` with a value for each mode in prompts/slots.json, filled with the mode's value.
// Such a value is a name or a clause of at most one sentence, never a second text, so what differs between the modes
// stays in sight. A text's other slots are its readers' (`fills`), filled at each call with fill(). The workbench reads
// the texts with browser/backend/app/prompts.py by the same rules (`{{include:plugin:NAME}}` in its own texts), and its
// parity check (browser/backend/tests_public/test_shared_texts.py) holds a text both modes read the same in both.
//
// Pure: no file system. The hooks module reads the files with $.fs (prompts.ts), Node with node:fs (node.mjs).

/** @typedef {{about: string, terminal?: string, browser?: string, use: string, fills?: string[]}} Text */
// terminal: the module that reads it in the terminal, from the plugin's root; browser: the module that reads it in the
// workbench, from the repository's root; fills: the slots its readers fill at each call

/** @type {Record<string, Text>} */
export const TEXTS = {
  guidance: {
    about: 'what thimble is, how to cite claims, when to draw a card or make a label',
    terminal: 'guidance/guidance.ts',
    use: 'context beside the first prompt of every conversation, sent again after a compaction',
    fills: ['TMPDIR'],
  },
  'card-tool': {
    about: 'how a card reads its rows and draws them, and how to test it',
    terminal: 'cards/tool.ts',
    use: 'the description of the card tool',
    fills: ['TMPDIR', 'KEPT'],
  },
  'card-check': {
    about: "the card check of a card that does not fit on the analyst's screen: the view and title that replace it, by the card guide and the guidance's Cards section",
    terminal: 'cards/fit.ts',
    use: 'one model call when a version the card tool drew does not fit, before the analyst sees it',
    fills: ['GUIDE', 'GUIDANCE'],
  },
  checker: {
    about: 'check each citation of a reply with evidence, and correct or fail it',
    terminal: 'marks/checker.ts',
    browser: 'browser/backend/app/marks.py',
    use: 'the prompt of the checker fork after each reply',
    fills: ['MARKS', 'CWD', 'ROOT', 'CARDS', 'REPLY'],
  },
  designer: {
    about: 'list forms for the answer, pick one, draw it as a card, read it back and fix it',
    terminal: 'designer/v.ts',
    use: 'the prompt of the designer fork that v starts',
    fills: ['TMPDIR'],
  },
  artifact: {
    about: "publish a card as a private claude.ai artifact: its chart or table, title, one sentence and the files it cites",
    terminal: 'cards/head.ts',
    use: 'the prompt of the fork that p on a card starts',
    fills: ['TITLE', 'FILE', 'COPY'],
  },
  labels: {
    about: "the classifier that reads a --prompt label's records",
    terminal: 'labels/labels.ts',
    use: 'one model call per batch of up to 50 records',
    fills: ['NAME', 'DEFINITION', 'VALUES', 'REASON_FIELD', 'RECORDS'],
  },
  'labels-off': {
    about: "Labels is off in thimble's settings: thimble made no label, and the command or call that asked for one changed nothing",
    terminal: 'hooks/path.ts',
    browser: 'browser/backend/app/labels_off.py',
    use: "the answer of Claude's `thimble label` while Labels is off, which the plugin gives the session's commands (engine/kernel/cli.py prints it), and in the browser workbench of a label tool's call while the workspace's Settings turn Labels off (browser/backend/app/tools.py)",
  },
  observer: {
    about: "the observer's frame: the shared principles of the look after each answer, with the enabled lenses' sections",
    terminal: 'observer/observer.ts',
    browser: 'browser/backend/app/look_of.mjs',
    use: "the first part of the prompt of one fork of main's conversation after each answer",
    fills: ['LENSES', 'SKELETON'],
  },
  'observer-turn': {
    about: 'what follows the frame: the messages to read, the cards and what the session read, what thimble already gave',
    terminal: 'observer/observer.ts',
    browser: 'browser/backend/app/look_of.mjs',
    use: "the second part of the look's prompt",
    fills: ['MESSAGES', 'ROW', 'SHOWN', 'OBJECTS', 'COVERAGE', 'SKELETON', 'DIGEST', 'RULES'],
  },
  'lens-explain': {
    about: 'explainers on the terms of an answer that would stop the reader',
    terminal: 'observer/observer.ts',
    browser: 'browser/backend/app/look_of.mjs',
    use: "a section of the look's prompt while Explainers is on",
    fills: ['GLOSSED'],
  },
  'lens-heads': {
    about: 'an important detail of the answer: an orange mark that opens a heads-up card',
    terminal: 'observer/observer.ts',
    browser: 'browser/backend/app/look_of.mjs',
    use: "a section of the look's prompt while Heads-ups is on",
    fills: ['HEADS'],
  },
  'lens-claims': {
    about: "the turn's claims, each placed by a quote, in a cluster, with why it holds",
    terminal: 'observer/observer.ts',
    use: "a section of the look's prompt after each reply while Claims is auto, else of a look of its own when f in the Claims pane asks",
    fills: ['CLAIMS', 'CLUSTERS', 'GROWN'],
  },
  'explain-expand': {
    about: 'an explainer of words the analyst picked, over the conversation, the words, the answer and the files it cites',
    terminal: 'explain/expand.ts',
    use: 'one fork of the conversation when the person asks what words of an answer mean (e on selected words, a press on cited words in a pane)',
  },
  'heads-expand': {
    about: 'a heads-up on words the analyst picked, the detail to know before relying on them, over the conversation, the words, the answer and the files it cites',
    terminal: 'explain/expand.ts',
    use: 'one fork of the conversation when the person asks for a heads-up on words of an answer (h on selected words)',
  },
  squeeze: {
    about: 'an answer rewritten at the levels the person picked on its chips, or a catch-up of the replies they missed',
    terminal: 'squeeze/term.ts',
    use: 'one model call per change of the chips',
  },
  thread: {
    about: "a side thread's instructions",
    terminal: 'threads/thread.ts',
    use: "the prompt of the fork that answers a side thread's question",
  },
  'fix-request': {
    about: "name the fix the person's words change, with the fix-thimble skill, or ask one short question first",
    terminal: 'fix/register.ts',
    use: "beside the person's words after /thimble-fix <words>, which a prompt of thimble's gives Claude as theirs",
    fills: ['WORDS'],
  },
  fixer: {
    about: 'make the change the person asked for to their thimble, in a scratch copy, test it, and say what it does',
    terminal: 'fix/fixer.ts',
    browser: 'browser/backend/app/fixes.py',
    use: 'the start of the first message of the fork that /thimble-fix starts, the fixer',
  },
  'fix-draft': {
    about: "a public GitHub issue's title, what was wrong and how it was fixed, for one of the person's fixes, before the privacy scan",
    browser: 'browser/backend/app/fix_share.py',
    use: 'one model call per fix the person shares from the browser',
  },
  reapply: {
    about: 'bring back the fixes thimble update set aside, each one the new release still needs, once',
    terminal: 'engine/kernel/fixes.py',
    use: 'the first message of the Claude Code session that thimble reapply opens in live',
    fills: ['LIVE', 'FROM', 'TO', 'FROM_REF', 'TO_REF', 'N_FIXES', 'THEY_ARE', 'THEM', 'FIXES'],
  },
}

/** A text's file, as a path from the plugin's root. */
export const fileOf = name => `prompts/${name}.md`

/** The file of each slot's value in each mode, {NAME: {terminal, browser}}, as a path from the plugin's root. */
export const SLOTS_FILE = 'prompts/slots.json'

/** The modes, by the name of each in slots.json. */
export const MODES = ['terminal', 'browser']

/** Fill {{NAME}} placeholders from `vals` (a function value is called); unknown ones stay as written. */
export function fill(text, vals) {
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => (k in vals ? String(typeof vals[k] === 'function' ? vals[k]() : vals[k] ?? '') : all))
}

const INCLUDE = /\{\{include:([a-z0-9-]+)\}\}/g
const SLOT = /\{\{([A-Z_]+)\}\}/g

/**
 * Text `name` as `mode` reads it, before its reader fills its slots: its file with each `{{include:NAME}}` replaced by
 * text NAME, without its closing newline, and each slot that its readers do not fill (`fills`) filled with the mode's
 * value from slots.json. `read(name)` gives a text's file and `slots()` the values of slots.json, which it asks for only
 * when the text has such a slot. Throws for an include cycle, and for such a slot with no value in the mode.
 */
export async function compose(name, mode, read, slots) {
  const text = await included(name, read, [])
  const fills = new Set(TEXTS[name]?.fills ?? [])
  const own = [...new Set(Array.from(text.matchAll(SLOT), m => m[1]))].filter(k => !fills.has(k))
  if (!own.length) return text
  const values = await slots()
  const vals = {}
  for (const k of own) {
    if (typeof values?.[k]?.[mode] !== 'string') throw new Error(`${fileOf(name)}: the slot {{${k}}} has no ${mode} value in ${SLOTS_FILE}`)
    vals[k] = values[k][mode]
  }
  return fill(text, vals)
}

/** Text `name`'s file with each text it includes in place. */
async function included(name, read, stack) {
  if (stack.includes(name)) throw new Error(`${fileOf(stack.at(-1))}: the include cycle ${[...stack, name].join(' -> ')}`)
  const text = String(await read(name))
  let out = ''
  let last = 0
  for (const m of text.matchAll(INCLUDE)) {
    out += text.slice(last, m.index) + (await included(m[1], read, [...stack, name])).replace(/\n+$/, '')
    last = m.index + m[0].length
  }
  return out + text.slice(last)
}

/** The registry in lines, for `thimble dev prompts`: each text, its file, what reads it in each mode, and what it is. */
export function listing() {
  const rows = Object.entries(TEXTS).map(([name, t]) => [name, fileOf(name), t.terminal ?? '-', t.browser ?? '-', `${t.use}: ${t.about}`])
  const w = [0, 1, 2, 3].map(i => Math.max(...rows.map(r => r[i].length)))
  return rows.map(r => r.map((c, i) => (i < 4 ? c.padEnd(w[i]) : c)).join('  '))
}
