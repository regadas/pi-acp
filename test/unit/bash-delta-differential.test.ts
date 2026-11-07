import test from 'node:test'
import assert from 'node:assert/strict'

import { bashOutputDelta, type BashOutputSnapshot } from '../../src/acp/translate/bash.js'

/**
 * Differential oracle: the split()-era semantics of `bashOutputDelta`,
 * preserved verbatim (forward newline scan with the whole-window line-count
 * verification) so refactors of the rolling-window arithmetic can be proven
 * equivalent over randomized corpora — including foreign metadata whose
 * coordinates disagree with the window text.
 */

/** Longest prefix of `next` that is a suffix of `previous` (KMP failure function). */
function refLongestSuffixPrefixOverlap(previous: string, next: string): number {
  if (!next) return 0
  const failure = new Int32Array(next.length)
  for (let i = 1, k = 0; i < next.length; i++) {
    while (k > 0 && next[i] !== next[k]) k = failure[k - 1]!
    if (next[i] === next[k]) k++
    failure[i] = k
  }
  let matched = 0
  for (let i = 0; i < previous.length; i++) {
    while (matched > 0 && previous[i] !== next[matched]) matched = failure[matched - 1]!
    if (previous[i] === next[matched]) matched++
    if (matched === next.length) {
      if (i === previous.length - 1) return next.length
      matched = failure[matched - 1]!
    }
  }
  return matched
}

function refCountOutputLines(text: string): number {
  if (!text) return 0
  let lines = 0
  let newline = text.indexOf('\n')
  while (newline !== -1) {
    lines++
    newline = text.indexOf('\n', newline + 1)
  }
  return text.endsWith('\n') ? lines : lines + 1
}

type RefCoords = { totalLines: number; totalBytes: number; outputLines: number; lastLinePartial?: boolean }

function refCompleteSnapshotCoords(text: string): RefCoords {
  const lines = refCountOutputLines(text)
  return { totalLines: lines, totalBytes: Buffer.byteLength(text), outputLines: lines }
}

function refTextDelta(previous: string, next: string): string {
  if (!previous) return next
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next.slice(refLongestSuffixPrefixOverlap(previous, next))
}

function refInferredAtLineEnd(snapshot: { window?: string; coords?: RefCoords }, window: string): boolean {
  if (snapshot.window === undefined) return window.endsWith('\n')
  if (!snapshot.coords) return false
  if (!window.endsWith('\n')) return false
  return refCountOutputLines(window) === snapshot.coords.outputLines
}

function refCarriedAtLineEnd(
  previous: { endsAtLineBoundary?: boolean; window?: string; coords?: RefCoords },
  prevWindow: string
): boolean {
  if (previous.endsAtLineBoundary !== undefined) return previous.endsAtLineBoundary
  return refInferredAtLineEnd(previous, prevWindow)
}

function refTextFallback(
  previous: { endsAtLineBoundary?: boolean; window?: string; coords?: RefCoords },
  prevWindow: string,
  next: { endsAtLineBoundary?: boolean; text: string }
): string {
  const delta = refTextDelta(prevWindow, next.text)
  next.endsAtLineBoundary = delta ? delta.endsWith('\n') : refCarriedAtLineEnd(previous, prevWindow)
  return delta
}

function refBytePartialTail(
  next: { window?: string; text: string; endsAtLineBoundary?: boolean },
  newBytes: number,
  suffix: string
): string {
  next.endsAtLineBoundary = false
  const windowBytes = Buffer.byteLength(next.window!)
  if (newBytes >= windowBytes) return next.text
  const window = Buffer.from(next.window!, 'utf8')
  let start = windowBytes - newBytes
  while (start < window.length && (window[start] & 0xc0) === 0x80) start++
  return window.subarray(start).toString('utf8') + suffix
}

