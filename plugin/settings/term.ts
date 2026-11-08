// term.ts: thimble's features in the terminal. The plugin's userConfig (.claude-plugin/plugin.json) declares one
// field per feature (settings/features.mjs): a boolean, or a string of its modes, so Claude Code keeps their values in
// settings.json and hands them to register(on, options); every module asks featureOn(key) when it acts.
//
//   heldValues($)          each feature's value as Claude Code holds it now (a change made a moment ago included)
//   shownValues($)         the same as the settings show them: Minimal's as it was pressed, while turning it on or off
//                          still changes its rows
//   settingsAction($, a)   turn a feature on or off (`toggle`; a feature with modes goes to its next mode), or set its
//                          mode (`set`), through Claude Code ($.config.set), which keeps the value and loads the plugin
//                          again with the new options; a refusal is one line with its fix. Minimal is a preset: on, it
//                          sets its rows' modes (features.mjs PRESET), keeping theirs (store: beforeMinimal); off puts
//                          them back; one of its rows changed away from its mode turns it off. It makes one change at a
//                          time (store: minimalDoing), each in a hook of its own: a change loads the plugin again, and
//                          the new load's session start makes the next (settleMinimal)
//   firstPartyApi($)       whether Claude Code reaches Claude through Anthropic's first-party API, not Bedrock, Vertex
//                          or Foundry: a setting that names its model ids (features.mjs `firstParty`) works only there
//
// A setting that names first-party model ids is hidden from /config where Claude Code runs on another provider.
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { firstParty } from '../core/models.js'
import { OLD_PRESET, PRESET, RENAMED, SWITCHES, atPreset, currentValues, noteChange, renamedTo, setOptions, switchOf, valueIn } from './features.mjs'

type Engine = EngineInterface

/** Whether Claude Code reaches Claude through Anthropic's first-party API (core/models.js firstParty): none of
 *  CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX and CLAUDE_CODE_USE_FOUNDRY is set to a true value. An engine that
 *  cannot say reads as the first-party API. */
export async function firstPartyApi($: Engine): Promise<boolean> {
  try {
    return firstParty([await $.env.get('CLAUDE_CODE_USE_BEDROCK'), await $.env.get('CLAUDE_CODE_USE_VERTEX'), await $.env.get('CLAUDE_CODE_USE_FOUNDRY')])
  } catch {
    return true
  }
}

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
 *  with it. A feature Claude Code lists no value for has the value this load runs with. A mode saved under its old
 *  name reads as its new one (RENAMED): Claude Code's row keeps it as saved. */
export async function heldValues($: Engine): Promise<Record<string, boolean | string>> {
  const rows = await configRows($).catch(() => new Map<string, ConfigRow>())
  const values: Record<string, unknown> = currentValues()
  for (const s of SWITCHES) {
    const r = rows.get(s.key)
    const v = renamedTo(s.key, r?.value) ?? r?.value
    if (r && (s.choices ? s.choices.includes(v as string) : typeof v === 'boolean')) values[s.key] = v
  }
  return Object.fromEntries(SWITCHES.map(s => [s.key, valueIn(values, s.key) as boolean | string]))
}

/** Each feature's value as the settings show it: as Claude Code holds it (heldValues), but Minimal's while turning it
 *  on or off still changes its rows (DOING), one per load of the plugin: the value it was pressed to, which Claude Code
 *  holds only once the change is done (Minimal is set last on, first off). A press on Minimal is read against this. */
export async function shownValues($: Engine): Promise<Record<string, boolean | string>> {
  const held = await heldValues($)
  const doing = await doingNow($)
  return doing === 'on' || doing === 'off' ? { ...held, minimal: doing === 'on' } : held
}

/** Turn a feature on or off, or set a feature's mode. A refusal is said in one line with its fix; nothing changes then. */
export async function settingsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  if ((a.do !== 'toggle' && a.do !== 'set') || typeof a.key !== 'string') return false
  const s = switchOf(a.key)
  if (!s) return `× thimble has no feature "${a.key}".`
  const now = (await shownValues($))[s.key]
  const to = a.do === 'set' ? a.value : s.choices ? s.choices[(s.choices.indexOf(now as string) + 1) % s.choices.length] : !now
  if (s.choices ? !s.choices.includes(to as string) : typeof to !== 'boolean') return `× ${s.title} has no setting "${String(to)}".`
  if (to === now) return
  const held = await heldValues($)
  if (s.key === 'minimal') return to ? minimalOn($, held) : minimalOff($)
  const denied = await setRow($, s.key, to as boolean | string)
  if (denied) return denied
  // a row of Minimal's changed away from it: Minimal is off, and this row's new mode stays; one changed while Minimal's
  // modes are still being set stops them
  const preset = PRESET as Record<string, boolean | string>
  if (s.key in preset && to !== preset[s.key] && (held.minimal === true || (await doingNow($)) === 'on')) {
    await $.store.set(DOING, null)
    await $.store.set(BEFORE, null)
    if (held.minimal === true) await setRow($, 'minimal', false)
  }
}

/** The modes of Minimal's rows from before it went on (store), which turning it off puts back. */
const BEFORE = 'beforeMinimal'

/** What turning Minimal on or off has left to do (store): `on`, its rows' modes to set, then Minimal; `off`, Minimal,
 *  then the rows' earlier modes to put back. Each change loads the plugin again, and a hook has ten seconds of its own,
 *  which a few loads use up: so each hook makes one change, and the new load's session start makes the next
 *  (settleMinimal). */
