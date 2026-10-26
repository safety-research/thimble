// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Citations, Cards), never by the part of thimble that makes
// it; a feature with `choices` is one of a few modes (Citations: auto cite + verify, auto cite, manual, off). Each is a field of the
// plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default: a boolean, or a string with its
// `options`), so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again
// with the new value. register(on, options) hands the values in (setOptions); every module asks featureOn(key), or
// choiceOf(key) for a mode, when it acts.

/** The features, in the order the settings pane lists them. `key`: the userConfig field; `title`: its name; `group`:
 *  the heading the pane lists it under, with the others of its group (Answers, Comments on an answer's words, Panes;
 *  a key keeps its name, so a saved setting still applies); Minimal, first, has none: it stands over the others; `does`: one line on what the person gets
 *  and what it costs, the field's description (a test checks). `choices`: the modes of a feature that has more than on
 *  and off, its default one of them. `lenses`: the lenses of the observer's look it needs (observer/lenses.mjs): the
 *  look runs while one such feature is on. `lensesIn`: the mode in which they join the look after each reply (Claims:
 *  `auto`; in `on demand`, a look of their own runs when the person asks). `says`: what each mode
 *  gives (`on` and `off` for a switch), which the settings pane shows under the row for the one set. */
export const SWITCHES = [
  {
    key: 'minimal', title: 'Minimal', default: false,
    does: 'Everything on demand: nothing runs after a reply and nothing is marked by itself. Select words and press e to explain them or c to cite them, h gives heads-ups on the last answer, and f in Evidence finds the claims. Claude still draws cards, and v visualizes the last answer. The settings below come back when it is off.',
    says: { on: 'Everything on demand: no call after a reply; e, c and h on an answer, f in Evidence.', off: 'Each feature works as set below.' },
  },
  {
    key: 'citations', title: 'Citations', group: 'Answers', default: 'manual', choices: ['auto cite + verify', 'auto cite', 'manual', 'off'],
    does: 'auto cite + verify: Claude cites each claim you would check, and a second Claude verifies each citation after each reply. auto cite: Claude cites, and a citation is checked when you open it, which spends fewer tokens. manual: select words in an answer and press c to cite them. off: no citations.',
    says: {
      'auto cite + verify': 'Claude cites what its answer rests on; a second Claude verifies each citation right away.',
      'auto cite': 'Claude cites what its answer rests on; a citation is checked when you open it.',
      'manual': 'Nothing is cited until you select words and press c.',
      'off': 'No citations.',
    },
  },
  {
    key: 'cards', title: 'Cards', group: 'Answers', default: true,
    does: 'Claude draws interactive cards, and v visualizes the last answer as a card.',
    says: { on: 'Claude draws charts and tables as cards inside the answer; v visualizes the last answer as a card.', off: 'No cards.' },
  },
  {
    key: 'squeezeAnswers', title: 'Rewrite', group: 'Answers', default: true,
    does: 's rewrites an answer shorter or longer, for a reader more novice or more expert, or in your own words. One rewrite each time you ask.',
    says: { on: 's rewrites an answer shorter or longer, more novice or more expert; 0 brings back the original.', off: 'No rewrites.' },
  },
  {
    key: 'catchUp', title: 'Catch-up', group: 'Answers', default: true,
    does: 'After replies to background work pile up, b sums them up in one short note, and 0 shows the replies again. One rewrite each time you ask.',
    says: { on: 'b sums up the replies that came in while you were away.', off: 'No catch-up.' },
  },
  {
    key: 'explain', title: 'Explainers', group: 'Comments', default: true, lenses: ['explain'],
    does: 'Marks the terms you may not know; ] opens what each one means here. A small part of the call after each reply.',
    says: { on: 'Words you may not know get a short explainer; select any words and press e for one.', off: 'No explainers.' },
  },
  {
    key: 'details', title: 'Heads-ups', group: 'Comments', default: true, lenses: ['heads'],
    does: 'Marks a detail of an answer that is easy to miss and changes what it means; ] opens its heads-up. A small part of the call after each reply.',
    says: { on: 'Words that may mislead get a heads-up.', off: 'No heads-ups.' },
  },
  {
    key: 'claimsMode', title: 'Evidence', group: 'Panes', default: 'on demand', choices: ['auto', 'on demand', 'off'], lenses: ['claims'], lensesIn: 'auto',
    does: 'c opens what Claude and you claimed in the session, with why each holds and its sources. auto: the claims are extracted after each reply, the largest part of the call after it. on demand: f in the Evidence pane extracts them, which spends fewer tokens. off: no Evidence pane.',
    says: {
      'auto': 'c lists the claims of the conversation with their evidence; they are extracted after each answer.',
      'on demand': 'c lists the claims of the conversation with their evidence; press f in the pane to extract them, which spends fewer tokens.',
      'off': 'No Evidence pane.',
    },
  },
  {
    key: 'labels', title: 'Labels', group: 'Panes', default: true,
    does: 'The bar counts the labels Claude made, and l opens them. No model call.',
    says: { on: 'l opens the labels Claude made, with their values and records.', off: 'No Labels pane.' },
  },
  {
    key: 'coverage', title: 'Coverage', group: 'Panes', default: true,
    does: 'The bar shows how much of the data Claude has read, and r opens it by folder. No model call: thimble counts the files after each turn.',
    says: { on: 'r shows which files Claude has read, by folder.', off: 'No Coverage pane.' },
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
  claims: { type: 'boolean', title: 'Claims (old setting)', description: 'Replaced by Evidence, which has its modes.', default: true },
}

/** Modes renamed since a value was saved under their old name, by feature: the old name stands for the new one, and
 *  the first session saves the new one (term.ts). */
export const RENAMED = { citations: { 'auto cite + check': 'auto cite + verify' } }

/** Defaults that moved, and the hidden field that says a person's settings have had them: the installer saves every
 *  field's default, so a value at an old default cannot tell whether the person chose it. While `defaultsAt` is not
 *  `DEFAULTS.at`, the first interactive session saves the new default where the old one stands and sets `defaultsAt`
 *  (term.ts); a value the person sets afterwards stays. 0.10.4: Citations is manual (Claude cites only what
 *  the person asks it to). */
export const DEFAULTS = { at: '0.10.4', moved: { citations: { from: 'auto cite', to: 'manual' } } }
export const DEFAULTS_FIELD = { defaultsAt: { type: 'string', title: 'Defaults seen (internal)', description: 'The thimble version whose defaults these settings have had.', default: '' } }

/** The values the moved defaults change in `values`, by feature: {} once `defaultsAt` says they were applied. */
export function defaultsFrom(values) {
  if (!values || typeof values !== 'object' || values.defaultsAt === DEFAULTS.at) return {}
  return Object.fromEntries(Object.entries(DEFAULTS.moved).filter(([k, m]) => values[k] === m.from).map(([k, m]) => [k, m.to]))
}

/** Whether a setting's value is its default: today's, or the one it had before it moved (DEFAULTS), which the
 *  installer may have saved. */
export const atDefault = (key, v) => v === undefined || v === BY_KEY.get(key)?.default || v === DEFAULTS.moved[key]?.from

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
  const renamed = Object.fromEntries(Object.entries(RENAMED).filter(([k, names]) => names[base[k]]).map(([k, names]) => [k, names[base[k]]]))
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
  const v = RENAMED[key]?.[saved] ?? saved
  // a setting at its default, while a retired field still holds a value saved before it, stands for that value
  const moved = movedFrom(values)
  if (s && key in moved && atDefault(key, v)) return moved[key]
  if (s?.choices) return s.choices.includes(v) ? v : s.default
  return typeof v === 'boolean' ? v : s ? s.default : true
}