function refBashOutputDelta(
  previous: { text: string; window?: string; coords?: RefCoords; endsAtLineBoundary?: boolean } | undefined,
  next: { text: string; window?: string; coords?: RefCoords; endsAtLineBoundary?: boolean }
): string {
  const nextWindow = next.window ?? next.text
  const suffix = next.text.slice(nextWindow.length)
  if (!previous) {
    next.endsAtLineBoundary = refInferredAtLineEnd(next, nextWindow)
    return next.text
  }
  const prevWindow = previous.window ?? previous.text
  if (!prevWindow) {
    next.endsAtLineBoundary = refInferredAtLineEnd(next, nextWindow)
    return next.text
  }

  if (!next.window || !next.coords) return refTextFallback(previous, prevWindow, next)

  const prevCoords = previous.coords ?? refCompleteSnapshotCoords(prevWindow)
  const progressed = next.coords.totalLines > prevCoords.totalLines || next.coords.totalBytes > prevCoords.totalBytes
  if (!progressed) {
    next.endsAtLineBoundary = refCarriedAtLineEnd(previous, prevWindow)
    return suffix
  }

  const newLines = next.coords.totalLines - prevCoords.totalLines
  const newBytes = next.coords.totalBytes - prevCoords.totalBytes
  if (newLines < 0 || newBytes < 0) return refTextFallback(previous, prevWindow, next)

  if (newLines === 0) {
    if (next.coords.lastLinePartial) return refBytePartialTail(next, newBytes, suffix)
    const atLineEnd = refCarriedAtLineEnd(previous, prevWindow)
    const shownLine = prevWindow.slice(prevWindow.lastIndexOf('\n') + 1)
    const lastLine = next.window.slice(next.window.lastIndexOf('\n') + 1)
    if (!atLineEnd && lastLine.startsWith(shownLine)) {
      const growth = lastLine.slice(shownLine.length)
      const remaining = newBytes - Buffer.byteLength(growth)
      if (remaining === 0) {
        next.endsAtLineBoundary = false
        return growth + suffix
      }
      if (remaining === 1) {
        next.endsAtLineBoundary = true
        return `${growth}\n` + suffix
      }
      return refTextFallback(previous, prevWindow, next)
    }
    if (next.coords.lastLinePartial === false) return refTextFallback(previous, prevWindow, next)
    return refBytePartialTail(next, newBytes, suffix)
  }

  const windowFirstLine = next.coords.totalLines - next.coords.outputLines + 1
  const alreadyShown = Math.max(0, prevCoords.totalLines - windowFirstLine + 1)

  const windowText = next.window
  let windowNewlines = 0
  let grownStart = alreadyShown <= 1 ? 0 : -1
  let freshStart = alreadyShown === 0 ? 0 : -1
  for (let newline = windowText.indexOf('\n'); newline !== -1; newline = windowText.indexOf('\n', newline + 1)) {
    windowNewlines++
    if (windowNewlines === alreadyShown - 1) grownStart = newline + 1
    else if (windowNewlines === alreadyShown) freshStart = newline + 1
  }
  if (windowNewlines + 1 !== next.coords.outputLines) return refTextFallback(previous, prevWindow, next)
  if (freshStart === -1) {
    next.endsAtLineBoundary = refCarriedAtLineEnd(previous, prevWindow)
    return suffix
  }

  const atLineEnd = refCarriedAtLineEnd(previous, prevWindow)
  let prefix = atLineEnd ? '' : '\n'
  if (!atLineEnd && alreadyShown >= 1) {
    const shownLastLine = prevWindow.slice(prevWindow.lastIndexOf('\n') + 1)
    const grown = windowText.slice(grownStart, freshStart - 1)
    if (grown.startsWith(shownLastLine)) prefix = `${grown.slice(shownLastLine.length)}\n`
  }
  next.endsAtLineBoundary = false
  return prefix + windowText.slice(freshStart) + suffix
}

/** Deterministic LCG so a failure reproduces from the case index alone. */
function lcg(seed: number): () => number {
  let state = seed % 2147483647
  if (state <= 0) state += 2147483646
  return () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
}

type GenSnapshot = { text: string; window?: string; coords?: RefCoords }

/**
 * Builds one snapshot sequence: a short line stream observed through a small
 * rolling window cap, with randomly honest and lying coordinates (a foreign
 * record can under- or over-count outputLines/totalLines), plus occasional
 * complete snapshots, verbatim-terminated tails, and a final annotation.
 */
