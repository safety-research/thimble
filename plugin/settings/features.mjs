// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Citations, Cards), never by the part of thimble that makes
// it; a feature with `choices` is one of a few modes (Citations: auto cite + verify, auto cite, manual, off). Each is a field of the
// plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default: a boolean, or a string with its
// `options`), so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again
// with the new value. register(on, options) hands the values in (setOptions); every module asks featureOn(key), or
// choiceOf(key) for a mode, when it acts.

import { ALIASES, EFFORTS, modelById, modelNamed, modelOf, shownName } from '../core/models.js'

/** What Minimal does, as the settings pane says it under its row. */
const MINIMAL_SAYS = 'No background tokens. Cards are enabled, while explainers, citations, heads-up, and claims only appear when you request them.'

/** Words in a list: `a, b or c`. */
const listed = (ws) => (ws.length > 1 ? `${ws.slice(0, -1).join(', ')} or ${ws.at(-1)}` : ws.join(''))
/** The models Checker names, each as Claude Code shows it, with its version (`Haiku 5.5`): the words the settings pane
 *  and /config show, and the value Claude Code saves. */
const CHECKER_MODELS = ALIASES.map(shownName)

/** The features, in the order the settings pane lists them. `key`: the userConfig field; `title`: its name; `group`:
 *  the heading the pane lists it under, with the others of its group (Answers, Comments on an answer's words, Panes;
 *  a key keeps its name, so a saved setting still applies); Minimal, first, has none: it stands over the others; `does`: one line on what the person gets
 *  and what it costs, the field's description (a test checks). `choices`: the modes of a feature that has more than on
 *  and off, its default one of them. `lenses`: the lenses of the observer's look it needs (observer/lenses.mjs): the
 *  look runs while one such feature is on. `lensesIn`: the mode in which they join the look after each reply (Claims:
 *  `auto`; in `on demand`, a look of their own runs when the person asks). `says`: what each mode
 *  gives (`on` and `off` for a switch), which the settings pane shows under the row for the one set. `under`: the
 *  feature whose work this setting changes (Checker and its Effort: the checks of Citations); the settings pane shows
 *  its row only while that feature is on. `firstParty`: the setting names models by the ids of Anthropic's first-party
 *  API (core/models.js), which Bedrock, Vertex and Foundry do not take, or the effort of the checker Checker names:
 *  where Claude Code runs on one of them (settings/term.ts firstPartyApi), neither the pane nor /config shows its row,
 *  and what it holds does nothing. */
