// labels.ts: labels (engine/kernel/labels.py) in the terminal: the model's reads of a --prompt label, the person's
// checks, and what the labels pane reads.
//
//   labelFromFeed  a `label` line in the change feed (`thimble label NAME --prompt …` and `--again` write one;
//                  core/feed.ts reads it): the model reads the waiting records beside the session (labelreads.mjs), its
//                  calls made here with $.model.complete, side by side. The bar's busy line says `labeling <name>` while
//                  they run; Claude hears what the reads gave with the person's next prompt; a call that failed shows
//                  the failure line (bar/notice.ts failNotice), in the person's words (core/why.js)
//   checkRecord    the person's check of one record in the labels pane: `thimble label NAME --check REF VALUE`; Claude
//                  hears what the person checked with their next prompt
//   labelsData     what the pane shows: the folder's labels (`thimble label --json`), or a page of one label's records
//                  (`--records`), read once per change of the labels
//   labelsChanged  labelGen goes up: the pane reads the labels again
//
// The kernel calls run as the person: nothing they read counts as what Claude read (core/env.ts runThimble).
import type { EngineInterface } from 'claude-code'

import { busy } from '../bar/busy'
import { failCleared, failNotice } from '../bar/notice'
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

/** A count that goes up whenever a label changes (Claude's command, the model's reads, the person's check): what shows
 *  a label reads it, and reads the label again when it changes. */
export async function labelGen($: Engine): Promise<number> {
  return Number((await $.state.get(GEN)).value ?? 0) || 0
}

export async function labelsChanged($: Engine): Promise<void> {
  await $.state.set(GEN, (await labelGen($)) + 1)
}

/** The last line a kernel call said, without its `thimble label: ` prefix. */
const said = (r: Ran) => `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-1)[0]!.replace(/^thimble label: /, '').slice(0, 200)

// ------------------------------------------------------------------------------------------------ the model's reads

/** The feed lines whose reads have started, so each runs once. */
const started = new Set<string>()

/** A `label` line of the change feed, read once: the model's reads of the label start beside the session. */
export function labelFromFeed($: Engine, ev: Any): void {
  if (typeof ev?.name !== 'string' || !ID.test(ev.name) || typeof ev.root !== 'string') return
  const key = `${ev.root}|${ev.name}|${ev.t}`
  if (started.has(key)) return
  started.add(key)
  const name = String(ev.name)
  $.clock.after(0, () => {
    void busy($, `labeling ${name}`, () => readHere($, name, String(ev.root).replace(/\/+$/, '')))
      .catch(err => failNotice($, `× The model's reads of the label ${name} stopped: ${String((err as Error)?.message || err).slice(0, 200)}. \`thimble label ${name} --again\` starts them again.`))
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

/** The reads at work (the pane follows each wave's answers), then what they gave for Claude with the next prompt, and
 *  the failure line when a call failed. */
async function readHere($: Engine, name: string, root: string): Promise<void> {
  const doing = `labeling ${name}`
  const out: Any = await readLabel({
    name, template: await promptText($, 'labels'), promptId: 'labels', settings: SETTINGS,
    kernel: (args: string[], input?: string): Promise<Ran> => runThimble($, root, args, input != null ? { stdin: input } : {}),
    callAll: async (reqs: Any[], each: (i: number, r: Any) => unknown) => {
      const replies = await callAll($, reqs, SETTINGS.parallel, doing, each)
      await labelsChanged($)
      return replies
    },
  })
  await tellAtNextPrompt($, `label:${root}|${name}`, out.error ? `The model's reads of the label ${name} failed: ${out.error}` : out.note)
  await labelsChanged($)
  const about = `label:${root}|${name}`
  if (out.error) failNotice($, `× The model's reads of the label ${name} failed: ${String(out.error).slice(0, 200)}.`, about)
  else if (out.failed) failNotice($, `× ${out.failed.toLocaleString('en-US')} record${out.failed === 1 ? '' : 's'} of the label ${name} got no value, because ${out.because}. \`thimble label ${name} --again\` asks again.`, about)
  else return
  failing.set(about, { root, name })
}

/** The labels a failure line is about now, by the line's `about`. */
const failing = new Map<string, { root: string; name: string }>()

