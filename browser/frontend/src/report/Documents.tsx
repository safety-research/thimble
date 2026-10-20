// The report's view behind one lazy import, so BlockNote loads the first time the tab is shown.
import type { Writeup } from '../lib/types'
import type { DocFilter } from './Editor'
import { ReportPage } from './ReportPage'

export interface DocumentViewProps {
  ws: string
  slug: string
  doc: Writeup
  filter: DocFilter | null
  /** the tab's token on the editor's saves */
  client: string
  onSaved: (doc: Writeup) => void
}

export function DocumentView({ ws, slug, doc, filter, client, onSaved }: DocumentViewProps) {
  return <ReportPage key={`${ws}:${slug}`} ws={ws} slug={slug} doc={doc} filter={filter} client={client} onSaved={onSaved} />
}
