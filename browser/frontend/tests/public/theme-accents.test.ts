// The accents are one list (src/lib/theme.ts ACCENTS): the popover shows each, the server takes each (backend render.py
// ACCENT_NAME), and src/styles/tokens.css gives each its tokens, in blocks of its own with every token iris has, its
// fill the swatch's hex. An accent with no block would draw in iris's colors.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { ACCENTS, DEFAULT_ACCENT } from '../../src/lib/theme.ts'

const CSS = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The custom properties of every rule whose selector list holds `selector`, later rules over earlier ones. */
function tokens(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').some((s) => s.replace(/\s+/g, '') === selector)) continue
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim().toLowerCase()
  }
  return out
}

test('every accent of the list has every token iris has in tokens.css, its fill the hex its swatch shows', () => {
  const block = (id: string) => tokens(`:root[data-accent='${id}']`)
  const iris = Object.keys(block(DEFAULT_ACCENT))
  expect(iris).toContain('--accent')
  for (const a of ACCENTS) {
    const own = block(a.id)
    expect(iris.filter((k) => !(k in own)), `${a.id}: tokens with no value of its own`).toEqual([])
    expect(own['--accent'], `${a.id}: its fill`).toBe(a.hex.toLowerCase())
  }
})
