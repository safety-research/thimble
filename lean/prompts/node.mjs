// node.mjs: the prompt registry from Node (a verb's child, `lean prompts`, `lean guide`). The hooks module sets
// LEAN_PROMPTS for the session's commands to the versions in use (the setting and the environment together), so a
// child reads the same versions as the hooks.
//
//   lean prompts                 every feature, its versions, the active one in brackets
//   lean guide <feature>         the active version's text (`lean guide cards`: the card guidance), which Claude reads
//                                right before it draws a card; it notes the read in the session's events
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALIASES, FEATURES, bodyOf, choose, idOf, indexOf, listing } from './registry.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every feature with the versions found on disk. */
export function loadIndex(root = ROOT) {
  const found = {}
  for (const name of Object.keys(FEATURES)) {
    try { found[name] = readdirSync(join(root, 'prompts', name)) } catch { found[name] = [] }
  }
  return indexOf(found)
}

/** The active versions as this process sees them. */
export function activeNow(root = ROOT, env = process.env) {
  const idx = loadIndex(root)
  return { idx, ...choose(idx, { env: env.LEAN_PROMPTS || '' }) }
}

/** The active text of a feature: {feature, version, id, text, file, problems}. A skill's in-place version is its body. */
export function textOf(feature, root = ROOT, env = process.env) {
  const name = ALIASES[feature] || feature
  const { idx, active, problems } = activeNow(root, env)
  const a = active[name]
  if (!a) throw new Error(`no prompt feature "${feature}"; the features are ${Object.keys(idx).join(', ')}`)
  if (a.off) return { feature: name, version: a.version, id: idOf(name, a.version), text: '', file: null, problems }
  const raw = readFileSync(join(root, a.file), 'utf8')
  return { feature: name, version: a.version, id: idOf(name, a.version), text: a.file.endsWith('SKILL.md') ? bodyOf(raw) : raw, file: join(root, a.file), problems }
}

/** One line in the session's events ($THIMBLE_HOME/lean/events/<session>.jsonl), appended in one write. */
export function emit(row, env = process.env) {
  const session = env.LEAN_SESSION
  if (!session) return
  try {
    const home = env.THIMBLE_HOME || join(env.HOME || '.', '.thimble')
    const dir = join(home, 'lean', 'events')
    mkdirSync(dir, { recursive: true })
    const safe = String(session).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'
    appendFileSync(join(dir, `${safe}.jsonl`), JSON.stringify({ t: Math.round(Date.now()) / 1000, session, ...row }) + '\n')
  } catch {
    // the record is for measuring; the text is printed either way
  }
}

function main(argv) {
  const [cmd, arg] = argv
  if (cmd === 'prompts') {
    const { idx, active, problems } = activeNow()
    console.log(['Prompt versions ([active]); choose with LEAN_PROMPTS=feature:version,… or the Prompts setting:', ...listing(idx, active), ...problems.map(p => `! ${p}`)].join('\n'))
    return 0
  }
  if (cmd === 'guide') {
    if (!arg) { console.error('lean guide <feature>: lean guide cards prints the card guidance. `lean prompts` lists the features.'); return 2 }
    const t = textOf(arg)
    for (const p of t.problems) console.error(`! ${p}`)
    const base = FEATURES[t.feature]?.versions?.[t.version]?.base || FEATURES[t.feature]?.base
    const head = base ? `(${t.id} · its folder: ${join(ROOT, base)}; paths below are relative to it)\n\n` : `(${t.id})\n\n`
    process.stdout.write(head + t.text + (t.text.endsWith('\n') ? '' : '\n'))
    emit({ kind: 'prompt', feature: t.feature, prompt: t.id, via: `lean guide ${arg}`, chars: t.text.length })
    return 0
  }
  console.error('usage: lean prompts | lean guide <feature>')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (err) { console.error(`lean: ${err.message}`); process.exitCode = 1 }
}

