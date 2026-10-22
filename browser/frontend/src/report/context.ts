// What the editor's custom blocks read from the tab around them: the workspace, the slug, the document as last loaded.
import { createContext, useContext, type RefObject } from 'react'
import type { Writeup } from '../lib/types'
import { workspaceFromUrl } from '../lib/workspace'
import { SLUG } from './model'

export interface ReportCtx {
  ws: string
  slug: string
  /** the document the editor was built from or last saved, for what a block cannot carry itself (a pending figure's request) */
  docRef: RefObject<Writeup | null>
  /** a prompt block's Enter: the request posted as a figure, the block replaced by the pending figure; rejects when it did not land */
  submitPrompt: (blockId: string, request: string) => Promise<void>
/** a card prompt's Enter (/card): the request posted to main; rejects when it did not land */
  submitCard: (blockId: string, request: string) => Promise<void>
  /** the blocks stand locked (a story, a deck, a page's claims): a figure shows its caption as text and offers no picker */
  readOnly?: boolean
}

const noEditor = () => Promise.reject(new Error('no editor'))

export const ReportContext = createContext<ReportCtx>({ ws: '', slug: SLUG, docRef: { current: null }, submitPrompt: noEditor, submitCard: noEditor })

export function useReportCtx(): ReportCtx {
  const ctx = useContext(ReportContext)
  return ctx.ws ? ctx : { ...ctx, ws: workspaceFromUrl() ?? '' }
}
