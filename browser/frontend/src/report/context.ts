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
  /** a prompt block's Enter: the request posted to Claude, the block gone; rejects when it did not land */
  submitPrompt: (blockId: string, request: string) => Promise<void>
  /** the blocks are read only (a past draft in History): a figure shows its caption as text and offers no picker */
  readOnly?: boolean
}

const noEditor = () => Promise.reject(new Error('no editor'))

export const ReportContext = createContext<ReportCtx>({ ws: '', slug: SLUG, docRef: { current: null }, submitPrompt: noEditor })

export function useReportCtx(): ReportCtx {
  const ctx = useContext(ReportContext)
  return ctx.ws ? ctx : { ...ctx, ws: workspaceFromUrl() ?? '' }
}
