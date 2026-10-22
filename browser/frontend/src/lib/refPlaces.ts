// Refs whose place is gone, as the page finds out when it opens one: the server answers GET …/ref with 404 (or 400 for
// a ref it cannot read). Every chip of that ref on the page then draws as a link that failed, gray with its reason, until
// the ref opens again (an undo brings the card back). A ref of a file is checked once its chip shows (checkFileRef).
import { useSyncExternalStore } from 'react'
import { api } from './api'
import type { ResolvedRef } from './types'
import { bus } from './bus'

const norm = (ref: string): string => ref.trim().replace(/%20/g, ' ')
const REF_CARD = /^(?:card|cell):([A-Za-z0-9_-]+)/
const textOf = (key: string): string => key.slice(key.indexOf('\n') + 1)

// a card that runs or comes back is there: a ref of it that failed when it was opened opens again
bus.on('cell', (e: { cell: string; slug?: string; kind: string }) => {
  if (e.kind === 'deleted') return
  const names = [e.cell, e.slug].filter((n): n is string => !!n)
  for (const k of Array.from(failed.keys())) {
    const card = REF_CARD.exec(textOf(k))
    if (card && names.includes(card[1])) markRefFailed(k.slice(0, k.indexOf('\n')), textOf(k), null)
  }
})

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
