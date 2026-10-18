// run.mjs: the Atlas verb (key a). An atlas is the orientation of a folder: the claims, facts, findings, judgment
// calls and events in the work, each with its evidence refs, the relations between them (contradicts, supports, same
// topic) and named clusters, saved as one object. Under a reply it draws as a cluster list (atlas.program.js); in the
// browser as a graph (shell/browser/atlas/).
//
//   run(ctx) -> {object?, text?, note?, ask?}      ctx as shell/node/verb.mjs builds it
//
// Atlas is offered, never started on its own: the observer lights `a` with estimate.mjs's offer ("map 40 runs · ~2
// min"), and only the person's press runs this.
//
// ---------------------------------------------------------------------------------------------- who builds it
// A subagent of main, guided by SKILL.md. Pressing `a` with no atlas yet asks main (`ask`) to start one subagent with
// a brief; the subagent reads with `lean sources`, `lean rows` and `lean q`, writes the atlas as JSON and checks it
// with `lean verb atlas check`; main then saves it with `lean verb atlas save`, so the object is drawn under main's
// reply and its lineage is the kernel's. Why a subagent and not main:
//   - main's context stays clean: building an atlas reads tens of thousands of tokens of rows. In main they would
//     ride along with every later request; in a subagent they end with it, and main gets two lines back.
//   - cost: the reading costs about the same either way, and main's later turns stay as cheap as before.
//   - Manual mode stays manual: the subagent's lean calls and its one Write go through the same permission mode.
//   - the shell draws only main's saves, so main makes the one save; the subagent's check runs the kernel's own
//     citation check without saving (check.py).
// Why not a quiet $.model.complete call: the claims rest on rows nobody has read yet. Only an agent with tools can
// read them, count in code and cite real rows.
//
// ---------------------------------------------------------------------------------------------- later messages
// Pressing `a` under a later message adds that message's claims: one quiet $.model.complete call reads the message
// and the atlas's claims (names only) and answers with the new claims, whose evidence must be refs the message itself
// cites. The verb saves them as the atlas's next version, drawn under that message as "3 new claims". No rows are
// read, so a few thousand tokens suffice.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimate } from './estimate.mjs'
import { check, isAtlas, kindOf, refsOf, relationOf, summary } from './shape.mjs'

export const PROGRAM = readFileSync(new URL('./atlas.program.js', import.meta.url), 'utf8')
const HERE = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
const DEFAULTS = { model: 'sonnet', effort: 'low', maxTokens: 4000, timeoutMs: 120000 }

/** The newest atlas among the folder's objects, or null. */
export function findAtlas(objects) {
  const list = (Array.isArray(objects) ? objects : []).filter(isAtlas)
  list.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
  return list[0] || null
}

/** The request main gets when the person presses `a` and there is no atlas yet. Text a model reads: changes are
 *  logged in PROMPTS.md. */
