// term.ts: thimble's features in the terminal. The plugin's userConfig (.claude-plugin/plugin.json) declares one
// field per feature (settings/features.mjs): a boolean, or a string of its modes, so Claude Code keeps their values in
// settings.json and hands them to register(on, options); every module asks featureOn(key) when it acts.
//
//   heldValues($)          each feature's value as Claude Code holds it now (a change made a moment ago included)
//   settingsAction($, a)   turn a feature on or off (`toggle`; a feature with modes goes to its next mode), or set its
//                          mode (`set`), through Claude Code ($.config.set), which keeps the value and loads the plugin
//                          again with the new options; a refusal is one line with its fix
//
// The fields Citations replaced (features.mjs RETIRED) stay in the manifest, hidden from /config, so a value saved under
// them reaches the plugin: the first interactive session moves it to Citations and sets them back to their defaults.
// Setting Citations sets them back too.
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { RETIRED, SWITCHES, choiceOf, citationsFrom, noteChange, retiredValues, setOptions, switchOf } from './features.mjs'

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
  if (s.key === 'citations') await retiredToDefaults($, r.key, retiredValues())
  // acted on at once, before the plugin loads again with it
  noteChange(s.key, to)
  $.ui.invalidate('ui.render')
}

/** A retired field's row key, beside the Citations row's (`<plugin>.citations`). */
const retiredKey = (citationsKey: string, field: string) => citationsKey.replace(/\.citations$/, `.${field}`)

/** The retired fields that hold a saved value (`saved`, as this load has them) back to their defaults (a hidden row
 *  still takes $.config.set), so only Citations says how the plugin cites. */
async function retiredToDefaults($: Engine, citationsKey: string, saved: Record<string, unknown>): Promise<void> {
  for (const [field, f] of Object.entries(RETIRED)) {
    if (saved[field] === undefined || saved[field] === f.default) continue
    await $.config.set({ key: retiredKey(citationsKey, field), value: f.default }).catch(() => undefined)
  }
}

/** A value saved under the retired fields, moved to Citations: once, at the first interactive session that has one. */
async function moveRetired($: Engine, options: Record<string, unknown>): Promise<void> {
  const mode = citationsFrom(options)
  if (!mode) return
  const r = (await configRows($)).get('citations')
  if (!r || r.isLocked) return
  if (r.value === switchOf('citations')!.default) await $.config.set({ key: r.key, value: mode })
  await retiredToDefaults($, r.key, options)
}

export const registerSettings: Register = (on, options) => {
  setOptions(options)
  // the retired fields stay out of /config
  on('config.describe', async ($, e, next) => {
    const m = /^(.+)\.([^.]+)$/.exec(e.key)
    const ours = m && (m[1] === $.plugin.name || m[1]!.startsWith(`${$.plugin.name}@`))
    return ours && m![2]! in RETIRED ? next({ ...e, isHidden: true }) : next(e)
  }).catch(($, e, next) => next(e))
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    await moveRetired($, (options ?? {}) as Record<string, unknown>).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))
}
