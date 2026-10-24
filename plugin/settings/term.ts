// term.ts: thimble's features in the terminal. The plugin's userConfig (.claude-plugin/plugin.json) declares one
// field per feature (settings/features.mjs): a boolean, or a string of its modes, so Claude Code keeps their values in
// settings.json and hands them to register(on, options); every module asks featureOn(key) when it acts.
//
//   heldValues($)          each feature's value as Claude Code holds it now (a change made a moment ago included)
//   settingsAction($, a)   turn a feature on or off (`toggle`; a feature with modes goes to its next mode), or set its
//                          mode (`set`), through Claude Code ($.config.set), which keeps the value and loads the plugin
//                          again with the new options; a refusal is one line with its fix
//   /thimble-off, /thimble-on   thimble off (or on again) in this session only: every feature off (features.mjs
//                          featureOn), no guidance with the next prompts, no bar and no side pane, and the card tool
//                          out of Claude's list. The switch lives in this session's state, never in a setting, so
//                          another session, and this one started again, keep thimble on
//   syncOff($)             the switch as this session's state holds it, after a reload of the plugin (the bar's
//                          drawing asks at once)
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { SWITCHES, choiceOf, featureOn, noteChange, setOptions, setSessionOff, switchOf } from './features.mjs'

type Engine = EngineInterface

/** Claude Code's rows of thimble's features, by feature: `<plugin>.<field>` (a --plugin-dir plugin may be
 *  `<plugin>@inline.<field>`). */
async function configRows($: Engine): Promise<Map<string, ConfigRow>> {
  const out = new Map<string, ConfigRow>()
  for (const r of await $.config.list()) {
    const m = /^(.+)\.([^.]+)$/.exec(r.key)
    if (!m || !switchOf(m[2]!)) continue
    if (m[1] !== $.plugin.name && !m[1]!.startsWith(`${$.plugin.name}@`)) continue
    out.set(m[2]!, r)
  }
  return out
}

/** Each feature's value as Claude Code holds it now: a change made a moment ago is here before the plugin loads again
 *  with it. A feature Claude Code lists no value for has the value this load runs with. */
export async function heldValues($: Engine): Promise<Record<string, boolean | string>> {
  const rows = await configRows($).catch(() => new Map<string, ConfigRow>())
  return Object.fromEntries(SWITCHES.map(s => {
    const r = rows.get(s.key)
    const kind = s.choices ? s.choices.includes(r?.value as string) : typeof r?.value === 'boolean'
    return [s.key, r && kind ? r.value : choiceOf(s.key)]
  }))
}

/** Turn a feature on or off, or set a feature's mode. A refusal is said in one line with its fix; nothing changes then. */
export async function settingsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  if ((a.do !== 'toggle' && a.do !== 'set') || typeof a.key !== 'string') return false
  const s = switchOf(a.key)
  if (!s) return `× thimble has no feature "${a.key}".`
  const r = (await configRows($)).get(s.key)
  if (!r) return `× Claude Code has not loaded thimble's settings, so ${s.title} cannot change now. Load thimble again in /plugin, then try once more.`
  if (r.isLocked) return `× ${s.title} is set by your organization's settings, so it cannot change here.`
  const now = (s.choices ? s.choices.includes(r.value as string) : typeof r.value === 'boolean') ? r.value : choiceOf(s.key)
  const to = a.do === 'set' ? a.value : s.choices ? s.choices[(s.choices.indexOf(now as string) + 1) % s.choices.length] : !now
  if (s.choices ? !s.choices.includes(to as string) : typeof to !== 'boolean') return `× ${s.title} has no setting "${String(to)}".`
  if (to === now) return
  const res = await $.config.set({ key: r.key, value: to as boolean | string })
  if (res.deny) return `× ${s.title} stayed ${typeof now === 'string' ? now : now ? 'on' : 'off'}: ${res.deny}`
  // acted on at once, before the plugin loads again with it
  noteChange(s.key, to)
  $.ui.invalidate('ui.render')
}

// ------------------------------------------------------------------------------------------------ off in this session

const OFF = { plugin: 'thimble', key: 'sessionOff' } as const
/** Whether this load of the plugin read the switch from the session's state yet. */
let synced = false

/** The switch as the session's state holds it (it outlives a reload of the plugin, which starts with thimble on). */
export async function syncOff($: Engine): Promise<boolean> {
  if (!synced) {
    synced = true
    setSessionOff(!!(await $.state.get(OFF).catch(() => ({ value: false }))).value)
  }
  return !featureOn('thimble')
}

const OFF_SAID = 'off in this session only: no citations, checks, cards, explainers, claims, bar or side pane until /thimble-on or the session ends. Other sessions, and this one when you start it again, keep thimble on; your settings did not change.'
const ON_SAID = 'on again in this session.'
/** What Claude reads with each: the guidance it had (if any) stops or starts to apply. */
const OFF_TOLD = 'The analyst turned thimble off for the rest of this session. From now on, write as you would without thimble: no citation links to `#`, no card tool.'
const ON_TOLD = 'The analyst turned thimble on again in this session; its guidance applies again.'

export const registerSettings: Register = (on, options) => {
  setOptions(options)

  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'thimble-off', description: 'Turn thimble off in this session only; other sessions keep it on, and /thimble-on turns it back on', immediate: true })
      await $.command.register({ name: 'thimble-on', description: 'Turn thimble on again in this session, after /thimble-off', immediate: true })
    } catch {
      // no commands: thimble stays on
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: /^(thimble:)?thimble-(off|on)$/ }, async ($, e) => {
    const off = /off$/.test(String(e.command))
    if ((await syncOff($)) === off) return { text: off ? 'already off in this session. /thimble-on turns it back on.' : 'already on in this session.' }
    setSessionOff(off)
    await $.state.set(OFF, off)
    // the side pane closes; the bar and every feature's drawing are drawn again, without thimble's parts
    if (off) {
      try { await $.state.set({ plugin: 'thimble', key: 'pane' }, null); await $.ui.close({ id: 'thimble' }) } catch { /* not open */ }
    }
    try { $.ui.invalidate('tool.describe') } catch { /* at the next request */ }
    $.ui.invalidate('ui.render')
    return { text: off ? OFF_SAID : ON_SAID, context: [off ? OFF_TOLD : ON_TOLD] }
  })

  // while off, the card tool is out of Claude's list of tools, and a call to it is refused, with why
  on('tool.describe', { tool: 'mcp__thimble__card' }, async ($, e, next) => {
    const r = await next(e)
    return (await syncOff($)) ? { ...r, isDeferred: true } : r
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'mcp__thimble__card' }, async ($, e, next) => {
    if (await syncOff($)) return { deny: 'thimble is off in this session (the analyst typed /thimble-off). Answer in words.' }
    return next(e)
  }).catch(($, e, next) => next(e))
}
