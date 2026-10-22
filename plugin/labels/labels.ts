// labels.ts: labels (engine/kernel/labels.py) in the terminal: the model's reads of a --prompt label.
//
//   labelFromFeed  a `label` line in the change feed (`thimble label NAME --prompt …` and `--again` write one): the
//                  model reads the waiting records beside the session (labelreads.mjs), its calls made here with
//                  $.model.complete, side by side; the bar's busy line says `labeling <name>` while they run, and Claude
//                  hears what the reads gave with the person's next prompt
//
// The kernel calls run as the person: nothing they read counts as what Claude read (core/env.ts runThimble).
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/fix'
import { runThimble, type Ran } from '../core/env'
import { tellAtNextPrompt } from '../core/tell'
import { promptText } from '../prompts/prompts'
import { tracked } from '../telemetry/telemetry'
import { SETTINGS, readLabel } from './labelreads.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const GEN = { plugin: 'thimble', key: 'labelGen' } as const
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/

/** A count that changes whenever a label changes here (its reads ended): what shows a label reads it again when it
 *  changes. */
export async function labelGen($: Engine): Promise<number> {
  return Number((await $.state.get(GEN)).value ?? 0) || 0
}

// ------------------------------------------------------------------------------------------------ the model's reads

/** The feed lines whose reads have started, so each runs once. */
const started = new Set<string>()

/** A `label` line of the change feed, read once: the model's reads of the label start beside the session. */
export function labelFromFeed($: Engine, ev: Any): void {
  if (typeof ev?.name !== 'string' || !ID.test(ev.name) || typeof ev.root !== 'string') return
  const key = `${ev.root}|${ev.name}|${ev.t}`
  if (started.has(key)) return
  started.add(key)
  $.clock.after(0, () => {
    void readHere($, ev).catch(err => failNotice($, `× The model's reads of the label ${String(ev.name)} stopped: ${String((err as Error)?.message || err).slice(0, 200)}. \`thimble label ${String(ev.name)} --again\` starts them again.`))
  })
}

/** One call to the model, made here, as a line in the session's events under the feature `labels`. `units` and
 *  `telemetry` are notes for the plugin, never sent. */
async function call($: Engine, request: Any, doing: string): Promise<Any> {
  const { telemetry: tag, units: _units, ...req } = request
  try {
    const r = await tracked($, { feature: 'labels', doing, prompt: tag?.prompt ?? null, model: String(req.model ?? '') }, () => $.model.complete(req))
    return r ?? { isAnswered: false, reason: 'empty-reply' }
  } catch (err) {
    return { isAnswered: false, reason: 'refused', error: String((err as Error)?.message || err).slice(0, 300) }
  }
}

/** Whether a call came back without text because the API was busy (a rate limit, an overload, a server error): such a
 *  call is tried again after a pause. */
const busyReply = (r: Any) => !!r && r.isAnswered === false && r.reason === 'api-error' && [429, 500, 502, 503, 529].includes(Number(r.status))

/** The calls of a wave, made side by side, at most `parallel` at once. A call the API turned away while busy is tried
 *  again after 2, 4 and 8 seconds. `each(i, reply)` hears each as it comes back. */
export async function callAll($: Engine, requests: Any[], parallel: number, doing: string, each?: (i: number, reply: Any) => unknown): Promise<Any[]> {
  const out: Any[] = new Array(requests.length)
  let next = 0
  const pause = (ms: number) => new Promise<void>(resolve => { $.clock.after(ms, () => resolve()) })
  const worker = async () => {
    while (next < requests.length) {
      const i = next++
      let r = await call($, requests[i], doing)
      for (let t = 0; t < 3 && busyReply(r); t++) {
        await pause(2000 * 2 ** t)
        r = await call($, requests[i], doing)
      }
      out[i] = r
      try { await each?.(i, r) } catch { /* the calls go on */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, requests.length)) }, worker))
  return out
}

/** The reads at work, then what they gave for Claude with the next prompt, and a line that says plainly what failed. */
async function readHere($: Engine, ev: Any): Promise<void> {
  const name = String(ev.name)
  const root = String(ev.root).replace(/\/+$/, '')
  const doing = `labeling ${name}`
  const t = await promptText($, 'labels')
  const out: Any = await readLabel({
    name, template: t.text, promptId: t.id, settings: SETTINGS,
    kernel: (args: string[], input?: string): Promise<Ran> => runThimble($, root, args, input != null ? { stdin: input } : {}),
    callAll: (reqs: Any[], each: (i: number, r: Any) => unknown) => callAll($, reqs, SETTINGS.parallel, doing, each),
  })
  await tellAtNextPrompt($, `label:${name}`, out.error ? `The model's reads of the label ${name} failed: ${out.error}` : out.note)
  await $.state.set(GEN, (await labelGen($)) + 1)
  if (out.error) failNotice($, `× label ${name}: ${String(out.error).slice(0, 200)}`)
  else if (out.failed) $.ui.toast(`! ${String(out.text).slice(0, 240)}`)
}
