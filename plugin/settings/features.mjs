// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Citations, Cards), never by the part of thimble that makes
// it; a feature with `choices` is one of a few modes (Citations: auto + verify, auto, manual, off). Each is a field of
// the plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default: a boolean, or a string
// with its `options`), so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the
// plugin again with the new value. register(on, options) hands the values in (setOptions); every module asks
// featureOn(key), or choiceOf(key) for a mode, when it acts.
//
// Where thimble's drawing does not show (core/host.ts says so as the session starts: setDrawn), the features that only
// the drawing shows act as off (UNDRAWN), whatever the person set: featureOn, choiceOf and the others answer so, and what
// the person set stays as it is (currentValues).

import { ALIASES, EFFORTS, modelById, modelNamed, modelOf, shownName } from '../core/models.js'

/** What Minimal mode does, as the settings pane says it beside its row. */
const MINIMAL_SAYS = 'Plain answers; cards only when you ask; the rest off.'

/** Words in a list: `a, b or c`. */
const listed = (ws) => (ws.length > 1 ? `${ws.slice(0, -1).join(', ')} or ${ws.at(-1)}` : ws.join(''))
/** The models Verifier model names, each as Claude Code shows it, with its version (`Haiku 5.5`): the words the
 *  settings pane and /config show, and the value Claude Code saves. */
const CHECKER_MODELS = ALIASES.map(shownName)

/** The features, in the order the settings pane lists them, which is the order of their keys on the bar. `key`: the
 *  userConfig field; `title`: its name; `group`: the rows the pane draws together, a thin line between one group and
 *  the next (a key keeps its name, so a saved setting still applies); `letter`: the key on the bar that acts for it
 *  (`v visualize`), which the pane shows after its name; `does`: what /config says of it, the field's description (a
 *  test checks), in the words of the pane's lines. `choices`: the modes of a feature that has more than on and off, its
 *  default one of them. `lenses`: the lenses of the observer's look it needs (observer/lenses.mjs): the look runs while
 *  one such feature is on. `lensesIn`: the mode in which they join the look after each reply (Claims: `auto`; in `on
 *  demand`, a look of their own runs when the person asks). `says`: what each mode gives (`on` and `off` for a
 *  switch), the line the settings pane shows with the row for the one set. `under`: the feature whose work this setting
 *  changes (Verifier model and Verifier effort: the checks of Citations); the settings pane shows its row, with no line
 *  of its own, only while that feature is on. `firstParty`: the setting names models by the ids of Anthropic's
 *  first-party API (core/models.js), which Bedrock, Vertex and Foundry do not take, or the effort of the model Verifier
 *  model names: where Claude Code runs on one of them (settings/term.ts firstPartyApi), neither the pane nor /config
 *  shows its row, and what it holds does nothing. */
