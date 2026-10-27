// The time limits thimble's code gives Claude Code's process calls stay within what Claude Code takes: $.process.run
// refuses a timeoutMs over 600000 ms (10 minutes) before it starts anything, so a call that asks for more never runs.
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

test('no process call in the plugin asks Claude Code for more than 10 minutes', () => {
  const over = []
  for (const file of code(PLUGIN)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/timeoutMs\s*(?::|\?\?|=)\s*([\d_]+)/g)) {
        if (Number(m[1].replaceAll('_', '')) > MOST) over.push(`${relative(PLUGIN, file)}:${i + 1}: ${m[0]}`)
      }
    })
  }
  assert.deepEqual(over, [])
})
