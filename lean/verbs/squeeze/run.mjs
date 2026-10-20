// run.mjs: the Squeeze verb (key s) run as any verb is (shell/node/verb.mjs): on a message of Claude's, with words that
// set its chips. The terminal does not come here: it draws the chips under the message and makes the same call in the
// hooks module (term.ts), with no Node child. This path is for /verb and for tools that hold a record.
//
//   run(ctx) -> {message?, text?, note?}
//   ctx.message   the message's record (CONTRACT 1)
//   ctx.args      the chips to set, as words: "length=short familiarity=beginner", "+engineer and manager" (a stretch
//                 of the person's, which stands at the original until a level is set), "original"; '' squeezes it to
//                 Length short, as a long message arrives
//   ctx.model     {complete(request)}: one call to the session's model ($.model.complete, through the shell)
//
// It returns the record with `shown` set to the new text and its marks placed again (`message`), the text, and a note
// for Claude.
import { textOf } from '../../prompts/node.mjs'
import { remark } from '../../shell/message.js'
import { modelWhy } from '../../shell/why.js'
import { FEATURES } from '../../prompts/registry.mjs'
import { ARRIVE, applyRewrite, checkRewrite, chipsOf, isOriginal, noteFor, readReply, request, restore, stretchChip, termsOf, withStretch } from './chips.mjs'

/** The levels the words ask for: `name=level` for each chip named, by its id, its name or its first word. */
export function parseWords(rec, words) {
  const at = { ...(rec.squeeze?.at || {}) }
  const chips = chipsOf(rec)
  const w = String(words || '').trim()
  if (!w) return { at: { ...at, length: ARRIVE } }
  if (/^(original|restore|0)$/i.test(w)) return { at: {}, original: true }
  if (w.startsWith('+')) return { at, own: w }
  for (const m of w.matchAll(/([\w↔ -]+?)\s*=\s*([\w -]+?)(?=\s+[\w↔-]+\s*=|$)/g)) {
    const name = m[1].trim().toLowerCase()
    const chip = chips.find(c => c.id === name || c.name.toLowerCase() === name || c.name.toLowerCase().split(/\s+/)[0] === name)
    if (!chip) throw new Error(`no chip "${m[1].trim()}": the chips are ${chips.map(c => c.name).join(', ')}`)
    const lv = chip.levels.indexOf(m[2].trim().toLowerCase())
    if (lv < 0) throw new Error(`${chip.name} has the levels ${chip.levels.join(', ')}`)
    at[chip.id] = lv
  }
  return { at }
}

export async function run(ctx) {
  let rec = ctx.message
  if (!rec || typeof rec.text !== 'string') return { text: 'Squeeze works on a message of Claude\'s: press s under it to open its chips.' }
  const want = parseWords(rec, ctx.args)
  if (want.original) {
    const back = restore(rec, remark)
    return { message: back, text: back.text, note: noteFor(back) }
  }
  if (want.own) {
    const chip = stretchChip(rec, want.own)
    if (!chip) return { text: 'A stretch needs two ends after the +, such as "+ engineer and manager".' }
    // a new stretch stands at the original: the record keeps it, and a level set later rewrites the text
    const next = { ...rec, squeeze: withStretch(rec, chip) }
    return { message: next, text: next.shown ?? next.text, note: noteFor(next) }
  }
  const probe = { ...rec, squeeze: { ...(rec.squeeze || {}), at: want.at } }
  if (isOriginal(chipsOf(probe))) {
    const back = restore(probe, remark)
    return { message: back, text: back.text, note: noteFor(back) }
  }
  if (!ctx.model || typeof ctx.model.complete !== 'function') throw new Error('no model to write the rewrite: ctx.model.complete is missing')
  const cfg = ctx.verb || {}
  const sp = textOf('squeeze')
  const terms = FEATURES.squeeze.versions?.[sp.version]?.terms ? termsOf(rec) : []
  const req = request(probe, { system: sp.text, question: ctx.question || '', terms, model: cfg.model || 'sonnet', effort: cfg.effort || 'low', maxTokens: cfg.maxTokens || 4000 })
  const t0 = Date.now()
  const r = await ctx.model.complete({ ...req, telemetry: { feature: 'squeeze', prompt: sp.id } })
  if (!r || !r.isAnswered) throw new Error(`the rewrite failed: ${modelWhy(r)}`)
  const reply = readReply(r.text)
  const checked = checkRewrite(rec.text, reply.text)
  const next = applyRewrite(rec, { text: checked.text, at: want.at, made: { ms: Date.now() - t0, model: req.model, usage: r.usage, prompt: sp.id }, problems: checked.problems }, remark)
  return { message: next, text: next.shown ?? next.text, note: noteFor(next) }
}