export const SWITCHES = [
  {
    key: 'minimal', title: 'Minimal mode', group: 'minimal', default: false,
    does: MINIMAL_SAYS,
    says: { on: MINIMAL_SAYS, off: MINIMAL_SAYS },
  },
  {
    key: 'cards', title: 'Cards', group: 'cards', letter: 'v', default: 'auto', choices: ['auto', 'on demand', 'off'],
    does: 'auto: Claude draws charts and tables of your data. on demand: Claude draws a card only when you ask for one. Press v for the last answer. off: no cards.',
    says: {
      'auto': 'Claude draws charts and tables of your data.',
      'on demand': 'Claude draws a card only when you ask for one. Press v for the last answer.',
      'off': 'No cards.',
    },
  },
  {
    key: 'squeezeAnswers', title: 'Simplify', group: 'rewrites', letter: 's', default: true,
    does: 'A shorter, plainer version of the last answer.',
    says: { on: 'A shorter, plainer version of the last answer.', off: 'No simpler versions.' },
  },
  {
    key: 'catchUp', title: 'Catch-up', group: 'rewrites', letter: 'b', default: true,
    does: 'One note on the replies that came in while you were away.',
    says: { on: 'One note on the replies that came in while you were away.', off: 'No catch-up.' },
  },
  {
    key: 'citations', title: 'Citations', group: 'citations', letter: 'c', default: 'manual', choices: ['auto + verify', 'auto', 'manual', 'off'],
    does: 'auto + verify: Claude cites what each answer rests on. The verifier checks every citation after each answer. auto: Claude cites what each answer rests on. The verifier checks a citation when you open it. manual: select words and press c. The verifier checks them against your files. off: no citations.',
    says: {
      'auto + verify': 'Claude cites what each answer rests on. The verifier checks every citation after each answer.',
      'auto': 'Claude cites what each answer rests on. The verifier checks a citation when you open it.',
      'manual': 'Select words and press c. The verifier checks them against your files.',
      'off': 'No citations.',
    },
  },
  {
    key: 'checkerModel', title: 'Verifier model', group: 'citations', under: 'citations', firstParty: true, default: 'same as Claude', choices: ['same as Claude', ...CHECKER_MODELS],
    does: `The model of the verifier, which checks citations. same as Claude: the model of the conversation. ${listed(CHECKER_MODELS)}: that model, which reads the conversation without the cache of the conversation's model.`,
  },
  {
    key: 'checkerEffort', title: 'Verifier effort', group: 'citations', under: 'citations', firstParty: true, default: 'same as Claude', choices: ['same as Claude', ...EFFORTS],
    does: `How hard the verifier thinks. same as Claude: the effort of the conversation. ${listed(EFFORTS)}: that effort, of the levels Claude Code offers for the verifier's model.`,
  },
  {
    key: 'explain', title: 'Explainers', group: 'comments', letter: 'e', default: 'auto', choices: ['auto', 'on demand', 'off'], lenses: ['explain'], lensesIn: 'auto',
    does: 'auto: short notes on terms you may not know. on demand: select words and press e for a short note. off: no explainers.',
    says: {
      'auto': 'Short notes on terms you may not know.',
      'on demand': 'Select words and press e for a short note.',
      'off': 'No explainers.',
    },
  },
  {
    key: 'details', title: 'Heads-ups', group: 'comments', default: 'auto', choices: ['auto', 'off'], lenses: ['heads'],
    does: 'auto: notes on details that may mislead. off: no heads-ups.',
    says: {
      'auto': 'Notes on details that may mislead.',
      'off': 'No heads-ups.',
    },
  },
  {
    key: 'labels', title: 'Labels', group: 'panes', letter: 'l', default: true,
    does: 'The labels Claude made, with their values and records. off: no Labels pane, and Claude makes no labels.',
    says: { on: 'The labels Claude made, with their values and records.', off: 'No Labels pane, and Claude makes no labels.' },
  },
  {
    key: 'claimsMode', title: 'Claims', group: 'panes', letter: 'w', default: 'off', choices: ['auto', 'on demand', 'off'], lenses: ['claims'], lensesIn: 'auto',
    does: 'auto: everything the session concluded. on demand: everything the session concluded, when you press f in the pane. off: no Claims pane.',
    says: {
      'auto': 'Everything the session concluded.',
      'on demand': 'Everything the session concluded, when you press f in the pane.',
      'off': 'No Claims pane.',
    },
  },
  {
    key: 'coverage', title: 'Coverage', group: 'panes', letter: 'r', default: false,
    does: 'Which files Claude has read.',
    says: { on: 'Which files Claude has read.', off: 'No Coverage pane.' },
  },
]

const BY_KEY = new Map(SWITCHES.map(s => [s.key, s]))

/** Modes renamed since a value was saved under their old name, by feature: the old name stands for the new one, and
 *  the first session saves the new one (term.ts). */
export const RENAMED = {
  // auto cite + verify and auto cite until 1.0, and auto cite + check before them
  citations: { 'auto cite + check': 'auto + verify', 'auto cite + verify': 'auto + verify', 'auto cite': 'auto' },
  // a switch until 0.10.4 (Cards until 0.10.8), now modes: on is auto, off is off; Heads-ups' on demand, gone since
  // 0.10.11, is off
  explain: { true: 'auto', false: 'off' },
  details: { true: 'auto', false: 'off', 'on demand': 'off' },
  cards: { true: 'auto', false: 'off' },
  // the 0.10.6 test branch saved a model by its alias (haiku); now by its name with the version (Haiku 5.5)
  checkerModel: Object.fromEntries(ALIASES.map(a => [a, shownName(a)])),
}

