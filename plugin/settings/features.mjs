// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Citations, Cards), never by the part of thimble that makes
// it. Each is a field of the plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default),
// so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again with the
// new value. register(on, options) hands the values in (setOptions); every module asks featureOn(key) when it acts.

/** The features, in the order the settings pane lists them. `key`: the userConfig field; `title`: its name; `group`:
 *  the heading the pane lists it under, with the others of its group (Comments: the explainers and heads-ups on an
 *  answer's words; a key keeps its name, so a saved setting still applies); `does`:
 *  one line on what the person gets and what it costs, the field's description (a test checks). `lenses`: the lenses of
 *  the observer's look it needs (observer/lenses.mjs): the look runs while one such feature is on. */
export const SWITCHES = [
  {
    key: 'marks', title: 'Citations', default: true,
    does: 'Claude adds a citation to each claim you would check, and a second Claude checks each one after the reply.',
  },
  {
    key: 'checkOnOpen', title: 'Check citations only when I open one', default: false,
    does: 'Off: a second Claude checks every citation after each reply. On: it checks a citation when you open it, which spends fewer tokens.',
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

/** The features as `values` holds them (a field missing, or not a boolean: its default), as a function of a key. The
 *  settings pane asks it with the values Claude Code holds now; featureOn is it with the plugin's options. */
export function switchesFrom(values) {
  return key => {
    const s = BY_KEY.get(key)
    const v = values ? values[key] : undefined
    return typeof v === 'boolean' ? v : s ? s.default : true
  }
}

/** A change the settings pane just made through Claude Code: this activation acts on it at once, while Claude Code
 *  loads the plugin again with the same value. */
export function noteChange(key, value) {
  if (BY_KEY.has(key) && typeof value === 'boolean') current = { ...current, [key]: value }
}

/** Whether a feature acts now: its option when it is a boolean, else its default. `observer` is whether the look after
 *  each reply runs: while a feature one of whose lenses it serves is on. */
export function featureOn(key) {
  if (key === 'observer') return SWITCHES.some(s => (s.lenses ?? []).length > 0 && switchesFrom(current)(s.key))
  return switchesFrom(current)(key)
}

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null
