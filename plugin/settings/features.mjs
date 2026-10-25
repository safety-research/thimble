// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Citations, Cards), never by the part of thimble that makes
// it; a feature with `choices` is one of a few modes (Citations: auto cite + check, auto cite, manual, off). Each is a field of the
// plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default: a boolean, or a string with its
// `options`), so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again
// with the new value. register(on, options) hands the values in (setOptions); every module asks featureOn(key), or
// choiceOf(key) for a mode, when it acts.

/** The features, in the order the settings pane lists them. `key`: the userConfig field; `title`: its name; `group`:
 *  the heading the pane lists it under, with the others of its group (Comments: the explainers and heads-ups on an
 *  answer's words; a key keeps its name, so a saved setting still applies); `does`: one line on what the person gets
 *  and what it costs, the field's description (a test checks). `choices`: the modes of a feature that has more than on
 *  and off, its default one of them. `lenses`: the lenses of the observer's look it needs (observer/lenses.mjs): the
 *  look runs while one such feature is on. `modeOf`: the feature whose lenses join the look after each reply only in
 *  this one's `auto` mode (in `on demand`, a look of their own runs when the person asks). `says`: for a feature with
 *  modes, what each mode gives, which the settings pane shows under the row for the mode set. */
export const SWITCHES = [
  {
    key: 'citations', title: 'Citations', default: 'auto cite', choices: ['auto cite + check', 'auto cite', 'manual', 'off'],
    does: 'auto cite + check: Claude cites each claim you would check, and a second Claude checks every citation after each reply. auto cite: Claude cites, and a citation is checked when you open it, which spends fewer tokens. manual: select words in an answer and press w to find where they come from. off: no citations.',
    says: {
      'auto cite + check': 'Claude cites each claim you would check, and a second Claude checks every citation after each reply.',
      'auto cite': 'Claude cites each claim you would check, and a second Claude checks a citation when you open it, which spends fewer tokens.',
      'manual': 'Claude cites nothing. Select words in an answer and press w: a second Claude finds where they come from in the files.',
      'off': 'No citations, and no checks.',
    },
  },
  {
    key: 'cards', title: 'Cards', default: true,
    does: 'Claude draws interactive cards, and v draws one of the last answer.',
  },
  {
    key: 'squeeze', title: 'Squeeze and catch-up', default: true,
    does: 's makes an answer shorter or longer, and catches you up on replies you missed. One rewrite each time you ask.',
  },
  {
    key: 'explain', title: 'Explainers', group: 'Comments', default: true, lenses: ['explain'],
    does: 'Marks the terms you may not know; ] opens what each one means here. A small part of the call after each reply.',
  },
  {
    key: 'details', title: 'Heads-ups', group: 'Comments', default: true, lenses: ['heads'],
    does: 'Marks a detail of an answer that is easy to miss and changes what it means; ] opens its heads-up. A small part of the call after each reply.',
  },
  {
    key: 'claims', title: 'Claims', default: true, lenses: ['claims'],
    does: 'c opens what Claude and you claimed in the session, with why each holds and its sources; the bar counts them. Extract claims says when they are extracted.',
  },
  {
    key: 'claimsMode', title: 'Extract claims', default: 'on demand', choices: ['auto', 'on demand'], modeOf: 'claims',
    does: 'auto: the claims are extracted after each reply, the largest part of the call after it. on demand: when you press f in the Claims pane, which spends fewer tokens.',
    says: {
      'auto': 'The claims are extracted after each reply, the largest part of the call after it.',
      'on demand': 'The claims are extracted when you press f in the Claims pane, which spends fewer tokens.',
    },
  },
  {
    key: 'counts', title: 'Labels and coverage on the bar', default: true,
    does: 'The bar shows how much of the data Claude has seen and how many labels there are. No model call: thimble counts the files after each turn.',
  },
  {
    key: 'squeezeCards', title: 'Squeeze changes cards (experimental)', default: true,
    does: 'When s makes an answer much shorter or longer, or writes it for another reader, it may edit, add or leave out a card with the text. 0 brings the cards back as they were. Each rewrite also reads the cards.',
  },
]

const BY_KEY = new Map(SWITCHES.map(s => [s.key, s]))

