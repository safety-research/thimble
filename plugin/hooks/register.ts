// thimble's plugin: its one hooks module. Each module has one job, and registers here in this order; for prompt.edit
// the order is the key precedence at an empty prompt (v, then the fix line's keys, then the focused card's keys, then
// the bar's).
//
//   settings    ../settings/term.ts     the plugin's options; featureOn(key) for every module
//   telemetry   ../telemetry/telemetry.ts  each model call and turn in the session's events; registered first and last,
//                                       so its two hooks of each event bracket thimble's others and time them
//   path        ./path.ts               the plugin's bin/ first on the PATH of the session's commands
//   watch       ./watch.ts              which files Claude's Read, Grep and Bash calls touched, for `thimble coverage`
//   prompts     ../prompts/prompts.ts   the prompt registry: one file per text a model reads
//   guidance    ../guidance/guidance.ts the `thimble` context block in every conversation
//   forks       ../core/forks.ts        the checker and designer forks: spawn, know, end; their reports kept from main
//   tell        ../core/tell.ts         what Claude reads of thimble's work, as rows before the person's next prompt
//   feed        ../core/feed.ts         the kernel's change feed, read after each Bash call, for the modules that act on it
//   panes       ../core/pane.ts         the one side pane, drawn by the kind it shows
//   designer    ../designer/v.ts        v at an empty prompt: a card of the last answer, made by a fork
//   fix keys    ../bar/register.ts      f F p u on the failure line or a fix in use
//   cards       ../cards/register.ts    the card tool, its runner, its drawing and its keys
//   marks       ../marks/register.ts    the reply's marks, their checker and their evidence
//   labels      ../labels/register.ts   a --prompt label's model reads; the person's checks
//   bar         ../bar/register.ts      the line above the prompt: busy step, fix line, counts
import type { Register } from 'claude-code'

import { registerBar, registerFixKeys } from '../bar/register'
import { registerCards } from '../cards/register'
import { registerFeed } from '../core/feed'
import { registerForks } from '../core/forks'
import { registerPanes } from '../core/pane'
import { registerTell } from '../core/tell'
import { registerDesigner } from '../designer/v'
import { registerGuidance } from '../guidance/guidance'
import { registerLabels } from '../labels/register'
import { registerMarks } from '../marks/register'
import { registerPrompts } from '../prompts/prompts'
import { registerSettings } from '../settings/term'
import { registerTelemetry } from '../telemetry/telemetry'
import { registerPath } from './path'
import { registerWatch } from './watch'

export const register: Register = (on, options) => {
  registerSettings(on, options)
  registerTelemetry(on, 'first')
  registerPath(on, options)
  registerWatch(on, options)
  registerPrompts(on, options)
  registerGuidance(on, options)
  registerForks(on, options)
  registerTell(on, options)
  registerFeed(on, options)
  registerPanes(on, options)
  registerDesigner(on, options)
  registerFixKeys(on, options)
  registerCards(on, options)
  registerMarks(on, options)
  registerLabels(on, options)
  registerBar(on, options)
  registerTelemetry(on, 'last')
}