export function askFor({ root, dir = HERE, est }) {
  const file = `${root}/thimble/atlas/atlas.json`
  const under = est.read ? ` under ${est.read}` : ''
  return [
    `Build the atlas of this folder: ${est.what}${under} (${est.detail}). It takes a subagent about ${est.minutes} minutes.`,
    '',
    'Hand the reading to one subagent with the Agent tool, so the rows it reads stay out of this conversation. Give it this prompt, and add one sentence on what the person is looking into if you know:',
    '',
    `"Build the atlas of the folder ${root}: ${est.what}${under}. First read ${dir}/SKILL.md and follow it. Write the atlas as JSON to ${file}, then run \`lean verb atlas check ${file}\` and fix what it lists. Your last message is the check's last line."`,
    '',
    `When the subagent is done, run \`lean verb atlas save ${file}\`. The person sees the atlas under your reply, so reply in one or two sentences: what the map holds, and the one thing in it that surprised you most.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------- the message

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
const isRef = s => /^(?:q\d+(?:#|$)|obj:|[^\s#:]+#(?:L\d|row=|\/|[A-Za-z_]))/.test(s) && !/^[a-z]+:\/\//i.test(s)

/** The message `a` was pressed under: its text, its row and the refs it cites, from ctx (the message layer's record)
 *  or from the newest record the message layer wrote for this session. */
export function messageOf(ctx) {
  let rec = ctx.record || ctx.message || null
  if (!rec && ctx.root) rec = latestRecord(ctx.root, ctx.session, ctx.row)
  if (!rec) return null
  const text = String(rec.shown || rec.text || '')
  if (!text.trim()) return null
  const cites = []
  for (const m of text.matchAll(LINK)) if (isRef(m[2]) && !cites.some(c => c.ref === m[2])) cites.push({ label: m[1], ref: m[2] })
  for (const mk of Array.isArray(rec.marks) ? rec.marks : []) if (mk && mk.kind === 'cite' && isRef(String(mk.ref)) && !cites.some(c => c.ref === mk.ref)) cites.push({ label: String(mk.label || ''), ref: String(mk.ref) })
  return { text, row: rec.row || ctx.row || null, cites }
}

function latestRecord(root, session, row) {
  const base = join(root, 'thimble', 'messages')
  if (!existsSync(base)) return null
  const read = f => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
  if (session && row) {
    const f = join(base, session, `${row}.json`)
    if (existsSync(f)) return read(f)
  }
  const dirs = session ? [session] : readdirSync(base)
  let best = null
  for (const d of dirs) {
    const idx = join(base, d, 'index.jsonl')
    if (!existsSync(idx)) continue
    const lines = readFileSync(idx, 'utf8').trim().split('\n').reverse()
    for (const l of lines) {
      let r
      try { r = JSON.parse(l) } catch { continue }
      if (r.kind !== 'assistant') continue
      if (!best || String(r.at) > String(best.at)) best = { ...r, dir: d }
      break
    }
  }
  return best ? read(join(base, best.dir, `${best.row}.json`)) : null
}

// ---------------------------------------------------------------------------------------------- adding claims

/** The model's instructions for adding one message's claims. Text a model reads: changes are logged in PROMPTS.md. */
export const ADD = `You add claims to an atlas. An atlas maps the claims, facts, findings, judgment calls and events in some work, each with the rows that show it. You get the atlas's clusters and claims, and one new message about the same work. Find what the message states that the atlas does not hold yet. Most messages add between zero and four claims. Do not repeat a claim the atlas already holds, even in other words.

Each new claim has:
- name: one short sentence in the message's words, under 80 characters.
- kind: fact (true of the setup, nobody disputes it), finding (shown by the data), judgment call (a choice someone made where another was possible), event (something that happened at a time), or claim (something someone asserted that can be wrong).
- cluster: the id of the cluster it belongs to.
- evidence: the refs the message cites for it, copied exactly from the message's links. Leave out a claim the message cites no ref for.
- relations: links to the atlas's claim ids, each "contradicts", "supports" or "same topic", only where the message makes the link plain.

For example, the message "840 of the steps were reruns with no code change ([39%](q7#run=r17@share)), and 480 came after the rate was known ([480](q8#run=r17@n))" adds:
{"claims": [{"id": "r17-late-reruns", "name": "r17: 480 reruns came after the rate was known", "kind": "finding", "cluster": "loop", "evidence": [{"ref": "q8#run=r17@n"}], "relations": [{"to": "lp-rate", "type": "supports"}]}]}

Answer with one JSON object and nothing else: {"claims": [...]}. With nothing new, answer {"claims": []}.`

/** The prompt for one message: the atlas's clusters and claims by name, then the message and its refs. */
export function addPrompt(data, msg) {
  const claims = Array.isArray(data.claims) ? data.claims : []
  const clusters = Array.isArray(data.clusters) ? data.clusters : []
  const lines = ['Clusters:']
  for (const c of clusters) lines.push(`- ${c.id}: ${c.name || c.id} (${claims.filter(x => String(x.cluster) === String(c.id)).length} claims)`)
  lines.push('', 'Claims:')
  for (const c of claims.slice(0, 400)) lines.push(`- ${c.id} [${kindOf(c.kind) || 'claim'}, ${c.cluster ?? '-'}]: ${String(c.name).slice(0, 120)}`)
  lines.push('', 'The new message:', msg.text.slice(0, 12000), '', 'The refs it cites:')
  for (const c of msg.cites) lines.push(`- ${c.ref} (${c.label.slice(0, 60)})`)
  return lines.join('\n')
}

/** The first JSON object in an answer. */
export function parseAnswer(text) {
  const t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('the answer holds no JSON object')
  return JSON.parse(t.slice(a, b + 1))
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'claim'

/**
 * The model's new claims held to what the atlas needs: a known kind, a cluster that exists (else none), evidence only
 * among the refs the message cites (a quoted citation's words become its quote), relations to claims that exist, ids
 * that are new. A claim left with no evidence is dropped and said in `dropped`.
 * @returns {{claims: object[], relations: object[], dropped: string[]}}
 */
export function admit(answer, data, msg) {
  const have = new Set((data.claims || []).map(c => String(c.id)))
  const clusters = new Set((data.clusters || []).map(c => String(c.id)))
  const cited = new Map(msg.cites.map(c => [c.ref, c]))
  const out = { claims: [], relations: [], dropped: [] }
  for (const raw of Array.isArray(answer?.claims) ? answer.claims : []) {
    if (!raw || !raw.name) continue
    const name = String(raw.name).trim().slice(0, 160)
    const evidence = []
    for (const e of Array.isArray(raw.evidence) ? raw.evidence : []) {
      const ref = String(typeof e === 'string' ? e : e?.ref || '').trim()
      const c = cited.get(ref)
      if (!c || evidence.some(x => x.ref === ref)) continue
      const q = /^["“](.+)["”]$/.exec(c.label.trim())
      evidence.push(q ? { ref, quote: q[1] } : { ref })
    }
    if (!evidence.length) { out.dropped.push(`${name} (no ref the message cites)`); continue }
    let id = slug(raw.id || name)
    while (have.has(id)) id = `${id}-2`
    have.add(id)
    const cluster = clusters.has(String(raw.cluster)) ? String(raw.cluster) : null
    out.claims.push({ id, name, kind: kindOf(raw.kind) || 'claim', cluster, evidence })
    for (const r of Array.isArray(raw.relations) ? raw.relations : []) {
      const type = relationOf(r?.type)
      if (type && have.has(String(r.to)) && String(r.to) !== id) out.relations.push({ from: id, to: String(r.to), type })
    }
  }
  return out
}

async function addClaims(ctx, atlas, msg) {
  const cfg = { ...DEFAULTS, ...pick(ctx.verb || {}, ['model', 'effort', 'maxTokens', 'timeoutMs']) }
  const src = atlas.source && atlas.source.data && Array.isArray(atlas.source.data.claims) ? atlas.source : { ...atlas, data: atlas.data }
  const data = src.data
  if (!msg.cites.length) return { text: `This message cites no rows, so it adds no claims. The atlas: ${summary(atlas)}.`, object: { id: atlas.id, version: atlas.version } }
  const r = await ctx.model.complete({ model: cfg.model, system: [{ text: ADD, cache: true }], prompt: addPrompt(data, msg), maxTokens: cfg.maxTokens, effort: cfg.effort, timeoutMs: cfg.timeoutMs })
  if (!r || !r.isAnswered) {
    const why = r ? (r.reason === 'api-error' ? `the API answered ${r.status ?? 'nothing'}` : r.reason) : 'no answer'
    return { error: `no claims were added: the model gave no answer (${why}). Press a again to try once more.` }
  }
  let answer
  try { answer = parseAnswer(r.text) } catch (e) { return { error: `no claims were added: the model's answer was not JSON (${e.message}). Press a again to try once more.` } }
  const got = admit(answer, data, msg)
  const fromRows = [...(Array.isArray(data.from_rows) ? data.from_rows : []), ...(msg.row ? [msg.row] : [])]
  if (!got.claims.length) {
    return { text: `Nothing new for the atlas in this message${got.dropped.length ? ` (${got.dropped.length} left out: no ref the message cites)` : ''}. It holds ${summary(atlas)}.`, note: `The person pressed a under a message; it added no claims to ${atlas.id}.` }
  }
  const next = { ...data, claims: [...data.claims, ...got.claims], relations: [...(Array.isArray(data.relations) ? data.relations : []), ...got.relations], added: { claims: got.claims.map(c => c.id), row: msg.row || null }, from_rows: fromRows }
  const shape = check(next)
  if (shape.problems.length) return { error: `the new claims do not fit the atlas: ${shape.problems.slice(0, 3).join('; ')}` }
  const { id, version, created, updated, session, history, data: _d, source: _s, lineage: _l, ...keep } = src
  const n = got.claims.length
  return {
    object: { ...keep, name: atlas.id, verb: 'atlas', program: atlas.program || PROGRAM, data: next },
    text: `${n} new claim${n === 1 ? '' : 's'} · in the map · ${next.claims.length} claims`,
    note: `The person pressed a: ${n} claim${n === 1 ? '' : 's'} from this message went into the atlas (${atlas.id}): ${got.claims.map(c => c.name).join('; ')}.`,
    usage: r.usage,
  }
}

function pick(o, keys) { const out = {}; for (const k of keys) if (o[k] != null) out[k] = o[k]; return out }

export async function run(ctx) {
  const root = ctx.root
  const atlas = findAtlas(ctx.kernel?.objects?.() || [])
  const args = String(ctx.args || '').trim().toLowerCase()
  if (!atlas || /^(build|rebuild|again|new)$/.test(args)) {
    const est = estimate(root)
    return {
      ask: askFor({ root, dir: ctx.verb?.dir || HERE, est }),
      text: `Asked Claude to ${est.what} (about ${est.minutes} min). A subagent reads the rows, so this conversation stays short.`,
      note: `The person pressed a: ${est.what} (${est.detail}).`,
    }
  }
  const msg = args === 'show' ? null : messageOf(ctx)
  const seen = Array.isArray(atlas.data?.from_rows) ? atlas.data.from_rows : []
  if (msg && !(msg.row && seen.includes(msg.row))) return addClaims(ctx, atlas, msg)
  return {
    object: { id: atlas.id, version: atlas.version },
    text: `The atlas: ${summary(atlas)}.`,
    note: `The person opened the atlas ${atlas.id}@${atlas.version}.`,
  }
}
