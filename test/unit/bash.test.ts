import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bashOrderedContent,
  bashOutputDelta,
  bashOutputSnapshot,
  type BashOutputSnapshot
} from '../../src/acp/translate/bash.js'

function textContent(result: unknown): string {
  const content = bashOrderedContent(result)
  assert.equal(content.length, 1)
  assert.equal(content[0]?.type, 'content')
  const block = content[0] as { type: 'content'; content: { type: string; text?: string } }
  assert.equal(block.content.type, 'text')
  assert.equal(typeof block.content.text, 'string')
  return block.content.text!
}

test('bashOrderedContent: preserves whitespace-only content text', () => {
  assert.equal(textContent({ content: [{ type: 'text', text: '   ' }] }), '```console\n   \n```')
})

test('bashOrderedContent: preserves trailing spaces and newlines', () => {
  assert.equal(textContent({ content: [{ type: 'text', text: 'value  \n\n' }] }), '```console\nvalue  \n\n```')
})

test('bashOrderedContent: uses a fence longer than embedded backtick runs', () => {
  const text = 'before\n``````\nafter'
  assert.equal(textContent({ content: [{ type: 'text', text }] }), '```````console\nbefore\n``````\nafter\n```````')
})

test('bashOrderedContent: preserves whitespace-only details fallback', () => {
  assert.equal(textContent({ content: [], details: { stdout: ' \n' } }), '```console\n \n```')
})

/** Snapshot without native truncation metadata (complete output). */
const complete = (text: string): BashOutputSnapshot => ({ text })

/**
 * Native pi 1.1.0 truncated snapshot: the tail window is joined without a
 * trailing newline and `details.truncation` carries the cumulative totals,
 * the window line count, the window text itself and whether the window is a
 * byte-partial slice of one line past the byte cap.
 */
function truncated(
  window: string,
  coords: { totalLines: number; totalBytes: number; outputLines: number },
  lastLinePartial = false
): {
  record: unknown
  snapshot: BashOutputSnapshot
} {
  const record = {
    content: [{ type: 'text', text: window }],
    details: {
      truncation: {
        truncated: true,
        truncatedBy: lastLinePartial ? 'bytes' : 'lines',
        ...coords,
        content: window,
        lastLinePartial
      }
    }
  }
  return { record, snapshot: bashOutputSnapshot(record) }
}

/** Drives snapshots through bashOutputDelta in call order, like the session. */
function deltaSequence(snapshots: BashOutputSnapshot[]): string[] {
  const deltas: string[] = []
  let previous: BashOutputSnapshot | undefined
  for (const snapshot of snapshots) {
    deltas.push(bashOutputDelta(previous, snapshot))
    previous = snapshot
  }
  return deltas
}

