// A thread's rows with the edits main made itself to the cards the thread is anchored on (threadStatus.mainEdits), each
// a line under the question it answered: `Main is editing` with the card's chip while the call runs, then `Main edited`.
// The thread's own calls, its fork's, show as everywhere else.
import { Fragment, type ReactNode } from 'react'
import { RefChip } from '../components/RefChip'
import type { Row, ToolRow } from './model'
import { Note } from './Notes'
import { Rows, type ErrorRetry } from './Rows'
import { editedCard } from './threadStatus'

/** One of main's own edits of a card the thread is anchored on, as a line in the thread. */
export function MainEdit({ row, ws }: { row: ToolRow; ws: string }) {
  const card = editedCard(row)
  const state = !row.result ? 'running' : row.result.is_error ? 'failed' : 'done'
  const text = state === 'running' ? 'Main is editing' : state === 'failed' ? 'Main could not edit' : 'Main edited'
  return <Note className="chat-main-edit" data-state={state} spin={state === 'running'} text={text} chips={card ? <RefChip ref={`card:${card}`} compact workspace={ws} /> : undefined} />
}

export function ThreadRows({ rows, edits, ws, chat, streaming = false, working, retry }: { rows: readonly Row[]; edits: ReadonlyMap<number, ToolRow[]>; ws: string; chat: string; streaming?: boolean; working?: ReactNode; retry?: ErrorRetry }) {
  // the rows cut after each question main edited a card for; the working line goes after the last part
  const parts: { key: string; rows: Row[]; edits: ToolRow[] }[] = []
  let start = 0
  let key = 'start'
  rows.forEach((r, i) => {
    const mine = r.kind === 'user' ? edits.get(r.index) : undefined
    if (!mine?.length) return
    parts.push({ key, rows: rows.slice(start, i + 1), edits: mine })
    start = i + 1
    key = `after:${r.index}`
  })
  parts.push({ key, rows: rows.slice(start), edits: [] })
  return (
    <>
      {parts.map((p, k) => {
        const last = k === parts.length - 1
        return (
          <Fragment key={p.key}>
            <Rows rows={p.rows} ws={ws} chat={chat} streaming={last && streaming} working={last ? working : undefined} retry={retry} />
            {p.edits.map((e) => (
              <MainEdit key={e.id} row={e} ws={ws} />
            ))}
          </Fragment>
        )
      })}
    </>
  )
}
