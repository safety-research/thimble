// Color by's state in Files' Transcript and Table modes (colorChoice.ts): the file's keys from the server, the choices,
// the values turned off and the colors picked, kept per file, the labels that mark the file, each value's chip of the
// first choice, and per record loaded its color and whether it is hidden. The choices go in order: the first colors the
// records, each other one has a lane of the tracks (Reader). Checking a label that is off turns it on, and unchecking
// one turns it off unless Filter by filters by it (`holds`). A label the analyst turns on anywhere else in thimble takes
// the first place, as in a view's Color by: a key that was first gives way, a label there keeps its lane; but for one
// Filter by turns on (`quiet`), which keeps its own.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { api } from '../lib/api'
import { bus } from '../lib/bus'
import type { Concept, LabelRow, SourceKeys, SourceRecord } from '../lib/types'
import { chipOfKeyValue, chipOfLabel, choiceId, colorKeys, keptPicks, keyChips, keyValue, labelChips, pickedChips, picksOf, readColor, togglePick, withPicks, writeColor, type ColorChoice, type ColorKept, type ColorValue } from './colorChoice'
import type { RecordColor } from './colorContext'
import { isFilesLabel, marksOf } from './labels'
import type { FilesLabels } from './useLabels'

export interface ColorBy {
  keys: SourceKeys | null
  /** the first choice, which colors the records; `off` for Off */
  choice: ColorChoice
  /** every choice in order, the first the color and each other a lane of the tracks; none for Off */
  picks: ColorChoice[]
  /** the labels over files that mark this file, on or off */
  fileLabels: Concept[]
  values: ColorValue[]
  off: string[]
  /** per line loaded, its color and whether it is hidden; null with Color by off */
  colors: ReadonlyMap<number, RecordColor> | null
  /** the chip a record falls under */
  chipOf: (rec: SourceRecord) => string | undefined
  /** the palette color (1 to 12) picked for a key's value, by value */
  picked: Readonly<Record<string, number>>
  /** Off, or a key or a label checked after the other choices, or unchecked */
  choose: (c: ColorChoice) => void
  toggle: (value: string, alone: boolean) => void
  /** give a value a palette color: a label's as the label's own (Files and every view), a key's kept per file */
  recolor: (value: string, color: number) => void
  /** give a key's values their own colors back; null when none was picked */
  resetColors: (() => void) | null
  /** the colors picked for a choice's values, by the choice's id (choiceId) */
  pickedOf: (id: string) => Readonly<Record<string, number>> | undefined
}

/** The file's keys (GET /source/keys) that Color by offers (colorKeys), asked once per file while `on`. */
export function useSourceKeys(ws: string, path: string, on: boolean): SourceKeys | null {
  const [got, setGot] = useState<{ path: string; keys: SourceKeys } | null>(null)
  useEffect(() => {
    if (!on) return
    let alive = true
    api
      .sourceKeys(ws, path)
      .then((k) => alive && setGot({ path, keys: { ...k, keys: colorKeys(k.keys) } }))
      .catch(
        () =>
          alive &&
          setGot({
            path,
            keys: {
              path,
              total: 0,
              bins: 0,
              partial: false,
              bytes: [],
              keys: [],
            },
          }),
      )
    return () => {
      alive = false
    }
  }, [ws, path, on])
  return got?.path === path ? got.keys : null
}

const OFF: ColorChoice = { by: 'off' }