/** After a `thimble label` command of Claude's: a label whose failure line shows and whose records all have a value now
 *  (Claude set them, or `--again` read them) takes the line away, and what waited to be told of it. */
export async function labelsSettled($: Engine): Promise<void> {
  for (const [about, { root, name }] of [...failing]) {
    const r = await runThimble($, root, ['label', name, '--json'])
    let s: Any = null
    try { s = JSON.parse(r.stdout) } catch { s = null }
    if (!s || s.waiting || s.failed) continue
    failing.delete(about)
    await failCleared($, about)
    await tellAtNextPrompt($, about, '')
  }
}

// ------------------------------------------------------------------------------------------------ the person's checks

/** The person's check of one record: the value they say it has (null takes the check back). Claude hears, with the
 *  next prompt, every check of the label that changed a value, as the label holds them. Returns a line for the person
 *  when the check was not kept, else null. */
export async function checkRecord($: Engine, root: string, label: string, ref: string, value: string | null): Promise<string | null> {
  let r: Ran
  try {
    r = await runThimble($, root, ['label', label, '--check', ref, value ?? '-', '--json'])
  } catch (err) {
    return `× The check was not kept: ${String((err as Error)?.message || err).slice(0, 200)}`
  }
  let got: Any = null
  try { got = JSON.parse(r.stdout) } catch { got = null }
  if (r.code !== 0 || !got) return `× The check was not kept: ${said(r) || 'thimble label gave nothing'}`
  const changed: Any[] = Array.isArray(got.changed) ? got.changed : []
  const shown = changed.slice(0, 8).map(c => `${c.ref} (the label gave ${c.was ?? 'no value'}, the analyst says ${c.now})`)
  await tellAtNextPrompt($, `label-checks:${root}|${label}`, `The analyst checked records of the label ${label} in the labels pane. It now holds ${got.checked} check${got.checked === 1 ? '' : 's'}: ${got.agree} agree with the label` +
    (changed.length ? ` and ${changed.length} changed a value: ${shown.join('; ')}${changed.length > 8 ? '; …' : ''}` : '') +
    `. The checks count in place of the label's values; \`thimble label ${label}\` prints the counts now.`)
  await labelsChanged($)
  return null
}

// ------------------------------------------------------------------------------------------------ what the pane reads

/** A /clear or a /resume (hooks/turnover.ts): the labels are the new conversation's. What was read of the earlier
 *  one's, and the failure lines about them, go; what shows a label reads it again. */
export async function turnLabels($: Engine): Promise<void> {
  failing.clear()
  read.clear()
  readGen = -1
  await labelsChanged($)
}

/** What the pane asks for: the labels (no `label`), or a page of one label's records: those of `value` (`*` all, `-`
 *  none yet), from `at`, `n` of them. */
export type LabelsAsk = { root: string; label?: string; value?: string; at?: number; n?: number }

/** The answers read since labelGen last changed, by ask. */
const read = new Map<string, Any>()
let readGen = -1

/** What the pane shows for `ask`: `thimble label --json` (a list of labels), or `thimble label NAME --records …
 *  --json` (a page: {label, value, at, total, records}); `{error}` when the kernel could not say. An answer is kept until
 *  labelGen changes, so drawing the pane again reads nothing. (A read belongs to the drawing that made it, which a newer
 *  drawing stops: so only a read that came back is kept, and the newer drawing reads again.) */
export async function labelsData($: Engine, ask: LabelsAsk): Promise<Any> {
  const gen = await labelGen($)
  if (gen !== readGen) {
    read.clear()
    readGen = gen
  }
  const key = JSON.stringify(ask)
  if (read.has(key)) return read.get(key)
  const args = ask.label
    ? ['label', ask.label, '--records', ask.value ?? '*', '--at', String(ask.at ?? 0), '--count', String(ask.n ?? 10), '--json']
    : ['label', '--json']
  const r = await runThimble($, ask.root, args, { timeoutMs: 60000 })
  let v: Any
  try { v = JSON.parse(r.stdout) } catch { v = { error: said(r) || 'thimble label gave nothing' } }
  if (gen === readGen) read.set(key, v)
  return v
}
