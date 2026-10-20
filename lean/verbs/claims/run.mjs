// run.mjs: the Claims verb (key c). The session's claims are kept in thimble/claims/<session>.json (claims.js): the
// observer's one look after each turn of work adds the turn's claims, so pressing c needs no model call. The shell
// draws the graph itself (shell/claimsview.ts); this run answers /verb claims and /verb claims orient:
//
//   run(ctx) -> {text, note}          the claims so far, in a line
//   run(ctx) with args 'orient'       -> {ask}: the corpus orientation, which a subagent of main does
//
// ---------------------------------------------------------------------------------------------- the corpus orientation
// Its time and tokens come from estimate.mjs (fitted to three live builds), and only the person's /verb claims orient
// runs it. That asks main (`ask`) to start one subagent with a brief; the subagent reads with `thimble sources`,
// `thimble rows` and `thimble run`, writes its claims as JSON and checks them with `thimble verb claims check`; main then runs
// `thimble verb claims save`, which puts them in the session's Claims marked as the orientation's. Why a subagent and not
// main: building it reads tens of thousands of tokens of rows; in main they would ride along with every later request,
// in a subagent they end with it. Manual mode stays manual: the subagent's thimble calls and its one Write go through the
// same permission mode.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { textOf } from '../../prompts/node.mjs'
import { readStore, viewOf } from './claims.js'
import { estimate } from './estimate.mjs'

const HERE = new URL('.', import.meta.url).pathname.replace(/\/$/, '')

/** The session's claims file, or null. */
export function storeFile(root, session) {
  return root && session ? join(root, 'thimble', 'claims', `${String(session).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120)}.json`) : null
}

/** The session's claims as kept on disk (an empty store when there are none yet). */
export function loadStore(root, session) {
  const f = storeFile(root, session)
  return readStore(f && existsSync(f) ? readFileSync(f, 'utf8') : null, session)
}

/** One line on what the store holds: "14 claims in 4 clusters · 2 revised · 3 said again". */
export function summary(store) {
  const v = viewOf(store)
  const revised = store.claims.filter(c => c.revised_by).length
  const again = store.claims.filter(c => (c.said || []).length > 1).length
  return [`${v.total} claim${v.total === 1 ? '' : 's'} in ${v.clusters} cluster${v.clusters === 1 ? '' : 's'}`, revised ? `${revised} revised` : '', again ? `${again} said again` : ''].filter(Boolean).join(' · ')
}

/** The request main gets when the person asks for the corpus orientation. Text a model reads: changes are logged in
 *  PROMPTS.md. */
export function askFor({ root, dir = HERE, est, skill = null }) {
  // the orientation's text: the registry's active version of `claims` (its SKILL.md unless another is chosen)
  let file = skill
  if (!file) { try { const t = textOf('claims'); file = t.version === 'skill' ? null : t.file } catch { file = null } }
  file = file || `${dir}/SKILL.md`
  const out = `${root}/thimble/claims/orientation.json`
  const under = est.read ? ` under ${est.read}` : ''
  return [
    `Orient on this folder's corpus: ${est.what}${under} (${est.detail}). It takes a subagent about ${est.minutes} minutes.`,
    '',
    'Hand the reading to one subagent with the Agent tool, so the rows it reads stay out of this conversation. Give it this prompt, and add one sentence on what the person is looking into if you know:',
    '',
    `"Orient on the folder ${root}: ${est.what}${under}. First read ${file} and follow it. Write the claims as JSON to ${out}, then run \`thimble verb claims check ${out}\` and fix what it lists. Your last message is the check's last line."`,
    '',
    `When the subagent is done, run \`thimble verb claims save ${out}\`. Its claims join this session's claims, which the person opens with c, so reply in one or two sentences: what the corpus holds, and the one thing in it that surprised you most.`,
  ].join('\n')
}

export async function run(ctx) {
  const root = ctx.root
  const args = String(ctx.args || '').trim().toLowerCase()
  if (/^(orient|orientation|build|map)$/.test(args)) {
    const est = estimate(root)
    return {
      ask: askFor({ root, dir: ctx.verb?.dir || HERE, est }),
      text: `Asked Claude to orient on the corpus: ${est.what} (about ${est.minutes} min). A subagent reads the rows, so this conversation stays short.`,
      note: `The person asked for the corpus orientation: ${est.what} (${est.detail}).`,
    }
  }
  const store = loadStore(root, ctx.session)
  return {
    text: store.claims.length ? `This session's claims: ${summary(store)}. Press c under a message to see them.` : 'No claims yet: they are read after each turn of work.',
    note: `The person looked at this session's claims (${summary(store)}).`,
  }
}