export const SWITCHES = [
  {
    key: 'minimal', title: 'Minimal', default: false,
    does: MINIMAL_SAYS,
    says: { on: MINIMAL_SAYS, off: MINIMAL_SAYS },
  },
  {
    key: 'citations', title: 'Citations', group: 'Answers', default: 'auto cite + verify', choices: ['auto cite + verify', 'auto cite', 'manual', 'off'],
    does: 'auto cite + verify: Claude cites what each answer rests on, and a second Claude verifies each citation after each answer. auto cite: Claude cites, and a citation is verified when you open it, which spends fewer tokens. manual: select words and press c to cite them. off: no citations.',
    says: {
      'auto cite + verify': 'Claude cites what each answer rests on, and a second Claude verifies each citation.',
      'auto cite': 'Claude cites what each answer rests on; a citation is verified when you open it.',
      'manual': 'Select words and press c to cite them.',
      'off': 'No citations.',
    },
  },
  {
    key: 'checkerModel', title: 'Checker', group: 'Answers', under: 'citations', firstParty: true, default: 'same as Claude', choices: ['same as Claude', ...CHECKER_MODELS],
    does: `The model of the second Claude that checks citations. same as Claude: the model of the conversation. ${listed(CHECKER_MODELS)}: that model, which reads the conversation without the cache of the conversation's model.`,
    says: {
      'same as Claude': 'The second Claude checks citations on the model of the conversation.',
      ...Object.fromEntries(CHECKER_MODELS.map(m => [m, `The second Claude checks citations on ${m}.`])),
    },
  },
  {
    key: 'checkerEffort', title: 'Effort', group: 'Answers', under: 'citations', firstParty: true, default: 'same as Claude', choices: ['same as Claude', ...EFFORTS],
    does: `How hard the second Claude that checks citations thinks. same as Claude: the effort of the conversation. ${listed(EFFORTS)}: that effort, of the levels Claude Code offers for the model Checker names.`,
    says: {
      'same as Claude': 'The second Claude checks citations at the effort of the conversation.',
      ...Object.fromEntries(EFFORTS.map(e => [e, `The second Claude checks citations at ${e} effort.`])),
    },
  },
  {
    key: 'cards', title: 'Cards', group: 'Answers', default: true,
    does: 'Claude draws charts and tables as cards in its answers. Press v to visualize the last answer.',
    says: { on: 'Claude draws charts and tables as cards in its answers. Press v to visualize the last answer.', off: 'No cards.' },
  },
  {
    key: 'squeezeAnswers', title: 'Rewrite', group: 'Answers', default: true,
    does: 'Press s to rewrite an answer shorter or longer, more novice or more expert, or in your own words. Press 0 for the original. One call each time you ask.',
    says: { on: 'Press s to rewrite an answer shorter or longer, more novice or more expert. Press 0 for the original.', off: 'No rewrites.' },
  },
  {
    key: 'catchUp', title: 'Catch-up', group: 'Answers', default: true,
    does: 'Press b to sum up the replies that came in while you were away, in one short note. Press 0 to see the replies again. One call each time you ask.',
    says: { on: 'Press b to sum up the replies that came in while you were away.', off: 'No catch-up.' },
  },
  {
    key: 'explain', title: 'Explainers', group: 'Comments', default: 'auto', choices: ['auto', 'on demand', 'off'], lenses: ['explain'], lensesIn: 'auto',
    does: 'auto: terms you may not know get a short explainer after each answer, a small part of the call after it; ] opens each one. Select words and press e for one. on demand: select words and press e for a short explainer. off: no explainers.',
    says: {
      'auto': 'Terms you may not know get a short explainer after each answer. Select words and press e for one.',
      'on demand': 'Select words and press e for a short explainer.',
      'off': 'No explainers.',
    },
  },
  {
    key: 'details', title: 'Heads-ups', group: 'Comments', default: 'auto', choices: ['auto', 'on demand', 'off'], lenses: ['heads'], lensesIn: 'auto',
    does: 'auto: details that may mislead get a heads-up after each answer, a small part of the call after it; ] opens each one. on demand: press h for heads-ups on the last answer. off: no heads-ups.',
    says: {
      'auto': 'Details that may mislead get a heads-up after each answer.',
      'on demand': 'Press h for heads-ups on the last answer.',
      'off': 'No heads-ups.',
    },
  },
  {
    key: 'claimsMode', title: 'Claims', group: 'Panes', default: 'auto', choices: ['auto', 'on demand', 'off'], lenses: ['claims'], lensesIn: 'auto',
    does: 'Press w to see the conversation\'s claims. auto: thimble pulls them out of each answer in the background, which uses tokens. on demand: only when you press f in the pane. off: no Claims pane.',
    says: {
      'auto': 'Press w to see the claims. thimble pulls them out of each answer in the background, which uses tokens.',
      'on demand': 'Press w to see the claims. thimble pulls them out only when you press f in the pane.',
      'off': 'No Claims pane.',
    },
  },
  {
    key: 'labels', title: 'Labels', group: 'Panes', default: true,
    does: 'Press l to see the labels Claude made, with their values and records. No model call.',
    says: { on: 'Press l to see the labels Claude made, with their values and records.', off: 'No Labels pane.' },
  },
  {
    key: 'coverage', title: 'Coverage', group: 'Panes', default: true,
    does: 'Press r to see which files Claude has read, by folder. No model call: thimble counts the files after each turn.',
    says: { on: 'Press r to see which files Claude has read, by folder.', off: 'No Coverage pane.' },
  },
]

const BY_KEY = new Map(SWITCHES.map(s => [s.key, s]))

