// What thimble draws of text it did not write (core/text.js printable, printing): each character that does not print
// shows as its escape, as Python's repr writes it, wherever thimble draws it. Made-up text.
//   node --test plugin/core/test/text.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { printable, printing } from '../text.js'

test("each character that does not print, as Python's str.isprintable reads it, shows as its escape, as Python's repr writes it; white space that lays text out stays: a line break (also \\r\\n), and a tab, as a space", () => {
  for (const [c, want] of [
    ['\u0000', '\\x00'],
    ['\u001b', '\\x1b'],
    ['\u007f', '\\x7f'],
    ['\u0085', '\\x85'],
    ['\u009f', '\\x9f'],
    ['\u00a0', '\\xa0'],
    ['\u00ad', '\\xad'],
    ['\u200b', '\\u200b'],
    ['\u200e', '\\u200e'],
    ['\u202e', '\\u202e'],
    ['\u2028', '\\u2028'],
    ['\u2029', '\\u2029'],
    ['\u3000', '\\u3000'],
    ['\ufeff', '\\ufeff'],
    ['\ue000', '\\ue000'],
    ['\udce9', '\\udce9'],
    ['\u{e0001}', '\\U000e0001'],
    ['\u{10eeee}', '\\U0010eeee'],
    ['\r', '\\r'],
  ]) assert.equal(printable(`a${c}b`), `a${want}b`, want)
  // what prints stays as it is: letters of any script, wide ones, marks, emoji of two halves, the space, a backslash
  for (const s of ['plain words', 'caf\u00e9 \u65e5\u672c', 'e\u0301', 'ok \u{1f389}', 'C:\\runs\\x00.txt']) assert.equal(printable(s), s)
  assert.equal(printable('one\ntwo\r\nthree\tfour'), 'one\ntwo\nthree four')
  // the head of a binary file, a test run's colored line
  assert.equal(printable('\u0089PNG\r\n\u001a\n\u0000\u0000'), '\\x89PNG\n\\x1a\n\\x00\\x00')
  assert.equal(printable('\u001b[31mFAILED\u001b[0m 12 of 40'), '\\x1b[31mFAILED\\x1b[0m 12 of 40')
  // once printable, it stays so
  const once = printable('\u001b[0m\u00a0\udce9')
  assert.equal(printable(once), once)
})

test('spans of a text move with it: the cited value stays marked where escapes stand before it, and a span over a byte that does not print takes its whole escape', () => {
  const line = '\u001b[31mFAILED\u001b[0m 12 of 40\u0000'
  const at = line.indexOf('12 of 40')
  const r = printable(line, [[at, at + 8], [0, 1]])
  assert.equal(r.text.slice(r.spans[0][0], r.spans[0][1]), '12 of 40')
  assert.equal(r.text.slice(r.spans[1][0], r.spans[1][1]), '\\x1b')
  // a line break written as \r\n is one: a span over it covers the one
  const two = printable('x\r\ny', [[0, 2], [3, 4]])
  assert.deepEqual(two, { text: 'x\ny', spans: [[0, 2], [2, 3]] })
  // nothing to escape: the same text and spans
  assert.deepEqual(printable('12 of 40', [[0, 2]]), { text: '12 of 40', spans: [[0, 2]] })
})

test("a drawing's elements draw every string printable: a Text's and a Button's strings, a Button's and a Link's label, a Code's source, a Markdown's text; the rest as given", () => {
  const made = []
  const el = type => (props, ...rest) => { made.push({ type, props, rest }); return { type, props } }
  // Claude Code's table is frozen
  const els = Object.freeze({ Box: el('Box'), Text: el('Text'), Button: el('Button'), Code: el('Code'), Markdown: el('Markdown'), Link: el('Link') })
  const p = printing(els)
  assert.equal(printing(p), p)
  const inner = p.Text({ key: 'v', bold: true, children: '12\u0007' })
  p.Text({ key: 'line', children: ['\u001b[0m', inner, 3, null] })
  p.Button({ key: 'b', label: 'open run\u0000.log', children: [p.Text({ children: 'run\u0000.log' })] })
  p.Code({ key: 'c', source: 'print("\u001b")' })
  p.Markdown({ key: 'm', text: '[a\u202eb](file:///x)' })
  p.Link({ key: 'l', href: 'file:///x', label: 'x\u200by' })
  p.Box({ key: 'box', children: [inner] })
  const by = type => made.filter(m => m.type === type).map(m => m.props)
  assert.deepEqual(by('Text').map(t => t.children), ['12\\x07', ['\\x1b[0m', inner, 3, null], 'run\\x00.log'])
  assert.equal(by('Text')[0].bold, true)
  assert.equal(by('Button')[0].label, 'open run\\x00.log')
  assert.equal(by('Code')[0].source, 'print("\\x1b")')
  assert.equal(by('Markdown')[0].text, '[a\\u202eb](file:///x)')
  assert.equal(by('Link')[0].label, 'x\\u200by')
  assert.deepEqual(by('Box')[0], { key: 'box', children: [inner] })
  // an element the table lacks stays missing
  assert.equal(p.Raster, undefined)
  assert.equal('Code' in p, true)
})
