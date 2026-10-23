// The reader's find bar (⌘F / Ctrl+F): the field, the match count (`3 of 120`), previous and next, and ×. Typing `:<n>`
// (Ctrl+G opens the bar with the colon typed) goes to line n. Enter goes to the next match or the line, ⇧Enter to the
// previous match, Escape closes. FileReader in Reader.tsx runs the search; this is the bar alone.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Spinner } from '../components/Spinner'
import { api } from '../lib/api'
import type { SourceFind } from '../lib/types'

/** ms the find waits after the last key before it asks the server */
const DEBOUNCE_MS = 250

export interface FileFindState {
  /** the text the answer is for */
  text: string
  found: SourceFind | null
  error: string | null
  /** an answer for other text is on its way */
  loading: boolean
  /** read the matches past the last one listed, when the answer listed or read only part of the file; resolves to
   * every line listed then, or null when there was nothing more to read */
  more: () => Promise<number[] | null>
}

/** How many times each listed line matches; one each from a server that does not say. */
export const countsOf = (found: SourceFind): number[] => found.lines.map((_, i) => found.counts?.[i] ?? 1)

/** The server's search of one file for `text` (GET /corpora/{c}/source/find), asked once typing pauses. `more` reads on
 * from where the last listing stopped and keeps the count whole. */
export function useSourceFind(ws: string, path: string, text: string): FileFindState {
  const [got, setGot] = useState<{ text: string; found: SourceFind | null; error: string | null }>({ text: '', found: null, error: null })
  const latest = useRef(got)
  latest.current = got
  useEffect(() => {
    if (!text) {
      setGot({ text: '', found: null, error: null })
      return
    }
    const ctl = new AbortController()
    const t = window.setTimeout(() => {
      api
        .findInSource(ws, path, text, 0, ctl.signal)
        .then((found) => setGot({ text, found, error: null }))
        .catch((e: Error) => !ctl.signal.aborted && setGot({ text, found: null, error: e.message }))
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(t)
      ctl.abort()
    }
  }, [ws, path, text])
  const more = useCallback(async () => {
    const { text: had, found } = latest.current
    if (!found || (found.complete && found.lines.length >= found.total)) return null
    const after = found.lines.length < found.total ? found.lines[found.lines.length - 1] : found.scanned
    const next = await api.findInSource(ws, path, had, after)
    if (latest.current.text !== had) return null
    const counts = [...countsOf(found), ...countsOf(next)]
    const listed = countsOf(found).reduce((a, b) => a + b, 0)
    const merged: SourceFind = { ...next, lines: [...found.lines, ...next.lines], counts, total: found.lines.length + next.total, matches: listed + (next.matches ?? next.total) }
    setGot({ text: had, found: merged, error: null })
    return merged.lines
  }, [ws, path])
  return { ...got, loading: !!text && got.text !== text, more }
}

interface Props {
  text: string
  onText: (text: string) => void
  /** the count or the line's bound shown after the field, empty while there is none */
  status: string
  busy: boolean
  /** step through the matches; null while there is nothing to step through */
  onStep: ((dir: 1 | -1) => void) | null
  /** Enter on a `:<n>` */
  onEnter: () => void
  onClose: () => void
  inputRef: RefObject<HTMLInputElement | null>
  /** bumps each time the bar is asked for again, so the field takes the focus and selects its text */
  ask: number
}

export function FindBar({ text, onText, status, busy, onStep, onEnter, onClose, inputRef, ask }: Props) {
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    // a go-to-line ask arrives with the colon typed: the caret goes after it, and a find ask selects the old text
    if (el.value === ':') el.setSelectionRange(1, 1)
    else el.select()
  }, [ask, inputRef])
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (onStep) onStep(e.shiftKey ? -1 : 1)
      else onEnter()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  return (
    <div className="reader-find" role="search" aria-label="Find in the file">
      <Icon name="search" size={13} className="reader-find-glyph" />
      <input ref={inputRef} value={text} onChange={(e) => onText(e.target.value)} onKeyDown={onKey} aria-label="Find in the file, or go to a line with a colon and its number" spellCheck={false} autoComplete="off" />
      {busy ? <Spinner size={10} label="Searching" /> : status && <span className="reader-find-count">{status}</span>}
      <Button variant="icon" size="sm" icon="chevron-up" title="Previous match" disabled={!onStep} onClick={() => onStep?.(-1)} />
      <Button variant="icon" size="sm" icon="chevron-down" title="Next match" disabled={!onStep} onClick={() => onStep?.(1)} />
      <Button variant="icon" size="sm" icon="x" title="Close" onClick={onClose} />
    </div>
  )
}