/** A mode saved under its old name (or as the switch it was), by its new name; undefined when it has none. */
export const renamedTo = (key, saved) => (typeof saved === 'string' || typeof saved === 'boolean' ? RENAMED[key]?.[String(saved)] : undefined)

/** Names modules ask featureOn by, for a feature kept under another key: Claims (`claims`) is the field `claimsMode`. */
const ALIAS = { claims: 'claimsMode' }

let current = {}

/** Whether thimble's drawing shows in this session: core/host.ts says it as the session starts; until then it shows. */
let drawn = true

/** The plugin's options, as register(on, options) received them. */
export function setOptions(options) {
  current = options && typeof options === 'object' ? { ...options } : {}
}

/** Whether thimble's drawing shows in this session, which core/host.ts reads from the session's start. */
export function setDrawn(shows) {
  drawn = shows !== false
}

/** A feature's value as `values` holds it: a boolean, or for a feature with modes one of its choices; a field missing,
 *  or not of its kind, has its default. */
export function valueIn(values, key) {
  const s = BY_KEY.get(key)
  const saved = values ? values[key] : undefined
  const v = renamedTo(key, saved) ?? saved
  if (s?.choices) return s.choices.includes(v) ? v : s.default
  return typeof v === 'boolean' ? v : s ? s.default : true
}

/** Minimal mode: the modes it sets. Claude still cites, each citation verified when it is opened (auto), and the look
 *  after each answer still writes explainers and heads-ups; where Claude Code reports the pointer (its fullscreen
 *  layout, with its mouse reports on) its answers are plain, these showing only for the paragraph under the pointer
 *  (marks/register.ts, view.ts `plain`), and elsewhere they stand at rest; Claude draws a card only when asked; Simplify,
 *  Catch-up and the session-wide panes (Claims, Labels, Coverage) are off, and with Labels off Claude makes no labels:
 *  the guidance leaves out its Labels section (guidance/guidance.ts), and `thimble label` refuses Claude's commands
 *  (hooks/path.ts). Turning it on saves them (settings/term.ts), and the rows show them; a row changed away from them
 *  turns it off. */
export const PRESET = { citations: 'auto', cards: 'on demand', squeezeAnswers: false, catchUp: false, explain: 'auto', details: 'auto', claimsMode: 'off', labels: false, coverage: false }

/** The modes Minimal set from 0.10.4 to 0.10.7: rows that still hold them stand for it, and the first session sets its
 *  modes now (settings/term.ts settleMinimal). Heads-ups was on demand then, which reads as off now (RENAMED). */
export const OLD_PRESET = { citations: 'manual', explain: 'on demand', details: 'off', claimsMode: 'on demand' }

/** The modes that stand where thimble's drawing does not show (core/host.ts drawsHere: the desktop app's Code tab,
 *  remote Cowork, claude -p): Citations, Cards, Explainers and Heads-ups off, as if the person had set them off, since
 *  nothing there draws a citation, its check, a card, an explainer or a heads-up (a citation would read as a raw link,
 *  and a card would show nowhere), and no key asks for one (every key types there). The person's own modes stay as they
 *  set them (currentValues), and the terminal acts on them. */
export const UNDRAWN = { citations: 'off', cards: 'off', explain: 'off', details: 'off' }

/** Whether `values` hold a preset's modes: Minimal's, or `preset`. */
export const atPreset = (values, preset = PRESET) => Object.entries(preset).every(([k, v]) => valueIn(values, k) === v)

/** The features as `values` holds them, as a function of a key: whether each is on (a feature with modes is on unless
 *  its mode is `off`). The settings pane asks it with the values Claude Code holds now; featureOn is it with the values
 *  the plugin acts on (acting). */
export function switchesFrom(values) {
  return key => {
    // c on selected words, a citation the analyst asks for, works in every mode of Citations but off
    if (key === 'cite') return valueIn(values, 'citations') !== 'off'
    const v = valueIn(values, ALIAS[key] ?? key)
    return typeof v === 'string' ? v !== 'off' : v
  }
}

