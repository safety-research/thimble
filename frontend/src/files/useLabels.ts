// The labels of the Files pane: the ones its Labels list holds (listedInFiles) in the server's order, the labels over
// files that are on in the order they were turned on (kept per workspace in the browser), the focused one, and which
// values each left on each file (GET /labels/presence, re-read on `concepts` events).
// On/off, highlights and colours are saved at once (PUT /concepts/{id}) and applied optimistically as overrides until
// the concepts are read again.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConcepts } from '../canvas/concepts'
import { api, labelApi } from '../lib/api'
import { bus } from '../lib/bus'
import { track } from '../lib/telemetry'
import type { Concept, ConceptPatch, LabelClass } from '../lib/types'
import { readStorage, storageKey, writeStorage } from '../lib/workspace'
import { classesOf, focusOf, isFilesLabel, listedInFiles, turnedOnOrder, withClassColour, type LabelFilter } from './labels'

export interface FilesLabels {
  /** the labels the Labels list holds, oldest first: the labels over files but a trial that is off, and the labels over
   * cards and report sentences */
  all: Concept[]
  /** the labels over files that are on in Files, in the order they were turned on: label N of this list is lane N of
   * the reader's ruler and column N of a record's gutter and of the Table's dots */
  on: Concept[]
  /** the label whose texts the reader fills (focusOf): the one last focused while it is on, else the last turned on */
  focus: string | null
  /** make a label the focused one */
  setFocus: (id: string) => void
  byId: ReadonlyMap<string, Concept>
  /** per label, per file, the count of each value */
  presence: ReadonlyMap<string, Record<string, Record<string, number>>>
  toggle: (id: string) => void
  /** save a change to a label's classes (a highlight, a colour) */
  setClasses: (id: string, classes: LabelClass[]) => void
  /** give a label's value a palette colour (withClassColour), saved as setClasses saves it, without a run */
  setColour: (id: string, value: string, colour: number) => void
  /** save any change; resolves with the stored label */
  save: (id: string, patch: ConceptPatch) => Promise<Concept>
  /** delete a label with its marks, its card and any filter that uses it: it leaves the list at once, and comes back
   * with a toast when the server refuses; resolves once the server has answered */
  remove: (id: string) => Promise<void>
}

const PRESENCE_DEBOUNCE_MS = 250

/** Whether a label as the server has it already carries a change. */
const shows = (k: Concept | undefined, patch: Partial<Concept>): boolean =>
  !!k && Object.entries(patch).every(([key, v]) => JSON.stringify((k as unknown as Record<string, unknown>)[key]) === JSON.stringify(v))

