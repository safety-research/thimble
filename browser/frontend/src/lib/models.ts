// Model ids as the UI names them, and the models a chat can pick from.
import type { ModelConf, Settings, SettingsPatch } from './types'

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
export const KNOWN_MODELS: readonly string[] = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-haiku-5-5']

/** The current models in their order, then `current` and the other models GET /settings names across roles, in
 * first-seen order, each once by its id without a tag (baseModel): every menu lists the models in the same order,
 * whichever one is picked. */
export function modelChoices(settings: Settings | null | undefined, current?: string | null): string[] {
  const out: string[] = []
  const add = (m: unknown) => {
    const id = typeof m === 'string' ? baseModel(m) : ''
    if (id && !out.includes(id)) out.push(id)
  }
  for (const m of KNOWN_MODELS) add(m)
  add(current)
  for (const conf of Object.values(settings?.models ?? {})) add(conf?.model)
  return out
}

/** Whether a model has fast mode, as Claude Code and the backend tell (config.has_fast_mode): an Opus 5 or Opus 4.8 id,
 * or `opus`, the alias for the current Opus. Pure. */
export function hasFastMode(model: string | null | undefined): boolean {
  const m = (model ?? '').toLowerCase()
  return m.includes('opus-5') || m.includes('opus-4-8') || m.split('[')[0] === 'opus'
}

/** The models Claude Code runs with no effort, as parts of their ids (config.NO_EFFORT_MODELS): Haiku 4.5 and the
 * Claude 3 Haikus. Haiku 5.5 is the first Haiku with effort levels. */
const NO_EFFORT_MODELS: readonly string[] = ['haiku-4', '3-5-haiku', '3-haiku']

/** Whether Claude Code runs a model at an effort (config.has_effort): every model but those of NO_EFFORT_MODELS, which
 * run with none, so their row and their run show no effort menu. Pure. */
export function hasEffort(model: string | null | undefined): boolean {
  const m = (model ?? '').toLowerCase()
  return !!m && !NO_EFFORT_MODELS.some((k) => m.includes(k))
}

// ---- the settings, read once per workspace and shared by the composer, the settings popover and the switches that
// live beside what they turn (the Labels sidebar's Label tool) ----
import { useEffect, useRef, useState } from 'react'
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

/** Forget the cached settings of `ws` after a save, and tell whoever shows them (the view proposal's switch). */
export const invalidateSettings = (ws: string): void => {
  cache.delete(ws)
  listeners.forEach((fn) => fn(ws))
}

/** Save a change of the settings (PUT /settings merges what it is given), then tell whoever shows them, after a failure
 * too, so they show what the server holds. */
export function saveSettings(ws: string, patch: SettingsPatch): Promise<void> {
  return api
    .putSettings(ws, patch)
    .then(() => invalidateSettings(ws))
    .catch((e: unknown) => {
      invalidateSettings(ws)
      throw e
    })
}

/** Save some of a role's model, effort and fast mode (settings.models: the server merges them into what the role
 * holds), as saveSettings does. */
export const saveRole = (ws: string, role: string, patch: Partial<ModelConf>): Promise<void> => saveSettings(ws, { models: { [role]: patch } })

/** Hear that the settings of a workspace changed; returns the unsubscribe. */
export function onSettingsChange(fn: (ws: string) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** One of the workspace's on/off settings, as `on` reads it from GET /settings: null until they are read, `fallback`
 * when they cannot be, and read again whenever they change, here or from another surface (onSettingsChange). */
export function useSettingOn(ws: string, on: (s: Settings) => boolean, fallback = true): boolean | null {
  const [value, setValue] = useState<boolean | null>(null)
  const read = useRef(on)
  read.current = on
  useEffect(() => {
    let alive = true
    const get = () =>
      loadSettings(ws)
        .then((s) => alive && setValue(read.current(s)))
        .catch(() => alive && setValue(fallback))
    void get()
    const off = onSettingsChange((w) => w === ws && void get())
    return () => {
      alive = false
      off()
    }
  }, [ws, fallback])
  return value
}

/** A switch of the workspace's settings that applies at once: its state (useSettingOn), which shows the pick while it
 * saves, and the turn, which saves `patch(on)` (saveSettings) and on a failure says so with `failed` and shows what the
 * server holds. */
export function useSettingSwitch(ws: string, on: (s: Settings) => boolean, patch: (on: boolean) => SettingsPatch, failed: (on: boolean, e: Error) => void): [boolean | null, (on: boolean) => void] {
  const saved = useSettingOn(ws, on)
  const [picked, setPicked] = useState<boolean | null>(null)
  const turn = (v: boolean) => {
    setPicked(v)
    saveSettings(ws, patch(v))
      // the settings read again after the save, which the switch then shows in the pick's place
      .then(() => loadSettings(ws).then(() => undefined, () => undefined))
      .catch((e: Error) => failed(v, e))
      .finally(() => setPicked(null))
  }
  return [picked ?? saved, turn]
}
