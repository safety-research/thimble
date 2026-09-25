// The prompt block: one bare mono field. Enter sends its text to the session's writer as a request about the passage
// above (a `write` event) and the block gives way; Escape on an empty field removes it. A card prompt (`mode: card`)
// asks main for a card (a `card` event) and stays, working, until the card's figure takes its place. A block sent to
// main with ⌘↵ stands as a card prompt with its text in `sent`, working from the start. The text lives in state, not
// the block's props, so typing never marks the document dirty and the prompt is never saved.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { BlockNoteEditor } from '@blocknote/core'
import { TextArea } from '../components/Field'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { bus } from '../lib/bus'
import { useReportCtx } from './context'

export interface PromptBlockProps {
  block: { id: string; props?: { mode?: 'write' | 'card'; sent?: string } }
  editor: BlockNoteEditor<any, any, any>
}

export function PromptBlock({ block, editor }: PromptBlockProps) {
  const { submitPrompt, submitCard } = useReportCtx()
  const card = block.props?.mode === 'card'
  const sent = block.props?.sent ?? ''
  const [text, setText] = useState(sent)
  const [busy, setBusy] = useState(!!sent)
  const field = useRef<HTMLTextAreaElement | null>(null)

  // the slash menu leaves the editor's cursor on the new block; the field takes it once the block is laid out
  useEffect(() => {
    if (sent) return
    const id = window.requestAnimationFrame(() => field.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [sent])

  const remove = () => {
    editor.removeBlocks([block.id])
    editor.focus()
  }

  const submit = async () => {
    const request = text.trim()
    if (!request || busy) return
    setBusy(true)
    try {
      await (card ? submitCard : submitPrompt)(block.id, request)
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
    <div className={['wu-prompt', card ? 'wu-prompt-card' : '', busy ? 'wu-prompt-busy' : '', sent ? 'wu-prompt-sent' : ''].filter(Boolean).join(' ')} data-prompt={block.id} contentEditable={false}>
      {card && <Icon name="cell-add" size={14} className="wu-prompt-glyph" />}
      <TextArea ref={field} bare mono block autoGrow rows={1} className="wu-prompt-field" value={text} onChange={setText} onKeyDown={onKey} disabled={busy} aria-label={sent ? 'Sent to main' : card ? 'Card from prompt' : 'Prompt'} spellCheck={false} />
      {busy && <Spinner label="working" />}
    </div>
  )
}
