// The citation healing pass as the page reads it (backend cards/heal.py, POST /corpora/{c}/heal), for every text that
// cites card values: a reply, a card's takeaway, a report's text. A text is checked once it is whole, and each citation
// chip inside its HealScope (components/RefChip) shows the result in place: a spinner while the check runs, then the
// place it was re-pointed to, a red × when the cited place shows another value, or grey when its place is gone.
import { createContext, createElement, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, type HealResult } from './api'
import type { ResolvedRef } from './types'
import { bus } from './bus'
import { pageJob } from './busy'
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

const CITED_CARD = /\]\((?:card|cell):([A-Za-z0-9_-]+)/g
const REF_CARD = /^(?:card|cell):([A-Za-z0-9_-]+)/

/** The cards a text in the pass's form cites, by the id or name each citation gives. */
export function citedCards(input: string): string[] {
  return [...new Set(Array.from(input.matchAll(CITED_CARD), (m) => m[1]))]
}

/** The pass's results by workspace and text. A text is checked once for each state of the cards it cites: when one of
 * them runs, changes, is deleted or comes back (a `cell` event), the text's result is dropped and its round goes up,
 * so every text on the page that cites the card is checked again. A takeaway checked before its card drew, or a reply
 * that cites a card rerun since, then shows what the card shows now. */
const results = new Map<string, HealResult | null>()
const rounds = new Map<string, number>()
const pending = new Map<string, { round: number; answer: Promise<HealResult | null> }>()
const roundSubs = new Set<() => void>()
let toldFailure = false

const roundOf = (key: string): number => rounds.get(key) ?? 0
const textOf = (key: string): string => key.slice(key.indexOf('\n') + 1)

function cardChanged(e: { cell: string; slug?: string; kind: string }): void {
  const names = [e.cell, e.slug].filter((n): n is string => !!n)
  const cites = (cards: readonly string[]) => cards.some((c) => names.includes(c))
  let again = false
  for (const key of new Set([...results.keys(), ...pending.keys()])) {
    if (!cites(citedCards(textOf(key)))) continue
    results.delete(key)
    pending.delete(key)
    rounds.set(key, roundOf(key) + 1)
    again = true
  }
  if (again) for (const fn of Array.from(roundSubs)) fn()
  // a card that runs or comes back is there: a citation of it that failed when it was opened looks as the check says
  if (e.kind !== 'deleted') {
    for (const k of Array.from(failed.keys())) {
      const card = REF_CARD.exec(textOf(k))
      if (card && names.includes(card[1])) markRefFailed(k.slice(0, k.indexOf('\n')), textOf(k), null)
    }
  }
}
bus.on('cell', cardChanged)

let asks = 0

/** The pass's answer for `input` in this round: one request for every text on the page that shows it. The answer
 * becomes the text's result only while no card it cites has changed since it was asked. */
function check(ws: string, input: string, key: string): Promise<HealResult | null> {
  const round = roundOf(key)
  const asked = pending.get(key)
  if (asked && asked.round === round) return asked.answer
  // the busy line says `checking citations` while it runs (lib/busy.ts); no citation draws a spinner of its own
  const job = `heal:${++asks}`
  pageJob(job, 'checking citations')
  const answer = api.heal(ws, input).then(
    (r) => r,
    (err: unknown) => {
      if (!toldFailure) {
        toldFailure = true
        bus.emit('toast', { kind: 'error', text: `The citations were not checked (${(err as Error)?.message || 'no answer'}). Hover a citation to see its place.` })
      }
      return null
    },
  )
  pending.set(key, { round, answer })
  void answer.then((r) => {
    pageJob(job, null)
    if (roundOf(key) !== round) return
    results.set(key, r)
    pending.delete(key)
  })
  return answer
}

const onRound = (fn: () => void) => {
  roundSubs.add(fn)
  return () => {
    roundSubs.delete(fn)
  }
}

/** What the pass did to a text's citations, once the text is `settled`; null while there is nothing to check. */
export function useHealLook(text: string, settled = true, workspace?: string): HealLook | null {
  const ws = workspace || workspaceFromUrl() || ''
  const input = useMemo(() => healInput(text || ''), [text])
  const want = settled && !!ws && CHECKED_LINK.test(input)
  const key = `${ws}\n${input}`
  const round = useSyncExternalStore(onRound, () => roundOf(key), () => roundOf(key))
  const [got, setGot] = useState<{ key: string; round: number; r: HealResult | null } | null>(null)
  useEffect(() => {
    if (!want || results.has(key)) return
    let live = true
    void check(ws, input, key).then((r) => {
      if (live) setGot({ key, round, r })
    })
    return () => {
      live = false
    }
  }, [want, ws, key, input, round])
  return useMemo(() => {
    if (!want) return null
    if (got?.key === key && got.round === round) return lookOf(got.r)
    return results.has(key) ? lookOf(results.get(key) ?? null) : CHECKING
  }, [want, key, round, got])
}

/** The citations inside `children` as the pass left them for `text` (the words they are part of). */
export function HealScope({ text, settled = true, workspace, children }: { text: string; settled?: boolean; workspace?: string; children: ReactNode }) {
  return createElement(HealContext.Provider, { value: useHealLook(text, settled, workspace) }, children)
}

// A citation whose place goes away after its text was checked (a card deleted, a file moved) is found when it is opened:
// the server answers GET …/ref with 404 (or 400 for a ref it cannot read). Every chip of that ref on the page then draws
// as a citation that failed, gray with its reason, until the ref opens again (an undo brings the card back).
const failed = new Map<string, string>()
const failedSubs = new Set<() => void>()
let failedVersion = 0

/** Why a ref's place failed, from the error of its fetch (lib/api: "<status> <detail>"); null when the server did not
 * say the place is gone (no answer, a sign-in, a server error), which says nothing about the citation. */
export function refFailure(err: unknown): string | null {
  const m = /^(\d{3}) ?([\s\S]*)$/.exec((err as Error)?.message ?? '')
  if (!m) return null
  const said = plainDetail(m[2])
  if (m[1] === '404' || m[1] === '410') return said ? `the cited place is gone (${said})` : 'the cited place is gone'
  if (m[1] === '400') return said || 'the cited place cannot be read'
  return null
}

/** The server's detail when it reads as plain words for the analyst; null for a system error or one that names a path
 * on the server's disk, which says nothing they can use. Pure. */
export function plainDetail(detail: string): string | null {
  const d = detail.trim()
  if (!d || d.length > 160 || /\[Errno|Traceback|(?:^|[\s'"(])\/(?:[\w.-]+\/)+/.test(d)) return null
  return d
}

// A citation of a file is checked once its chip shows, as the hover would read it: the server reads a path written from
// a subfolder at the file it means (corpus.locate), and a place that is not there marks the citation failed in place.
const fileChecks = new Map<string, Promise<ResolvedRef | null>>()

/** What a file citation resolves to (its `ref` names the file as the folder holds it), or null when it failed, which
 * then draws as failed on every chip of it. One request per workspace and ref. */
export function checkFileRef(ws: string, ref: string): Promise<ResolvedRef | null> {
  const k = `${ws}\n${norm(ref)}`
  let got = fileChecks.get(k)
  if (!got) {
    got = api.resolveRef(ws, ref).then(
      (r) => {
        markRefFailed(ws, ref, null)
        return r
      },
      (err: unknown) => {
        const why = refFailure(err)
        if (why) markRefFailed(ws, ref, why)
        else fileChecks.delete(k) // no answer says nothing about the citation: a later look asks again
        return null
      },
    )
    fileChecks.set(k, got)
  }
  return got
}

/** Record that `ref` failed with `why`, or that it opened again (null). */
export function markRefFailed(ws: string, ref: string, why: string | null): void {
  const k = `${ws}\n${norm(ref)}`
  if (why == null ? !failed.delete(k) : failed.get(k) === why) return
  if (why != null) failed.set(k, why)
  failedVersion += 1
  for (const fn of Array.from(failedSubs)) fn()
}

/** Why `ref` failed when it was last opened on this page, or null. */
export function useRefFailure(ws: string, ref: string): string | null {
  useSyncExternalStore(
    (fn) => {
      failedSubs.add(fn)
      return () => failedSubs.delete(fn)
    },
    () => failedVersion,
  )
  return failed.get(`${ws}\n${norm(ref)}`) ?? null
}
