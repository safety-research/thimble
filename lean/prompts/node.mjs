// node.mjs: the prompt registry from Node (a verb's child, `thimble dev prompts`). The hooks module sets THIMBLE_PROMPTS
// for the session's commands to the versions in use (from the environment), so a child reads the same versions as the
// hooks.
//
//   thimble dev prompts             every feature, its versions, the active one in brackets
import { readFileSync, readdirSync } from 'node:fs'
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
  return { idx, ...choose(idx, { env: env.THIMBLE_PROMPTS || '' }) }
}

/** The active text of a feature: {feature, version, id, text, file, problems}. */
export function textOf(feature, root = ROOT, env = process.env) {
  const name = ALIASES[feature] || feature
  const { idx, active, problems } = activeNow(root, env)
  const a = active[name]
  if (!a) throw new Error(`no prompt feature "${feature}"; the features are ${Object.keys(idx).join(', ')}`)
  if (a.off) return { feature: name, version: a.version, id: idOf(name, a.version), text: '', file: null, problems }
  const raw = readFileSync(join(root, a.file), 'utf8')
  return { feature: name, version: a.version, id: idOf(name, a.version), text: a.file.endsWith('SKILL.md') ? bodyOf(raw) : raw, file: join(root, a.file), problems }
}

function main(argv) {
  const [cmd] = argv
  if (cmd === 'prompts') {
    const { idx, active, problems } = activeNow()
    console.log(['Prompt versions ([active]); choose with THIMBLE_PROMPTS=feature:version,…:', ...listing(idx, active), ...problems.map(p => `! ${p}`)].join('\n'))
    return 0
  }
  console.error('usage: thimble dev prompts')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (err) { console.error(`thimble: ${err.message}`); process.exitCode = 1 }
}

