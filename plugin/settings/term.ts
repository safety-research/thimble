// term.ts: thimble's features in the terminal. The plugin's userConfig (.claude-plugin/plugin.json) declares one
// boolean per feature (settings/features.mjs), so Claude Code keeps their values in settings.json and hands them to
// register(on, options); every module asks featureOn(key) when it acts.
//
//   heldValues($)          each feature's value as Claude Code holds it now (a change made a moment ago included)
//   heldColor($)           thimble's color (settings/features.mjs COLORS) as Claude Code holds it now
//   settingsAction($, a)   turn a feature on or off, or pick thimble's color, through Claude Code ($.config.set), which
//                          keeps the value and loads the plugin again with the new options; a refusal is one line with
//                          its fix
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { COLOR, SWITCHES, colorNow, colorOf, featureOn, noteChange, setOptions, switchOf } from './features.mjs'

type Engine = EngineInterface

/** Claude Code's rows of thimble's features, by feature: `<plugin>.<field>` (a --plugin-dir plugin may be
 *  `<plugin>@inline.<field>`). */
async function configRows($: Engine): Promise<Map<string, ConfigRow>> {
  const out = new Map<string, ConfigRow>()
  for (const r of await $.config.list()) {
    const m = /^(.+)\.([^.]+)$/.exec(r.key)
    if (!m || (!switchOf(m[2]!) && m[2] !== COLOR.key)) continue
    if (m[1] !== $.plugin.name && !m[1]!.startsWith(`${$.plugin.name}@`)) continue
    out.set(m[2]!, r)
  }
  return out
}

/** Each feature's value as Claude Code holds it now: a change made a moment ago is here before the plugin loads again
 *  with it. A feature Claude Code lists no value for has the value this load runs with. */
export async function heldValues($: Engine): Promise<Record<string, boolean>> {
  const rows = await configRows($).catch(() => new Map<string, ConfigRow>())
  return Object.fromEntries(SWITCHES.map(s => {
    const r = rows.get(s.key)
    return [s.key, r && typeof r.value === 'boolean' ? r.value : featureOn(s.key)]
  }))
}

/** thimble's color as Claude Code holds it now (a pick made a moment ago included): the name of one of COLORS. */
export async function heldColor($: Engine): Promise<string> {
  const r = (await configRows($).catch(() => new Map<string, ConfigRow>())).get(COLOR.key)
  return r && colorOf(r.value) ? String(r.value) : colorNow()
}

/** Pick thimble's color by its name. A refusal is said in one line with its fix; nothing changes then. */
async function pickColor($: Engine, name: unknown): Promise<string | void> {
  const c = colorOf(name)
  if (!c) return `× thimble has no color "${String(name)}".`
  const r = (await configRows($)).get(COLOR.key)
  if (!r) return `× Claude Code has not loaded thimble's settings, so its color cannot change now. Load thimble again in /plugin, then try once more.`
  if (r.isLocked) return `× thimble's color is set by your organization's settings, so it cannot change here.`
  const res = await $.config.set({ key: r.key, value: c.name })
  if (res.deny) return `× thimble's color stayed ${await heldColor($)}: ${res.deny}`
  // drawn at once, before the plugin loads again with it
  noteChange(COLOR.key, c.name)
  $.ui.invalidate('ui.render')
}

/** Turn a feature on or off (`do: 'toggle'`, `key`), or pick thimble's color (`do: 'color'`, `name`). A refusal is said
 *  in one line with its fix; nothing changes then. */
export async function settingsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  if (a.do === 'color') return pickColor($, a.name)
  if (a.do !== 'toggle' || typeof a.key !== 'string') return false
  const s = switchOf(a.key)
  if (!s) return `× thimble has no feature "${a.key}".`
  const r = (await configRows($)).get(s.key)
  if (!r) return `× Claude Code has not loaded thimble's settings, so ${s.title} cannot change now. Load thimble again in /plugin, then try once more.`
  if (r.isLocked) return `× ${s.title} is set by your organization's settings, so it cannot change here.`
  const to = !(typeof r.value === 'boolean' ? r.value : featureOn(s.key))
  const res = await $.config.set({ key: r.key, value: to })
  if (res.deny) return `× ${s.title} stayed ${to ? 'off' : 'on'}: ${res.deny}`
  // acted on at once, before the plugin loads again with it
  noteChange(s.key, to)
  $.ui.invalidate('ui.render')
}

export const registerSettings: Register = (_on, options) => {
  setOptions(options)
}
