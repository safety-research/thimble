// @vitest-environment jsdom
// The order new values take the label palette's places (backend/app/label_order.json, src/files/labels.ts
// LABEL_ORDER): blue, orange, green, gold, teal, brown, sky, then navy, grass, cerulean, chestnut and cyan, so the first
// five are five hues with no second blue. A stored color is a place, which keeps its hue, so the order changes only
// what new values take: a new label and its values in the editor, Files' record keys, a new report check. The server's
// copy (kernel_thimble.LABEL_ORDER) is the same list.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { nextFreeColour } from '../../src/files/LabelCard.tsx'
import { keyChips, keyColor } from '../../src/files/colorChoice.ts'
import { classesOf, draftClasses, freeColour, LABEL_ORDER, ownColour, paletteFrom } from '../../src/files/labels.ts'
import { CHECK_COLOURS, freeColour as freeCheckColour } from '../../src/report/checkComments.ts'
import type { Concept, SourceKey } from '../../src/lib/types.ts'

const ORDER = [1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11, 12]
const label = (labels: string[], colors: number[] = []) =>
  ({ id: labels[0], name: labels[0], labels, classes: colors.map((color, i) => ({ name: labels[i], color, highlight: !!color })) }) as unknown as Concept

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

  test('runs round from any place, and from the first for no place', () => {
    expect(paletteFrom(1)).toEqual(ORDER)
    expect(paletteFrom(7)).toEqual([7, 4, 8, 9, 10, 11, 12, 1, 2, 3, 5, 6])
    expect(paletteFrom(4)).toEqual([4, 8, 9, 10, 11, 12, 1, 2, 3, 5, 6, 7])
    expect(paletteFrom(0)).toEqual(ORDER)
  })

  test("a new label's values in the editor take it, a further label the colors left, and none repeats while one is free", () => {
    expect(draftClasses(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 1).map((c) => c.color)).toEqual([1, 2, 3, 5, 6, 7, 4])
    expect(draftClasses(['yes', 'no'], 1).map((c) => c.color)).toEqual([1, 0])
    // the first label holds blue, orange and green: the next starts at gold and goes on in the order
    expect(nextFreeColour([label(['a', 'b', 'c'], [1, 2, 3])])).toBe(5)
    expect(draftClasses(['x', 'y', 'z'], 5, [1, 2, 3]).map((c) => c.color)).toEqual([5, 6, 7])
    expect(freeColour(1, [1, 2, 3, 5])).toBe(6)
    expect(freeColour(12, [12, 1])).toBe(2)
    expect(freeColour(1, ORDER)).toBeNull()
    expect(ownColour(3, [3])).toBe(5)
    expect(ownColour(7, [7, 4])).toBe(8)
    expect(ownColour(0, [0])).toBe(0)
    expect(nextFreeColour([])).toBe(1)
    // with every color held, a new label takes them in turn: the thirteenth the first again
    expect(nextFreeColour(ORDER.map((n) => label([`v${n}`], [n])))).toBe(1)
    // a label the server has sent no classes for draws its values in the order too, its negative in the gray
    expect(classesOf(label(['a', 'b', 'c', 'd', 'e', 'f', 'other'])).map((c) => c.color)).toEqual([1, 2, 3, 5, 6, 7, 0])
  })

  test("Files' record keys take it by frequency, the commonest first, then Other in the gray", () => {
    const key: SourceKey = { key: 'type', values: Array.from({ length: 13 }, (_, i) => ({ value: `v${i}`, n: 100 - i })), more: { values: 0, n: 0 }, none: 0, at: [] }
    expect(keyChips(key).slice(0, 12).map((c) => c.color)).toEqual(ORDER.map((n) => `var(--label-${n})`))
    expect(keyColor(12)).toBe('var(--label-none)')
  })

  test('a new report check takes the first of the eight check colors in the order that no check has', () => {
    expect(CHECK_COLOURS).toEqual([1, 2, 3, 5, 6, 7, 4, 8])
    // the built-in checks hold blue, green and gold
    expect(freeCheckColour([{ colour: 1 }, { colour: 3 }, { colour: 5 }])).toBe(2)
    expect(freeCheckColour([{ colour: 1 }, { colour: 2 }, { colour: 3 }, { colour: 5 }])).toBe(6)
    expect(freeCheckColour([{ colour: 1 }, { colour: 2 }, { colour: 3 }, { colour: 5 }, { colour: 6 }, { colour: 7 }])).toBe(4)
  })
})
