// labels.ts: labels (engine/kernel/labels.py) in the terminal. A label is drawn as a card the kernel saves (its counts
// per value, each value's records as examples), and the detail view shows on every example the values labels gave it,
// how a part's rows split by each label, and lets the person check a record with the number keys (panes/detail.js).
// This module is the host's part of that, the model's reads and the person's checks:
//
//   labelFromFeed  a `label` line in the change feed (`thimble label NAME --prompt …` and `--again` write one): the
//                  model reads the waiting records beside the session (labelreads.mjs), its calls made here with
//                  $.model.complete, side by side; the progress shows under the card, the new card takes the old
//                  one's place, and Claude hears what the reads gave with its next prompt
//   askFromFeed  a `label_ask` line (a --prompt label over more records than a sample): the model reads nothing yet;
//                the terminal asks the person under the label's card and in the bar (1 run all, 2 run on a sample, 0
//                cancel), and answerAsk runs their choice as the person (`thimble label NAME --answer … --ask ID`)
//   labelsOf     what k.want({labels: refs, gen}) asks: each record's labels, read through `thimble label --of`,
//                kept per set of refs and per generation (a check starts a new one, so the examples read them again)
//   check        the detail's k.do('check', {label, ref, value}): `thimble label NAME --check REF VALUE`, as the
//                person's command (their session, never counted as what Claude read)
//   checksDone   when the detail closes after checks (or at the next prompt to main, if the close was never heard): the
//                label counted again and its card saved again (drawn in the old one's place), and Claude hears what the
//                person checked at once, in a row of its own the person never sees (shell.tsx tellMain)
import type { EngineInterface } from 'claude-code'

import { leanEnv, noteForClaude, showVersion, tellMain } from './shell'
import { promptText } from '../prompts/prompts'
import { tracked } from '../telemetry/telemetry'
import { SETTINGS, progressText, readLabel } from './labelreads.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const GEN = { plugin: 'thimble', key: 'labelgen' } as const
const OF = { plugin: 'thimble', key: 'labelsof' } as const
const SAID = { plugin: 'thimble', key: 'said' } as const
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/

/** The checks made since the detail opened, by folder and label: what the person said of which record. */
const made = new Map<string, { root: string; label: string; checks: { ref: string; was: string | null; now: string | null }[] }>()

async function thimble($: Engine, root: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run([`${dir}/bin/thimble`, ...args], { cwd: root, env: await leanEnv($, root), timeoutMs: 120000, ...(input != null ? { stdin: input } : {}) })
  return { code: r.exitCode ?? 1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') }
}

async function kernel($: Engine, root: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await thimble($, root, args)
  return { ok: r.code === 0, out: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim() }
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
    void readHere($, ev).catch(err => $.ui.toast(`× The model's reads of the label ${String(ev.name)} stopped: ${String((err as Error)?.message || err).slice(0, 200)}. \`thimble label ${String(ev.name)} --again\` starts them again.`))
  })
}

/** One call to the model, made here, as a line in the session's events under the feature `labels`. `units` and
 *  `telemetry` are notes for the shell, never sent. */
async function call($: Engine, request: Any): Promise<Any> {
  const { telemetry: tag, units: _units, ...req } = request
  try {
    const r = await tracked($, { feature: 'labels', prompt: tag?.prompt ?? null, model: String(req.model ?? '') }, () => $.model.complete(req))
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
export async function callAll($: Engine, requests: Any[], parallel: number, each?: (i: number, reply: Any) => unknown): Promise<Any[]> {
  const out: Any[] = new Array(requests.length)
  let next = 0
  const pause = (ms: number) => new Promise<void>(resolve => { $.clock.after(ms, () => resolve()) })
  const worker = async () => {
    while (next < requests.length) {
      const i = next++
      let r = await call($, requests[i])
      for (let t = 0; t < 3 && busyReply(r); t++) {
        await pause(2000 * 2 ** t)
        r = await call($, requests[i])
      }
      out[i] = r
      try { await each?.(i, r) } catch { /* the calls go on */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, requests.length)) }, worker))
  return out
}

