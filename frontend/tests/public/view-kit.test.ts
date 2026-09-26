// thimble's parts for a view's page (backend/app/viewer_kit.css) are drawn only in tokens the frame passes: each one it
// reads is in VIEW_TOKENS, and the headless shot (scripts/view_shot.mjs) passes the same list as the app's frame.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import { VIEW_TOKENS } from '../../src/lib/frame'

const ROOT = path.resolve(__dirname, '../../..')
const KIT = readFileSync(path.join(ROOT, 'backend/app/viewer_kit.css'), 'utf8')
const SHOT = readFileSync(path.join(ROOT, 'scripts/view_shot.mjs'), 'utf8')

test('every token the parts read reaches the frame', () => {
  const used = new Set([...KIT.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
  expect(used.size).toBeGreaterThan(10)
  expect([...used].filter((t) => !VIEW_TOKENS.includes(t))).toEqual([])
})

test('the headless shot passes the frame the same tokens as the app', () => {
  const list = /const VIEW_TOKENS = \[([\s\S]*?)\]/.exec(SHOT)?.[1] ?? ''
  const shot = [...list.matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1])
  expect([...shot].sort()).toEqual([...VIEW_TOKENS].sort())
})
