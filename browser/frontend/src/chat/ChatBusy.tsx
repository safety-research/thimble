// The one sign that Claude or thimble works, just above the chat's input box, where the orientation's strip used to
// sit: a spinner and a word. "working" while main's turn runs (the chat list's `running`), and thimble's own job
// (lib/busy.ts: "marking", "labeling", "writing") with its seconds from 3 s on. When both run, one line says both.
import { Spinner } from '../components/Spinner'
import { useBusy } from '../lib/busy'
import { useChatMetas } from './useChat'

/** Main's turn while it runs, as the chat list says it (`running`, which the server sets for the open turn). */
export function mainRunning(metas: readonly { kind?: string; running?: boolean }[]): boolean {
  return metas.some((m) => m.kind === 'main' && !!m.running)
}

export function ChatBusy({ ws }: { ws: string }) {
  const main = mainRunning(useChatMetas(ws))
  const job = useBusy()
  if (!main && !job) return null
  return (
    <div className="chat-strip chat-busy" role="status" data-busy={job?.word ?? 'main'} data-main={main || undefined}>
      <div className="chat-strip-bar">
        <span className="chat-busy-head">
          <Spinner label="working" />
          <span className="chat-strip-title">
            {main && 'working'}
            {main && job && <span className="chat-busy-sep"> · </span>}
            {job && job.word}
            {job?.secs != null && <span className="chat-busy-secs"> {job.secs}s</span>}
          </span>
        </span>
      </div>
    </div>
  )
}
