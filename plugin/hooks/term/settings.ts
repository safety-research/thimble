// The feature switches (SPEC-v2 3.6), kept in step between `/config` → thimble (the plugin's userConfig, which the
// module gets as `options`) and thimble's config file (`<home>/config.json`, which the browser's Settings writes and
// `thimble features` reads and sets, C6). Written for Claude Code 2.1.301:
//   - `config.set` fires before the write, so inside it `options` still holds the old value: the push takes `e.value`
//   - a /config change and `$.config.set` reload the whole module, and the new copy's `session.start` runs again
//   - $.store keeps `settings.synced`, the values thimble held at the last sync, across reloads and sessions
// The push: a person's /config change of a thimble row in an active session runs `thimble features --set` from the
// config.set hook. The compare and pull (session.start of an active session, activation, and the tick when config.json
// changed): fields of `options` that differ from `synced` are pushed; thimble's values are read; `synced` is written to
// $.store first (the next step reloads the module, and the old copy may run no other line); each field thimble holds
// otherwise is set in /config with $.config.set; the reloaded copy then finds `options` equal to `synced` and stops.
// Before activation nothing here runs a process: "Turn on when Claude reads data" is read from config.json.
import type { PluginOptions } from 'claude-code'

import { FEATURE_KEYS, FEATURES_ON } from './contracts'
import type { FeatureKey, FeatureSettings } from './contracts'
import type { Ctx } from './ctx'
import { homeOf, parsePrinted } from './data'
import { rt } from './term'

/** The $.store key of the values thimble held at the last sync. */
export const SYNCED_KEY = 'settings.synced'
const FEATURES_TIMEOUT_MS = 30_000

/** What this module copy holds: the `/config` values it was loaded with, thimble's values as last read, and the
 *  config.json mtime the tick last saw. */
const mem = {
  options: {} as Partial<FeatureSettings>,
  now: null as FeatureSettings | null,
  configMtime: 0,
  syncing: false,
}

/** The /config values this module copy was loaded with (register's `options`): the seven switches, booleans only. */
export function setOptions(options: PluginOptions | undefined): void {
  const out: Partial<FeatureSettings> = {}
  for (const k of FEATURE_KEYS) if (typeof options?.[k] === 'boolean') out[k] = options[k] as boolean
  mem.options = out
}

/** The /config values as loaded, defaults filled in. */
export function optionsNow(): FeatureSettings {
  return { ...FEATURES_ON, ...mem.options }
}

/** Settings as JSON holds them: each of the seven a boolean, an unknown or missing one at its default. */
export function settingsOf(v: unknown): FeatureSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out = { ...FEATURES_ON }
  for (const k of FEATURE_KEYS) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean
  return out
}

/** The switches as they stand now (C13): thimble's as last read, else the /config values. */
export async function settingsNow(cx: Ctx): Promise<FeatureSettings> {
  return mem.now ?? (await cx.settings()) ?? optionsNow()
}

/** One switch now, without a read: thimble's as last read, else /config's. */
export function featureOn(key: FeatureKey): boolean {
  return (mem.now ?? optionsNow())[key]
}

/** "Turn on when Claude reads data" before activation (3.3): `options` when it differs from what was last synced (a
 *  /config change thimble's config has not heard of), else config.json's `features.autoActivate`, else `options`. One
 *  file read, no process. */
export async function autoActivateOf(cx: Ctx, home?: string): Promise<boolean> {
  const opts = optionsNow()
  const synced = (await cx.storeGet(SYNCED_KEY)) as Partial<FeatureSettings> | undefined
  const unpushed = synced && typeof synced.autoActivate === 'boolean' ? opts.autoActivate !== synced.autoActivate : opts.autoActivate !== FEATURES_ON.autoActivate
  if (unpushed) return opts.autoActivate
  try {
    const config = JSON.parse(await cx.read(`${home ?? (await homeOf(cx))}/config.json`)) as { features?: { autoActivate?: unknown } }
    const v = config?.features?.autoActivate
    return typeof v === 'boolean' ? v : FEATURES_ON.autoActivate
  } catch {
    return opts.autoActivate
  }
}