/** The manifest's fields that newer settings replaced, kept so a value saved under them still reaches the plugin:
 *  Citations (`marks`, on or off) and Citation checks (`citationChecks`), now Citations' modes; Squeeze and catch-up
 *  (`squeeze`), now Squeeze and Catch-up; Labels and coverage on the bar (`counts`), now Labels and Coverage; and
 *  Squeeze changes cards (`squeezeCards`), gone: a squeeze always may move or leave out a card; and Claims (`claims`, on
 *  or off), now Claims' `off` mode beside its `auto` and `on demand` (`claimsMode`, once Extract claims). Settings hides them
 *  (term.ts), and the first session moves a saved one to the settings that replaced it (movedFrom), then sets it back
 *  to its default. */
export const RETIRED = {
  marks: { type: 'boolean', title: 'Citations (old setting)', description: 'Replaced by Citations, which has its modes.', default: true },
  citationChecks: { type: 'string', title: 'Citation checks (old setting)', description: 'Replaced by Citations, which has its modes.', options: ['auto', 'on demand', 'off'], default: 'on demand' },
  squeeze: { type: 'boolean', title: 'Squeeze and catch-up (old setting)', description: 'Replaced by Rewrite and Catch-up.', default: true },
  counts: { type: 'boolean', title: 'Labels and coverage on the bar (old setting)', description: 'Replaced by Labels and Coverage.', default: true },
  squeezeCards: { type: 'boolean', title: 'Squeeze changes cards (old setting)', description: 'Removed: a squeeze may move or leave out a card.', default: true },
  claims: { type: 'boolean', title: 'Claims (old setting)', description: 'Replaced by Claims, which has its modes.', default: true },
}

/** Modes renamed since a value was saved under their old name, by feature: the old name stands for the new one, and
 *  the first session saves the new one (term.ts). */
export const RENAMED = {
  citations: { 'auto cite + check': 'auto cite + verify' },
  // a switch until 0.10.4, now modes: on is auto, off is off
  explain: { true: 'auto', false: 'off' },
  details: { true: 'auto', false: 'off' },
  // the 0.10.6 test branch saved a model by its alias (haiku); now by its name with the version (Haiku 5.5)
  checkerModel: Object.fromEntries(ALIASES.map(a => [a, shownName(a)])),
}

/** A mode saved under its old name (or as the switch it was), by its new name; undefined when it has none. */
export const renamedTo = (key, saved) => (typeof saved === 'string' || typeof saved === 'boolean' ? RENAMED[key]?.[String(saved)] : undefined)

/** Defaults that moved, and the hidden field that says a person's settings have had them: the installer saves every
 *  field's default, so a value at an old default cannot tell whether the person chose it. While `defaultsAt` is not
 *  `DEFAULTS.at`, the first interactive session saves the new default where the old one stands and sets `defaultsAt`
 *  (term.ts); a value the person sets afterwards stays. None moves now: a value saved at an old default stays, so
 *  no one's settings change under them. `formerly`: the defaults a release had before (0.10.3: Citations auto cite,
 *  Claims on demand), which the installer may have saved, so a value at one still counts as unset (atDefault).
 *  `defaultsAt` starts at `none`, no version, and not empty: the installer gives each field its default, Claude Code
 *  takes no empty value, and it says a field with no value is not set. */
export const DEFAULTS = { at: '0.10.4', moved: {}, formerly: { citations: ['auto cite'], claimsMode: ['on demand'] } }
export const DEFAULTS_FIELD = { defaultsAt: { type: 'string', title: 'Defaults seen (internal)', description: 'The thimble version whose defaults these settings have had.', default: 'none' } }

/** The values the moved defaults change in `values`, by feature: {} once `defaultsAt` says they were applied. */
export function defaultsFrom(values) {
  if (!values || typeof values !== 'object' || values.defaultsAt === DEFAULTS.at) return {}
  return Object.fromEntries(Object.entries(DEFAULTS.moved).filter(([k, m]) => values[k] === m.from).map(([k, m]) => [k, m.to]))
}

/** Whether a setting's value is its default: today's, or one it had before (DEFAULTS), which the installer may have
 *  saved. */
