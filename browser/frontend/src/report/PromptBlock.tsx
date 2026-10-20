// The prompt block: one bare field, a request to Claude placed in the report. Enter sends its text to Claude in the
// chat, with the words of the passage above it, and the block gives way; Escape on an empty field removes it. The text
// lives in state, not the block's props, so typing never marks the document dirty and the prompt is never saved.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BlockNoteEditor } from '@blocknote/core'
import { TextArea } from '../components/Field'
import { Spinner } from '../components/Spinner'
import { bus } from '../lib/bus'
import { useReportCtx } from './context'

export interface PromptBlockProps {
  block: { id: string }
  editor: BlockNoteEditor<any, any, any>
}

export function PromptBlock({ block, editor }: PromptBlockProps) {
  const { submitPrompt } = useReportCtx()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLTextAreaElement | null>(null)

  // the slash menu leaves the editor's cursor on the new block; the field takes it once the block is laid out
  useEffect(() => {
    const id = window.requestAnimationFrame(() => field.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [])

  const remove = () => {
    editor.removeBlocks([block.id])
    editor.focus()
  }

  const submit = async () => {
    const request = text.trim()
    if (!request || busy) return
    setBusy(true)
    try {
      await submitPrompt(block.id, request)
    } catch (e) {
      setBusy(false)
      bus.emit('toast', { text: `Could not send the request. ${(e as Error).message}`, kind: 'error' })
      field.current?.focus()
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape' && !text) {
      e.preventDefault()
      remove()
    }
  }

  return (
    <div className={['wu-prompt', busy ? 'wu-prompt-busy' : ''].filter(Boolean).join(' ')} data-prompt={block.id} contentEditable={false}>
      <TextArea ref={field} bare block autoGrow rows={1} className="wu-prompt-field" value={text} onChange={setText} onKeyDown={onKey} disabled={busy} placeholder="Ask Claude to write here…" aria-label="Ask Claude to write here" spellCheck={false} />
      {busy && <Spinner label="working" />}
    </div>
  )
}
