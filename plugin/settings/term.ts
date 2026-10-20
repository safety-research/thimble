// term.ts: thimble's switches in the terminal. The plugin's userConfig (.claude-plugin/plugin.json) declares one
// boolean per feature (settings/features.mjs), so Claude Code lists them in /config and /plugin and keeps their values
// in settings.json; register(on, options) hands the values in, and every module asks featureOn(key) when it acts.
//
// The settings panel lists the same switches in the side panel (panes/settings.js): /thimble-settings, or a click on
// `thimble` at the bar's left, opens it. (/thimble is the skill's own command, and /settings is Claude Code's /config.) ↵ or a click turns one on or off through Claude Code ($.config.set), so the
// value is kept where /config keeps it, and Claude Code loads the plugin again with the new options.
//
// Each row says what the switch costs: in this session, from its events (telemetry/events.mjs summarize: the
// observer's calls against the main turns, each lens's share of the calls), else a typical word from features.mjs.
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { SWITCHES, ownValue, setOptions, switchOf } from './features.mjs'
import { openSide } from '../shell/side'
import { eventsFile, parseLines, summarize } from '../telemetry/events.mjs'
import { sessionKey } from '../hooks/conversation'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const pct = (part: number) => (part >= 0.995 ? '100%' : part < 0.01 ? 'under 1%' : `${Math.round(100 * part)}%`)

/** The settings panel in the side panel, over what it shows (esc goes back to it). */
export async function openSettings($: Engine): Promise<boolean> {
  return openSide($, { pane: 'settings', args: {}, title: 'thimble settings' }, { push: true })
}

/** The /config rows of thimble's switches, by switch: `<plugin>.<field>` (a --plugin-dir plugin may be
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

type Costs = { looks: number; w: number; main: number; lenses: Record<string, number> }

/** This session's costs so far, in price-weighted tokens, from its events: the main turns, the observer's calls, and
 *  each lens's share of those calls. Null when there are none yet. */
async function costsNow($: Engine): Promise<Costs | null> {
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  const file = eventsFile(home, await sessionKey($))
  if (!(await $.fs.exists(file))) return null
  const s = summarize(parseLines(String(await $.fs.read(file)))) as Any
  const obs = s.features.observer
  if (!obs?.calls) return null
  return { looks: obs.calls, w: obs.w, main: s.features['main turns']?.w ?? 0, lenses: Object.fromEntries(Object.entries(obs.lenses ?? {}).map(([n, L]) => [n, (L as Any).w])) }
}

/** What a switch costs, in words: measured in this session where it can be, else the typical word. */
function costOf(key: string, lens: string | undefined, c: Costs | null): string {
  const s = switchOf(key)!
  if (key === 'observer' && c && c.main > 0) return `This session: ${c.looks} look${c.looks === 1 ? '' : 's'}, ${pct(c.w / c.main)} of what the main turns cost.`
  if (lens && c && c.w > 0 && c.lenses[lens] != null) return `This session: about ${pct(c.lenses[lens]! / c.w)} of what the observer cost.`
  return s.costs
}

/** The panel's store: each switch with its value (as Claude Code holds it now), its words and its cost. */
export async function settingsStore($: Engine): Promise<Any> {
  const rows = await configRows($).catch(() => new Map<string, ConfigRow>())
  const costs = await costsNow($).catch(() => null)
  const valueOf = (key: string) => {
    const r = rows.get(key)
    return r && typeof r.value === 'boolean' ? r.value : ownValue(key)
  }
  return {
    switches: SWITCHES.map(s => ({
      key: s.key, title: s.title, group: s.group, under: s.under ?? null, does: s.does,
      costs: costOf(s.key, s.lens, costs),
      on: valueOf(s.key),
      parentOn: s.under ? valueOf(s.under) : true,
      locked: !!rows.get(s.key)?.isLocked,
      // the value Claude Code holds is not the one this load runs with yet: the plugin is loading again
      pending: valueOf(s.key) !== ownValue(s.key),
    })),
  }
}

/** What the panel asks: turn a switch on or off. A refusal is said in one line; nothing changes then. */
export async function settingsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  if (a.do !== 'toggle' || typeof a.key !== 'string') return false
  const s = switchOf(a.key)
  if (!s) return `× thimble has no setting "${a.key}".`
  const r = (await configRows($)).get(s.key)
  if (!r) return `× Claude Code lists no setting for ${s.title}. Change it in /config, or load thimble again with /plugin.`
  if (r.isLocked) return `× ${s.title} is set by your organization's settings, so it cannot change here.`
  const to = !(typeof r.value === 'boolean' ? r.value : ownValue(s.key))
  const res = await $.config.set({ key: r.key, value: to })
  if (res.deny) return `× ${s.title} stayed ${to ? 'off' : 'on'}: ${res.deny}`
}

export const registerSettings: Register = (on, options) => {
  setOptions(options)

  on('session.start', { cwd: /.+/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'thimble-settings', description: "thimble's settings: turn the observer, each of its parts, catch-up and the bar's counts on or off", immediate: true })
    } catch {
      // /config still lists the switches
    }
    return r
  })

  on('command.run', { command: 'thimble-settings' }, async ($) => {
    await openSettings($)
    return {}
  })
}
