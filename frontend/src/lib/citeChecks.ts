// How each citation's check stands, read from what the backend stored about it: a card's links check
// (cell.verification.links, backend verify.py) and a document sentence's healing pass (sentence.healed, backend heal.py).
// Every citation looks the same everywhere (components/RefChip): `checking` while thimble verifies it (a small spinner
// after it), `ok` once verified or never checked (nothing), `corrected` when the check rewrote it in place (nothing; a
// click shows what Claude wrote, what the check made it and why), `failed` when it could not be verified (red, ×). Pure.
import type { HealChange } from './types'

export type CiteCheckState = 'checking' | 'ok' | 'corrected' | 'failed'

/** A citation as written: the words or number it shows and the place it cites. */
export interface CitePlace {
  value?: string
  ref: string
}

/** One revision of a citation: what Claude wrote, what the check made it, and why. */
export interface CiteRevision {
  wrote: CitePlace
  now: CitePlace
  why: string
}

export interface CiteCheck {
  state: CiteCheckState
  /** why a citation failed */
  why?: string
  /** a corrected citation's revisions, oldest first */
  history?: CiteRevision[]
}

/** The checks of one text's citations, by value and ref; `rest` is the state of a citation the record does not list
 * (checking while the check runs on the whole text, failed when it could not finish). */
export interface CiteChecks {
  byKey: ReadonlyMap<string, CiteCheck>
  rest?: CiteCheck
}

/** A card ref reads the same with either prefix. */
const canonRef = (ref: string): string => ref.trim().replace(/^cell:/, 'card:')

export const citeKey = (ref: string, value?: string | null): string => `${(value ?? '').trim()}\u0000${canonRef(ref)}`

/** The check of the citation `ref` shown as `value`: its own entry, then the entry of the ref alone (a bare citation),
 * then the text's `rest`; null when nothing is known (drawn as verified). */
export function checkOf(checks: CiteChecks | null | undefined, ref: string, value?: string): CiteCheck | null {
  if (!checks) return null
  return checks.byKey.get(citeKey(ref, value)) ?? (value ? undefined : checks.byKey.get(citeKey(ref))) ?? checks.rest ?? null
}

/** Why a value moved to another place, by how the check found it (backend heal.CELL, CITED, NOTEBOOK, cite.COMPUTED). */
const MOVED_WHY: Record<string, string> = {
  cell: 'the value is at another place in the cited card',
  cited: 'the value is in another card the text cites',
  notebook: 'the value is in another card',
  computed: "the card's code computes the value here; the cited place types it in",
}
const movedWhy = (how: unknown): string => (typeof how === 'string' && MOVED_WHY[how]) || 'the value is at another place'

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined)
const list = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter(isObj) : [])

/** The checks of a card's takeaway from its `verification` record. While the links check runs every citation is
 * checking; once it ends, a re-pointed or rewritten value is corrected and one that is contradicted, has no home or is
 * typed in the card's code is failed. A check that could not finish fails the citations it did not link. */
export function cardChecks(verification: unknown): CiteChecks | null {
  const links = isObj(verification) && isObj(verification.links) ? verification.links : null
  if (!links) return null
  if (links.status === 'pending' && links.checked !== true) return { byKey: new Map(), rest: { state: 'checking' } }
  const byKey = new Map<string, CiteCheck>()
  const set = (ref: unknown, value: unknown, c: CiteCheck) => {
    const r = str(ref)
    if (r) byKey.set(citeKey(r, typeof value === 'string' ? value : undefined), c)
  }
  for (const e of list(links.resolved)) {
    const from = str(e.from)
    const ref = str(e.ref)
    if (from && ref && canonRef(from) !== canonRef(ref)) {
      const value = str(e.value)
      set(ref, value, { state: 'corrected', history: [{ wrote: { value, ref: from }, now: { value, ref }, why: movedWhy(e.how) }] })
    } else set(ref, e.value, { state: 'ok' })
  }
  for (const e of list(links.broken)) {
    const ref = str(e.ref)
    const value = str(e.value)
    if (e.corrected && ref) set(ref, value, { state: 'corrected', history: [{ wrote: { value: str(e.was), ref }, now: { value, ref }, why: str(e.why) ?? 'the cited place shows another value' }] })
    else set(ref, value, { state: 'failed', why: str(e.why) })
  }
  for (const e of [...list(links.quiet), ...list(links.typed)]) set(e.ref, e.value, { state: 'failed', why: str(e.why) })
  const rest: CiteCheck | undefined = links.status === 'failed' ? { state: 'failed', why: (isObj(verification) && str(verification.note)) || 'the check could not finish' } : undefined
  return { byKey, rest }
}

const NUM = /[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g

/** The words of a citation the healing pass rewrote in place: its one number replaced by the number the cited place
 * shows (backend heal._corrected_display); null when that is not one plain number or the words hold several. */
export function correctedValue(was: string, source: string): string | null {
  const src = source.trim()
  const whole = new RegExp(`^${NUM.source}$`)
  if (!whole.test(src)) return null
  if (whole.test(was.trim())) return was.trim().endsWith('%') === src.endsWith('%') ? src : null
  const nums = [...was.matchAll(NUM)]
  if (nums.length !== 1 || nums[0][0].endsWith('%') !== src.endsWith('%')) return null
  const at = nums[0].index ?? 0
  return was.slice(0, at) + src + was.slice(at + nums[0][0].length)
}

/** The checks of a document's sentences from their healing records (sentence.healed): a value re-pointed at the place
 * that shows it, or rewritten to the value its place shows, is corrected; a contradicted value or one kept with no home
 * is failed. A value the pass unwrapped is no longer a citation. */
export function healChecks(healed: readonly HealChange[] | undefined | null): CiteChecks | null {
  if (!healed?.length) return null
  const byKey = new Map<string, CiteCheck>()
  for (const ch of healed) {
    const to = ch.to || ''
    if (!to) continue
    if (ch.state === 'linked') {
      if (canonRef(to) !== canonRef(ch.ref)) byKey.set(citeKey(to, ch.value), { state: 'corrected', history: [{ wrote: { value: ch.value, ref: ch.ref }, now: { value: ch.value, ref: to }, why: movedWhy(ch.how) }] })
    } else if (ch.state === 'contradicted' && ch.corrected) {
      const was = ch.was || ch.value
      const now = (ch.source && correctedValue(was, ch.source)) || ch.value
      byKey.set(citeKey(to, now), { state: 'corrected', history: [{ wrote: { value: was, ref: ch.ref }, now: { value: now, ref: to }, why: ch.why || 'the cited place shows another value' }] })
    } else if (ch.state === 'contradicted' || ch.state === 'quiet') byKey.set(citeKey(to, ch.value), { state: 'failed', why: ch.why })
  }
  return byKey.size ? { byKey } : null
}

/** The checks of many sentences as one, for a text drawn whole (a document in the editor). */
export function mergeChecks(all: readonly (CiteChecks | null)[]): CiteChecks | null {
  const byKey = new Map<string, CiteCheck>()
  for (const c of all) c?.byKey.forEach((v, k) => byKey.set(k, v))
  return byKey.size ? { byKey } : null
}
