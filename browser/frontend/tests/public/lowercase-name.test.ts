// The page writes thimble's name in lowercase, at the start of a sentence too ("thimble asks before an agent changes
// your files", "thimble retries now"): no string under src names it Thimble, while identifiers such as
// startedByThimble and the X-Thimble-Session header keep theirs. The live QA of 0.7.0 (2026-10-10) found the
// orientation-skipped note, the comment field's placeholder and the orientation's review line writing Thimble.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

const SRC = path.resolve(__dirname, '../../src')

/** Every source file under src. */
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|mjs|json)$/.test(n) ? [p] : []
  })
}

/** The text with its comments blanked, each line kept where it was. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

test('no string in the page writes thimble with a capital', () => {
  const found = sources().flatMap((f) =>
    code(readFileSync(f, 'utf8'))
      .split('\n')
      .flatMap((line, i) => (/(?<![\w-])Thimble(?![\w-])/.test(line) ? [`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`] : [])),
  )
  expect(found).toEqual([])
})
