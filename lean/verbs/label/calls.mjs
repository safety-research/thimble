// calls.mjs: a --prompt label's model calls, as pure functions (no $, no files): the request for one batch of records,
// and what its reply says of each record. run.mjs makes the calls through ctx.model; the tests read these directly.
//
//   requestFor(template, label, units, cfg) -> a $.model.complete request for one batch (units: [{ref, text}])
//   answersOf(reply, units, values)         -> {values: {ref: {value, confidence, reason}}, failed: {ref: why}}
//   failedCall(reply, units)                -> {failed: {ref: why}} for a call that brought no text
import { fill } from '../../prompts/registry.mjs'

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
    // for the shell's progress line and the session's events; never sent to the model
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

/** Why a call brought no text, in a few plain words: "api-error 529 (overloaded_error)", "aborted", "refused: …". */
export function whyNot(reply) {
  if (!reply) return 'no reply'
  if (reply.reason === 'api-error') return `api-error${reply.status ? ' ' + reply.status : ''}${reply.error ? ` (${String(reply.error).slice(0, 80)})` : ''}`
  if (reply.reason === 'refused') return `refused: ${String(reply.error || '').slice(0, 120)}`
  return String(reply.reason || 'no text')
}

/** Every record of a call that brought no text, with why. */
export function failedCall(reply, units) {
  const why = `the call failed: ${whyNot(reply)}`
  return { values: {}, failed: Object.fromEntries(units.map(u => [u.ref, why])) }
}
