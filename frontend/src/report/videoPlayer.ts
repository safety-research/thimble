// A video's playback, apart from React. Each line is spoken with the browser's speech synthesis while the film is drawn
// through the line's window of the timing (backend video.timing) on a clock scaled by the rate. When the voice runs past
// the window the window's last frame holds; when it ends before, the next line starts at once. The pause after a line,
// and a line with no voice to speak it, run on the clock alone.
import type { VideoTiming } from '../lib/types'

export interface PlayerOut {
  /** draw the film at t seconds */
  draw: (t: number) => void
  /** playback started or stopped */
  playing: (on: boolean) => void
  /** the voice reached the word at `char` of line `line`'s text; null when a line starts afresh */
  word: (line: number, char: number | null) => void
}

// macOS's novelty voices, left out of the list
const NOVELTY = new Set(['albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'deranged', 'good news', 'hysterical', 'jester', 'organ', 'pipe organ', 'princess', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox'])
// older synthesized voices, kept in the list but ranked after the natural ones
const DATED = new Set(['agnes', 'bruce', 'fred', 'junior', 'kathy', 'ralph', 'vicki', 'victoria'])
const baseName = (v: SpeechSynthesisVoice) => v.name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase()

/** The voices worth offering, best first: in the page's language, then those that run on this machine before online
 * ones (localService), then Premium or Enhanced, then natural or neural, then the rest but dated voices, the system
 * default before the rest; no novelty voice. */
