// node.mjs: the prompt registry from Node (`thimble dev prompts`).
//
//   thimble dev prompts             every text, its file, and what it is
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEXTS, fileOf, listing } from './registry.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A text as this process sees it: {name, text, file}. */
export function textOf(name, root = ROOT) {
  if (!TEXTS[name]) throw new Error(`no prompt text "${name}"; the texts are ${Object.keys(TEXTS).join(', ')}`)
  const file = join(root, fileOf(name))
  return { name, text: readFileSync(file, 'utf8'), file }
}

function main(argv) {
  if (argv[0] === 'prompts') {
    console.log(['The texts a model reads, one file each (edit the file to change one):', ...listing()].join('\n'))
    return 0
  }
  console.error('usage: thimble dev prompts')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (err) { console.error(`thimble: ${err.message}`); process.exitCode = 1 }
}