export function useFilesLabels(ws: string): FilesLabels {
  const concepts = useConcepts(ws)
  const [overrides, setOverrides] = useState<Map<string, { patch: Partial<Concept>; settled: boolean }>>(new Map())
  const [presence, setPresence] = useState<Map<string, Record<string, Record<string, number>>>>(new Map())
  const seen = useRef(concepts)

  // a new read of the concepts carries every change saved before it: the settled overrides go, and so does any the
  // server already shows
  useEffect(() => {
    if (seen.current === concepts) return
    seen.current = concepts
    setOverrides((cur) => {
      const keep = [...cur].filter(([id, o]) => !o.settled && !shows(concepts.get(id), o.patch))
      return keep.length === cur.size ? cur : new Map(keep)
    })
  }, [concepts])

  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const read = () =>
      labelApi
        .presence(ws)
        .then((list) => alive && setPresence(new Map(list.map((p) => [p.concept_id, p.paths]))))
        .catch(() => {
          /* no dots until the next read */
        })
    void read()
    const off = bus.on('concepts', () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void read(), PRESENCE_DEBOUNCE_MS)
    })
    return () => {
      alive = false
      off()
      if (timer != null) window.clearTimeout(timer)
    }
  }, [ws])

  // the labels deleted here that the concepts read may still hold
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (!gone.size || [...gone].some((id) => concepts.has(id))) return
    setGone(new Set())
  }, [concepts, gone])
  const all = useMemo(
    () =>
      [...concepts.values()]
        .filter((k) => listedInFiles(k) && !gone.has(k.id))
        .map((k) => {
          const o = overrides.get(k.id)
          return o ? { ...k, ...o.patch } : k
        }),
    [concepts, overrides, gone],
  )
  const byId = useMemo(() => new Map(all.map((k) => [k.id, k])), [all])
  // the ids of the labels on, in the order they were turned on as this browser saw them come on
  const orderKey = storageKey(ws, 'labelsOnOrder')
  const [order, setOrder] = useState<string[]>(() => readStorage<string[]>(orderKey, []))
  const on = useMemo(() => turnedOnOrder(all.filter((k) => isFilesLabel(k) && k.shown), order), [all, order])
  useEffect(() => {
    const ids = on.map((k) => k.id)
    // before the labels are read, the order kept stays as it is
    if (!all.length || (ids.length === order.length && ids.every((id, i) => id === order[i]))) return
    setOrder(ids)
    writeStorage(orderKey, ids)
  }, [all, on, order, orderKey])
  // the label last focused, which stays the focus while it is on
  const focusKey = storageKey(ws, 'labelFocus')
  const [focused, setFocused] = useState<string | null>(() => readStorage<string | null>(focusKey, null))
  const focus = focusOf(on, focused)
  const setFocus = useCallback(
    (id: string) => {
      setFocused(id)
      writeStorage(focusKey, id)
    },
    [focusKey],
  )

  const put = useCallback(
    (id: string, patch: Partial<Concept>, body: ConceptPatch) => {
      setOverrides((cur) => new Map(cur).set(id, { patch: { ...cur.get(id)?.patch, ...patch }, settled: false }))
      const settle = () =>
        setOverrides((cur) => {
          const o = cur.get(id)
          return o ? new Map(cur).set(id, { ...o, settled: true }) : cur
        })
      return labelApi.update(ws, id, body).then(
        (k) => {
          settle()
          return k as Concept
        },
        (e: Error) => {
          setOverrides((cur) => {
            const next = new Map(cur)
            next.delete(id)
            return next
          })
          bus.emit('toast', { text: `Could not save the label. ${e.message}`, kind: 'error' })
          throw e
        },
      )
    },
    [ws],
  )

  const toggle = useCallback(
    (id: string) => {
      const k = byId.get(id)
      if (!k) return
      track('label-edit', { target: `concept:${id}`, detail: { on: !k.shown } })
      put(id, { shown: !k.shown }, { shown: !k.shown }).catch(() => undefined)
    },
    [byId, put],
  )
  const setClasses = useCallback(
    (id: string, classes: LabelClass[]) => {
      put(id, { classes }, { classes }).catch(() => undefined)
    },
    [put],
  )
  const setColour = useCallback(
    (id: string, value: string, colour: number) => {
      const k = byId.get(id)
      const next = k && withClassColour(classesOf(k), value, colour)
      if (!next) return
      track('label-edit', { target: `concept:${id}`, detail: { colour, value } })
      put(id, { classes: next }, { classes: next }).catch(() => undefined)
    },
    [byId, put],
  )
  const save = useCallback(
    (id: string, patch: ConceptPatch) => {
      const { classes, ...rest } = patch
      const local: Partial<Concept> = { ...rest }
      if (classes) {
        const had = classesOf(byId.get(id) ?? { labels: [], classes: [] })
        local.classes = classes.map((c, i) => ({ name: c.name, color: c.color ?? had[i]?.color ?? 0, highlight: c.highlight ?? true }))
        local.labels = classes.map((c) => c.name)
      }
      return put(id, local, patch)
    },
    [byId, put],
  )

  const remove = useCallback(
    async (id: string) => {
      const name = byId.get(id)?.name ?? 'the label'
      track('label-delete', { target: `concept:${id}` })
      const hide = (on: boolean) =>
        setGone((cur) => {
          const next = new Set(cur)
          if (on) next.add(id)
          else next.delete(id)
          return next
        })
      hide(true)
      try {
        await labelApi.remove(ws, id)
        // every reader of the labels reads them again now, before the stream's own `concepts` event arrives
        bus.emit('concepts', { concept: id, what: 'deleted' })
      } catch (e) {
        hide(false)
        bus.emit('toast', { text: `Could not delete ${name}. ${(e as Error).message}`, kind: 'error' })
      }
    },
    [ws, byId],
  )

  return useMemo(() => ({ all, on, focus, setFocus, byId, presence, toggle, setClasses, setColour, save, remove }), [all, on, focus, setFocus, byId, presence, toggle, setClasses, setColour, save, remove])
}

/** The Files label filter, {concept, value} or null: read once, then kept from the `filter` events of the Files scope. A
 * view keeps its records by it. */
export function useFilesFilter(ws: string): LabelFilter | null {
  const [filter, setFilter] = useState<LabelFilter | null>(null)
  useEffect(() => {
    let alive = true
    api
      .filters(ws)
      .then((all) => {
        const f = all?.files
        if (alive) setFilter(f && f.concept && f.value != null ? { concept: f.concept, value: f.value } : null)
      })
      .catch(() => undefined)
    const off = bus.on('filter', (e) => {
      if (e.scope === 'files') setFilter(e.concept && e.value != null ? { concept: e.concept, value: e.value } : null)
    })
    return () => {
      alive = false
      off()
    }
  }, [ws])
  return filter
}
