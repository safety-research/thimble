// labels.ts: labels (engine/kernel/labels.py) in the terminal: the model's reads of a --prompt label, the person's
// checks, and what the labels pane reads.
//
//   labelFromFeed  a `label` line in the change feed (`thimble label NAME --prompt …` and `--again` write one;
//                  core/feed.ts reads it): the model reads the waiting records beside the session (labelreads.mjs), its
//                  calls made here with $.model.complete, side by side. The bar's busy line says `labeling <name>` while
//                  they run; Claude hears what the reads gave with the person's next prompt; a call that failed shows
//                  the failure line (bar/fix.ts failNotice), in the person's words (core/why.js)
//   checkRecord    the person's check of one record in the labels pane: `thimble label NAME --check REF VALUE`; Claude
//                  hears what the person checked with their next prompt
//   labelsData     what the pane shows: the folder's labels (`thimble label --json`), or a page of one label's records
//                  (`--records`), read once per change of the labels and drawn when it arrives
//   labelsChanged  labelGen goes up: the pane reads the labels again
//
// The kernel calls run as the person: nothing they read counts as what Claude read (core/env.ts runThimble).
import type { EngineInterface } from 'claude-code'

import { busy } from '../bar/busy'
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
const READ = { plugin: 'thimble', key: 'labelRead' } as const
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
  const t = await promptText($, 'labels')
  const out: Any = await readLabel({
    name, template: t.text, promptId: t.id, settings: SETTINGS,
    kernel: (args: string[], input?: string): Promise<Ran> => runThimble($, root, args, input != null ? { stdin: input } : {}),
    callAll: async (reqs: Any[], each: (i: number, r: Any) => unknown) => {
      const replies = await callAll($, reqs, SETTINGS.parallel, doing, each)
      await labelsChanged($)
      return replies
    },
  })
  await tellAtNextPrompt($, `label:${root}|${name}`, out.error ? `The model's reads of the label ${name} failed: ${out.error}` : out.note)
  await labelsChanged($)
  if (out.error) failNotice($, `× The model's reads of the label ${name} failed: ${String(out.error).slice(0, 200)}.`)
  else if (out.failedCalls) failNotice($, `× ${out.failedCalls} of ${out.calls} model calls for the label ${name} failed: ${out.why}. \`thimble label ${name} --again\` asks again.`)
}

// ------------------------------------------------------------------------------------------------ the person's checks

/** The checks the person made in this load of the plugin, by folder and label: each record's latest. */
const checked = new Map<string, Map<string, { was: string | null; now: string | null }>>()

/** The person's check of one record: the value they say it has (null takes the check back). Returns a line for the
 *  person when it was not kept, else null. */
export async function checkRecord($: Engine, root: string, label: string, ref: string, value: string | null): Promise<string | null> {
  const r = await runThimble($, root, ['label', label, '--check', ref, value ?? '-', '--json'])
  let got: Any = null
  try { got = JSON.parse(r.stdout) } catch { got = null }
  if (r.code !== 0 || !got) return `× The check was not kept: ${said(r) || 'thimble label gave nothing'}`
  const key = `${root}|${label}`
  const mine = checked.get(key) ?? new Map<string, { was: string | null; now: string | null }>()
  mine.set(String(got.ref), { was: got.was ?? null, now: got.now ?? null })
  checked.set(key, mine)
  const all = [...mine.entries()].filter(([, c]) => c.now !== null)
  const changed = all.filter(([, c]) => c.was !== c.now)
  const shown = changed.slice(0, 8).map(([ref, c]) => `${ref} (the label gave ${c.was ?? 'no value'}, the analyst says ${c.now})`)
  await tellAtNextPrompt($, `label-checks:${key}`, `The analyst checked ${all.length} record${all.length === 1 ? '' : 's'} of the label ${label} in the labels pane: they agree with ${all.length - changed.length}` +
    (changed.length ? ` and changed ${changed.length}: ${shown.join('; ')}${changed.length > 8 ? '; …' : ''}` : '') +
    `. Their checks count in place of the label's values; \`thimble label ${label}\` prints the counts now.`)
  await labelsChanged($)
  return null
}

// ------------------------------------------------------------------------------------------------ what the pane reads

/** What the pane asks for: the labels (no `label`), or a page of one label's records: those of `value` (`*` all, `-`
 *  none yet), from `at`, `n` of them. */
export type LabelsAsk = { root: string; label?: string; value?: string; at?: number; n?: number }

/** The answers read since labelGen last changed, by ask: `value` once it came. */
const read = new Map<string, { value?: Any }>()
let readGen = -1
let arrived = 0

/** What the pane shows for `ask`: `thimble label --json` (a list of labels), or `thimble label NAME --records …
 *  --json` (a page: {label, value, at, total, records}); `{error}` when the kernel could not say; undefined while it is
 *  being read (a page of a large file takes a few seconds), and the pane is drawn again when it comes. Each ask is
 *  read once per labelGen, so drawing the pane again reads nothing. */
export async function labelsData($: Engine, ask: LabelsAsk): Promise<Any | undefined> {
  const gen = await labelGen($)
  await $.state.get(READ)
  if (gen !== readGen) {
    read.clear()
    readGen = gen
  }
  const key = JSON.stringify(ask)
  let got = read.get(key)
  if (!got) {
    const mine: { value?: Any } = {}
    got = mine
    read.set(key, mine)
    const args = ask.label
      ? ['label', ask.label, '--records', ask.value ?? '*', '--at', String(ask.at ?? 0), '--count', String(ask.n ?? 10), '--json']
      : ['label', '--json']
    const came = runThimble($, ask.root, args, { timeoutMs: 60000 }).then(r => {
      try { return JSON.parse(r.stdout) } catch { return { error: said(r) || 'thimble label gave nothing' } }
    }, err => ({ error: String((err as Error)?.message || err).slice(0, 200) })).then(v => {
      mine.value = v
      void $.state.set(READ, ++arrived).catch(() => undefined)
    })
    // a quick read is drawn at once, without a "reading" frame first
    await Promise.race([came, new Promise<void>(resolve => { $.clock.after(400, () => resolve()) })])
  }
  return got.value
}
