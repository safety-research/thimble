// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Citations, Cards), never by the part of thimble that makes
// it; a feature with `choices` is one of a few modes (Citation checks: auto, on demand, off). Each is a field of the
// plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default: a boolean, or a string with its
// `options`), so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again
// with the new value. register(on, options) hands the values in (setOptions); every module asks featureOn(key), or
// choiceOf(key) for a mode, when it acts.

/** The features, in the order the settings pane lists them. `key`: the userConfig field; `title`: its name; `does`:
 *  one line on what the person gets and what it costs, the field's description (a test checks). `choices`: the modes of
 *  a feature that has more than on and off, its default one of them. `lenses`: the lenses of the observer's look it
 *  needs (observer/lenses.mjs): the look runs while one such feature is on. */
export const SWITCHES = [
  {
    key: 'marks', title: 'Citations', default: true,
    does: 'Claude adds a citation to each claim you would check, and a second Claude checks it against the files, as Citation checks says.',
  },
  {
    key: 'citationChecks', title: 'Citation checks', default: 'on demand', choices: ['auto', 'on demand', 'off'],
    does: 'auto: a second Claude checks every citation after each reply. on demand: it checks a citation when you open it, which spends fewer tokens. off: no checks.',
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
    key: 'explain', title: 'Explainers', default: true, lenses: ['explain'],
    does: 'Marks the terms you may not know; ] opens what each one means here. A small part of the call after each reply.',
  },
  {
    key: 'details', title: 'Heads-ups', default: true, lenses: ['heads'],
    does: 'Marks a detail of an answer that is easy to miss and changes what it means; ] opens its heads-up. A small part of the call after each reply.',
  },
  {
    key: 'claims', title: 'Claims', default: true, lenses: ['claims'],
    does: 'c opens what Claude and you claimed in the session, with sources; the bar counts them. The largest part of the call after each reply.',
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
  if (s?.choices) return s.choices.includes(v) ? v : s.default
  return typeof v === 'boolean' ? v : s ? s.default : true
}

/** The features as `values` holds them, as a function of a key: whether each is on (a feature with modes is on unless
 *  its mode is `off`). The settings pane asks it with the values Claude Code holds now; featureOn is it with the plugin's
 *  options. */
export function switchesFrom(values) {
  return key => {
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
  if (s && (s.choices ? s.choices.includes(value) : typeof value === 'boolean')) current = { ...current, [key]: value }
}

/** Whether thimble is off in this session (/thimble-off, settings/term.ts): every feature is then off, whatever its
 *  switch says, and the switches stay as they are. */
let sessionOff = false

export function setSessionOff(off) {
  sessionOff = !!off
}

/** Whether a feature acts now: its option when it is a boolean, else its default; none while thimble is off in this
 *  session. `observer` is whether the look after each reply runs: while a feature one of whose lenses it serves is on.
 *  `thimble` is whether thimble acts at all in this session (its guidance, the bar, the side pane). */
export function featureOn(key) {
  if (sessionOff) return false
  if (key === 'thimble') return true
  if (key === 'observer') return SWITCHES.some(s => (s.lenses ?? []).length > 0 && switchesFrom(current)(s.key))
  return switchesFrom(current)(key)
}

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null
