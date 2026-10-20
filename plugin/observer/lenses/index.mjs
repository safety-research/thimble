// The lenses of the post-turn pass, in the order their fragments stand in the prompt. A new kind of observation is a
// folder here (lens.mjs: its output shape, its digest, its rules and its merge) and its fragment in the registry
// (prompts/lens-<name>/), plus its line below.
import actions from './actions/lens.mjs'
import explain from './explain/lens.mjs'
import notes from './notes/lens.mjs'
import squeeze from './squeeze/lens.mjs'

export const LENSES = [notes, actions, squeeze, explain]