/** The reads at work: `label… <progress>` under the card while its calls run; then the new card in the old one's place,
 *  what the reads gave for Claude with the next prompt, and a toast that says plainly what failed. */
async function readHere($: Engine, ev: Any): Promise<void> {
  const name = String(ev.name)
  const root = String(ev.root).replace(/\/+$/, '')
  const card = typeof ev.object === 'string' && ID.test(ev.object) ? ev.object : null
  const say = async (v: Any) => { if (card) await $.state.set({ ...SAID, id: card }, v) }
  await say({ verb: 'label', running: true, text: 'starting' })
  const t = await promptText($, 'labels')
  const out: Any = await readLabel({
    name, template: t.text, promptId: t.id, settings: SETTINGS,
    kernel: (args: string[], input?: string) => thimble($, root, args, input),
    callAll: (reqs: Any[], each: (i: number, r: Any) => unknown) => callAll($, reqs, SETTINGS.parallel, each),
    progress: (p: Any) => say({ verb: 'label', running: true, text: progressText(p) }),
  })
  await say(out.error ? { verb: 'label', error: out.error } : { verb: 'label', text: out.text })
  if (out.card) await showVersion($, { id: out.card.id, v: out.card.v, root })
  await noteForClaude($, out.error ? `The model's reads of the label ${name} failed: ${out.error}` : out.note)
  if (out.error) $.ui.toast(`× label ${name}: ${String(out.error).slice(0, 200)}`)
  else if (out.failed) $.ui.toast(`! ${String(out.text).slice(0, 240)}`)
}

// ------------------------------------------------------------------------------------------------ the ask before a big run

/** The ask that waits for the person's choice: a big label's run, with the sentence that says what it reads, the line
 *  under its choices (its model calls) and the card it is drawn under. One at a time: a newer ask takes its place. */
const LABELASK = { plugin: 'thimble', key: 'labelask' } as const
export type LabelAsk = { root: string; name: string; ask: string; card: string | null; text: string; meta: string; units: number; sample: number }

/** A `label_ask` line of the change feed: the ask waits for the person (the bar and the card's row show it). */
export async function askFromFeed($: Engine, ev: Any): Promise<void> {
  if (typeof ev?.name !== 'string' || !ID.test(ev.name) || typeof ev.root !== 'string' || typeof ev.ask !== 'string') return
  const a: LabelAsk = {
    root: String(ev.root).replace(/\/+$/, ''), name: ev.name, ask: ev.ask,
    card: typeof ev.object === 'string' && ID.test(ev.object) ? ev.object : null,
    text: String(ev.text || `Read ${Number(ev.units) || 0} records with Claude`), meta: String(ev.meta || ''),
    units: Number(ev.units) || 0, sample: Number(ev.sample) || 0,
  }
  await $.state.set(LABELASK, a)
}

/** The ask that waits, if any. */
export async function labelAskNow($: Engine): Promise<LabelAsk | null> {
  return ((await $.state.get(LABELASK)).value ?? null) as LabelAsk | null
}

/** The person's choice for the ask: run all, run on a sample, or cancel, as their own command. The reads start here,
 *  beside the session, and Claude hears the choice with the next prompt. */
export async function answerAsk($: Engine, choice: 'all' | 'sample' | 'cancel'): Promise<void> {
  const a = await labelAskNow($)
  if (!a) return
  await $.state.set(LABELASK, null)
  const r = await kernel($, a.root, ['label', a.name, '--answer', choice, '--ask', a.ask])
  let got: Any = null
  try { got = JSON.parse(r.out) } catch { got = null }
  if (!r.ok || !got) {
    $.ui.toast(`× The label ${a.name} did not start: ${r.out.split('\n').slice(-1)[0]?.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing'}. Ask Claude to run it again.`)
    return
  }
  if (choice === 'cancel') {
    await noteForClaude($, `The analyst chose not to run the label ${a.name}: the model reads none of its ${a.units.toLocaleString('en-US')} records.`)
    return
  }
  const what = choice === 'all' ? `all ${a.units.toLocaleString('en-US')} records` : `a random sample of ${Number(got.reads || a.sample).toLocaleString('en-US')} records`
  await noteForClaude($, `The analyst chose to run the label ${a.name} on ${what}. The model reads them beside the session; \`thimble label ${a.name}\` shows the counts.`)
  const card = got.card && typeof got.card.id === 'string' ? got.card.id : a.card
  labelFromFeed($, { name: a.name, root: a.root, object: card, t: `${a.ask}-${choice}` })
}

