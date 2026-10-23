// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Citations, Cards), never by the part of thimble that makes
// it. Each is a field of the plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default),
// so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again with the
// new value. register(on, options) hands the values in (setOptions); every module asks featureOn(key) when it acts.
//
// thimble's color is one more field of the same userConfig (COLOR, a string): the name of one of COLORS. Claude Code
// keeps it as it keeps the switches; core/theme.ts accent() asks colorNow() each time thimble draws.

/** The features, in the order the settings pane lists them. `key`: the userConfig field; `title`: its name; `does`:
 *  one line on what the person gets and what it costs, the field's description (a test checks). `lenses`: the lenses of
 *  the observer's look it needs (observer/lenses.mjs): the look runs while one such feature is on. */
export const SWITCHES = [
  {
    key: 'marks', title: 'Citations', default: true,
    does: 'Claude adds a citation to each claim you would check, and a second Claude checks each one after the reply.',
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
    key: 'details', title: 'Important details', default: true, lenses: ['heads'],
    does: 'Marks the details of an answer that are easy to miss and change what it means. A small part of the call after each reply.',
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

/** thimble's colors, in the order the settings pane shows them: `name`, the value Claude Code keeps; `key`, the
 *  Claude Code theme key it draws in, which Claude Code resolves to a shade that reads in the person's theme (light,
 *  dark, ANSI). Purple, the first, is Claude Code's color for a merged pull request, and thimble's by default. */
export const COLORS = [
  { name: 'purple', key: 'merged' },
  { name: 'blue', key: 'ide' },
  { name: 'teal', key: 'planMode' },
  { name: 'green', key: 'success' },
  { name: 'orange', key: 'claude' },
  { name: 'yellow', key: 'warning' },
]

/** thimble's color as a userConfig field (.claude-plugin/plugin.json, with the same key, title and default). */
export const COLOR = {
  key: 'color', title: 'Color', default: 'purple',
  does: `thimble's color, on its name in the bar and the keys it names: ${COLORS.map(c => c.name).join(', ')}.`,
}

const BY_KEY = new Map(SWITCHES.map(s => [s.key, s]))
const COLOR_BY_NAME = new Map(COLORS.map(c => [c.name, c]))

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
  if (key === COLOR.key && COLOR_BY_NAME.has(value)) current = { ...current, [key]: value }
}

/** A color by its name, or null. */
export const colorOf = name => COLOR_BY_NAME.get(name) ?? null

/** The color's name as `values` holds it: one of COLORS, else the default. */
export function colorFrom(values) {
  const v = values ? values[COLOR.key] : undefined
  return colorOf(v) ? v : COLOR.default
}

/** The color's name now, from the plugin's options and a change made a moment ago. */
export const colorNow = () => colorFrom(current)

/** Whether a feature acts now: its option when it is a boolean, else its default. `observer` is whether the look after
 *  each reply runs: while a feature one of whose lenses it serves is on. */
export function featureOn(key) {
  if (key === 'observer') return SWITCHES.some(s => (s.lenses ?? []).length > 0 && switchesFrom(current)(s.key))
  return switchesFrom(current)(key)
}

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null