const DOING = 'minimalDoing'

/** What turning Minimal on or off has left (DOING); null where the store cannot say. */
async function doingNow($: Engine): Promise<unknown> {
  try { return await $.store.get(DOING) } catch { return null }
}

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

/** Minimal on: the modes of its rows now are kept, over them the earlier modes it kept of the rows it set before
 *  0.10.8 (`kept`); then its modes are set (PRESET), then Minimal, one change at a time (minimalStep). Pressed while
 *  turning Minimal off still puts its rows back, a row that still holds Minimal's mode keeps the mode kept before, as
 *  it was not put back yet, and any other row its mode now (put back, or set by the person since). */
async function minimalOn($: Engine, held: Record<string, boolean | string>, kept: Record<string, boolean | string> = {}): Promise<string | void> {
  const preset = PRESET as Record<string, boolean | string>
  const earlier = (await doingNow($)) == null ? {} : (((await $.store.get(BEFORE)) ?? {}) as Record<string, boolean | string>)
  const keep = (k: string) => (held[k] === preset[k] && k in earlier ? earlier[k] : held[k])
  if (!atPreset(held)) await $.store.set(BEFORE, { ...Object.fromEntries(Object.keys(PRESET).map(k => [k, keep(k)])), ...kept })
  await $.store.set(DOING, 'on')
  return minimalStep($)
}

/** Minimal off: Minimal, then the modes its rows had before it went on (their defaults when none were kept), where a
 *  row still holds Minimal's mode, one change at a time (minimalStep). */
async function minimalOff($: Engine): Promise<string | void> {
  await $.store.set(DOING, 'off')
  return minimalStep($)
}

/** The next change of what turning Minimal on or off has left (DOING): on, the first of its rows that does not hold its
 *  mode yet set to it, else Minimal; off, Minimal, else the first row that still holds Minimal's mode set back to the
 *  mode it had before. Once none is left, nothing is: the store forgets it (and, off, the modes kept). A refusal stops
 *  it. */
async function minimalStep($: Engine): Promise<string | void> {
  const doing = await doingNow($)
  if (doing !== 'on' && doing !== 'off') return
  const held = await heldValues($)
  const preset = PRESET as Record<string, boolean | string>
  const kept = ((await $.store.get(BEFORE)) ?? {}) as Record<string, boolean | string>
  const back = Object.keys(preset).find(k => held[k] === preset[k] && valueIn(kept, k) !== preset[k])
  const unset = Object.keys(preset).find(k => held[k] !== preset[k])
  const change: [string, boolean | string] | null = doing === 'on'
    ? (unset ? [unset, preset[unset]!] : held.minimal !== true ? ['minimal', true] : null)
    : (held.minimal === true ? ['minimal', false] : back ? [back, valueIn(kept, back) as boolean | string] : null)
  if (!change) {
    await $.store.set(DOING, null)
    if (doing === 'off') await $.store.set(BEFORE, null)
    return
  }
  const denied = await setRow($, change[0], change[1])
  if (denied) await $.store.set(DOING, null)
  return denied
}

/** The next change of turning Minimal on or off, when one is left (this load came from the last one). Else Minimal saved
 *  on while its rows hold other modes: from before it was a preset (0.10.4), its modes are set once, what the rows held
 *  kept; as 0.10.4 to 0.10.7 left it (its modes kept, its rows at OLD_PRESET), its modes now are set once, what it kept
 *  still kept; else a row changed elsewhere (/config) turns it off. */
export async function settleMinimal($: Engine): Promise<void> {
  if ((await doingNow($)) != null) { await minimalStep($); return }
  const held = await heldValues($)
  if (held.minimal !== true || atPreset(held)) return
  const kept = (await $.store.get(BEFORE)) as Record<string, boolean | string> | null | undefined
  if (kept == null) await minimalOn($, held)
  else if (atPreset(held, OLD_PRESET)) await minimalOn($, held, kept)
  else { await $.store.set(BEFORE, null); await setRow($, 'minimal', false) }
}

/** A mode saved under its old name (features.mjs RENAMED) saved under its new one. A mode the manifest no longer offers
 *  (Heads-ups' on demand) reaches the plugin as its default, so its row, which keeps it as saved, says it was saved. */
async function saveRenamed($: Engine): Promise<void> {
  const rows = await configRows($)
  for (const key of Object.keys(RENAMED)) {
    const r = rows.get(key)
    const to = renamedTo(key, r?.value)
    if (r && !r.isLocked && to) await $.config.set({ key: r.key, value: to }).catch(() => undefined)
  }
}

export const registerSettings: Register = (on, options) => {
  setOptions(options)
  // a setting of first-party model ids stays out of /config on another provider
  on('config.describe', async ($, e, next) => {
    const m = /^(.+)\.([^.]+)$/.exec(e.key)
    const ours = m && (m[1] === $.plugin.name || m[1]!.startsWith(`${$.plugin.name}@`))
    if (ours && switchOf(m![2]!)?.firstParty && !(await firstPartyApi($))) return next({ ...e, isHidden: true })
    return next(e)
  }).catch(($, e, next) => next(e))
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    await saveRenamed($).catch(() => undefined)
    await settleMinimal($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))
}
