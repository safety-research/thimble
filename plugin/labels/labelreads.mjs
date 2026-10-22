// labelreads.mjs: the model's reads of a --prompt label (engine/kernel/labels.py). Its records wait in the label until
// the model has read each one against the label's definition; `thimble label NAME --prompt …` (and `--again`) writes a
// `label` line in the session's change feed, and the plugin (labels.ts) makes the reads beside the session, so neither
// Claude nor the person waits on them (`thimble label NAME --wait` waits, when Claude wants the counts in the same
// turn). No `$` here: the plugin hands in the kernel and the model, and the tests a stand-in for each.
//
//   readLabel({name, kernel, callAll, template, promptId, settings, progress}) -> {text, note, failedCalls, calls, why}
//                                                                                   | {error}
//   requestFor(template, label, units, settings) -> a $.model.complete request for one batch (units: [{ref, text}])
//   answersOf(reply, units, values)              -> {values: {ref: {value, confidence, reason}}, failed: {ref: why}}
//   failedCall(reply, units)                     -> {failed: {ref: why}} for a call that brought no text
//
// The records go in batches of up to 50 (the kernel's `batches`), one call each, with the registry's `labels` prompt,
// a wave of calls at a time (settings.wave), made side by side by the plugin. After each wave the answers go back to
// the label (`thimble label NAME --answers -`), so reads that stop halfway keep what they got. A call that fails, a
// reply that is not JSON, or a value off the label's list leaves those records with no value and says why; they never
// wait again by themselves (`--again` asks once more).
import { fill } from '../prompts/registry.mjs'
import { modelWhy } from '../core/why.js'

const REASON = ', "reason": one short sentence naming the words in the record that decided the value'

/** The request for one batch: the label's definition, its values and the records, each under its number. */
export function requestFor(template, label, units, cfg = {}) {
  const records = units.map((u, i) => `### record ${i + 1}\n${String(u.text || '').trim()}`).join('\n\n')
  const prompt = fill(template, {
    NAME: label.name,
    DEFINITION: String(label.definition || '').trim() || '(no definition was given)',
    VALUES: label.values.join(', '),
    REASON_FIELD: label.reason ? REASON : '',
    RECORDS: records,
  })
  return {
    model: String(cfg.model || 'sonnet'),
    prompt,
    maxTokens: Number(cfg.maxTokens) || 8000,
    ...(cfg.effort ? { effort: String(cfg.effort) } : {}),
    ...(cfg.timeoutMs ? { timeoutMs: Number(cfg.timeoutMs) } : {}),
    // for the progress and the session's events; never sent to the model
    units: units.length,
    telemetry: { feature: 'labels', prompt: cfg.promptId || null },
  }
}

/** The JSON array in a reply: the whole text, a fenced block, or the first [ … ] in it. */
function arrayIn(text) {
  const s = String(text || '').trim()
  const tries = [s]
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
  if (fence) tries.push(fence[1])
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1))
  for (const t of tries) {
    try {
      const v = JSON.parse(t)
      if (Array.isArray(v)) return v
      if (v && Array.isArray(v.records)) return v.records
    } catch { /* the next form */ }
  }
  return null
}

/** What a reply says of each record of its batch. A record the reply leaves out, or gives a value off the list, has
 *  no value and says why; a near miss in case is the value it names. */
export function answersOf(reply, units, values) {
  const out = { values: {}, failed: {} }
  const arr = arrayIn(reply)
  if (!arr) {
    for (const u of units) out.failed[u.ref] = 'the reply held no JSON array of values'
    return out
  }
  const byI = new Map()
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue
    const i = Number(e.i ?? e.index ?? e.n)
    if (Number.isInteger(i) && !byI.has(i)) byI.set(i, e)
  }
  units.forEach((u, k) => {
    const e = byI.get(k + 1)
    if (!e) { out.failed[u.ref] = 'the reply gave this record no value'; return }
    const raw = e.value ?? e.label
    const v = values.find(x => x === raw) ?? values.find(x => typeof raw === 'string' && x.toLowerCase() === raw.trim().toLowerCase())
    if (v === undefined) { out.failed[u.ref] = `the reply gave ${JSON.stringify(raw)}, which is not one of ${values.join(', ')}`; return }
    const c = Number(e.confidence)
    out.values[u.ref] = { value: v, ...(Number.isFinite(c) ? { confidence: Math.max(0, Math.min(1, c)) } : {}), ...(e.reason || e.rationale ? { reason: String(e.reason || e.rationale).slice(0, 300) } : {}) }
  })
  return out
}

/** Every record of a call that brought no text, with why in the person's words (core/why.js). */
export function failedCall(reply, units) {
  const why = `the call failed: ${modelWhy(reply)}`
  return { values: {}, failed: Object.fromEntries(units.map(u => [u.ref, why])) }
}

