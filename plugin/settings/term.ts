// term.ts: thimble's features in the terminal. The plugin's userConfig (.claude-plugin/plugin.json) declares one
// field per feature (settings/features.mjs): a boolean, or a string of its modes, so Claude Code keeps their values in
// settings.json and hands them to register(on, options); every module asks featureOn(key) when it acts.
//
//   heldValues($)          each feature's value as Claude Code holds it now (a change made a moment ago included)
//   settingsAction($, a)   turn a feature on or off (`toggle`; a feature with modes goes to its next mode), or set its
//                          mode (`set`), through Claude Code ($.config.set), which keeps the value and loads the plugin
//                          again with the new options; a refusal is one line with its fix. Minimal is a preset: on, it
//                          sets its rows' modes (features.mjs PRESET), keeping theirs (store: beforeMinimal); off puts
//                          them back; one of its rows changed away from its mode turns it off
//
// The fields newer settings replaced (features.mjs RETIRED) stay in the manifest, hidden from /config, so a value saved
// under them reaches the plugin: the first interactive session moves it to the settings that replaced it and sets them
// back to their defaults. A setting the person changes moves them first too. A default that moved (features.mjs
// DEFAULTS) is saved the same way, once: a value at the old default takes the new one, and the hidden field defaultsAt
// says it was done.
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { DEFAULTS, DEFAULTS_FIELD, PRESET, RENAMED, RETIRED, SWITCHES, atDefault, atPreset, currentValues, movedFrom, noteChange, noteDefaults, noteSettled, renamedTo, setOptions, switchOf, valueIn } from './features.mjs'

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
  // with defaultsAt, so the values read again (the bar's preview, Minimal's rows) read a moved default as these do
  const at = typeof values.defaultsAt === 'string' ? { defaultsAt: values.defaultsAt } : {}
  return { ...Object.fromEntries(SWITCHES.map(s => [s.key, valueIn(values, s.key) as boolean | string])), ...at }
}

/** Turn a feature on or off, or set a feature's mode. A refusal is said in one line with its fix; nothing changes then. */
export async function settingsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  if ((a.do !== 'toggle' && a.do !== 'set') || typeof a.key !== 'string') return false
  const s = switchOf(a.key)
  if (!s) return `× thimble has no feature "${a.key}".`
  const now = (await heldValues($))[s.key]
  const to = a.do === 'set' ? a.value : s.choices ? s.choices[(s.choices.indexOf(now as string) + 1) % s.choices.length] : !now
  if (s.choices ? !s.choices.includes(to as string) : typeof to !== 'boolean') return `× ${s.title} has no setting "${String(to)}".`
  if (to === now) return
  // a value the retired fields still hold, and a default that moved, are saved first, so the change stands over them
  await moveRetired($, currentValues()).catch(() => undefined)
  await moveDefaults($).catch(() => undefined)
  const held = await heldValues($)
  if (s.key === 'minimal') return to ? minimalOn($, held) : minimalOff($, held)
  const denied = await setRow($, s.key, to as boolean | string)
  if (denied) return denied
  // a row of Minimal's changed away from it: Minimal is off, and this row's new mode stays
  if (held.minimal === true && s.key in PRESET && to !== (PRESET as Record<string, string>)[s.key]) {
    await $.store.set(BEFORE, null)
    await setRow($, 'minimal', false)
  }
}

/** The modes of Minimal's rows from before it went on (store), which turning it off puts back. */
const BEFORE = 'beforeMinimal'

/** Set one feature through Claude Code; this load acts on it at once, before the plugin loads again with it. A
 *  refusal is its line; nothing changes then. */
async function setRow($: Engine, key: string, to: boolean | string): Promise<string | void> {
  const s = switchOf(key)!
  const r = (await configRows($)).get(key)
  if (!r) return `× Claude Code has not loaded thimble's settings, so ${s.title} cannot change now. Load thimble again in /plugin, then try once more.`
  if (r.isLocked) return `× ${s.title} is set by your organization's settings, so it cannot change here.`
  if (r.value === to) { noteChange(key, to); return }
  const res = await $.config.set({ key: r.key, value: to })
  if (res.deny) return `× ${s.title} did not change: ${res.deny}`
  noteChange(key, to)
  $.ui.invalidate('ui.render')
}

/** Minimal on: the modes of its rows now are kept, its modes set (PRESET), then Minimal. */
async function minimalOn($: Engine, held: Record<string, boolean | string>): Promise<string | void> {
  if (!atPreset(held)) await $.store.set(BEFORE, Object.fromEntries(Object.keys(PRESET).map(k => [k, held[k]])))
  for (const [k, v] of Object.entries(PRESET)) {
    const denied = await setRow($, k, v)
    if (denied) return denied
  }
  return setRow($, 'minimal', true)
}

