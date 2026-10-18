// records.ts: a source row as the person reads it: its words (a body, a text, a message) and a short line of who and
// when, never a dump of `field: value`. Rows are read whole through the page server (`lean rows <ref>`), a file's refs
// in one row set.
import { api } from './api'

export const HEAD_KEYS = ['label', 'name', 'user', 'author', 'agent', 'sender', 'role', 'speaker', 'type', 'kind', 'page_id', 'title', 'wiki']
export const TIME_KEYS = ['time', 'timestamp', 'ts', 'at', 'date', 'created', 'write_date']
export const BODY_KEYS = ['quote', 'body', 'text', 'content', 'message', 'summary', 'change_summary', 'value', 'output']

export interface Words {
  ref: string
  words: string
  meta: string
}

export function parse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

const when = (t: string) => t.replace('T', ' ').replace(/:\d\d(\.\d+)?Z?$/, '')

/** A record's words and its meta line. */
export function recordWords(v: unknown, ref = ''): Words {
  if (typeof v === 'string') {
    const o = parse(v)
    if (!o) return { ref, words: v, meta: '' }
    v = o
  }
  const r = (v || {}) as Record<string, unknown>
  const key = BODY_KEYS.find((k) => typeof r[k] === 'string' && (r[k] as string).trim())
  const head = HEAD_KEYS.filter((k) => k !== key && typeof r[k] === 'string' && r[k]).slice(0, 2).map((k) => String(r[k]))
  const time = TIME_KEYS.map((k) => r[k]).find((x) => typeof x === 'string') as string | undefined
  const meta = [...head, time ? when(time) : ''].filter(Boolean).join(' · ')
  if (key) return { ref: typeof r.ref === 'string' ? r.ref : ref, words: String(r[key]).replace(/\s+/g, ' ').trim(), meta }
  const rest = Object.entries(r).filter(([k, x]) => k !== 'ref' && !k.startsWith('_') && (typeof x === 'string' || typeof x === 'number')).slice(0, 4)
  return { ref: typeof r.ref === 'string' ? r.ref : ref, words: rest.map(([, x]) => String(x)).join(' · '), meta }
}

/** The whole rows behind source refs (path#L<n>), read in one row set per file; refs that are not file lines stay out. */
export async function fullRows(refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byFile = new Map<string, number[]>()
  for (const ref of refs) {
    const m = /^(.+)#L(\d+)$/.exec(ref)
    if (!m) continue
    byFile.set(m[1], [...(byFile.get(m[1]) || []), Number(m[2])])
  }
  await Promise.all(
    [...byFile].map(async ([path, lines]) => {
      const r = await api(`rows?ref=${encodeURIComponent(`${path}#L${lines.join(',')}`)}&n=${lines.length}`)
      for (const x of r.rows || []) out.set(`${path}#L${x.line}`, x.text)
    }),
  )
  return out
}

/** Resolved records ({ref, text}) as words, each from its whole row when the row can be read. */
export async function wordsOf(records: { ref: string; text: string }[]): Promise<Words[]> {
  const whole = await fullRows(records.map((r) => r.ref))
  return records.map((r) => recordWords(whole.get(r.ref) ?? r.text, r.ref))
}
