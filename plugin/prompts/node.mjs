// node.mjs: the prompt registry from Node (a verb's child, `thimble dev prompts`). The hooks module sets THIMBLE_PROMPTS
// for the session's commands to the texts turned off (from the environment), so a child reads the same texts as the
// hooks.
//
//   thimble dev prompts             every text, its file, and whether it is off
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALIASES, TEXTS, bodyOf, fileOf, listing, offOf } from './registry.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A text as this process sees it: {name, id, text, file, off, problems}. A text turned off has no text. */
export function textOf(name, root = ROOT, env = process.env) {
  const n = ALIASES[name] || name
  if (!TEXTS[n]) throw new Error(`no prompt text "${name}"; the texts are ${Object.keys(TEXTS).join(', ')}`)
  const { off, problems } = offOf(env.THIMBLE_PROMPTS || '')
  if (off.includes(n)) return { name: n, id: n, text: '', file: null, off: true, problems }
  const file = join(root, fileOf(n))
  const raw = readFileSync(file, 'utf8')
  return { name: n, id: n, text: file.endsWith('SKILL.md') ? bodyOf(raw) : raw, file, off: false, problems }
}

function main(argv) {
  const [cmd] = argv
  if (cmd === 'prompts') {
    const { off, problems } = offOf(process.env.THIMBLE_PROMPTS || '')
    console.log(['The texts a model reads, one file each (edit the file to change one); turn an optional one off with THIMBLE_PROMPTS=text:off,…:', ...listing(off), ...problems.map(p => `! ${p}`)].join('\n'))
    return 0
  }
  console.error('usage: thimble dev prompts')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (err) { console.error(`thimble: ${err.message}`); process.exitCode = 1 }
}