// Real pi 1.1.0 OutputAccumulator snapshots: below the line/byte cap the raw
// text is kept verbatim (trailing newline included); once the window rolls,
// the kept lines are joined without one.
const windowText = (from: number, to: number, trailingNewline = false) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line${from + i}`).join('\n') + (trailingNewline ? '\n' : '')

test('bashOutputSnapshot: keeps the observed text and splits the window from the final annotation', () => {
  // `seq 2001` fully terminated: 16902 stream bytes, window = lines 2-2001.
  const { snapshot } = truncated(windowText(2, 2001), { totalLines: 2001, totalBytes: 16902, outputLines: 2000 })
  const annotation = '\n\n[Showing lines 2-2001 of 2001. Full output: /tmp/pi-bash-x.log]'
  const final = bashOutputSnapshot({
    content: [{ type: 'text', text: windowText(2, 2001) + annotation }],
    details: {
      truncation: {
        truncated: true,
        truncatedBy: 'lines',
        totalLines: 2001,
        totalBytes: 16902,
        outputLines: 2000,
        content: windowText(2, 2001),
        lastLinePartial: false
      }
    }
  })
  assert.deepEqual(final, {
    text: windowText(2, 2001) + annotation,
    window: windowText(2, 2001),
    coords: { totalLines: 2001, totalBytes: 16902, outputLines: 2000, lastLinePartial: false }
  })
  assert.deepEqual(snapshot, {
    text: windowText(2, 2001),
    window: windowText(2, 2001),
    coords: { totalLines: 2001, totalBytes: 16902, outputLines: 2000, lastLinePartial: false }
  })
  assert.deepEqual(bashOutputSnapshot({ content: [{ type: 'text', text: 'plain\n' }] }), { text: 'plain\n' })
  assert.deepEqual(bashOutputSnapshot({ content: [] }), { text: '' })
  // Metadata that disagrees with the observed text is ignored.
  assert.deepEqual(
    bashOutputSnapshot({
      content: [{ type: 'text', text: 'other\n' }],
      details: {
        truncation: {
          truncated: true,
          truncatedBy: 'lines',
          totalLines: 2001,
          totalBytes: 16902,
          outputLines: 2000,
          content: windowText(2, 2001),
          lastLinePartial: false
        }
      }
    }),
    { text: 'other\n' }
  )
})

test('bashOutputDelta: short cumulative output appends only the new tail', () => {
  assert.equal(bashOutputDelta(undefined, complete('partial\n')), 'partial\n')
  assert.equal(bashOutputDelta(complete(''), complete('partial\n')), 'partial\n')
  assert.equal(bashOutputDelta(complete('partial\n'), complete('partial\nmore\n')), 'more\n')
  assert.equal(bashOutputDelta(complete('same\n'), complete('same\n')), '')
})

test('bashOutputDelta: a rolling 2000-line tail window appends only the new line', () => {
  const previous = windowText(1, 2000, true)
  const next = windowText(2, 2001)
  // Complete stream so far: 16893 bytes; the open `line2001` adds 8 more.
  assert.equal(
    bashOutputDelta(
      complete(previous),
      truncated(next, { totalLines: 2001, totalBytes: 16901, outputLines: 2000 }).snapshot
    ),
    'line2001'
  )
})

test('bashOutputDelta: streaming completes a partial last line byte-exactly', () => {
  assert.equal(bashOutputDelta(complete('out\npartial'), complete('out\npartial line\n')), ' line\n')
  // Stream: line1..line2000 complete (16893 window bytes + `line1\n`) plus
  // the open line `line20`; it grows to `line2001` (+2 bytes), still open.
  const previous = windowText(2, 2000) + '\nline20'
  const next = windowText(2, 2001)
  assert.equal(
    bashOutputDelta(
      truncated(previous, { totalLines: 2001, totalBytes: 16899, outputLines: 2000 }).snapshot,
      truncated(next, { totalLines: 2001, totalBytes: 16901, outputLines: 2000 }).snapshot
    ),
    '01'
  )
})

test('bashOutputDelta: repeated lines append only genuinely new lines', () => {
  assert.equal(bashOutputDelta(complete('a\nb\nb\n'), complete('b\nb\nb\nc\n')), 'b\nc\n')
  const previous = 'v\n'.repeat(2000)
  const next = 'v\n'.repeat(1999) + 'end\n'
  assert.equal(bashOutputDelta(complete(previous), complete(next)), 'end\n')
})

test('bashOutputDelta: unrelated or fully recontained snapshots', () => {
  assert.equal(bashOutputDelta(complete('abc\n'), complete('xyz\n')), 'xyz\n')
  assert.equal(bashOutputDelta(complete('x\ny\nz\n'), complete('y\nz\n')), '')
  assert.equal(bashOutputDelta(complete('anything'), complete('')), '')
})

test('bashOutputDelta: a 50KiB rolled window stays linear and exact', () => {
  const line = `${'x'.repeat(24)}\n`
  const previous = line.repeat(2000)
  const next = line.repeat(1999) + `${'y'.repeat(24)}\n`
  assert.equal(bashOutputDelta(complete(previous), complete(next)), `${'y'.repeat(24)}\n`)
})

test('bashOutputDelta: an open line terminator is appended, not a duplicated byte', () => {
  // Exact native reproduction (pi 1.1.0 OutputAccumulator): the stream is
  // 'v\n' x2000 + 'open' (window = lines 2..2001), then the open line's
  // terminator arrives. Both windows are byte-identical because the native
  // window never includes its last line's terminator; only totalBytes moves
  // 4004 -> 4005.
  const window = 'v\n'.repeat(1999) + 'open'
  const before = truncated(window, { totalLines: 2001, totalBytes: 4004, outputLines: 2000 })
  const after = truncated(window, { totalLines: 2001, totalBytes: 4005, outputLines: 2000 })
  assert.equal(bashOutputDelta(before.snapshot, after.snapshot), '\n')
})

test('bashOutputDelta: growth and terminator in one interval extend the line then close it', () => {
  const before = truncated('v\n'.repeat(1999) + 'open', { totalLines: 2001, totalBytes: 4004, outputLines: 2000 })
  const after = truncated('v\n'.repeat(1999) + 'openxyz', {
    totalLines: 2001,
    totalBytes: 4008,
    outputLines: 2000
  })
  assert.equal(bashOutputDelta(before.snapshot, after.snapshot), 'xyz\n')
})

test('bashOutputDelta: multibyte growth and terminators count bytes, not characters', () => {
  // 'opén' is 5 bytes; ' é' adds 3 bytes and the terminator one more.
  const before = truncated('v\n'.repeat(1999) + 'opén', { totalLines: 2001, totalBytes: 4005, outputLines: 2000 })
  const grown = truncated('v\n'.repeat(1999) + 'opén é', {
    totalLines: 2001,
    totalBytes: 4008,
    outputLines: 2000
  })
  assert.equal(bashOutputDelta(before.snapshot, grown.snapshot), ' é')
  const closed = truncated('v\n'.repeat(1999) + 'opén é', {
    totalLines: 2001,
    totalBytes: 4009,
    outputLines: 2000
  })
  assert.equal(bashOutputDelta(grown.snapshot, closed.snapshot), '\n')
  assert.equal(bashOutputDelta(before.snapshot, closed.snapshot), ' é\n')
})

test('bashOutputDelta: a closed line followed by a new line emits no second separator', () => {
  // The open line 'openxyz' was shown without its terminator. When the next
  // snapshot closes it and starts a new line, the pending terminator lands
  // as the separator; once the terminator was already emitted, the fresh
  // line must not be preceded by a double newline.
  const shownOpen = {
    text: 'v\n'.repeat(1999) + 'openxyz',
    window: 'v\n'.repeat(1999) + 'openxyz',
    coords: { totalLines: 2001, totalBytes: 4008, outputLines: 2000 }
  }
  const after = truncated('v\n'.repeat(1998) + 'openxyz\nnext', {
    totalLines: 2002,
    totalBytes: 4013,
    outputLines: 2000
  })
  assert.equal(bashOutputDelta(shownOpen, after.snapshot), '\nnext')
  assert.equal(bashOutputDelta({ ...shownOpen, endsAtLineBoundary: true }, after.snapshot), 'next')
})

test('bashOutputDelta: identical rolling windows with progressed totals still append the new lines', () => {
  // Audit reproduction: `repeat\n` x2010 then the open line `repeat`, then 10
  // more lines. Both windows are byte-identical, so text comparison alone
  // yields an empty delta. Coherent totals: 2000 complete lines + the open
  // line is 14006 bytes; ten more lines bring 70 bytes (nine terminators
  // included) to 14076.
  const window = 'repeat\n'.repeat(1999) + 'repeat'
  const before = truncated(window, { totalLines: 2001, totalBytes: 14006, outputLines: 2000 })
  const after = truncated(window, { totalLines: 2011, totalBytes: 14076, outputLines: 2000 })
  const tenMore = 'repeat\n'.repeat(9) + 'repeat'
  assert.equal(bashOutputDelta(before.snapshot, after.snapshot), '\n' + tenMore)
  // A later identical window without progress appends nothing at all.
  assert.equal(bashOutputDelta(after.snapshot, after.snapshot), '')
  // ...but the final annotation still lands exactly once.
  const annotation = '\n\n[Showing lines 12-2011 of 2011. Full output: /tmp/pi-bash-r1.log]'
  const annotatedAfter = bashOutputSnapshot({
    content: [{ type: 'text', text: window + annotation }],
    details: {
      truncation: {
        truncated: true,
        truncatedBy: 'lines',
        totalLines: 2011,
        totalBytes: 14076,
        outputLines: 2000,
        content: window,
        lastLinePartial: false
      }
    }
  })
  assert.equal(bashOutputDelta(after.snapshot, annotatedAfter), annotation)
})

test('bashOutputDelta: disjoint rolling windows keep their line boundary', () => {
  // A burst of 2000 lines between throttled updates moves the window fully
  // past everything previously shown; the append must not glue the last
  // previously shown line to the first new one. Streams of lines 1..N with
  // the last line still open: 16901 bytes, then 34901.
  const firstWindow = windowText(2, 2001)
  const secondWindow = windowText(2002, 4001)
  const first = truncated(firstWindow, { totalLines: 2001, totalBytes: 16901, outputLines: 2000 })
  const second = truncated(secondWindow, { totalLines: 4001, totalBytes: 34901, outputLines: 2000 })
  assert.equal(bashOutputDelta(first.snapshot, second.snapshot), '\n' + secondWindow)
  // A complete snapshot that already ended with a newline needs no separator.
  const openThenBurst = truncated(windowText(2002, 4001), { totalLines: 4001, totalBytes: 34901, outputLines: 2000 })
  assert.equal(bashOutputDelta(complete(windowText(1, 2000, true)), openThenBurst.snapshot), secondWindow)
})

test('bashOutputDelta: byte growth on the capped trailing line appends the window tail', () => {
  // Genuine pi 1.1.0 cap shape: a single line past the 51200-byte cap is
  // byte-truncated from the end (native lastLinePartial), so the window is
  // its last 51200 bytes — byte-identical across snapshots while the
  // cumulative totalBytes advances.
  const capped = (totalBytes: number) =>
    truncated('x'.repeat(51200), { totalLines: 1, totalBytes, outputLines: 1 }, true).snapshot
  assert.equal(bashOutputDelta(capped(51201), capped(51211)), 'x'.repeat(10))
  assert.equal(bashOutputDelta(capped(51201), capped(51202)), 'x')
  assert.equal(bashOutputDelta(capped(51201), capped(52201)), 'x'.repeat(1000))
  // A complete snapshot crossing into the cap keeps everything shown and
  // appends the fresh bytes as the new window's tail.
  assert.equal(bashOutputDelta(complete('x'.repeat(51000)), capped(52000)), 'x'.repeat(1000))
  // Terminating the capped line: the window never contains the terminator,
  // and a byte-partial snapshot cannot distinguish it from one more content
  // byte — the fresh-tail slice repeats one already-shown byte.
  assert.equal(bashOutputDelta(capped(51211), capped(51212)), 'x')
  // When the fresh bytes cover the whole window, the entire window is appended.
  const freshWindow = truncated('y'.repeat(51200), { totalLines: 1, totalBytes: 112211, outputLines: 1 }, true).snapshot
  assert.equal(bashOutputDelta(capped(51211), freshWindow), 'y'.repeat(51200))
})

test('bashOutputDelta: a grown open line keeps its continuation before the new lines', () => {
  // The previous window ends mid-line ("partial"); that line is terminated
  // plus more lines arrive. The window's final copy of the line extends what
  // was shown, so the delta continues the line instead of starting a new one.
  // Native-verified raw stream: line1..line2000 complete plus the open
  // "partial" (2001 lines, 16900 bytes); appending " line\nline2001"
  // terminates it and opens line2002 (+14 bytes). The 2000-line window
  // slides to line3..line2000 plus the two new lines.
  const rawBefore = Array.from({ length: 2000 }, (_, i) => `line${i + 1}\n`).join('') + 'partial'
  const previous = truncated(windowText(2, 2000) + '\npartial', {
    totalLines: 2001,
    totalBytes: Buffer.byteLength(rawBefore),
    outputLines: 2000
  })
  const nextWindow = windowText(3, 2000) + '\npartial line\nline2001'
  const next = truncated(nextWindow, {
    totalLines: 2002,
    totalBytes: Buffer.byteLength(rawBefore) + Buffer.byteLength(' line\nline2001'),
    outputLines: 2000
  })
  assert.equal(bashOutputDelta(previous.snapshot, next.snapshot), ' line\nline2001')
})

test('bashOutputDelta: a blank logical tail line survives zero-text progress', () => {
  // Native trace: 'v\n' x2000 + 'open', then its terminator, then a blank
  // line, then 'next\n'. The blank line's own snapshot emits no visible
  // text, but the logical state must advance so the next update emits the
  // blank line's terminator instead of gluing 'next' onto 'open'.
  const w1 = 'v\n'.repeat(1999) + 'open'
  const w3 = 'v\n'.repeat(1998) + 'open\n'
  const w4 = 'v\n'.repeat(1997) + 'open\n\nnext'
  assert.deepEqual(
    deltaSequence([
      truncated(w1, { totalLines: 2001, totalBytes: 4004, outputLines: 2000 }).snapshot,
      truncated(w1, { totalLines: 2001, totalBytes: 4005, outputLines: 2000 }).snapshot,
      truncated(w3, { totalLines: 2002, totalBytes: 4006, outputLines: 2000 }).snapshot,
      truncated(w4, { totalLines: 2003, totalBytes: 4011, outputLines: 2000 }).snapshot
    ]),
    [w1, '\n', '', '\nnext']
  )
})

test('bashOutputDelta: a blank line between terminated lines keeps its separator', () => {
  // Native trace: 'x\n' x2001, then 'a\n\n', then 'b\n'. The blank line
  // is shown as the window's trailing separator, not as its own terminator;
  // the final delta must open with that separator so 'a' and 'b' stay two
  // blank-separated lines.
  const w1 = 'x\n'.repeat(1999) + 'x'
  const w2 = 'x\n'.repeat(1998) + 'a\n'
  const w3 = 'x\n'.repeat(1997) + 'a\n\nb'
  assert.deepEqual(
    deltaSequence([
      truncated(w1, { totalLines: 2001, totalBytes: 4002, outputLines: 2000 }).snapshot,
      truncated(w2, { totalLines: 2003, totalBytes: 4005, outputLines: 2000 }).snapshot,
      truncated(w3, { totalLines: 2004, totalBytes: 4007, outputLines: 2000 }).snapshot
    ]),
    [w1, '\na\n', '\nb']
  )
})

test('bashOutputDelta: a first truncated window ending in a newline is a blank tail line', () => {
  // Native trace: 'x\n' x2001 then a final blank line (4003 bytes), so the
  // first observed window ends with the separator before that blank line —
  // that trailing newline is not the blank line's emitted terminator. The
  // next line must arrive behind another separator, not glued onto it.
  const w1 = 'x\n'.repeat(1999)
  const w2 = 'x\n'.repeat(1998) + '\ny'
  assert.deepEqual(
    deltaSequence([
      truncated(w1, { totalLines: 2002, totalBytes: 4003, outputLines: 2000 }).snapshot,
      truncated(w2, { totalLines: 2003, totalBytes: 4004, outputLines: 2000 }).snapshot
    ]),
    [w1, '\ny']
  )
})

test('bashOutputDelta: a trimmed giant line keeps the verbatim tail terminator', () => {
  // Native pi 1.1.0 trace (50KiB/2000-line caps): 'x'x300000, then '\n',
  // then 'v\n', then 'w\n'x2000. The giant line is byte-truncated to its
  // last 51200 bytes and trimmed from the tail, the empty snapshot carries
  // no text, and the short tail 'v\n' is kept VERBATIM — trailing
  // terminator included, because truncateTail returns short tails unmodified
  // even though the cumulative totals mark the snapshot truncated. That
  // terminator is real: the joined 2000-w window that follows must not be
  // preceded by a second separator.
  const wWindow = 'w\n'.repeat(1999) + 'w'
  assert.deepEqual(
    deltaSequence([
      truncated('x'.repeat(51200), { totalLines: 1, totalBytes: 300000, outputLines: 1 }, true).snapshot,
      truncated('', { totalLines: 1, totalBytes: 300001, outputLines: 0 }).snapshot,
      truncated('v\n', { totalLines: 2, totalBytes: 300003, outputLines: 1 }).snapshot,
      truncated(wWindow, { totalLines: 2002, totalBytes: 304003, outputLines: 2000 }).snapshot
    ]),
    ['x'.repeat(51200), '', 'v\n', wWindow]
  )
})

test('bashOutputDelta: a verbatim window terminator is honored at the initial and unset seams', () => {
  // The same verbatim 'v\n' snapshot as the trimmed-giant trace, met as
  // the first observed snapshot or with no recorded state: the terminator
  // native truncation kept verbatim is real either way, so the joined
  // window that follows is not preceded by a second separator.
  const wWindow = 'w\n'.repeat(1999) + 'w'
  const joined = truncated(wWindow, { totalLines: 2002, totalBytes: 304003, outputLines: 2000 }).snapshot
  const verbatim = truncated('v\n', { totalLines: 2, totalBytes: 300003, outputLines: 1 })

  assert.equal(bashOutputDelta(undefined, verbatim.snapshot), 'v\n')
  assert.equal(verbatim.snapshot.endsAtLineBoundary, true)
  assert.equal(bashOutputDelta(verbatim.snapshot, joined), wWindow)

  const unset: BashOutputSnapshot = {
    text: 'v\n',
    window: 'v\n',
    coords: { totalLines: 2, totalBytes: 300003, outputLines: 1 }
  }
  assert.equal(bashOutputDelta(unset, joined), wWindow)
})

test('bashOutputDelta: byte-partial multibyte tails stay valid UTF-8', () => {
  // Native trace: 'π' (2 bytes) x25601 crosses the byte cap, then 'é\n'
  // arrives. Both windows are the line's last 51200 bytes — byte-shifted by
  // the 2-byte 'é' — and the 3 fresh bytes' offset lands inside the final
  // 'π'. The slice must advance to the character boundary instead of
  // decoding a replacement character; whether the terminator arrived is
  // unknowable from a byte-partial window, so it lands with the next
  // whole-line window's separator.
  const w1 = 'π'.repeat(25600)
  const w2 = 'π'.repeat(25599) + 'é'
  assert.deepEqual(
    deltaSequence([
      truncated(w1, { totalLines: 1, totalBytes: 51202, outputLines: 1 }, true).snapshot,
      truncated(w2, { totalLines: 1, totalBytes: 51205, outputLines: 1 }, true).snapshot,
      truncated('z', { totalLines: 2, totalBytes: 51206, outputLines: 1 }).snapshot
    ]),
    [w1, 'é', '\nz']
  )
})

test('bashOutputDelta: window line count mismatch falls back to text overlap', () => {
  // Foreign metadata whose outputLines disagrees with the window text must
  // not drive line arithmetic.
  const window = windowText(2, 2001)
  const lying = truncated(window, { totalLines: 2001, totalBytes: 14007, outputLines: 1999 })
  const previous = truncated(windowText(2, 2000), { totalLines: 2000, totalBytes: 14000, outputLines: 1999 })
  assert.equal(bashOutputDelta(previous.snapshot, lying.snapshot), '\nline2001')
})
