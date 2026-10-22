// The one sign that Claude or thimble works, just above the chat's input box: a spinner, the step's words and its
// seconds (lib/busy.ts). Main's turn is the step "answering" and a side thread's "answering: <thread>", as the chat list
// says them (`running`, which the server sets for an open turn); thimble's own steps come from lib/busy.ts. No chat
// row, tab or thread draws a spinner of its own.
import { useEffect, useRef } from 'react'
import { Spinner } from '../components/Spinner'
import { pageJob, useBusy } from '../lib/busy'
import { useChatMetas } from './useChat'

type Meta = { id?: string; kind?: string; title?: string; name?: string | null; running?: boolean }

/** The chats whose turn runs now, each as its step: main's "answering", a thread's "answering: <its name>". Pure. */
export function answering(metas: readonly Meta[]): { id: string; word: string }[] {
  return metas
    .filter((m) => m.running && m.id)
    .map((m) => {
      if (m.kind === 'main') return { id: 'chat:main', word: 'answering' }
      const name = String(m.name || m.title || 'a thread').replace(/\s+/g, ' ').trim()
      return { id: `chat:${m.id}`, word: `answering: ${name.length > 24 ? `${name.slice(0, 23)}…` : name}` }
    })
}

export function ChatBusy({ ws }: { ws: string }) {
  const metas = useChatMetas(ws)
  const now = answering(metas)
  const key = now.map((x) => `${x.id}=${x.word}`).join('|')
  // the turns that run, as the page's own steps: one that ended goes, one that runs on keeps its time
  const was = useRef<string[]>([])
  useEffect(() => {
    for (const x of now) pageJob(x.id, x.word)
    for (const id of was.current) if (!now.some((x) => x.id === id)) pageJob(id, null)
    was.current = now.map((x) => x.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(
    () => () => {
      for (const id of was.current) pageJob(id, null)
    },
    [],
  )
  const job = useBusy()
  if (!job) return null
  return (
    <div className="chat-strip chat-busy" role="status" data-busy={job.word}>
      <div className="chat-strip-bar">
        <span className="chat-busy-head">
          <Spinner label={job.word} />
          <span className="chat-strip-title">
            {job.word}
            {job.secs != null && <span className="chat-busy-secs"> {job.secs}s</span>}
          </span>
        </span>
      </div>
    </div>
  )
}