/** The manifest's fields that Citations replaced, kept so a value saved under them still reaches the plugin: Citations
 *  (`marks`, on or off) and Citation checks (`citationChecks`). Settings hides them (term.ts), and the first session
 *  moves a saved one to Citations (citationsFrom), then sets it back to its default. */
export const RETIRED = {
  marks: { type: 'boolean', title: 'Citations (old setting)', description: 'Replaced by Citations, which has its modes.', default: true },
  citationChecks: { type: 'string', title: 'Citation checks (old setting)', description: 'Replaced by Citations, which has its modes.', options: ['auto', 'on demand', 'off'], default: 'on demand' },
}

/** The Citations mode that the retired fields saved in `values` stand for, or null when they hold their defaults:
 *  citations off is `off`; checks after each reply are `auto cite + check`; checks off is `auto cite`, since every mode
 *  that cites checks a citation once it is opened. */
export function citationsFrom(values) {
  if (!values || typeof values !== 'object') return null
  if (values.marks === false) return 'off'
  if (values.citationChecks === 'auto') return 'auto cite + check'
  if (values.citationChecks === 'off') return 'auto cite'
  return null
}

let current = {}

/** The plugin's options, as register(on, options) received them. */
export function setOptions(options) {
  current = options && typeof options === 'object' ? { ...options } : {}
}

/** A feature's value as `values` holds it: a boolean, or for a feature with modes one of its choices; a field missing,
 *  or not of its kind, has its default. */
function valueIn(values, key) {
  const s = BY_KEY.get(key)
  const v = values ? values[key] : undefined
  // a Citations at its default, while a retired field still holds a value saved before it, stands for that value
  if (key === 'citations' && (v === undefined || v === s?.default)) return citationsFrom(values) ?? s.default
  if (s?.choices) return s.choices.includes(v) ? v : s.default
  return typeof v === 'boolean' ? v : s ? s.default : true
}

/** The features as `values` holds them, as a function of a key: whether each is on (a feature with modes is on unless
 *  its mode is `off`). The settings pane asks it with the values Claude Code holds now; featureOn is it with the plugin's
 *  options. */
export function switchesFrom(values) {
  return key => {
    // w, where words come from, is Citations' manual mode
    if (key === 'where') return valueIn(values, 'citations') === 'manual'
    const v = valueIn(values, key)
    return typeof v === 'string' ? v !== 'off' : v
  }
}

/** A feature's mode, for a feature with `choices` (`on demand`); its value as a boolean for any other. */
export function choiceOf(key) {
  return valueIn(current, key)
}

/** A change the settings pane just made through Claude Code: this activation acts on it at once, while Claude Code
 *  loads the plugin again with the same value. */
export function noteChange(key, value) {
  const s = BY_KEY.get(key)
  if (!s || !(s.choices ? s.choices.includes(value) : typeof value === 'boolean')) return
  current = { ...current, [key]: value }
  // a Citations the person sets stands over a value the retired fields saved (term.ts sets those back too)
  if (key === 'citations') current = { ...current, marks: RETIRED.marks.default, citationChecks: RETIRED.citationChecks.default }
}

/** Whether a feature acts now: its option when it is a boolean, else its default. `observer` is whether the look after
 *  each reply runs: while a feature one of whose lenses it serves is on, and in its mode's `auto` when it has one. */
export function featureOn(key) {
  if (key === 'observer') return SWITCHES.some(s => (s.lenses ?? []).length > 0 && lensesAfterReply(s.key))
  return switchesFrom(current)(key)
}

/** Whether a feature's lenses join the look after each reply: it is on, and a feature that sets when it acts
 *  (`modeOf` it) is in its `auto` mode. */
export function lensesAfterReply(key) {
  return switchesFrom(current)(key) && SWITCHES.every(m => m.modeOf !== key || valueIn(current, m.key) === 'auto')
}

/** The retired fields' values this load runs with (RETIRED). */
export const retiredValues = () => Object.fromEntries(Object.keys(RETIRED).map(k => [k, current[k]]))

/** Whether Claude cites its claims (Citations auto cite + check, or auto cite): main reads the citing guidance, and
 *  the reply's citations are checked, after it or once opened. */
export const claudeCites = () => ['auto cite + check', 'auto cite'].includes(choiceOf('citations'))

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null
