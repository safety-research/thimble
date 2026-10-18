// The browser canvas's Fit (shell/browser/src/canvas/fit.ts): a board that fits at a zoom where its cards read is shown
// whole, as 0.9 does; a bigger one stops at the readable zoom from its top left, and the person pans to the rest.
//   node --test lean/shell/test/canvasfit.test.mjs   (Node strips the file's types: 22.18 or later)
import assert from 'node:assert/strict'
import { test } from 'node:test'

const fit = await import('../browser/src/canvas/fit.ts').catch(() => null)

test('Fit never zooms below the readable floor; above it, the whole board as 0.9 fits it', { skip: !fit && 'this Node does not load .ts files' }, () => {
  const { READABLE_FIT, readableFit } = fit
  // a small board: 0.9's fit stands
  const whole = { x: 30, y: 12, scale: 0.9 }
  assert.deepEqual(readableFit(whole, { x: 40, y: 60, w: 800, h: 400 }, 1400, 900, 48, 200), whole)
  // two wide cards side by side and a tall one: 0.9 would show it at 0.4, where 13 px words are 5 px
  const view = readableFit({ x: 0, y: 0, scale: 0.4 }, { x: 40, y: 60, w: 1700, h: 1300 }, 1400, 900, 48, 200)
  assert.equal(view.scale, READABLE_FIT)
  assert.ok(READABLE_FIT * 13 >= 9, 'a card\'s words read at the floor')
  // the board's top left at the pad
  assert.equal(view.x, 48 - 40 * READABLE_FIT)
  assert.equal(view.y, 48 - 60 * READABLE_FIT)
  // a board narrower than the room at the floor is centred across
  const narrow = readableFit({ x: 0, y: 0, scale: 0.3 }, { x: 0, y: 0, w: 600, h: 4000 }, 1400, 900, 48, 200)
  assert.equal(narrow.x, (1200 - 600 * READABLE_FIT) / 2)
  assert.equal(narrow.y, 48)
  assert.deepEqual(readableFit(whole, null, 1400, 900), whole)
})
