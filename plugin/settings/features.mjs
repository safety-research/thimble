// features.mjs: the features a person turns on and off. Pure: no `$`, no Node. The hooks module, the settings pane
// and the tests import it.
//
// Each feature is one switch, named by what the person gets (Citations, Cards), never by the part of thimble that makes
// it; a feature with `choices` is one of a few modes (Citations: auto cite + verify, auto cite, manual, off). Each is a field of the
// plugin's userConfig (.claude-plugin/plugin.json, with the same key, title and default: a boolean, or a string with its
// `options`), so Claude Code keeps its value (settings.json, pluginConfigs.thimble.options) and loads the plugin again
// with the new value. register(on, options) hands the values in (setOptions); every module asks featureOn(key), or
// choiceOf(key) for a mode, when it acts.
//
// Where thimble's drawing does not show (core/host.ts says so as the session starts: setDrawn), the features that only
// the drawing shows act as off (UNDRAWN), whatever the person set: featureOn, choiceOf and the others answer so, and what
// the person set stays as it is (currentValues).

import { ALIASES, EFFORTS, modelById, modelNamed, modelOf, shownName } from '../core/models.js'

/** What Minimal does, as the settings pane says it under its row. */
const MINIMAL_SAYS = 'In fullscreen, citations, explainers and heads-ups show only while the pointer is over their paragraph. Visualizations are shown only when requested. Simplify, Catch-up, Claims, Labels and Coverage are off.'

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
    key: 'citations', title: 'Citations', group: 'Answers', default: 'manual', choices: ['auto cite + verify', 'auto cite', 'manual', 'off'],
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
    key: 'cards', title: 'Cards', group: 'Answers', default: 'auto', choices: ['auto', 'on demand', 'off'],
    does: 'auto: Claude draws charts and tables as cards in its answers. on demand: Claude draws a card only when you ask for one. Press v to visualize the last answer. off: no cards.',
    says: {
      'auto': 'Claude draws charts and tables as cards in its answers. Press v to visualize the last answer.',
      'on demand': 'Claude draws a card only when you ask for one. Press v to visualize the last answer.',
      'off': 'No cards.',
    },
  },
  {
    key: 'squeezeAnswers', title: 'Simplify', group: 'Answers', default: true,
    does: 'Press s for a shorter, plainer version of the last answer, below it. Under it, press 1 for shorter, 2 for longer, 3 to explain more, 4 to assume more, or 0 to hide it. One call each time you ask.',
    says: { on: 'Press s for a shorter, plainer version of the last answer, below it. Under it, 1–4 make it shorter, longer, explain more or assume more; 0 hides it.', off: 'No simpler versions.' },
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
    key: 'details', title: 'Heads-ups', group: 'Comments', default: 'auto', choices: ['auto', 'off'], lenses: ['heads'],
    does: 'auto: details that may mislead get a heads-up after each answer, a small part of the call after it; ] opens each one. off: no heads-ups.',
    says: {
      'auto': 'Details that may mislead get a heads-up after each answer.',
      'off': 'No heads-ups.',
    },
  },
  {
    key: 'claimsMode', title: 'Claims', group: 'Panes', default: 'off', choices: ['auto', 'on demand', 'off'], lenses: ['claims'], lensesIn: 'auto',
    does: 'Press w to see the conversation\'s claims. auto: thimble pulls them out of each answer in the background, which uses tokens. on demand: only when you press f in the pane. off: no Claims pane.',
    says: {
      'auto': 'Press w to see the claims. thimble pulls them out of each answer in the background, which uses tokens.',
      'on demand': 'Press w to see the claims. thimble pulls them out only when you press f in the pane.',
      'off': 'No Claims pane.',
    },
  },
  {
    key: 'labels', title: 'Labels', group: 'Panes', default: true,
    does: 'Press l to see the labels Claude made, with their values and records. No model call. off: no Labels pane, and Claude makes no labels.',
    says: { on: 'Press l to see the labels Claude made, with their values and records.', off: 'No Labels pane, and Claude makes no labels.' },
  },
  {
    key: 'coverage', title: 'Coverage', group: 'Panes', default: false,
    does: 'Press r to see which files Claude has read, by folder. No model call: thimble counts the files after each turn.',
    says: { on: 'Press r to see which files Claude has read, by folder.', off: 'No Coverage pane.' },
  },
]

const BY_KEY = new Map(SWITCHES.map(s => [s.key, s]))

/** Modes renamed since a value was saved under their old name, by feature: the old name stands for the new one, and
 *  the first session saves the new one (term.ts). */
export const RENAMED = {
  citations: { 'auto cite + check': 'auto cite + verify' },
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

/** Minimal: the modes it sets. Claude still cites, each citation verified when it is opened (auto cite), and the look
 *  after each answer still writes explainers and heads-ups; where Claude Code reports the pointer (its fullscreen
 *  layout, with its mouse reports on) its answers are plain, these showing only for the paragraph under the pointer
 *  (marks/register.ts, view.ts `plain`), and elsewhere they stand at rest; Claude draws a card only when asked; Simplify,
 *  Catch-up and the session-wide panes (Claims, Labels, Coverage) are off, and with Labels off Claude makes no labels:
 *  the guidance leaves out its Labels section (guidance/guidance.ts), and `thimble label` refuses Claude's commands
 *  (hooks/path.ts). Turning it on saves them (settings/term.ts), and the rows show them; a row changed away from them
 *  turns it off. */
export const PRESET = { citations: 'auto cite', cards: 'on demand', squeezeAnswers: false, catchUp: false, explain: 'auto', details: 'auto', claimsMode: 'off', labels: false, coverage: false }

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