export const atDefault = (key, v) => v === undefined || v === BY_KEY.get(key)?.default || v === DEFAULTS.moved[key]?.from || (DEFAULTS.formerly[key] ?? []).includes(v)

/** Names modules ask featureOn by, for a feature kept under another key: Claims (`claims`) is the field `claimsMode`. */
const ALIAS = { claims: 'claimsMode' }

/** The Citations mode that the retired fields saved in `values` stand for, or null when they hold their defaults:
 *  citations off is `off`; checks after each reply are `auto cite + verify`; checks off is `auto cite`, since every mode
 *  that cites checks a citation once it is opened. */
export function citationsFrom(values) {
  if (!values || typeof values !== 'object') return null
  if (values.marks === false) return 'off'
  if (values.citationChecks === 'auto') return 'auto cite + verify'
  if (values.citationChecks === 'off') return 'auto cite'
  return null
}

/** The values the retired fields saved in `values` stand for, by the setting that replaced them: {} when they hold
 *  their defaults. */
export function movedFrom(values) {
  if (!values || typeof values !== 'object') return {}
  const out = {}
  const cites = citationsFrom(values)
  if (cites) out.citations = cites
  if (values.squeeze === false) Object.assign(out, { squeezeAnswers: false, catchUp: false })
  if (values.counts === false) Object.assign(out, { labels: false, coverage: false })
  if (values.claims === false) out.claimsMode = 'off'
  return out
}

/** `values` with what the retired fields saved moved to the settings that replaced them (where those hold their
 *  defaults), and the retired fields at their defaults. */
export function settled(values) {
  const base = values && typeof values === 'object' ? values : {}
  const moved = Object.fromEntries(Object.keys(movedFrom(base)).map(k => [k, valueIn(base, k)]))
  const renamed = Object.fromEntries(Object.keys(RENAMED).filter(k => renamedTo(k, base[k])).map(k => [k, renamedTo(k, base[k])]))
  return { ...base, ...renamed, ...moved, ...Object.fromEntries(Object.entries(RETIRED).map(([k, f]) => [k, f.default])) }
}

let current = {}

/** The plugin's options, as register(on, options) received them. */
export function setOptions(options) {
  current = options && typeof options === 'object' ? { ...options } : {}
}

/** A feature's value as `values` holds it: a boolean, or for a feature with modes one of its choices; a field missing,
 *  or not of its kind, has its default. */
export function valueIn(values, key) {
  const s = BY_KEY.get(key)
  const saved = values ? values[key] : undefined
  const v = renamedTo(key, saved) ?? saved
  // a setting at its default, while a retired field still holds a value saved before it, stands for that value
  const moved = movedFrom(values)
  if (s && key in moved && atDefault(key, v)) return moved[key]
  if (s?.choices) return s.choices.includes(v) ? v : s.default
  return typeof v === 'boolean' ? v : s ? s.default : true
}

/** Minimal: the modes it sets, so nothing runs after a reply and each of these waits to be asked. Turning it on saves
 *  them (settings/term.ts), and the rows show them; a row changed away from them turns it off. */
export const PRESET = { citations: 'manual', explain: 'on demand', details: 'on demand', claimsMode: 'on demand' }

/** Whether `values` hold Minimal's modes. */
export const atPreset = values => Object.entries(PRESET).every(([k, v]) => valueIn(values, k) === v)

/** The features as `values` holds them, as a function of a key: whether each is on (a feature with modes is on unless
 *  its mode is `off`), as Minimal leaves it. The settings pane asks it with the values Claude Code holds now; featureOn
 *  is it with the plugin's options. */
export function switchesFrom(values) {
  return key => {
    // c on selected words, a citation the analyst asks for, works in every mode of Citations but off
    if (key === 'cite') return valueIn(values, 'citations') !== 'off'
    // h, heads-ups on an answer the person asks for, is Heads-ups' on demand
    if (key === 'heads') return valueIn(values, 'details') === 'on demand'
    const v = valueIn(values, ALIAS[key] ?? key)
    return typeof v === 'string' ? v !== 'off' : v
  }
}

