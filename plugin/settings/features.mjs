// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings panel
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Cards, Claims), never by the part of thimble that makes
// it. Each is a field of the plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default),
// so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again with the
// new value. The settings panel (settings/term.ts, panes/settings.js) lists the same features and changes them
// through Claude Code ($.config.set). register(on, options) hands the values in (setOptions); every module asks
// featureOn(key) when it acts.
//
// The observer is no switch. It is the one model call after each reply that serves the features that read answers
// (the ones with `lenses`), so it runs while one of them is on, and each of its lenses is asked while its feature is.
// A lens no feature names (a new one) is asked whenever the observer runs.

/** The features, in the order the settings panel lists them. `key`: the userConfig field; `title`: its name in the
 *  panel; `label`: its name in Claude Code's own lists, when it differs; `does`: one line on what the person gets;
 *  `costs`: what it costs, in words; `lenses`: the observer's lenses it needs; `bar`: what it puts on the bar;
 *  `group`: a heading over it in the panel (only the experimental ones have one); `surfaces`: the surfaces that honor
 *  it. The manifest's field has the label (else the title) as its title, and `does` and `costs` as its description
 *  (a test checks). */
export const SWITCHES = [
  {
    key: 'cards', title: 'Cards', default: true, lenses: ['actions'], bar: ['v'], surfaces: ['terminal'],
    does: 'v makes a chart or a table of an answer, and lights up when one would show more.',
    costs: 'A small part of the call after each reply; then one card each time you ask.',
  },
  {
    key: 'squeeze', title: 'Squeeze and catch-up', default: true, lenses: ['squeeze'], bar: ['s'], surfaces: ['terminal'],
    does: 's makes an answer shorter or longer, and catches you up on replies you missed.',
    costs: 'A few words of the call after each reply; then one rewrite each time you ask.',
  },
  {
    key: 'explain', title: 'Explainers', default: true, lenses: ['explain'], surfaces: ['terminal'],
    does: 'Marks the terms you may not know; ] opens what each one means here.',
    costs: 'A small part of the call after each reply.',
  },
  {
    key: 'details', title: 'Important details', default: true, lenses: ['heads'], surfaces: ['terminal'],
    does: 'Marks the details of an answer that are easy to miss and change what it means.',
    costs: 'A small part of the call after each reply.',
  },
  {
    key: 'claims', title: 'Claims', default: true, lenses: ['claims'], bar: ['c'], surfaces: ['terminal'],
    does: 'c opens what Claude and you claimed in the session, with sources; the bar counts them.',
    costs: 'The largest part of the call after each reply.',
  },
  {
    key: 'counts', title: 'Labels and coverage on the bar', default: true, lenses: [], bar: ['cov', 'labels'], surfaces: ['terminal'],
    does: 'The bar shows how much of the data Claude read (r) and how many labels there are (l).',
    costs: 'No model call: thimble counts the files after each turn.',
  },
  {
    key: 'notes', title: 'Notes to Claude', label: 'Notes to Claude (experimental)', group: 'Experimental', default: false, lenses: ['notes'], surfaces: ['terminal'],
    does: 'Claude gets up to two notes on its last answer with your next prompt. You do not see them.',
    costs: 'A small part of the call after each reply.',
  },
]

/** Switches an earlier build had, by the feature that holds them now: a person would never turn them on or off
 *  apart (v proposals without v, catch-up without squeeze, one of the bar's two counts). featureOn answers them as
 *  that feature. */
export const MERGED = { visualize: 'cards', catchup: 'squeeze', coverage: 'counts', labels: 'counts' }

const BY_KEY = new Map(SWITCHES.map(s => [s.key, s]))

let current = {}

/** The plugin's options, as register(on, options) received them. */
export function setOptions(options) {
  current = options && typeof options === 'object' ? { ...options } : {}
}

/** The features as `values` holds them (a field missing, or not a boolean: its default), as a function of a key:
 *  a feature's own key, a merged switch's (MERGED), or `observer` (whether the call after each reply runs). The
 *  settings panel's preview asks it with the values Claude Code holds now; featureOn is it with the plugin's options. */
export function switchesFrom(values) {
  const own = key => {
    const s = BY_KEY.get(key)
    const v = values ? values[key] : undefined
    return typeof v === 'boolean' ? v : s ? s.default : true
  }
  return key => {
    if (key === 'observer') return SWITCHES.some(s => s.lenses.length > 0 && own(s.key))
    return own(MERGED[key] ?? key)
  }
}

/** A change the settings panel just made through Claude Code: this activation acts on it at once (the bar loses v as
 *  the person watches), while Claude Code loads the plugin again with the same value. */
export function noteChange(key, value) {
  if (BY_KEY.has(key) && typeof value === 'boolean') current = { ...current, [key]: value }
}

/** The feature's own value: the option when it is a boolean, else the default. */
export function ownValue(key) {
  const s = BY_KEY.get(key)
  const v = current[key]
  return typeof v === 'boolean' ? v : s ? s.default : true
}

/** Whether a feature acts now. `observer` is whether the call after each reply runs: while a feature that needs it
 *  is on. */
export function featureOn(key) {
  return switchesFrom(current)(key)
}

/** Whether the observer runs: one of the features that read answers is on. */
export const observerOn = () => featureOn('observer')

/** The feature of a lens: the one its module names (`option`), else the one whose `lenses` hold its name. */
export function switchOfLens(lens) {
  if (!lens) return null
  if (typeof lens.option === 'string' && BY_KEY.has(lens.option)) return BY_KEY.get(lens.option)
  return SWITCHES.find(s => s.lenses.includes(lens.name)) ?? null
}

/** Whether a lens is asked: its feature is on (a lens no feature names: whenever the observer runs). */
export function lensOn(lens) {
  if (!observerOn()) return false
  const s = switchOfLens(lens)
  return s ? featureOn(s.key) : true
}

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null
