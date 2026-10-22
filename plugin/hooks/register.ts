// thimble's plugin: its one hooks module. Each module has one job, and registers here in this order. A module
// registered earlier wraps the later ones: its hook runs before theirs and ends after them.
//
//   settings    ../settings/term.ts     the plugin's options; featureOn(key) for every module
//   telemetry   ../telemetry/telemetry.ts  each model call and turn in the session's events; registered first and last,
//                                       so its two hooks of each event bracket thimble's others and time them
//   path        ./path.ts               the session's environment: the plugin's bin/ first on PATH, and a TMPDIR
//   watch       ./watch.ts              which files Claude's Read, Grep and Bash calls touched, for `thimble coverage`
//   prompts     ../prompts/prompts.ts   the prompt registry: one file per text a model reads
//   guidance    ../guidance/guidance.ts guidance.md beside the prompt, once in every conversation
//   turn        ../core/turn.ts         whether main's turn runs
//   forks       ../core/forks.ts        the checker and designer forks: spawn, know, end; their reports kept from main
//   tell        ../core/tell.ts         what Claude reads of thimble's work, with the person's next prompt
//   feed        ../core/feed.ts         the kernel's change feed, read after each Bash call, for the modules that act on it
//   panes       ../core/pane.ts         the one side pane, drawn by the kind it shows
//   keys        ./keys.ts               thimble's keys at an empty prompt (v, the fix lines', the cards', the bar's)
//   designer    ../designer/v.ts        v at an empty prompt: a card of the last answer, made by a fork
//   cards       ../cards/register.ts    the card tool, its runner and its drawing
//   marks       ../marks/register.ts    the reply's marks, their checker and their evidence
//   labels      ../labels/register.ts   a --prompt label's model reads; the person's checks
//   bar         ../bar/register.ts      the line above the prompt: busy step, failure and fix lines, counts
import type { Register } from 'claude-code'

import { registerBar } from '../bar/register'
import { registerCards } from '../cards/register'
import { registerFeed } from '../core/feed'
import { registerForks } from '../core/forks'
import { registerPanes } from '../core/pane'
import { registerTell } from '../core/tell'
import { registerTurn } from '../core/turn'
import { registerDesigner } from '../designer/v'
import { registerGuidance } from '../guidance/guidance'
import { registerLabels } from '../labels/register'
import { registerMarks } from '../marks/register'
import { registerPrompts } from '../prompts/prompts'
import { registerSettings } from '../settings/term'
import { registerTelemetry } from '../telemetry/telemetry'
import { registerKeys } from './keys'
import { registerPath } from './path'
import { registerWatch } from './watch'

export const register: Register = (on, options) => {
  registerSettings(on, options)
  registerTelemetry(on, 'first')
  registerPath(on, options)
  registerWatch(on, options)
  registerPrompts(on, options)
  registerGuidance(on, options)
  registerTurn(on, options)
  registerForks(on, options)
  registerTell(on, options)
  registerFeed(on, options)
  registerPanes(on, options)
  registerKeys(on, options)
  registerDesigner(on, options)
  registerCards(on, options)
  registerMarks(on, options)
  registerLabels(on, options)
  registerBar(on, options)
  registerTelemetry(on, 'last')
}
