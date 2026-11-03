// The open comments of the written documents (docTypes.ts writtenDocs), one copy per workspace that every reader shares:
// the top bar's Comments count and the sidebar's list (shell/CommentsList.tsx) read the same comments, so Done in one
// shows in the other at once. While a workspace has readers, a `report` stream event on a document reads that document
// again; the server sends one on every change to a document's comments (a comment added, resolved or opened again, a
// check's run commenting), and `deleted` when a document is deleted, which leaves the document no comments at once.
// Every read and every Done is numbered when it goes out, and an answer older than what the store holds of its document
// is dropped: a read that went out before Done and answers after it does not bring the resolved comment back. The first
// reader after none starts with no comments and reads them, since no event was heard meanwhile.
import { useEffect, useSyncExternalStore } from 'react'
import { docsApi, isNotFound } from '../lib/api'
import { bus } from '../lib/bus'
import type { AnyDoc, WriteupComment } from '../lib/types'
import { commentsApi } from './commentsApi'

type Comments = Readonly<Record<string, readonly WriteupComment[]>>

/** One workspace's: the documents its readers list, each one's open comments and the number of the request they
 * answered, its readers, and the end of its stream subscription. */
interface Store {
  slugs: ReadonlySet<string>
  comments: Comments
  n: Map<string, number>
  readers: number
  off: () => void
}

const stores = new Map<string, Store>()
const listeners = new Set<() => void>()
const NONE: Comments = {}
// the number of the last request that went out
let last = 0

const openOf = (d: AnyDoc | undefined): WriteupComment[] => (d?.comments ?? []).filter((c) => c.status === 'open')
const changed = () => listeners.forEach((fn) => fn())

/** Document `slug`'s comments from the answer to request `n`, unless the workspace's store is gone, no longer lists the
 * document, or holds the answer to a later request. */
function set(ws: string, s: Store, slug: string, comments: readonly WriteupComment[], n: number): void {
  if (stores.get(ws) !== s || !s.slugs.has(slug) || n <= (s.n.get(slug) ?? 0)) return
  s.n.set(slug, n)
  s.comments = { ...s.comments, [slug]: comments }
  changed()
}

/** Document `slug` left with no comments (deleted, or no longer written); a read that went out before is dropped. */
function clear(s: Store, slug: string): void {
  s.n.set(slug, ++last)
  if (!s.comments[slug]?.length) return
  s.comments = { ...s.comments, [slug]: [] }
  changed()
}

/** Document `slug` read again. A document that is not there has no comments; a read that failed otherwise leaves what
 * the store holds. */
function read(ws: string, s: Store, slug: string): void {
  const n = ++last
  docsApi.document(ws, slug).then(
    (d) => set(ws, s, slug, openOf(d), n),
    (e) => void (isNotFound(e) && set(ws, s, slug, [], n)),
  )
}

/** A reader of workspace `ws`'s comments; what it returns lets go. */
function hold(ws: string): () => void {
  let s = stores.get(ws)
  if (s) s.readers += 1
  else {
    const made: Store = { slugs: new Set(), comments: NONE, n: new Map(), readers: 1, off: () => undefined }
    made.off = bus.on('report', (e) => {
      if (e.status === 'deleted') clear(made, e.slug)
      else if (made.slugs.has(e.slug)) read(ws, made, e.slug)
    })
    stores.set(ws, made)
    s = made
  }
  const held = s
  return () => {
    if (--held.readers > 0) return
    held.off()
    if (stores.get(ws) === held) stores.delete(ws)
  }
}

/** The documents workspace `ws`'s readers list: one newly listed is read, one no longer listed has no comments. */
function want(ws: string, slugs: readonly string[]): void {
  const s = stores.get(ws)
  if (!s) return
  const next = new Set(slugs)
  const left = [...s.slugs].filter((slug) => !next.has(slug))
  const added = slugs.filter((slug) => !s.slugs.has(slug))
  if (!left.length && !added.length) return
  s.slugs = next
  left.forEach((slug) => clear(s, slug))
  added.forEach((slug) => read(ws, s, slug))
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** The open comments of workspace `ws`'s documents `key` (their slugs, space-separated), by slug; a document not read
 * yet has none. */
export function useDocComments(ws: string, key: string): Comments {
  const comments = useSyncExternalStore(
    subscribe,
    () => stores.get(ws)?.comments ?? NONE,
    () => NONE,
  )
  useEffect(() => hold(ws), [ws])
  useEffect(() => want(ws, key.split(' ')), [ws, key])
  return comments
}

/** Done on comment `id` of document `slug`: resolved on the server, whose answer, the document, is then what every
 * reader shows of it. */
export async function resolveDocComment(ws: string, slug: string, id: string): Promise<void> {
  const s = stores.get(ws)
  const n = ++last
  const saved = await commentsApi.resolve(ws, slug, id)
  if (s) set(ws, s, slug, openOf(saved), n)
}
