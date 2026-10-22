// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Marks, Cards), never by the part of thimble that makes
// it. Each is a field of the plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default),
// so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again with the
// new value. register(on, options) hands the values in (setOptions); every module asks featureOn(key) when it acts.

/** The features, in the order the settings pane lists them. `key`: the userConfig field; `title`: its name; `does`:
 *  one line on what the person gets, the field's description (a test checks). */
export const SWITCHES = [
  {
    key: 'marks', title: 'Marks', default: true,
    does: 'Claude marks the claims you would check, and a second Claude checks each one after the reply.',
  },
  {
    key: 'cards', title: 'Cards', default: true,
    does: 'Claude draws interactive cards, and v draws one of the last answer.',
  },
  {
    key: 'counts', title: 'Labels and coverage on the bar', default: true,
    does: 'The bar shows how much of the data Claude has seen and how many labels there are. No model call: thimble counts the files after each turn.',
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

/** The feature's own value: the option when it is a boolean, else the default. */
export function ownValue(key) {
  return switchesFrom(current)(key)
}

/** Whether a feature acts now. */
export function featureOn(key) {
  return switchesFrom(current)(key)
}

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null
