// edit.ts: the person's change of a label from the labels pane: the label applied again with one thing changed (its
// rule, its plain sentence, the records it goes over, its values, a prompt label's model, a trial's size), by the same
// `thimble label` command Claude runs (ledger.mjs rerunArgs), so its versions, checks and records stay right. It runs as
// the person (core/env.ts runThimble): nothing it reads counts as what Claude read.
//
//   rerunLabel($, root, label, change)   applies `label` (as `thimble label --json` gives it) again with `change`;
//                                        a line for the person when it could not, else null. A prompt label's records
//                                        are read, or the person is asked first, as when Claude runs it (core/feed.ts
//                                        withPersonFeed); Claude hears what changed with the person's next prompt
import type { EngineInterface } from 'claude-code'

import { runThimble } from '../core/env'
import { withPersonFeed } from '../core/feed'
import { tellAtNextPrompt } from '../core/tell'
import { labelsChanged } from './labels'
import { rerunArgs } from './ledger.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A field's name as Claude reads it in the note. */
const FIELD: Record<string, string> = { rule: 'rule', says: 'plain sentence', in: 'records (--in)', values: 'values', where: '--where', within: '--within', model: 'model', limit: 'trial size (--limit)' }

export async function rerunLabel($: Engine, root: string, label: Any, change: Record<string, unknown>): Promise<string | null> {
  const name = String(label?.name ?? '')
  const run = rerunArgs(label, change) as { args: string[]; stdin?: string } | null
  if (!run) return `× The label ${name} cannot be applied again from here: it has no rule or no records named.`
  let r: Awaited<ReturnType<typeof runThimble>>
  try {
    r = await withPersonFeed($, () => runThimble($, root, run.args, { ...(run.stdin != null ? { stdin: run.stdin } : {}), timeoutMs: 300000 }))
  } catch (err) {
    return `× The label ${name} was not applied again: ${String((err as Error)?.message || err).slice(0, 200)}`
  }
  let got: Any = null
  try { got = JSON.parse(r.stdout) } catch { got = null }
  await labelsChanged($)
  if (r.code !== 0 || !got) return `× The label ${name} was not applied again: ${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-1)[0]!.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing'}`
  const what = Object.keys(change).map(k => FIELD[k] ?? k).join(', ')
  const counts = Object.entries((got.counts ?? {}) as Record<string, number>).map(([v, n]) => `${v} ${n}`).join(', ')
  await tellAtNextPrompt($, `label-edit:${root}|${name}`, `The analyst changed the ${what} of the label ${name} in the labels pane and applied it again: ${run.args.slice(1, -1).join(' ')}. ` +
    `It holds ${Number(got.records) || 0} records${counts ? ` (${counts})` : ''}${got.waiting ? `, ${got.waiting} of them waiting for the model` : ''}. \`thimble label ${name}\` prints its counts now.`)
  return null
}