/** Minimal off: the modes its rows had before it went on come back (their defaults when none were kept), where a row
 *  still holds Minimal's mode. */
async function minimalOff($: Engine, held: Record<string, boolean | string>): Promise<string | void> {
  const denied = await setRow($, 'minimal', false)
  if (denied) return denied
  const kept = ((await $.store.get(BEFORE)) ?? {}) as Record<string, boolean | string>
  for (const [k, v] of Object.entries(PRESET)) {
    if (held[k] !== v) continue
    const back = valueIn(kept, k)
    if (back !== v) await setRow($, k, back as boolean | string)
  }
  await $.store.set(BEFORE, null)
}

/** Minimal saved on while its rows hold other modes: from before it was a preset (0.10.4), its modes are set once,
 *  what the rows held kept; once it was (the modes kept), a row changed elsewhere (/config) turns it off. */
export async function settleMinimal($: Engine): Promise<void> {
  const held = await heldValues($)
  if (held.minimal !== true || atPreset(held)) return
  if ((await $.store.get(BEFORE)) == null) await minimalOn($, held)
  else { await $.store.set(BEFORE, null); await setRow($, 'minimal', false) }
}

/** A retired field's row key, beside a feature's row key (`<plugin>.<field>`). */
const retiredKey = (featureKey: string, field: string) => featureKey.replace(/\.[^.]+$/, `.${field}`)

/** A value saved under the retired fields (`saved`), moved to the settings that replaced it where those hold their
 *  defaults, and the retired fields set back to theirs (a hidden row still takes $.config.set), so only the new settings
 *  say what the plugin does. Once: afterwards the retired fields hold their defaults and nothing moves. */
async function moveRetired($: Engine, saved: Record<string, unknown>): Promise<void> {
  const moved = movedFrom(saved) as Record<string, boolean | string>
  const stale = Object.entries(RETIRED).filter(([field, f]) => saved[field] !== undefined && saved[field] !== f.default)
  const renamed = Object.keys(RENAMED).filter(key => renamedTo(key, saved[key]))
  if (!stale.length && !renamed.length) return
  const rows = await configRows($)
  const any = rows.values().next().value as ConfigRow | undefined
  if (!any) return
  // a mode saved under its old name is saved under its new one
  for (const key of renamed) {
    const r = rows.get(key)
    const to = renamedTo(key, r?.value)
    if (r && !r.isLocked && to) await $.config.set({ key: r.key, value: to }).catch(() => undefined)
  }
  for (const [key, value] of Object.entries(moved)) {
    const r = rows.get(key)
    if (r && !r.isLocked && atDefault(key, r.value)) await $.config.set({ key: r.key, value }).catch(() => undefined)
  }
  for (const [field, f] of stale) await $.config.set({ key: retiredKey(any.key, field), value: f.default }).catch(() => undefined)
  noteSettled()
}

/** A default that moved, saved once where the setting holds the old default (and no retired field's value stands for
 *  it), then defaultsAt set, so a value the person sets afterwards stays. While no default moved, nothing is saved:
 *  each save loads the plugin again, and Claude Code says so in the conversation. */
async function moveDefaults($: Engine): Promise<void> {
  const saved = currentValues()
  if (saved.defaultsAt === DEFAULTS.at || !Object.keys(DEFAULTS.moved).length) return
  const rows = await configRows($)
  const any = rows.values().next().value as ConfigRow | undefined
  if (!any) return
  const moved = movedFrom(saved) as Record<string, unknown>
  for (const [key, m] of Object.entries(DEFAULTS.moved)) {
    const r = rows.get(key)
    // this load's copy says what stands now (a value the retired fields saved has just moved into it)
    if (r && !r.isLocked && saved[key] === m.from && r.value === m.from && !(key in moved)) await $.config.set({ key: r.key, value: m.to }).catch(() => undefined)
  }
  await $.config.set({ key: retiredKey(any.key, 'defaultsAt'), value: DEFAULTS.at }).catch(() => undefined)
  noteDefaults()
}

export const registerSettings: Register = (on, options) => {
  setOptions(options)
  // the retired fields, and defaultsAt, stay out of /config
  on('config.describe', async ($, e, next) => {
    const m = /^(.+)\.([^.]+)$/.exec(e.key)
    const ours = m && (m[1] === $.plugin.name || m[1]!.startsWith(`${$.plugin.name}@`))
    return ours && (m![2]! in RETIRED || m![2]! in DEFAULTS_FIELD) ? next({ ...e, isHidden: true }) : next(e)
  }).catch(($, e, next) => next(e))
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    await moveRetired($, currentValues()).catch(() => undefined)
    await moveDefaults($).catch(() => undefined)
    await settleMinimal($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))
}
