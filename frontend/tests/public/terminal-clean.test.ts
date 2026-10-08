// Terminal output cleaned for reading: cursor moves applied, ANSI escapes and counter markers dropped, control bytes
// gone, trailing space and the blank lines at either end trimmed (src/lib/terminal.ts).
import { describe, expect, test } from 'vitest'
import { applyCursor, cleanTerminal, needsClean, trimLines } from '../../src/lib/terminal.ts'

describe('cursor moves', () => {
  test('a backspace moves the cursor left, so what follows overwrites', () => {
    expect(applyCursor('abc\b\bX')).toBe('aXc')
    // trailing backspaces before a newline only move the cursor: the text stays
    expect(applyCursor('FAIL     \b\b\b\b\b')).toBe('FAIL     ')
  })
  test('a carriage return returns to the line start, so a redrawn line reads as the last state', () => {
    expect(applyCursor('30%\r60%\r100%')).toBe('100%')
    // overwrite, not erase: 'done' is written over the first four of 'loading...'
    expect(applyCursor('loading...\rdone')).toBe('doneing...')
  })
  test('newlines end lines; backspaces do not cross them', () => {
    expect(applyCursor('one\btwo')).toBe('ontwo')
    expect(applyCursor('a\n\bb')).toBe('a\nb')
  })
})

describe('cleanTerminal', () => {
  test('drops ANSI colour and cursor escapes', () => {
    expect(cleanTerminal('\x1b[31mred\x1b[0m text')).toBe('red text')
    expect(cleanTerminal('\x1b[2K\x1b[Gline')).toBe('line')
  })
  test('drops counter markers a harness wraps around a prompt', () => {
    expect(cleanTerminal('<counter>11</counter> user@host:~$ ls')).toBe('user@host:~$ ls')
  })
  test('drops stray control bytes but keeps tabs and newlines', () => {
    expect(cleanTerminal('a\x00b\x07\tc')).toBe('ab\tc')
    expect(cleanTerminal('line one\nline two')).toBe('line one\nline two')
  })
  test('trims trailing space and the blank lines at either end', () => {
    expect(trimLines('\n\nkept  \n\nmore \n\n')).toBe('kept\n\nmore')
  })
  test('a real-shaped echo: a command echoed, rubbed back with backspaces, and the counter prompt', () => {
    const raw = '\n<counter>11</counter> user@host:~$ \n\n<ssh ... && echo R_UP || echo R_FAIL          \b\b\b\b\b\b\b\b\b\b\n'
    const out = cleanTerminal(raw)
    expect(out).not.toContain('<counter>')
    expect(out).not.toContain('\b')
    expect(out).toContain('user@host:~$')
    expect(out).toContain('echo R_UP || echo R_FAIL')
  })
  test('needsClean is false for text already clean, true when there is anything to apply', () => {
    expect(needsClean('plain output\nsecond line')).toBe(false)
    expect(needsClean('a\x1b[0m')).toBe(true)
    expect(needsClean('a\b')).toBe(true)
    expect(needsClean('trailing  ')).toBe(true)
  })
})