export function rankVoices(voices: readonly SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice[] {
  const want = lang.toLowerCase().replace('_', '-')
  const wantBase = want.split('-')[0]
  const key = (v: SpeechSynthesisVoice): (number | string)[] => {
    const l = v.lang.toLowerCase().replace('_', '-')
    const n = v.name.toLowerCase()
    const tier = /premium|enhanced/.test(n) ? 0 : /natural|neural/.test(n) ? 1 : !DATED.has(baseName(v)) ? 2 : 3
    return [l.split('-')[0] === wantBase ? 0 : 1, v.localService ? 0 : 1, tier, l === want ? 0 : 1, v.default ? 0 : 1, v.name]
  }
  const order = (a: (number | string)[], b: (number | string)[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    return 0
  }
  return voices.filter((v) => !NOVELTY.has(baseName(v))).sort((a, b) => order(key(a), key(b)))
}

interface Run {
  line: number
  /** `line` while the line's window runs, `gap` from its end to the next line's start (the film's end after the last) */
  phase: 'line' | 'gap'
  /** the film time at `at`, a performance.now() */
  from: number
  at: number
  /** whether a voice speaks the line, so its end moves playback on */
  voiced: boolean
}

const EARLY_S = 0.05
// how long past its window a voice may run before playback goes on without its end, which a voice can fail to report
const STALL_S = 8
const SILENT_MS = 250
const EMPTY: VideoTiming = { duration: 0, lines: [] }

export function speech(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
}

export class VideoPlayer {
  timing: VideoTiming = EMPTY
  texts: string[] = []
  voice: SpeechSynthesisVoice | null = null
  rate = 1
  t = 0
  private run: Run | null = null
  private token = 0
  private frame: number | null = null
  // the utterance speaking, held so it is not collected before its end fires
  private utterance: SpeechSynthesisUtterance | null = null
  private readonly out: PlayerOut

  constructor(out: PlayerOut) {
    this.out = out
  }

  get playing(): boolean {
    return this.run != null
  }

  /** A new script: playback stops and the film is drawn at t, kept when it is still inside the film. */
  load(timing: VideoTiming | null, texts: string[]): void {
    if (this.run) this.pause()
    else this.halt()
    this.timing = timing ?? EMPTY
    this.texts = texts
    this.draw(this.t <= this.timing.duration ? this.t : 0)
  }

  /** The line whose window began last at t, 0 before the first. */
  lineAt(t = this.t): number {
    let k = 0
    this.timing.lines.forEach((l, i) => {
      if (l.start <= t + 1e-6) k = i
    })
    return k
  }

  /** Play from line `i`, else from the line at t: the next one when t is past its window, the first at the end. */
  play(i?: number): void {
    const lines = this.timing.lines
    if (!lines.length) return
    let k = i ?? this.lineAt()
    if (i == null && this.t > lines[k].end + EARLY_S) k += 1
    if (k >= lines.length) k = 0
    this.startLine(k)
    this.out.playing(true)
    if (this.frame == null) this.frame = requestAnimationFrame(this.tick)
  }

  pause(): void {
    this.halt()
    this.out.playing(false)
  }

  /** Line `i` from its start: spoken from there while playing, else drawn. */
  go(i: number): void {
    const lines = this.timing.lines
    if (!lines.length) return
    const k = Math.max(0, Math.min(lines.length - 1, i))
    if (this.run) this.startLine(k)
    else {
      this.out.word(k, null)
      this.draw(lines[k].start)
    }
  }

  /** The rate for what is spoken next; the clock goes on from the frame drawn now. */
  setRate(rate: number): void {
    this.rate = rate
    if (this.run) Object.assign(this.run, { from: this.t, at: performance.now() })
  }

  dispose(): void {
    this.halt()
  }

  private draw(t: number): void {
    this.t = t
    this.out.draw(t)
  }

  private halt(): void {
    this.token++
    this.run = null
    if (this.frame != null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.utterance = null
    speech()?.cancel()
  }

  private startLine(i: number): void {
    const token = ++this.token
    speech()?.cancel()
    const start = this.timing.lines[i].start
    this.run = { line: i, phase: 'line', from: start, at: performance.now(), voiced: false }
    this.out.word(i, null)
    this.draw(start)
    this.run.voiced = this.speak(i, token)
  }

  private speak(i: number, token: number): boolean {
    const synth = speech()
    const text = this.texts[i]?.trim()
    if (!synth || !text) return false
    const u = new SpeechSynthesisUtterance(text)
    if (this.voice) {
      u.voice = this.voice
      u.lang = this.voice.lang
    }
    u.rate = this.rate
    const said = performance.now()
    // a voice that fails, or ends before it could have said anything, leaves the line to the clock
    const unvoiced = () => {
      if (token === this.token && this.run?.line === i) this.run.voiced = false
    }
    u.onend = () => {
      if (token !== this.token) return
      if (performance.now() - said < SILENT_MS) unvoiced()
      else this.spoken(i)
    }
    u.onerror = unvoiced
    u.onboundary = (e) => {
      if (token === this.token && (e.name ?? 'word') === 'word') this.out.word(i, e.charIndex)
    }
    this.utterance = u
    synth.speak(u)
    return true
  }

  /** The voice finished line `i`: early, the next line starts; on time or late, its pause runs from the line's end. */
  private spoken(i: number): void {
    const run = this.run
    if (!run || run.line !== i || run.phase !== 'line') return
    const end = this.timing.lines[i].end
    const early = this.t < end - EARLY_S
    if (early && i + 1 < this.timing.lines.length) return this.startLine(i + 1)
    this.run = { ...run, phase: 'gap', from: early ? end : this.t, at: performance.now() }
    if (early) this.draw(end)
  }

  private tick = (): void => {
    this.frame = null
    const run = this.run
    if (!run) return
    const lines = this.timing.lines
    const x = run.from + ((performance.now() - run.at) / 1000) * this.rate
    const line = lines[run.line]
    if (run.phase === 'line') {
      this.draw(Math.min(x, line.end))
      if (run.voiced && x >= line.end + STALL_S) this.spoken(run.line)
      else if (!run.voiced && x >= line.end) this.run = { ...run, phase: 'gap', from: line.end, at: performance.now() }
    } else {
      const last = run.line + 1 >= lines.length
      const until = last ? this.timing.duration : lines[run.line + 1].start
      this.draw(Math.min(x, until))
      if (x >= until) {
        if (last) return this.pause()
        this.startLine(run.line + 1)
      }
    }
    this.frame = requestAnimationFrame(this.tick)
  }
}
