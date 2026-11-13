// The time limits thimble's code gives Claude Code's process calls stay within what Claude Code takes: $.process.run
// refuses a timeoutMs over 600000 ms (10 minutes) before it starts anything, so a call that asks for more never runs.
// A call gives its limit as a number or as a constant's name, whose number is read where the constant is declared.
//   node --test plugin/core/test/limits.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOST = 600000

/** The plugin's code files, without tests and installed packages. */
function code(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return ['node_modules', 'test', 'tests'].includes(e.name) ? [] : code(p)
    return /\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

/** The number a constant holds where `text` declares it (`const CARRY_MS = 600_000`), or undefined. */
const held = (text, name) => new RegExp(`\\bconst ${name}\\s*=\\s*([\\d_]+)(?![\\w.])`).exec(text)?.[1]

test('no process call in the plugin asks Claude Code for more than 10 minutes', () => {
  const files = code(PLUGIN).map(file => ({ file, text: readFileSync(file, 'utf8') }))
  const over = []
  for (const { file, text } of files) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/timeoutMs\s*(?::|\?\?|=)\s*([\d_]+|[A-Z][A-Z\d_]*)(?![\w.])/g)) {
        // a constant's number: in this file, else in the file that exports it
        const n = /^\d/.test(m[1]) ? m[1] : held(text, m[1]) ?? files.map(f => held(f.text, m[1])).find(Boolean)
        const at = `${relative(PLUGIN, file)}:${i + 1}: ${m[0]}`
        if (n === undefined) over.push(`${at}, a constant that holds no number this test reads`)
        else if (Number(n.replaceAll('_', '')) > MOST) over.push(n === m[1] ? at : `${at} = ${n}`)
      }
    })
  }
  assert.deepEqual(over, [])
})
