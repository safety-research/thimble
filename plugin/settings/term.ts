// term.ts: thimble's features in the terminal. The plugin's userConfig (.claude-plugin/plugin.json) declares one
// boolean per feature (settings/features.mjs), so Claude Code keeps their values in settings.json and hands them to
// register(on, options); every module asks featureOn(key) when it acts.
//
// The settings panel lists the features in the side panel (panes/settings.js): /thimble-settings, or a click on
// `thimble` at the bar's left, opens it. ↵ or a click turns one on or off through Claude Code ($.config.set), which
// keeps the value and loads the plugin again with the new options. Above the list the panel shows the bar as the
// features leave it (shell.tsx barPreviewEl), from the values Claude Code holds now (heldValues), so it changes at once.
//
// The panel's last line says what the call after each reply costs, in this session where its events say
// (telemetry/events.mjs summarize: the observer's calls against the main turns).
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { SWITCHES, noteChange, ownValue, setOptions, switchOf, switchesFrom } from './features.mjs'
import { openSide } from '../shell/side'
import { eventsFile, parseLines, summarize } from '../telemetry/events.mjs'
import { sessionKey } from '../hooks/conversation'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// the feature the panel changed last: a change loads the plugin again, and the panel keeps it selected through that
const LAST = { plugin: 'thimble', key: 'setlast' } as const

const pct = (part: number) => (part >= 0.995 ? '100%' : part < 0.01 ? 'under 1%' : `${Math.round(100 * part)}%`)

/** The settings panel in the side panel, over what it shows (esc goes back to it). */
export async function openSettings($: Engine): Promise<boolean> {
  return openSide($, { pane: 'settings', args: {}, title: 'thimble settings' }, { push: true })
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
 *  with it. A feature Claude Code lists no value for has the value this load runs with. */
export async function heldValues($: Engine): Promise<Record<string, boolean>> {
  const rows = await configRows($).catch(() => new Map<string, ConfigRow>())
  return Object.fromEntries(SWITCHES.map(s => {
    const r = rows.get(s.key)
    return [s.key, r && typeof r.value === 'boolean' ? r.value : ownValue(s.key)]
  }))
}

/** This session's call after each reply so far: how many, and their price-weighted tokens against the main turns'.
 *  Null when there are none yet. */
async function costsNow($: Engine): Promise<{ looks: number; w: number; main: number } | null> {
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  const file = eventsFile(home, await sessionKey($))
  if (!(await $.fs.exists(file))) return null
  const s = summarize(parseLines(String(await $.fs.read(file)))) as Any
  const obs = s.features.observer
  if (!obs?.calls) return null
  return { looks: obs.calls, w: obs.w, main: s.features['main turns']?.w ?? 0 }
}

/** What the features that read answers cost together, in one line: they share one model call after each reply. */
export function costLine(values: Record<string, boolean>, c: { looks: number; w: number; main: number } | null): string {
  const none = SWITCHES.filter(s => !s.lenses.length).map(s => s.title)
  const which = none.length ? `All features but ${none.join(' and ')}` : 'These features'
  if (!switchesFrom(values)('observer')) return `${which} share one model call after each reply. With all of them off, thimble makes no such call.`
  const measured = c && c.main > 0 ? ` This session: ${c.looks} call${c.looks === 1 ? '' : 's'}, ${pct(c.w / c.main)} of what Claude's own turns cost.` : ''
  return `${which} share one model call after each reply.${measured}`
}

/** The panel's store: each feature with its value (as Claude Code holds it now) and its words, and the cost line. */
export async function settingsStore($: Engine): Promise<Any> {
  const rows = await configRows($).catch(() => new Map<string, ConfigRow>())
  const values = await heldValues($)
  const costs = await costsNow($).catch(() => null)
  return {
    switches: SWITCHES.map(s => ({
      key: s.key, title: s.title, group: s.group ?? null, surfaces: s.surfaces ?? [], does: s.does, bar: s.bar ?? [],
      on: values[s.key],
      locked: !!rows.get(s.key)?.isLocked,
      // the value Claude Code holds is not the one this load runs with yet: the plugin is loading again
      pending: values[s.key] !== ownValue(s.key),
    })),
    last: ((await $.state.get(LAST)).value as string | null | undefined) ?? null,
    cost: costLine(values, costs),
  }
}

/** What the panel asks: turn a feature on or off. A refusal is said in one line with its fix; nothing changes then. */
export async function settingsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  if (a.do !== 'toggle' || typeof a.key !== 'string') return false
  const s = switchOf(a.key)
  if (!s) return `× thimble has no feature "${a.key}".`
  const r = (await configRows($)).get(s.key)
  if (!r) return `× Claude Code has not loaded thimble's settings, so ${s.title} cannot change now. Load thimble again in /plugin, then try once more.`
  if (r.isLocked) return `× ${s.title} is set by your organization's settings, so it cannot change here.`
  const to = !(typeof r.value === 'boolean' ? r.value : ownValue(s.key))
  // kept before the change, which loads the plugin again
  await $.state.set(LAST, s.key)
  const res = await $.config.set({ key: r.key, value: to })
  if (res.deny) return `× ${s.title} stayed ${to ? 'off' : 'on'}: ${res.deny}`
  // acted on at once, before the plugin loads again with it: the panel, its preview and the real bar draw again now
  noteChange(s.key, to)
  $.ui.invalidate('ui.render')
}

export const registerSettings: Register = (on, options) => {
  setOptions(options)

  on('session.start', { cwd: /.+/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'thimble-settings', description: "thimble's settings: turn cards, squeeze, explainers, important details, claims and the bar's counts on or off", immediate: true })
    } catch {
      // a click on `thimble` at the bar's left still opens the panel
    }
    return r
  })

  on('command.run', { command: 'thimble-settings' }, async ($) => {
    await openSettings($)
    return {}
  })
}
