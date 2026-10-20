// The frame of a card under a reply: square corners, its question in bold first, a blank row, the drawing, and its
// takeaway when it has one.
//   node --test shell/test/cardframe.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cardFrame, frameLines, frameRows, frameWidth } from '../cardframe.js'

const BODY = ['▆▆▆▆▆▆ 12', '▆▆▆ 6']

test('a card is framed: its question, a blank row, the drawing, then its takeaway with citations as words', () => {
  const lines = frameLines({ w: 40, title: 'Which line runs late most often?', text: 'Line 12 ran late on [212](r4#line=12@late) of its **930** trips.' }, BODY)
  assert.equal(lines[0], '┌' + '─'.repeat(38) + '┐')
  assert.equal(lines[lines.length - 1], '└' + '─'.repeat(38) + '┘')
  assert.ok(lines.every(l => [...l].length === 40), lines.join('\n'))
  assert.match(lines[1], /^│ Which line runs late most often\? +│$/)
  assert.match(lines[2], /^│ +│$/)
  assert.match(lines[3], /^│ ▆▆▆▆▆▆ 12 +│$/)
  assert.equal(lines.slice(6, -1).map(l => l.slice(2, -2).trim()).join(' '), 'Line 12 ran late on 212 of its 930 trips.')
  assert.match(lines[5], /^│ +│$/)
  assert.ok(!lines.some(l => /[╭╮╰╯]/.test(l)), 'square corners')
})

test('a card with no takeaway ends with its drawing, and a long question wraps to two rows at most', () => {
  const kinds = frameRows({ w: 30, title: 'How did each of the twenty-three runs end, and what did each cost to run?', text: '', bodyH: 2 }).map(r => r.kind)
  assert.deepEqual(kinds, ['top', 'title', 'title', 'blank', 'body', 'bottom'])
})

test('the frame is as wide as the drawing or its question needs, inside the room it has', () => {
  assert.equal(frameWidth(124, 50, 'Short?'), 54)
  assert.equal(frameWidth(124, 200, 'Short?'), 124)
  assert.equal(frameWidth(124, 20, 'q'), 40)
  assert.equal(frameWidth(60, 20, 'A question longer than the room the frame has for it, by a good margin'), 60)
})

test('as elements: the border in the keys\' color on the card they act on, dim on any other, around the drawing', () => {
  const el = type => props => ({ type, props })
  const els = { Box: el('Box'), Text: el('Text') }
  const find = (n, pred, out = []) => { if (n && typeof n === 'object') { if (pred(n)) out.push(n); for (const c of [].concat(n.props?.children ?? [])) find(c, pred, out) } return out }
  const body = { type: 'Body', props: {} }
  const focused = cardFrame(els, { key: 'k', w: 40, title: 'Q?', text: 'T.', body, bodyH: 2, color: '#5aa2e6' })
  const top = find(focused, n => n.props?.key === 'top')[0]
  assert.equal(top.props.color, '#5aa2e6')
  assert.ok(find(focused, n => n === body).length === 1)
  assert.equal(find(focused, n => n.props?.bold === true)[0].props.children, 'Q?')
  const rest = cardFrame(els, { key: 'k', w: 40, title: 'Q?', text: '', body, bodyH: 2, color: null })
  assert.equal(find(rest, n => n.props?.key === 'top')[0].props.dimColor, true)
})