function generateSequence(rand: () => number): GenSnapshot[] {
  const lineCount = 2 + Math.floor(rand() * 14)
  const cap = 1 + Math.floor(rand() * 4)
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    if (rand() < 0.15) lines.push('')
    else if (rand() < 0.2) lines.push('π' + 'x'.repeat(Math.floor(rand() * 4)))
    else lines.push('L' + i + 'x'.repeat(Math.floor(rand() * 5)))
  }

  const snapshots: GenSnapshot[] = []
  let shown = 0 // lines fully terminated so far
  let firstSnapshot = true
  for (let step = 0; step < lines.length; step++) {
    const full = lines[step]!
    // The open line is a random prefix of this step's line; it usually
    // terminates before the next snapshot.
    const openLen = Math.floor(rand() * (full.length + 1))
    const openText = full.slice(0, openLen)
    const terminated = rand() < 0.75
    if (terminated) shown++

    const totalLines = shown + (terminated ? 0 : 1)
    const openKept = terminated ? '' : openText
    const allText =
      lines
        .slice(0, shown)
        .join('\n')
        .concat(shown > 0 && openKept ? '\n' : '') + openKept
    const windowLines = Math.min(totalLines, cap)
    const windowStart = totalLines - windowLines
    const window =
      lines
        .slice(windowStart, shown)
        .join('\n')
        .concat(windowStart < shown && openKept ? '\n' : '') + openKept
    const totalBytes = Buffer.byteLength(allText)

    const roll = rand()
    if (roll < 0.15 && !firstSnapshot) {
      snapshots.push({ text: allText })
    } else {
      let coords: RefCoords = {
        totalLines,
        totalBytes,
        outputLines: windowLines,
        lastLinePartial: false
      }
      if (rand() < 0.3) {
        // Foreign metadata: the coordinates disagree with the window text.
        const lie = rand()
        if (lie < 0.5) coords = { ...coords, outputLines: windowLines - 1 }
        else if (lie < 0.8) coords = { ...coords, outputLines: windowLines + 1 }
        else coords = { ...coords, totalLines: totalLines - 1 }
      }
      snapshots.push({ text: window, window, coords })
    }
    firstSnapshot = false
  }

  // Sometimes append a final annotated result over the last window.
  const last = snapshots[snapshots.length - 1]
  if (last && last.window !== undefined && rand() < 0.4) {
    const annotation = '\n\n[Showing lines. Full output: /tmp/x.log]'
    snapshots.push({ ...last, text: last.window + annotation })
  }
  return snapshots
}

test('bashOutputDelta matches the reference semantics over randomized windows', () => {
  const rand = lcg(20260107)
  const cases = 20_000
  for (let i = 0; i < cases; i++) {
    const generated = generateSequence(rand)
    const subject: BashOutputSnapshot[] = generated.map(s => ({
      text: s.text,
      ...(s.window !== undefined ? { window: s.window } : {}),
      ...(s.coords !== undefined ? { coords: s.coords } : {})
    }))
    const reference: BashOutputSnapshot[] = generated.map(s => ({
      text: s.text,
      ...(s.window !== undefined ? { window: s.window } : {}),
      ...(s.coords !== undefined ? { coords: s.coords } : {})
    }))

    let subjectPrevious: BashOutputSnapshot | undefined
    let referencePrevious: BashOutputSnapshot | undefined
    for (let step = 0; step < subject.length; step++) {
      const subjectDelta = bashOutputDelta(subjectPrevious, subject[step]!)
      const referenceDelta = refBashOutputDelta(referencePrevious, reference[step]!)
      assert.deepEqual(
        { delta: subjectDelta, boundary: subject[step]!.endsAtLineBoundary },
        { delta: referenceDelta, boundary: reference[step]!.endsAtLineBoundary },
        `case ${i} step ${step}: ${JSON.stringify(generated[step])}`
      )
      subjectPrevious = subject[step]
      referencePrevious = reference[step]
    }
  }
})

test('bashOutputDelta: the known incoherent-metadata divergence probe (old-vs-old sanity)', () => {
  // The window-vs-metadata verification is load-bearing: a window whose
  // text has more lines than outputLines claims must fall back to text
  // overlap. This pins the protection the differential corpus exercises.
  const honest: BashOutputSnapshot = {
    text: 'a\nb',
    window: 'a\nb',
    coords: { totalLines: 2, totalBytes: 3, outputLines: 2 }
  }
  const lying: BashOutputSnapshot = {
    text: 'a\nb\nc\nd',
    window: 'a\nb\nc\nd',
    coords: { totalLines: 3, totalBytes: 7, outputLines: 2 }
  }
  assert.equal(bashOutputDelta(honest, lying), '\nc\nd')
})