/** The values the features act on now: the person's (the plugin's options), with UNDRAWN's modes over them where
 *  thimble's drawing does not show. Each answer on what acts now reads these: choiceOf, featureOn, lensesAfterReply,
 *  minimalOn. */
const acting = () => (drawn ? current : { ...current, ...UNDRAWN })

/** A feature's mode, for a feature with `choices` (`on demand`); its value as a boolean for any other. */
export function choiceOf(key) {
  return valueIn(acting(), ALIAS[key] ?? key)
}

/** A change the settings pane just made through Claude Code: this activation acts on it at once, while Claude Code
 *  loads the plugin again with the same value. */
export function noteChange(key, value) {
  const s = BY_KEY.get(key)
  if (!s || !(s.choices ? s.choices.includes(value) : typeof value === 'boolean')) return
  current = { ...current, [key]: value }
}

/** Whether a feature acts now: its option when it is a boolean, else its default. `observer` is whether the look after
 *  each reply runs: while a feature one of whose lenses it serves is on, and in its mode's `auto` when it has one. */
export function featureOn(key) {
  if (key === 'observer') return SWITCHES.some(s => (s.lenses ?? []).length > 0 && lensesAfterReply(s.key))
  return switchesFrom(acting())(key)
}

/** Whether a feature's lenses join the look after each reply: it is on, and in its `lensesIn` mode when it has one. */
export function lensesAfterReply(key) {
  const s = BY_KEY.get(ALIAS[key] ?? key)
  const values = acting()
  return switchesFrom(values)(key) && (!s?.lensesIn || valueIn(values, s.key) === s.lensesIn)
}

/** Whether Minimal is on: the modes it set (PRESET) stand. */
export const minimalOn = () => valueIn(acting(), 'minimal') === true

/** The values the person set, as this load runs with them: never UNDRAWN's modes. */
export const currentValues = () => ({ ...current })

/** Whether Claude cites its claims (Citations auto + verify, or auto): main reads the citing guidance, and the reply's
 *  citations are checked, after it or once opened. */
export const claudeCites = () => ['auto + verify', 'auto'].includes(choiceOf('citations'))

/** A feature by its key, or null. */
export const switchOf = key => BY_KEY.get(key) ?? null

/** The model the checker of the citations runs on (the setting Verifier model), by the id a request names it by
 *  (core/models.js: a request takes no alias), or null for the model of the conversation, which a fork keeps. */
export function checkerModel() {
  const m = choiceOf('checkerModel')
  return m === 'same as Claude' ? null : modelNamed(m)?.id ?? null
}

/** The effort levels Claude Code offers for a model (core/models.js), by the name Verifier model saves it by
 *  (`Haiku 5.5`), its alias or its request's id; every level for a model thimble does not list, as Claude Code itself
 *  fits a level to the model it sends to. */
const effortsOf = (model) => (modelNamed(model) ?? modelOf(model) ?? modelById(model))?.efforts ?? EFFORTS

/** The choices of a setting as the settings pane offers them with `values`: Verifier effort offers the levels of the
 *  model Verifier model names (of the conversation's: every level); any other setting its choices. */
export function choicesIn(key, values) {
  const s = BY_KEY.get(key)
  if (!s?.choices) return null
  if (key !== 'checkerEffort') return s.choices
  const m = valueIn(values, 'checkerModel')
  return ['same as Claude', ...(m === 'same as Claude' ? EFFORTS : effortsOf(m))]
}

/** The effort of the checker's requests (the setting Verifier effort) on `model`, the model a request names, or null
 *  for the effort of the conversation, which a fork keeps. A level the model does not offer gives way to the highest it
 *  offers below it, as Claude Code fits /effort to a model. */
export function checkerEffort(model) {
  const e = choiceOf('checkerEffort')
  if (e === 'same as Claude') return null
  const offered = effortsOf(model)
  return offered.includes(e) ? e : offered.filter(l => EFFORTS.indexOf(l) < EFFORTS.indexOf(e)).at(-1) ?? null
}
