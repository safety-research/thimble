// Model ids as the UI names them, and the models a chat can pick from.
import type { ModelConf, Settings } from './types'

/** A model id without its `[…]` tag: `claude-opus-5-5[1m]` → `claude-opus-5-5`. The `[1m]` tag asks Claude Code for
 * the 1M-token context window of the same model, which the server adds for the orientation (backend
 * config.long_context), so a menu names each model once, by this id. Pure. */
export function baseModel(id: string | null | undefined): string {
  return (id ?? '').trim().replace(/\[[^\]]*\]$/, '')
}

/** Whether two ids name the same model, whatever their tags. Pure. */
export const sameModel = (a: string | null | undefined, b: string | null | undefined): boolean => !!baseModel(a) && baseModel(a) === baseModel(b)

/** `claude-opus-5` → `Opus 5`, `claude-opus-5-5` → `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`,
 *  `claude-opus-5-5[1m]` → `Opus 5.5` (the tag is left out, baseModel). An id with no version keeps its family word. */
export function modelLabel(id: string): string {
  const raw = baseModel(id)
  if (!raw) return 'model'
  const parts = raw.replace(/^claude[-_]/i, '').split(/[-_]/).filter(Boolean)
  if (!parts.length) return raw
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const version = parts.slice(1).filter((p) => /^\d{1,3}$/.test(p)).join('.')
  return [family, version].filter(Boolean).join(' ')
}

/** The current models by their ids, offered in every model menu. */
export const KNOWN_MODELS: readonly string[] = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']

/** The models GET /settings names across roles plus `current`, then the current models, in first-seen order, each
 * once by its id without a tag (baseModel). */
export function modelChoices(settings: Settings | null | undefined, current?: string | null): string[] {
  const out: string[] = []
  const add = (m: unknown) => {
    const id = typeof m === 'string' ? baseModel(m) : ''
    if (id && !out.includes(id)) out.push(id)
  }
  add(current)
  for (const conf of Object.values(settings?.models ?? {})) add(conf?.model)
  for (const m of KNOWN_MODELS) add(m)
  return out
}

/** Whether a model has fast mode, as Claude Code and the backend tell (config.has_fast_mode): an Opus 5 or Opus 4.8 id,
 * or `opus`, the alias for the current Opus. Pure. */
export function hasFastMode(model: string | null | undefined): boolean {
  const m = (model ?? '').toLowerCase()
  return m.includes('opus-5') || m.includes('opus-4-8') || m.split('[')[0] === 'opus'
}

// ---- the settings, read once per workspace and shared by the composer and the settings popover ----
import { api } from './api'

const cache = new Map<string, Promise<Settings>>()

const listeners = new Set<(ws: string) => void>()

/** GET /settings for `ws`, cached until `invalidateSettings`; `fresh` refetches, and tells whoever shows the settings
 * when the answer differs from the one cached before, so every surface shows the same values. A failed read is not
 * cached. */
export function loadSettings(ws: string, fresh = false): Promise<Settings> {
  if (fresh || !cache.has(ws)) {
    const before = cache.get(ws)
    const p = api.settings(ws).catch((e: unknown) => {
      if (cache.get(ws) === p) cache.delete(ws)
      throw e
    })
    cache.set(ws, p)
    if (before)
      void Promise.all([before.catch(() => null), p])
        .then(([was, now]) => JSON.stringify(was) !== JSON.stringify(now) && listeners.forEach((fn) => fn(ws)))
        .catch(() => undefined)
  }
  return cache.get(ws)!
}

/** Forget the cached settings of `ws` after a save, and tell whoever shows them (the Start gate's effort). */
export const invalidateSettings = (ws: string): void => {
  cache.delete(ws)
  listeners.forEach((fn) => fn(ws))
}

/** Save some of a role's model, effort and fast mode (settings.models: the server merges them into what the role
 * holds), then tell whoever shows the settings, after a failure too, so they show what the server holds. */
export function saveRole(ws: string, role: string, patch: Partial<ModelConf>): Promise<void> {
  return api
    .putSettings(ws, { models: { [role]: patch } })
    .then(() => invalidateSettings(ws))
    .catch((e: unknown) => {
      invalidateSettings(ws)
      throw e
    })
}

/** Save one of the workspace's settings, such as `hide_chat`, then tell whoever shows the settings, after a failure
 * too. */
export function saveSetting(ws: string, key: string, value: unknown): Promise<void> {
  return api
    .putSettings(ws, { [key]: value })
    .then(() => invalidateSettings(ws))
    .catch((e: unknown) => {
      invalidateSettings(ws)
      throw e
    })
}

/** Hear that the settings of a workspace changed; returns the unsubscribe. */
export function onSettingsChange(fn: (ws: string) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