/** The calls' settings: the model, its effort and limits, how many calls run at once and how many make a wave. */
export const SETTINGS = { model: 'sonnet', effort: 'low', maxTokens: 8000, timeoutMs: 180000, parallel: 8, wave: 16 }

const n = x => Number(x || 0).toLocaleString('en-US')

/** The label's state in one line, as the person and Claude read it. */
export function summary(name, s) {
  const counts = Object.entries(s.counts || {}).map(([v, k]) => `${n(k)} ${v}`).join(', ')
  const parts = [`${name}: ${n(s.valued)} of ${n(s.records)} records have a value${counts ? ` (${counts})` : ''}`]
  if (s.waiting) parts.push(`${n(s.waiting)} still wait for the model`)
  if (s.failed) parts.push(`${n(s.failed)} have no value${s.why ? ` (${s.why})` : ''}: \`thimble label ${name} --again\` asks the model again`)
  return parts.join('. ') + '.'
}

/**
 * Read every waiting record of the label `name`, a wave of calls at a time.
 *   kernel(args, input?) -> {code, stdout, stderr}   the `thimble` command, in the label's folder
 *   callAll(requests, each) -> replies                the calls made side by side; each(i, reply) as each comes back
 *   progress({done, of, failed})                      after each call
 */
export async function readLabel({ name, kernel, callAll, template, promptId = null, settings = SETTINGS, progress }) {
  const json = async (args, input) => {
    const r = await kernel([...args, '--json'], input)
    try { return JSON.parse(r.stdout) } catch { return { error: (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 400) || `exit ${r.code}` } }
  }
  // the reads are picked up: `thimble label NAME --wait` waits for them from here on
  const start = await kernel(['label', name, '--answers', '-'], JSON.stringify({ run: { state: 'running', started: Date.now() / 1000 } }))
  if (start.code !== 0) return { error: `the label ${name} could not be read: ${(start.stdout + start.stderr).trim().slice(0, 300)}` }
  const wave = Math.max(1, Number(settings.wave) || 16)
  let last = null
  let calls = 0
  let failedCalls = 0
  let why = ''
  let of = null
  let done = 0
  // a read that stops tells the label, so `thimble label NAME --wait` stops too and says why
  const stop = async error => {
    await kernel(['label', name, '--answers', '-'], JSON.stringify({ run: { state: 'failed', error: String(error).slice(0, 300) } }))
    return { error }
  }
  for (;;) {
    // the records of one wave only: the whole list of a large label is more than a process's output can carry
    const w = await json(['label', name, '--waiting', String(wave)])
    if (w.error) return stop(`the label ${name} could not be read: ${w.error}`)
    if (!w.units.length) break
    const left = Number.isFinite(Number(w.waiting)) ? Number(w.waiting) : w.units.length
    if (of == null) {
      of = left
      try { await progress?.({ done: 0, of, failed: 0 }) } catch { /* the reads go on */ }
    }
    const byRef = new Map(w.units.map(u => [u.ref, u]))
    const batches = w.batches.slice(0, wave).map(refs => refs.map(r => byRef.get(r)).filter(Boolean))
    const replies = await callAll(batches.map(units => requestFor(template, w, units, { ...settings, promptId })), async (i, reply) => {
      done += batches[i].length
      if (!reply || !reply.isAnswered) failedCalls++
      try { await progress?.({ done, of, failed: failedCalls }) } catch { /* the reads go on */ }
    })
    const payload = { values: {}, failed: {}, run: { state: 'running', calls: calls + replies.length } }
    replies.forEach((reply, i) => {
      calls++
      const got = reply && reply.isAnswered ? answersOf(reply.text, batches[i], w.values) : failedCall(reply, batches[i])
      if (!reply || !reply.isAnswered) why = Object.values(got.failed)[0] || why
      Object.assign(payload.values, got.values)
      Object.assign(payload.failed, got.failed)
    })
    last = await json(['label', name, '--answers', '-'], JSON.stringify(payload))
    if (last.error) return stop(`the answers could not be written to ${name}: ${last.error}`)
    // a wave that settled no record would come back the same: stop rather than ask again
    if (!(Number(last.waiting) < left)) return stop(`the answers settled none of the waiting records of ${name}`)
  }
  const s = last || await json(['label', name])
  if (s.error) return { error: s.error }
  why = why.replace(/^the call failed: /, '')
  const text = summary(name, { ...s, why: failedCalls ? `${failedCalls} call${failedCalls === 1 ? '' : 's'} failed: ${why}` : '' })
  return {
    text, calls, failedCalls, why,
    note: `The model finished reading the records of the label ${name} (${calls} call${calls === 1 ? '' : 's'}). ${text} \`thimble label ${name}\` prints its counts.`,
  }
}
