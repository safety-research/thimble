// @vitest-environment jsdom
// The order new values take the label palette's places (backend/app/label_order.json, src/files/labels.ts
// LABEL_ORDER): blue, orange, green, gold, teal, brown, sky, then navy, grass, cerulean, chestnut and cyan, so the first
// five are five hues with no second blue. A stored color is a place, which keeps its hue, so the order changes only
// what new values take: a new label and its values in the editor, Files' record keys, a new report check. The server's
// copy (kernel_thimble.LABEL_ORDER) is the same list.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { LABEL_ORDER } from '../../src/files/labels.ts'

const ORDER = [1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11, 12]

describe('the order new values take the label palette', () => {
  test('is one list: the JSON the view kit gets, the frontend constant and the kernel constant', () => {
    const app = path.resolve(__dirname, '../../../backend/app')
    const json = JSON.parse(readFileSync(path.join(app, 'label_order.json'), 'utf8'))
    const py = readFileSync(path.join(app, 'kernel_thimble.py'), 'utf8')
    const kernel = JSON.parse(`[${/^LABEL_ORDER = \(([^)]*)\)/m.exec(py)![1]}]`)
    expect(json).toEqual(ORDER)
    expect([...LABEL_ORDER]).toEqual(ORDER)
    expect(kernel).toEqual(ORDER)
    expect([...ORDER].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })
})
