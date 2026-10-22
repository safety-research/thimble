// Comment routes with no client in lib/api.ts: the analyst's comment on a passage, resolving a comment (Done), the
// comments on the cards, and export.
import { claimKey, describeDetail, signInNeeded } from '../lib/api'
import { apiBase } from '../lib/browserKey'
import type { AnyDoc, CanvasComment, WriteupComment } from '../lib/types'

const inv = (ws: string, slug: string) => `${apiBase()}/ws/${encodeURIComponent(ws)}/investigations/main/types/${encodeURIComponent(slug)}`

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  await claimKey()
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  if (!res.ok) {
    await signInNeeded(res)
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
  /** `POST …/comments/{id}/dismiss`: the comment resolved (Done); answers the document. */
  resolve: (ws: string, slug: string, id: string) => call<AnyDoc>(`${inv(ws, slug)}/comments/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),
  /** `GET …/export`: the document as plain markdown, and a page's html. */
  exportDoc: (ws: string, slug: string) => call<{ markdown: string; html?: string; title?: string }>(`${inv(ws, slug)}/export`),
}

const canvas = (ws: string) => `${apiBase()}/ws/${encodeURIComponent(ws)}/canvas/comments`

export const canvasCommentsApi = {
  /** `GET /canvas/comments`: the open comments on the cards that are there. */
  list: (ws: string) => call<{ comments: CanvasComment[] }>(canvas(ws)).then((r) => r.comments ?? []),
  /** `POST /canvas/comments/{id}/resolve`: Done, which hides the comment; answers the open comments. */
  resolve: (ws: string, id: string) => call<{ comments: CanvasComment[] }>(`${canvas(ws)}/${encodeURIComponent(id)}/resolve`, { method: 'POST' }).then((r) => r.comments ?? []),
}
