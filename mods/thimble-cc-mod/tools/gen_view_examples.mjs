#!/usr/bin/env node
// Writes tests/view-examples.ts and tests/view-examples/<name>.ts from the worked examples' viewers/<name>/view.json and
// rows.json, for tests that cannot read files (claude plugin test). One file per example, as the test runner reads no
// file over 1 MiB. Run it after changing an example's spec or rerunning its reader:
//
//   python3 helper/viewhost.py viewers/<name> rows --root viewers/<name>/sample --out viewers/<name>/rows.json
//   node tools/gen_view_examples.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mod = join(dirname(fileURLToPath(import.meta.url)), '..')
const names = ['timeline', 'linked-sessions', 'repository']
const read = (name, file) => JSON.parse(readFileSync(join(mod, 'viewers', name, file), 'utf8'))
const head = `// Written by tools/gen_view_examples.mjs; edit the example's JSON and run it again, not this.\n`
mkdirSync(join(mod, 'tests', 'view-examples'), { recursive: true })
const sizes = names.map(name => {
  const out = `${head}import type { ViewData, ViewSpec } from '../../hooks/viewspec'

export const spec = ${JSON.stringify(read(name, 'view.json'))} as unknown as ViewSpec
export const data = ${JSON.stringify(read(name, 'rows.json'))} as unknown as ViewData
`
  writeFileSync(join(mod, 'tests', 'view-examples', `${name}.ts`), out)
  return `${name} ${Math.round(out.length / 1024)} KB`
})
const id = name => name.replace(/-(.)/g, (_, c) => c.toUpperCase())
const index = `// The worked examples of views (viewers/<name>/view.json and rows.json, whole), for tests that cannot read files.
${head}import type { ViewData, ViewSpec } from '../hooks/viewspec'
${names.map(n => `import * as ${id(n)} from './view-examples/${n}'`).join('\n')}

export const VIEWERS: Record<string, { spec: ViewSpec; data: ViewData }> = {
${names.map(n => `  ${JSON.stringify(n)}: ${id(n)},`).join('\n')}
}
`
writeFileSync(join(mod, 'tests', 'view-examples.ts'), index)
process.stdout.write(`tests/view-examples/: ${sizes.join(', ')}\n`)
