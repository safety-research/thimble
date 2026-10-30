// What thimble draws of text from the records (core/text.js printable): each character that does not print shows as
// its escape, as Python's repr writes it. Made-up text.
//   node --test plugin/core/test/text.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { printable } from '../text.js'

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
