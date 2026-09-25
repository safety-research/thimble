// Report routes with no client in lib/api.ts: the analyst's comment on a passage, resolving a comment, and export.
import { describeDetail } from '../lib/api'
import type { AnyDoc, WriteupComment } from '../lib/types'

const inv = (ws: string, slug: string) => `/api/ws/${encodeURIComponent(ws)}/investigations/main/types/${encodeURIComponent(slug)}`

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = describeDetail(body.detail ?? body)
    } catch {
      /* the status text stands */
    }
    throw new Error(`${res.status} ${detail}`)
  }
  return (await res.json()) as T
}

export const commentsApi = {
  /** `POST …/comments`: the analyst's comment on a sentence or a section heading; answers the comment. */
  add: (ws: string, slug: string, sentenceId: string, text: string) => call<WriteupComment>(`${inv(ws, slug)}/comments`, { method: 'POST', body: JSON.stringify({ sentence_id: sentenceId, text }) }),
  /** `POST …/comments/{id}/dismiss`: the comment resolved; answers the document. */
  resolve: (ws: string, slug: string, id: string) => call<AnyDoc>(`${inv(ws, slug)}/comments/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),
  /** `GET …/export`: the document as plain markdown, and a page's html. */
  exportDoc: (ws: string, slug: string) => call<{ markdown: string; html?: string; title?: string }>(`${inv(ws, slug)}/export`),
}