/** How many checks the person has made: the examples' labels are read again when it changes. */
export async function labelGen($: Engine): Promise<number> {
  return Number((await $.state.get(GEN)).value ?? 0) || 0
}

/** Each record's labels ({ref: {label: {value, values, by, confidence, reason, checked, was}}}), read once per set of
 *  refs and generation. */
export async function labelsOf($: Engine, root: string, refs: string[], gen: number): Promise<unknown> {
  const list = refs.filter(r => typeof r === 'string' && r.length < 2000).slice(0, 200)
  if (!list.length) return {}
  const at = { ...OF, id: `${root}|${gen}|${list.join(' ').slice(0, 4000)}` }
  const kept = (await $.state.get(at)).value
  if (kept !== undefined) return kept
  const r = await kernel($, root, ['label', '--of', ...list])
  let v: unknown
  try { v = JSON.parse(r.out) } catch { v = { error: r.out.split('\n').slice(-1)[0]?.slice(0, 200) || 'thimble label --of gave nothing' } }
  await $.state.set(at, v)
  return v
}

/** The person's check of one record: what they say its value is. Returns a line for the person when it failed. */
export async function check($: Engine, root: string, a: Record<string, unknown>): Promise<string | void> {
  const label = String(a.label || '')
  const ref = String(a.ref || '')
  const value = a.value == null ? '-' : String(a.value)
  if (!label || !ref) return '× There is no record to check here.'
  const r = await kernel($, root, ['label', label, '--check', ref, value, '--json'])
  let got: Any = null
  try { got = JSON.parse(r.out) } catch { got = null }
  if (!r.ok || !got) return `× The check was not kept: ${r.out.split('\n').slice(-1)[0]?.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing'}`
  const key = `${root}|${label}`
  const m = made.get(key) ?? { root, label, checks: [] }
  m.checks = [...m.checks.filter(x => x.ref !== got.ref), { ref: got.ref, was: got.was ?? null, now: got.now ?? null }]
  made.set(key, m)
  await $.state.set(GEN, (await labelGen($)) + 1)
}

/** After the detail closes: each label the person checked is counted again and its card saved again, drawn where the
 *  old one is; Claude hears what they checked. */
export async function checksDone($: Engine): Promise<void> {
  const all = [...made.values()]
  made.clear()
  for (const m of all) {
    if (!m.checks.length) continue
    const r = await kernel($, m.root, ['label', m.label, '--json'])
    let s: Any = null
    try { s = JSON.parse(r.out) } catch { s = null }
    if (s?.card && s.card_version) await showVersion($, { id: String(s.card), v: Number(s.card_version), root: m.root })
    const agree = m.checks.filter(c => c.was != null && c.was === c.now)
    const changed = m.checks.filter(c => c.was !== c.now)
    const shown = changed.slice(0, 6).map(c => `${c.ref} (the label said ${c.was ?? 'nothing'}, the analyst says ${c.now})`)
    await tellMain($, `The analyst checked ${m.checks.length} record${m.checks.length === 1 ? '' : 's'} of the label ${m.label}: they agree with ${agree.length}` +
      (changed.length ? ` and changed ${changed.length}: ${shown.join('; ')}${changed.length > 6 ? '; …' : ''}` : '') +
      `. Their checks count in place of the label's values${s?.query ? `; its counts are now query ${s.query}` : ''}.`)
  }
}

/** Whether the person has made checks Claude has not heard of yet. */
export function checksPending(): boolean {
  return [...made.values()].some(m => m.checks.length > 0)
}

/** For tests: no checks remembered. */
export function resetLabels(): void {
  made.clear()
  started.clear()
}
