import { StringDecoder } from 'node:string_decoder'

/**
 * Incremental LF-only line splitter for pi's RPC stdout.
 *
 * Node's readline module must not be used here: it also treats U+2028/U+2029
 * as line breaks, and those characters are valid inside JSON strings, so
 * readline can split one valid NDJSON record into invalid fragments. Pi's RPC
 * framing requires splitting on `\n` only. UTF-8 code points split across
 * chunk boundaries are reassembled via StringDecoder.
 */
export class LfLineTooLongError extends Error {
  constructor(readonly maxBufferedBytes: number) {
    super(`pi RPC stdout record exceeded the ${maxBufferedBytes}-byte framing limit`)
    this.name = 'LfLineTooLongError'
  }
}

const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024

export class LfLineDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  constructor(private readonly maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES) {}

  /** Consume a chunk and return every complete LF-terminated line (without the LF). */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)

    const lines: string[] = []
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      if (Buffer.byteLength(line, 'utf8') > this.maxBufferedBytes) {
        this.buffer = ''
        throw new LfLineTooLongError(this.maxBufferedBytes)
      }
      lines.push(line)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      newlineIndex = this.buffer.indexOf('\n')
    }

    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBufferedBytes) {
      this.buffer = ''
      throw new LfLineTooLongError(this.maxBufferedBytes)
    }
    return lines
  }

  /** Flush the trailing unterminated line at end of stream, if any. */
  end(): string | null {
    const rest = this.buffer + this.decoder.end()
    this.buffer = ''
    if (Buffer.byteLength(rest, 'utf8') > this.maxBufferedBytes) {
      throw new LfLineTooLongError(this.maxBufferedBytes)
    }
    return rest || null
  }
}
