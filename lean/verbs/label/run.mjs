// run.mjs: the Label verb. A --prompt label (engine/kernel/labels.py) keeps its records waiting until the model has
// read each one against the label's definition; this verb makes those reads. `thimble label NAME --prompt …` asks for
// it in the session's change feed, and the shell runs it beside the session on the label's card, so neither Claude nor
// the person waits on it (`thimble label NAME --wait` waits, when Claude wants the counts in the same turn).
//
//   run(ctx) -> {object, text, note}     ctx.args: the label's name (else the card's `label` field), and `again` to ask
//                                        the model again for the records that got no value
//
// The records go in batches of up to 50 (the kernel's `batches`), one $.model.complete call each, with the registry's
// `labels` prompt. Calls are started together, a wave of them at a time (verb.json `wave`); the shell makes a wave's
// calls side by side (`parallel` at once) and runs this verb again with their answers. Each run writes the answers it
// has back to the label (`thimble label NAME --answers -`), so a run that stops halfway keeps what it got, then asks
// for the next wave. A call that fails, a reply that is not JSON, or a value off the label's list leaves those records
// with no value and says why; they never wait again by themselves (`--again` asks once more). When nothing waits, the
// kernel counts the label again and saves a new version of its card, which the shell draws in the old one's place.
import { textOf } from '../../prompts/node.mjs'
import { answersOf, failedCall, requestFor } from './calls.mjs'

/** The label this run is for: the first word of its args, else the card's own `label` field. */
export function labelName(ctx) {
  const words = String(ctx.args || '').trim().split(/\s+/).filter(Boolean).filter(w => w !== 'again')
  return words[0] || (ctx.object && typeof ctx.object.label === 'string' ? ctx.object.label : null)
}

function json(ctx, args, input) {
  const r = ctx.kernel.run([...args, '--json'], input != null ? { input } : {})
  try { return JSON.parse(r.stdout) } catch { return { error: (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 400) || `exit ${r.code}` } }
}

const n = x => Number(x || 0).toLocaleString('en-US')

/** The label's state in one line, as the person and Claude read it. */
export function summary(name, s) {
  const counts = Object.entries(s.counts || {}).map(([v, k]) => `${n(k)} ${v}`).join(', ')
  const parts = [`${name}: ${n(s.valued)} of ${n(s.records)} records have a value${counts ? ` (${counts})` : ''}`]
  if (s.waiting) parts.push(`${n(s.waiting)} still wait for the model`)
  if (s.failed) parts.push(`${n(s.failed)} have no value${s.why ? ` (${s.why})` : ''}: \`thimble label ${name} --again\` asks the model again`)
  return parts.join('. ') + '.'
}

export async function run(ctx) {
  const name = labelName(ctx)
  if (!name) return { error: 'no label named: run it on a label\'s card, or as /verb label <card> <label name>' }
  const cfg = ctx.verb || {}
  if (/\bagain\b/.test(String(ctx.args || '')) && ctx.round === 0) {
    const r = ctx.kernel.run(['label', name, '--again'])
    if (r.code !== 0) return { error: (r.stdout + r.stderr).trim().slice(0, 400) }
  }
  let template, promptId
  try { const t = textOf('labels'); template = t.text; promptId = t.id } catch (e) { return { error: `the labels prompt could not be read: ${String(e.message || e).slice(0, 200)}` } }
  const wave = Math.max(1, Number(cfg.wave) || 16)
  let last = null
  let calls = 0
  let failedCalls = 0
  let why = ''
  for (;;) {
    const w = json(ctx, ['label', name, '--waiting'])
    if (w.error) return { error: `the label ${name} could not be read: ${w.error}` }
    if (!w.units.length) break
    const byRef = new Map(w.units.map(u => [u.ref, u]))
    const batches = w.batches.slice(0, wave).map(refs => refs.map(r => byRef.get(r)).filter(Boolean))
    const reqs = batches.map(units => requestFor(template, w, units, { ...cfg, promptId }))
    // started together, so the shell makes them side by side; a run without their answers stops here
    const replies = await Promise.all(reqs.map(r => ctx.model.complete(r)))
    const payload = { values: {}, failed: {}, run: { state: 'running', calls: calls + replies.length } }
    replies.forEach((reply, i) => {
      calls++
      const got = reply && reply.isAnswered ? answersOf(reply.text, batches[i], w.values) : failedCall(reply, batches[i])
      if (!reply || !reply.isAnswered) { failedCalls++; why = Object.values(got.failed)[0] || why }
      Object.assign(payload.values, got.values)
      Object.assign(payload.failed, got.failed)
    })
    last = json(ctx, ['label', name, '--answers', '-'], JSON.stringify(payload))
    if (last.error) return { error: `the answers could not be written to ${name}: ${last.error}` }
  }
  const s = last || json(ctx, ['label', name])
  if (s.error) return { error: s.error }
  const text = summary(name, { ...s, why: failedCalls ? `${failedCalls} call${failedCalls === 1 ? '' : 's'} failed: ${why.replace(/^the call failed: /, '')}` : '' })
  const card = last && last.card && last.card.id ? { id: last.card.id, version: last.card.version } : null
  return {
    ...(card ? { object: card } : {}),
    text,
    note: `The model finished reading the records of the label ${name} (${calls} call${calls === 1 ? '' : 's'}). ${text}${s.query ? ` Its counts are query ${s.query}; \`thimble label ${name}\` prints them with their citations.` : ''}`,
    ...(failedCalls || s.failed ? { failed: true } : {}),
  }
}
