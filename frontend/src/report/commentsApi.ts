// Comment routes with no client in lib/api.ts: the analyst's comment on a passage, resolving a comment (Done or Know
// it), the comments on the cards, and export.
import { claimKey, describeDetail } from '../lib/api'
import type { AnyDoc, CanvasComment, WriteupComment } from '../lib/types'

/** How the analyst resolves a comment: Done (✓), or Know it, which its check never raises again. */
export type ResolveHow = 'done' | 'known'

const inv = (ws: string, slug: string) => `/api/ws/${encodeURIComponent(ws)}/investigations/main/types/${encodeURIComponent(slug)}`

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  await claimKey()
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
  /** `POST …/comments/{id}/dismiss`: the comment resolved, Done or Know it; answers the document. */
  resolve: (ws: string, slug: string, id: string, how: ResolveHow = 'done') => call<AnyDoc>(`${inv(ws, slug)}/comments/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: JSON.stringify({ how }) }),
  /** `GET …/export`: the document as plain markdown, and a page's html. */
  exportDoc: (ws: string, slug: string) => call<{ markdown: string; html?: string; title?: string }>(`${inv(ws, slug)}/export`),
}

const canvas = (ws: string) => `/api/ws/${encodeURIComponent(ws)}/canvas/comments`

export const canvasCommentsApi = {
  /** `GET /canvas/comments`: the open comments on the cards that are there. */
  list: (ws: string) => call<{ comments: CanvasComment[] }>(canvas(ws)).then((r) => r.comments ?? []),
  /** `POST /canvas/comments/{id}/resolve`: Done or Know it, which hides the comment; answers the open comments. */
  resolve: (ws: string, id: string, how: ResolveHow) => call<{ comments: CanvasComment[] }>(`${canvas(ws)}/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ how }) }).then((r) => r.comments ?? []),
}
