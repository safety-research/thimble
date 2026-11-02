// node.mjs: the prompt registry from Node.
//
//   thimble dev prompts               every text: its file, the module that reads it in each mode, how, and what it is
//   thimble dev prompts NAME [MODE]   text NAME as MODE (terminal, the default, or browser) reads it, before its reader
//                                     fills its slots
//   textOf(name, mode)                the same, for a Node module that reads a text (the workbench's look_of.mjs)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MODES, SLOTS_FILE, TEXTS, compose, fileOf, listing } from './registry.mjs'

const fromRoot = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** Text `name` as `mode` reads it (registry.mjs compose), from the plugin's files. `slots` stands for the values of
 *  slots.json, as when a test gives each slot a marker. */
export function textOf(name, mode, slots = null) {
  return compose(name, mode, n => fromRoot(fileOf(n)), () => slots ?? JSON.parse(fromRoot(SLOTS_FILE)))
}

async function main(argv) {
  const [cmd, name, mode = 'terminal'] = argv
  if (cmd === 'prompts' && argv.length === 1) {
    console.log(['The texts a model reads, one file each (edit the file to change one): name, file, its reader in the terminal and in the browser, use.', ...listing()].join('\n'))
    return 0
  }
  if (cmd === 'prompts' && TEXTS[name] && MODES.includes(mode)) {
    process.stdout.write(await textOf(name, mode))
    return 0
  }
  console.error(`usage: thimble dev prompts [NAME [${MODES.join(' | ')}]]`)
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2))
