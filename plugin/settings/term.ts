// term.ts: thimble's features in the terminal. The plugin's userConfig (.claude-plugin/plugin.json) declares one
// field per feature (settings/features.mjs): a boolean, or a string of its modes, so Claude Code keeps their values in
// settings.json and hands them to register(on, options); every module asks featureOn(key) when it acts.
//
//   heldValues($)          each feature's value as Claude Code holds it now (a change made a moment ago included)
//   settingsAction($, a)   turn a feature on or off (`toggle`; a feature with modes goes to its next mode), or set its
//                          mode (`set`), through Claude Code ($.config.set), which keeps the value and loads the plugin
//                          again with the new options; a refusal is one line with its fix
//
// The fields newer settings replaced (features.mjs RETIRED) stay in the manifest, hidden from /config, so a value saved
// under them reaches the plugin: the first interactive session moves it to the settings that replaced it and sets them
// back to their defaults. A setting the person changes moves them first too.
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { RENAMED, RETIRED, SWITCHES, currentValues, movedFrom, noteChange, noteSettled, setOptions, switchOf, valueIn } from './features.mjs'

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
  // a value the retired fields saved stands while the setting that replaced it holds its default
  const values: Record<string, unknown> = currentValues()
  for (const s of SWITCHES) {
    const r = rows.get(s.key)
    if (r && (s.choices ? s.choices.includes(r.value as string) : typeof r.value === 'boolean')) values[s.key] = r.value
  }
  return Object.fromEntries(SWITCHES.map(s => [s.key, valueIn(values, s.key) as boolean | string]))
}

/** Turn a feature on or off, or set a feature's mode. A refusal is said in one line with its fix; nothing changes then. */
export async function settingsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  if ((a.do !== 'toggle' && a.do !== 'set') || typeof a.key !== 'string') return false
  const s = switchOf(a.key)
  if (!s) return `× thimble has no feature "${a.key}".`
  const r = (await configRows($)).get(s.key)
  if (!r) return `× Claude Code has not loaded thimble's settings, so ${s.title} cannot change now. Load thimble again in /plugin, then try once more.`
  if (r.isLocked) return `× ${s.title} is set by your organization's settings, so it cannot change here.`
  const now = (await heldValues($))[s.key]
  const to = a.do === 'set' ? a.value : s.choices ? s.choices[(s.choices.indexOf(now as string) + 1) % s.choices.length] : !now
  if (s.choices ? !s.choices.includes(to as string) : typeof to !== 'boolean') return `× ${s.title} has no setting "${String(to)}".`
  if (to === now) return
  // a value the retired fields still hold moves first, so the change stands over it
  await moveRetired($, currentValues()).catch(() => undefined)
  const res = await $.config.set({ key: r.key, value: to as boolean | string })
  if (res.deny) return `× ${s.title} stayed ${typeof now === 'string' ? now : now ? 'on' : 'off'}: ${res.deny}`
  // acted on at once, before the plugin loads again with it
  noteChange(s.key, to)
  $.ui.invalidate('ui.render')
}

/** A retired field's row key, beside a feature's row key (`<plugin>.<field>`). */
const retiredKey = (featureKey: string, field: string) => featureKey.replace(/\.[^.]+$/, `.${field}`)

/** A value saved under the retired fields (`saved`), moved to the settings that replaced it where those hold their
 *  defaults, and the retired fields set back to theirs (a hidden row still takes $.config.set), so only the new settings
 *  say what the plugin does. Once: afterwards the retired fields hold their defaults and nothing moves. */
async function moveRetired($: Engine, saved: Record<string, unknown>): Promise<void> {
  const moved = movedFrom(saved) as Record<string, boolean | string>
  const stale = Object.entries(RETIRED).filter(([field, f]) => saved[field] !== undefined && saved[field] !== f.default)
  const renamed = (Object.entries(RENAMED) as [string, Record<string, string>][]).filter(([key, names]) => typeof saved[key] === 'string' && names[saved[key] as string])
  if (!stale.length && !renamed.length) return
  const rows = await configRows($)
  const any = rows.values().next().value as ConfigRow | undefined
  if (!any) return
  // a mode saved under its old name is saved under its new one
  for (const [key, names] of renamed) {
    const r = rows.get(key)
    if (r && !r.isLocked && names[r.value as string]) await $.config.set({ key: r.key, value: names[r.value as string]! }).catch(() => undefined)
  }
  for (const [key, value] of Object.entries(moved)) {
    const r = rows.get(key)
    if (r && !r.isLocked && (r.value === undefined || r.value === switchOf(key)?.default)) await $.config.set({ key: r.key, value }).catch(() => undefined)
  }
  for (const [field, f] of stale) await $.config.set({ key: retiredKey(any.key, field), value: f.default }).catch(() => undefined)
  noteSettled()
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
    await moveRetired($, currentValues()).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))
}