/** `thimble features [--set k=on|off …] --json` (C6): thimble's values after it, or why not. */
async function features(cx: Ctx, sets: readonly string[]): Promise<{ settings: FeatureSettings | null; error: string }> {
  const sc = rt.sc
  if (!sc) return { settings: null, error: 'thimble is not on' }
  try {
    const r = await cx.run([sc.bin, 'features', '--cwd', sc.cwd, '--json', ...sets.flatMap(s => ['--set', s])], { cwd: sc.cwd, env: sc.env, timeoutMs: FEATURES_TIMEOUT_MS })
    const got = parsePrinted(r)
    if (!got.ok) return { settings: null, error: got.error }
    return { settings: settingsOf((got.value as { settings?: unknown }).settings), error: '' }
  } catch (err) {
    return { settings: null, error: String(err).slice(0, 300) }
  }
}

/** The push of one /config change (the `config.set` hook of a person's change, in an active session): thimble's config
 *  takes `value` (the row's new value: `options` still holds the old one there), and `synced` follows, so the reloaded
 *  copy pushes nothing again. */
export async function pushChange(cx: Ctx, key: string, value: unknown): Promise<void> {
  const field = key.replace(/^thimble\./, '') as FeatureKey
  if (!FEATURE_KEYS.includes(field) || typeof value !== 'boolean') return
  const got = await features(cx, [`${field}=${value ? 'on' : 'off'}`])
  if (!got.settings) return void cx.log(`thimble: the ${field} switch did not reach thimble's config: ${got.error}`)
  mem.now = got.settings
  await cx.storeSet(SYNCED_KEY, got.settings)
}

/** The compare and pull (see the file's head); `changed` tells which switches flipped (the guide follows labels and
 *  checks). Returns thimble's values, or null when they could not be read. */
export async function syncSettings(cx: Ctx, changed?: (before: FeatureSettings | null, after: FeatureSettings) => void): Promise<FeatureSettings | null> {
  if (!rt.sc || mem.syncing) return null
  mem.syncing = true
  try {
    const opts = optionsNow()
    const synced = (await cx.storeGet(SYNCED_KEY)) as Partial<FeatureSettings> | undefined
    // (1) /config changes not yet pushed: against what was synced last, or before any sync against the defaults (a row
    // the person changed in /config before thimble was ever on)
    const base = { ...FEATURES_ON, ...settingsOf(synced ?? FEATURES_ON) }
    const sets = FEATURE_KEYS.filter(k => opts[k] !== base[k]).map(k => `${k}=${opts[k] ? 'on' : 'off'}`)
    // (2) thimble's values
    const got = await features(cx, sets)
    if (!got.settings) {
      cx.log(`thimble: its settings could not be read: ${got.error}`)
      return null
    }
    const before = mem.now
    const now = got.settings
    mem.now = now
    // (3) synced first: the next step reloads the module
    await cx.storeSet(SYNCED_KEY, now)
    await cx.setSettings(now)
    changed?.(before, now)
    // (4) /config follows thimble
    for (const k of FEATURE_KEYS) {
      if (now[k] === opts[k]) continue
      const r = await cx.configSet(`thimble.${k}`, now[k])
      if (r.deny) cx.log(`thimble: /config → thimble → ${k} was not changed: ${r.deny}`)
    }
    return now
  } finally {
    mem.syncing = false
  }
}

/** What to do when a switch flips, set by register.tsx (the guide owed when labels or checks flip). */
export const onFlip = { run: (before: FeatureSettings | null, after: FeatureSettings): void => void [before, after] }

/** The sync, once the hook that asked has returned (a /config change reloads the module). */
export function syncSoon(cx: Ctx): void {
  // a timer's work after the session ended rejects: nothing waits for it
  cx.later(0, () => void syncSettings(cx, (b, a) => onFlip.run(b, a)).catch(() => undefined))
}

/** The tick's look at config.json: a change since the last look (the browser's Settings) syncs. One stat a second. */
export async function watchConfig(cx: Ctx): Promise<void> {
  if (!rt.sc) return
  const st = await cx.real(`${await homeOf(cx)}/config.json`)
  const mtime = st?.mtimeMs ?? 0
  if (!mem.configMtime) {
    mem.configMtime = mtime
    return
  }
  if (mtime === mem.configMtime) return
  mem.configMtime = mtime
  await syncSettings(cx, (b, a) => onFlip.run(b, a))
}

/** A fresh module copy or session: nothing read yet. */
export function resetSettings(): void {
  mem.now = null
  mem.configMtime = 0
  mem.syncing = false
}
