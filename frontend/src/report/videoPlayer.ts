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
    this.halt()
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
    else this.draw(lines[k].start)
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
    const done = () => {
      if (token === this.token) this.spoken(i)
    }
    u.onend = done
    u.onerror = done
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