/** What Minimal holds a mode at while it is on, by feature: a mode that acts after each reply waits to be asked
 *  (Citations' auto modes are manual; Claims' auto is on demand). Explainers and Heads-ups stay on, so e and h ask for
 *  them, but their lenses leave the look after each reply (lensesAfterReply). */
const MINIMAL = { citations: { 'auto cite + verify': 'manual', 'auto cite': 'manual' }, claimsMode: { auto: 'on demand' } }

/** A feature's value as it acts: its value in `values`, or what Minimal holds it at while Minimal is on. */
export function actingIn(values, key) {
  const v = valueIn(values, key)
  return key !== 'minimal' && valueIn(values, 'minimal') === true ? MINIMAL[key]?.[v] ?? v : v
}

/** The features Minimal changes while it is on, by feature: what each does then, in the settings pane's words. Empty
 *  while Minimal is off. */
export function heldByMinimal(values) {
  if (valueIn(values, 'minimal') !== true) return {}
  const out = {}
  for (const key of Object.keys(MINIMAL)) if (actingIn(values, key) !== valueIn(values, key)) out[key] = actingIn(values, key)
  for (const s of SWITCHES) if (s.lenses && !s.lensesIn && valueIn(values, s.key) === true) out[s.key] = 'on demand'
  return out
}

/** The features as `values` holds them, as a function of a key: whether each is on (a feature with modes is on unless
 *  its mode is `off`), as Minimal leaves it. The settings pane asks it with the values Claude Code holds now; featureOn
 *  is it with the plugin's options. */
export function switchesFrom(values) {
  return key => {
    // c on selected words, a citation the analyst asks for, is Citations' manual mode
    if (key === 'cite') return actingIn(values, 'citations') === 'manual'
    // h, heads-ups on an answer the person asks for, is Minimal's, while Heads-ups is on
    if (key === 'heads') return valueIn(values, 'minimal') === true && valueIn(values, 'details') === true
    const v = actingIn(values, ALIAS[key] ?? key)
    return typeof v === 'string' ? v !== 'off' : v
  }
}

/** A feature's mode, for a feature with `choices` (`on demand`), as Minimal leaves it; its value as a boolean for any
 *  other. */
export function choiceOf(key) {
  return actingIn(current, ALIAS[key] ?? key)
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
  // Minimal: nothing joins the look after each reply; each lens waits to be asked
  if (valueIn(current, 'minimal') === true) return false
  return switchesFrom(current)(key) && (!s?.lensesIn || valueIn(current, s.key) === s.lensesIn)
}

/** Whether Minimal is on: every feature waits to be asked. */
export const minimalOn = () => valueIn(current, 'minimal') === true

/** The values this load runs with now, the retired fields' included. */
export const currentValues = () => ({ ...current })

/** Whether Claude cites its claims (Citations auto cite + verify, or auto cite): main reads the citing guidance, and
 *  the reply's citations are checked, after it or once opened. */
export const claudeCites = () => ['auto cite + verify', 'auto cite'].includes(choiceOf('citations'))

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null
