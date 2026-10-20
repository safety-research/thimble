// features.mjs: the switches that turn thimble's features on and off. Pure: no `$`, no Node. The hooks module, the
// settings pane and the tests import it.
//
// Each switch is a field of the plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default),
// so Claude Code lists it in /config and /plugin, stores it in settings.json (pluginConfigs.thimble.options) and loads
// the plugin again with the new value. The settings panel (settings/term.ts, panes/settings.js) lists the same
// switches and changes them through Claude Code ($.config.set), so a change lands where the package's setting is
// kept. register(on, options) hands the values in (setOptions); every module asks featureOn(key) when it acts.
//
// A lens of the observer (observer/lenses/) is on when its switch is: the switch whose `lens` names it, or the one its
// module names with `option`. A lens no switch names is on while the observer is.

/** The switches, in the order the settings panel lists them. `key`: the userConfig field; `title`: its name in the
 *  panel; `label`: its name in /config, where no group heads it; `group`: the panel's heading over it; `lens`: the
 *  observer lens it turns on and off; `under`: the switch it needs (a lens needs the observer); `surfaces`: the surfaces
 *  that honor it (the terminal's panel and bar; another surface adds its name where it reads the same switch). The
 *  manifest's field has the label as its title and `does` and `costs` as its description (a test checks). */
export const SWITCHES = [
  {
    key: 'observer', title: 'Observer', label: 'Observer', group: 'Observer', default: true, surfaces: ['terminal'],
    does: "After each of Claude's messages, a side agent reads it with the whole session and gives the parts that are on.",
    costs: 'One call per message, over the session Claude already has cached.',
  },
  {
    key: 'notes', title: 'Notes to Claude', label: 'Observer: notes to Claude', lens: 'notes', under: 'observer', group: 'Observer', default: true, surfaces: ['terminal'],
    does: 'Up to two notes Claude reads with your next prompt, such as a number that counts the wrong months. You do not see them.',
    costs: 'A small part of each look.',
  },
  {
    key: 'visualize', title: 'v proposals', label: 'Observer: v proposals', lens: 'actions', under: 'observer', group: 'Observer', default: true, surfaces: ['terminal'],
    does: 'Lights v with a named view when a view would show what the answer only tells.',
    costs: 'A small part of each look.',
  },
  {
    key: 'explain', title: 'Explainers', label: 'Observer: explainers', lens: 'explain', under: 'observer', group: 'Observer', default: true, surfaces: ['terminal'],
    does: 'Marks the terms of an answer you may not know; ] opens what each one means here.',
    costs: 'A small part of each look.',
  },
  {
    key: 'details', title: 'Important details', label: 'Observer: important details', lens: 'details', under: 'observer', group: 'Observer', default: true, surfaces: ['terminal'],
    does: 'Marks the details of an answer that are easy to miss and change what it means.',
    costs: 'A small part of each look.',
  },
  {
    key: 'squeeze', title: 'Squeeze levels', label: 'Observer: squeeze levels', lens: 'squeeze', under: 'observer', group: 'Observer', default: true, surfaces: ['terminal'],
    does: "Says where each answer stands on squeeze's chips, so your first change with s starts from the right level.",
    costs: 'A few words of each look.',
  },
  {
    key: 'claims', title: 'Claims', label: 'Observer: claims', lens: 'claims', under: 'observer', group: 'Observer', default: true, surfaces: ['terminal'],
    does: "Keeps the session's claims in the Claims pane, with c and the claims count on the bar.",
    costs: 'The largest part of each look.',
  },
  {
    key: 'catchup', title: 'Catch-up', label: 'Catch-up', group: 'The bar', default: true, surfaces: ['terminal'],
    does: 'When two or more replies came since your last prompt, s offers to catch up on all of them in one.',
    costs: 'Nothing until you press s: then one rewrite of the replies.',
  },
  {
    key: 'coverage', title: 'Coverage count', label: 'Coverage count on the bar', group: 'The bar', default: true, surfaces: ['terminal'],
    does: 'Shows on the bar how much of the data Claude read (seen 12%); r opens Coverage.',
    costs: 'No model call: thimble counts the files after each turn.',
  },
  {
    key: 'labels', title: 'Labels count', label: 'Labels count on the bar', group: 'The bar', default: true, surfaces: ['terminal'],
    does: 'Shows on the bar how many labels the folder has; l opens them.',
    costs: 'No model call.',
  },
]

const BY_KEY = new Map(SWITCHES.map(s => [s.key, s]))

let current = {}

/** The plugin's options, as register(on, options) received them. */
export function setOptions(options) {
  current = options && typeof options === 'object' ? { ...options } : {}
}

/** The switch's own value: the option when it is a boolean, else the default. */
export function ownValue(key) {
  const s = BY_KEY.get(key)
  const v = current[key]
  return typeof v === 'boolean' ? v : s ? s.default : true
}

/** Whether a feature acts now: its switch is on, and so is the switch it needs. */
export function featureOn(key) {
  const s = BY_KEY.get(key)
  if (!ownValue(key)) return false
  return s && s.under ? featureOn(s.under) : true
}

/** The switch of a lens: the one its module names (`option`), else the one whose `lens` is its name. */
export function switchOfLens(lens) {
  if (!lens) return null
  if (typeof lens.option === 'string' && BY_KEY.has(lens.option)) return BY_KEY.get(lens.option)
  return SWITCHES.find(s => s.lens && s.lens === lens.name) ?? null
}

/** Whether a lens is asked: the observer is on, and so is the lens's switch (a lens no switch names is on). */
export function lensOn(lens) {
  if (!featureOn('observer')) return false
  const s = switchOfLens(lens)
  return s ? featureOn(s.key) : true
}

/** A switch by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null
