// What the strip behind the composer says while main or a side thread works (ChatPanel taskStrip): the step under way,
// in the words of a step that runs (Running · Count revisions per day, Waiting on <the subagent>), Thinking while no call
// runs, and the time since the turn started, which the strip counts up each second.
import type { ChatRecord } from '../lib/types'
import { HANDBACK_LINE, plainStep, taskTitle, toolDisplayName, type Row, type ToolRow } from './model'

/** The strip's line while no call of the turn runs: the model reads, thinks or writes. */
export const THINKING = 'Thinking'

/** A finished step's verb (plainStep) as the verb of a step under way. A verb not listed stays as it is. */
const UNDER_WAY: Readonly<Record<string, string>> = {
  'Added card': 'Adding card',
  'Edited card': 'Editing card',
  'Deleted card': 'Deleting card',
  'Listed cards': 'Listing cards',
  Read: 'Reading',
  'Took screenshot': 'Taking screenshot',
  'Applied label': 'Applying label',
  'Showed label': 'Showing label',
  'Hid label': 'Hiding label',
  'Deleted label': 'Deleting label',
  'Ran check': 'Running check',
  'Turned off check': 'Turning off check',
  'Proposed view': 'Proposing view',
  Wrote: 'Writing',
  Edited: 'Editing',
  'Commented on': 'Commenting on',
  'Resolved comment': 'Resolving comment',
  'Reopened comment': 'Reopening comment',
  Replied: 'Replying',
  'Sent to thread': 'Sending to thread',
  'Asked again in thread': 'Asking again in thread',
  'Waited for': 'Waiting for',
  'Listed agents': 'Listing agents',
  'Renamed thread': 'Renaming thread',
  'Deleted thread': 'Deleting thread',
  'Filed ticket': 'Filing ticket',
  'Searched for': 'Searching for',
  'Listed files': 'Listing files',
  Ran: 'Running',
  Fetched: 'Fetching',
  'Searched the web for': 'Searching the web for',
  'Ran workflow': 'Running workflow',
  'Loaded skill': 'Loading skill',
  [HANDBACK_LINE]: 'Sending its summary to main',
}

/** A call that runs, as the strip says it: the subagent a call of Agent or Task waits on, else its step (plainStep) with
 * the verb of a step under way. Pure. */
export function stepUnderWay(t: ToolRow): string {
  const name = toolDisplayName(t.name)
  if (name === 'Agent' || name === 'Task') {
    const inp = (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>
    const title = taskTitle(String(inp.description ?? inp.subagent_type ?? '').replace(/\s+/g, ' ').trim())
    return title ? `Waiting on ${title}` : 'Waiting on a subagent'
  }
  const plain = plainStep(t)
  const at = plain.indexOf(' · ')
  const verb = at < 0 ? plain : plain.slice(0, at)
  return (UNDER_WAY[verb] ?? verb) + (at < 0 ? '' : plain.slice(at))
}

/** The call of the turn that runs now: of the calls that end the rows (several made at once), the last with no result
 * yet; null while no call runs. A call whose result only says a background subagent started has ended: the turn goes
 * on without it. Pure. */
export function callUnderWay(rows: readonly Row[]): ToolRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.kind !== 'tool') return null
    if (!r.result) return r
  }
  return null
}

/** What the strip says the turn does now: the call under way (stepUnderWay), else THINKING. Pure. */
export function currentStep(rows: readonly Row[]): string {
  const t = callUnderWay(rows)
  return t ? stepUnderWay(t) : THINKING
}

/** When the turn that runs started, in ms: the time of the first record after the log's last `done` or `error` that has
 * one; null when none of them has a time. Pure. */
export function turnStart(records: readonly ChatRecord[]): number | null {
  let from = 0
  for (let i = records.length - 1; i >= 0; i--) {
    const t = records[i].type
    if (t === 'done' || t === 'error') {
      from = i + 1
      break
    }
  }
  for (let i = from; i < records.length; i++) {
    const r = records[i]
    const ts = 'ts' in r ? r.ts : undefined
    const ms = ts ? Date.parse(ts) : NaN
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/** A time so far as the strip counts it: 8s, 1m 05s, 1h 02m. Pure. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
