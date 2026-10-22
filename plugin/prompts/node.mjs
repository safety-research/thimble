// node.mjs: the prompt registry from Node.
//
//   thimble dev prompts             every text: its file, the module that reads it, how, and what it is
import { fileURLToPath } from 'node:url'
import { listing } from './registry.mjs'

function main(argv) {
  if (argv[0] === 'prompts') {
    console.log(['The texts a model reads, one file each (edit the file to change one): name, file, reader, use.', ...listing()].join('\n'))
    return 0
  }
  console.error('usage: thimble dev prompts')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2))