export function useColorBy(ws: string, path: string, on: boolean, labels: FilesLabels, records: readonly SourceRecord[], rows: ReadonlyMap<string, ReadonlyMap<string, LabelRow>>, total: number | null, quiet?: RefObject<Set<string>>, holds?: RefObject<string | null>): ColorBy {
  const keys = useSourceKeys(ws, path, on)
  const [kept, setKept] = useState<ColorKept>(() => readColor(ws, path))
  const keep = useCallback(
    (next: ColorKept) => {
      setKept(next)
      writeColor(ws, path, next)
    },
    [ws, path],
  )
  const fileLabels = useMemo(() => [...labels.byId.values()].filter((k) => isFilesLabel(k) && marksOf(k) !== 'file' && !k.trial && !!labels.presence.get(k.id)?.[path]), [labels.byId, labels.presence, path])
  const onIds = useMemo(() => new Set(labels.on.map((k) => k.id)), [labels.on])
  // a label holds as a choice while it is on and marks the file
  const labelHolds = useCallback((id: string) => onIds.has(id) && fileLabels.some((k) => k.id === id), [onIds, fileLabels])
  // the choices kept that still stand, else the key chosen last, else the file's default
  const picks = useMemo(() => picksOf(kept, keys?.keys ?? [], labelHolds), [kept.by, kept.picks, kept.key, keys, labelHolds]) // eslint-disable-line react-hooks/exhaustive-deps
  const choice = picks[0] ?? OFF
  // a label deleted while it is one of the choices leaves them, and with none left Color by is Off, as a view's does
  // (viewer_colour.js)
  useEffect(
    () =>
      bus.on('concepts', (e) => {
        if (e.what !== 'deleted') return
        const gone = `l:${e.concept}`
        const raw = keptPicks(kept)
        if (!raw?.includes(gone)) return
        const rest = raw.filter((x) => x !== gone)
        keep({ ...kept, by: rest[0] ?? 'off', picks: rest })
      }),
    [kept, keep],
  )
  // the labels Color by itself turns on, which keep the place they were checked in
  const mine = useRef(new Set<string>())
  // a label turned on since the labels first came, that marks this file, takes the first place
  const seenOn = useRef<Set<string> | null>(null)
  const loaded = labels.all.length > 0
  useEffect(() => {
    if (!loaded) return
    const before = seenOn.current
    seenOn.current = onIds
    if (!before || !on) return
    const held = quiet?.current
    const fresh = labels.on.filter((k) => !before.has(k.id) && fileLabels.some((f) => f.id === k.id) && !held?.has(k.id) && !mine.current.has(k.id))
    held?.forEach((id) => onIds.has(id) && held.delete(id))
    mine.current.forEach((id) => onIds.has(id) && mine.current.delete(id))
    if (!fresh.length) return
    const id = fresh[fresh.length - 1].id
    const now = picksOf(kept, keys?.keys ?? [], (x) => x !== id && labelHolds(x))
    // a key that was the color gives way; a label there keeps its lane
    const gave = now[0]?.by === 'key' ? now[0].key : undefined
    keep(withPicks(kept, [{ by: 'label', id }, ...(gave ? now.slice(1) : now)], gave))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onIds, loaded])
  const id = choiceId(choice)
  const off = useMemo(() => kept.off[id] ?? [], [kept.off, id])
  const key = choice.by === 'key' ? keys?.keys.find((k) => k.key === choice.key) : undefined
  const label = choice.by === 'label' ? labels.byId.get(choice.id) : undefined
  const picked = useMemo(() => (key ? (kept.colors?.[id] ?? {}) : {}), [key, kept.colors, id])
  const values = useMemo<ColorValue[]>(() => (key ? pickedChips(keyChips(key), picked) : label ? labelChips(label, labels.presence.get(label.id)?.[path], total) : []), [key, picked, label, labels.presence, path, total])
  const chipOf = useCallback(
    (rec: SourceRecord): string | undefined => {
      if (key) return chipOfKeyValue(key, keyValue(rec, key.key))
      if (label) return chipOfLabel(label, rows.get(`${path}#L${rec.line}`)?.get(label.id), true)
      return undefined
    },
    [key, label, rows, path],
  )
  const colors = useMemo(() => {
    if (!on || choice.by === 'off' || (!key && !label)) return null
    const colorOf = new Map(values.map((v) => [v.id, v.color]))
    const offSet = new Set(off)
    const out = new Map<number, RecordColor>()
    for (const rec of records) {
      const chip = chipOf(rec)
      if (chip == null) continue
      out.set(rec.line, {
        color: colorOf.get(chip) ?? null,
        hidden: offSet.has(chip),
      })
    }
    return out
  }, [on, choice.by, key, label, values, off, records, chipOf])
  const { setFocus, toggle: toggleLabel, setColour } = labels
  const choose = useCallback(
    (c: ColorChoice) => {
      if (c.by === 'off') return keep(withPicks(kept, []))
      const had = picks.some((p) => choiceId(p) === choiceId(c))
      if (c.by === 'label') {
        // checked while off, it is turned on; unchecked, it is turned off, unless Filter by filters by it
        if (!had && !onIds.has(c.id)) {
          mine.current.add(c.id)
          setFocus(c.id)
          toggleLabel(c.id)
        } else if (had && onIds.has(c.id) && holds?.current !== c.id) toggleLabel(c.id)
      }
      keep(withPicks(kept, togglePick(picks, c), !had && c.by === 'key' ? c.key : undefined))
    },
    [picks, onIds, holds, setFocus, toggleLabel, keep, kept],
  )
  const toggle = useCallback(
    (value: string, alone: boolean) => {
      const all = values.map((v) => v.id)
      const now = new Set(off)
      let next: string[]
      if (alone) next = now.size === all.length - 1 && !now.has(value) ? [] : all.filter((v) => v !== value)
      else next = now.has(value) ? off.filter((v) => v !== value) : [...off, value]
      keep({ ...kept, off: { ...kept.off, [id]: next } })
    },
    [values, off, keep, kept, id],
  )
  const recolor = useCallback(
    (value: string, color: number) => {
      if (label) return setColour(label.id, value, color)
      if (!key) return
      keep({ ...kept, colors: { ...kept.colors, [id]: { ...picked, [value]: color } } })
    },
    [label, key, setColour, keep, kept, id, picked],
  )
  const hasPicked = Object.keys(picked).length > 0
  const resetColors = useMemo(
    () =>
      key && hasPicked
        ? () => {
            const rest = { ...kept.colors }
            delete rest[id]
            keep({ ...kept, colors: rest })
          }
        : null,
    [key, hasPicked, kept, keep, id],
  )
  const pickedOf = useCallback((c: string) => kept.colors?.[c], [kept.colors])
  return {
    keys,
    choice,
    picks,
    fileLabels,
    values,
    off,
    colors,
    chipOf,
    picked,
    choose,
    toggle,
    recolor,
    resetColors,
    pickedOf,
  }
}
