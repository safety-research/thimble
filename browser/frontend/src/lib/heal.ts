// The citation healing pass as the page reads it (backend cards/heal.py, POST /corpora/{c}/heal), for every text that
// cites card values: a reply, a card's takeaway, a report's text. A text is checked once it is whole, and each citation
// chip inside its HealScope (components/RefChip) shows the result in place: a spinner while the check runs, then the
// place it was re-pointed to, a red × when the cited place shows another value, or grey when its place is gone.
import { createContext, createElement, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type HealResult } from './api'
import { bus } from './bus'
import { splitValueRef } from './refs'
import { workspaceFromUrl } from './workspace'

export type HealChange = HealResult['changes'][number]

/** What the citations of one text read: whether its check runs now, and what the pass did to one citation. */
export interface HealLook {
  checking: boolean
  get(value: string | undefined, ref: string): HealChange | null
}

export const HealContext = createContext<HealLook | null>(null)

const TOKEN = /\[\[((?:[^[\]\n]|\[[^[\]\n]*\])+?)\]\]/g
/** a citation the pass checks: one of a card, or of a cell of its table */
export const CHECKED_REF = /^(?:card|cell):/
const CHECKED_LINK = /\]\((?:card|cell):/
const norm = (ref: string): string => ref.trim().replace(/%20/g, ' ')
const BARE = '↗'

/** `text` as the pass reads it: each `[[value|card:…]]` token of the canvas's and the report's form written as the
 * Markdown link Claude writes. Other tokens stay as they are. */
export function healInput(text: string): string {
  if (!text.includes('[[')) return text
  return text.replace(TOKEN, (whole, inner: string) => {
    const { value, ref } = splitValueRef(inner)
    return CHECKED_REF.test(ref) ? `[${value || BARE}](${ref})` : whole
  })
}

/** A lookup over what the pass did, by a citation's words and ref; by its ref alone when only one citation has it. */
function lookOf(r: HealResult | null): HealLook {
  const by = new Map<string, HealChange>()
  const byRef = new Map<string, HealChange | null>()
  for (const c of r?.changes ?? []) {
    const k = `${c.label.trim()}|${norm(c.ref)}`
    if (!by.has(k)) by.set(k, c)
    byRef.set(norm(c.ref), byRef.has(norm(c.ref)) ? null : c)
  }
  return { checking: false, get: (value, ref) => by.get(`${(value || BARE).trim()}|${norm(ref)}`) ?? byRef.get(norm(ref)) ?? null }
}

const CHECKING: HealLook = { checking: true, get: () => null }

/** The pass's results for this page load, by workspace and text: a text is checked once. */
const results = new Map<string, HealResult | null>()
let toldFailure = false

/** What the pass did to a text's citations, once the text is `settled`; null while there is nothing to check. */
export function useHealLook(text: string, settled = true, workspace?: string): HealLook | null {
  const ws = workspace || workspaceFromUrl() || ''
  const input = useMemo(() => healInput(text || ''), [text])
  const want = settled && !!ws && CHECKED_LINK.test(input)
  const key = `${ws}\n${input}`
  const [got, setGot] = useState<{ key: string; r: HealResult | null } | null>(null)
  useEffect(() => {
    if (!want || results.has(key)) return
    let live = true
    api.heal(ws, input).then(
      (r) => {
        results.set(key, r)
        if (live) setGot({ key, r })
      },
      (err: unknown) => {
        results.set(key, null)
        if (live) setGot({ key, r: null })
        if (!toldFailure) {
          toldFailure = true
          bus.emit('toast', { kind: 'error', text: `The citations were not checked (${(err as Error)?.message || 'no answer'}). Hover a citation to see its place.` })
        }
      },
    )
    return () => {
      live = false
    }
  }, [want, ws, key, input])
  return useMemo(() => {
    if (!want) return null
    if (got?.key === key) return lookOf(got.r)
    return results.has(key) ? lookOf(results.get(key) ?? null) : CHECKING
  }, [want, key, got])
}

/** The citations inside `children` as the pass left them for `text` (the words they are part of). */
export function HealScope({ text, settled = true, workspace, children }: { text: string; settled?: boolean; workspace?: string; children: ReactNode }) {
  return createElement(HealContext.Provider, { value: useHealLook(text, settled, workspace) }, children)
}