/** A feature's mode, for a feature with `choices` (`on demand`); its value as a boolean for any other. */
export function choiceOf(key) {
  return valueIn(current, ALIAS[key] ?? key)
}

/** A change the settings pane just made through Claude Code: this activation acts on it at once, while Claude Code
 *  loads the plugin again with the same value. */
export function noteChange(key, value) {
  const s = BY_KEY.get(key)
  if (!s || !(s.choices ? s.choices.includes(value) : typeof value === 'boolean')) return
  // a value the retired fields saved moves first, so the setting the person changes stands over it (term.ts moves
  // them too)
  current = { ...settled(current), defaultsAt: DEFAULTS.at, [key]: value }
}

/** The moved defaults saved in this load's copy, after term.ts saved them in Claude Code's. */
export function noteDefaults() {
  current = { ...current, ...defaultsFrom(current), defaultsAt: DEFAULTS.at }
}

/** The retired fields' values moved in this load's copy, after term.ts moved them in Claude Code's. */
export function noteSettled() {
  current = settled(current)
}

/** Whether a feature acts now: its option when it is a boolean, else its default. `observer` is whether the look after
 *  each reply runs: while a feature one of whose lenses it serves is on, and in its mode's `auto` when it has one. */
export function featureOn(key) {
  if (key === 'observer') return SWITCHES.some(s => (s.lenses ?? []).length > 0 && lensesAfterReply(s.key))
  return switchesFrom(current)(key)
}

/** Whether a feature's lenses join the look after each reply: it is on, and in its `lensesIn` mode when it has one. */
export function lensesAfterReply(key) {
  const s = BY_KEY.get(ALIAS[key] ?? key)
  return switchesFrom(current)(key) && (!s?.lensesIn || valueIn(current, s.key) === s.lensesIn)
}

/** Whether Minimal is on: the modes it set (PRESET) stand. */
export const minimalOn = () => valueIn(current, 'minimal') === true

/** The values this load runs with now, the retired fields' included. */
export const currentValues = () => ({ ...current })

/** Whether Claude cites its claims (Citations auto cite + verify, or auto cite): main reads the citing guidance, and
 *  the reply's citations are checked, after it or once opened. */
export const claudeCites = () => ['auto cite + verify', 'auto cite'].includes(choiceOf('citations'))

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null

/** The model the checker of the citations runs on (the setting Checker), by the id a request names it by (core/models.js: a
 *  request takes no alias), or null for the model of the conversation, which a fork keeps. */
export function checkerModel() {
  const m = choiceOf('checkerModel')
  return m === 'same as Claude' ? null : modelNamed(m)?.id ?? null
}

/** The effort levels Claude Code offers for a model (core/models.js), by the name Checker saves it by (`Haiku 5.5`),
 *  its alias or its request's id; every level for a model thimble does not list, as Claude Code itself fits a level to
 *  the model it sends to. */
const effortsOf = (model) => (modelNamed(model) ?? modelOf(model) ?? modelById(model))?.efforts ?? EFFORTS

/** The choices of a setting as the settings pane offers them with `values`: Effort offers the levels of the model
 *  Checker names (of the conversation's: every level); any other setting its choices. */
export function choicesIn(key, values) {
  const s = BY_KEY.get(key)
  if (!s?.choices) return null
  if (key !== 'checkerEffort') return s.choices
  const m = valueIn(values, 'checkerModel')
  return ['same as Claude', ...(m === 'same as Claude' ? EFFORTS : effortsOf(m))]
}

/** The effort of the checker's requests (the setting Checker's Effort) on `model`, the model a request names, or null
 *  for the effort of the conversation, which a fork keeps. A level the model does not offer gives way to the highest it
 *  offers below it, as Claude Code fits /effort to a model. */
export function checkerEffort(model) {
  const e = choiceOf('checkerEffort')
  if (e === 'same as Claude') return null
  const offered = effortsOf(model)
  return offered.includes(e) ? e : offered.filter(l => EFFORTS.indexOf(l) < EFFORTS.indexOf(e)).at(-1) ?? null
}
