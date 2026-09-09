import { StringDecoder } from 'node:string_decoder'

/** LF-only RPC framing; split UTF-8 code points are reassembled before decoding records. */
export class LfLineTooLongError extends Error {
  constructor(readonly maxBufferedBytes: number) {
    super(`pi RPC stdout record exceeded the ${maxBufferedBytes}-byte framing limit`)
    this.name = 'LfLineTooLongError'
  }
}

const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024

export class LfLineDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private parts: string[] = []
  private bytes = 0
  private lastCodeUnit = 0

  constructor(private readonly maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES) {}

  private append(text: string): void {
    if (!text) return
    this.bytes += Buffer.byteLength(text, 'utf8')
    // String inputs may split a surrogate pair, unlike StringDecoder output.
    if (
      this.lastCodeUnit >= 0xd800 &&
      this.lastCodeUnit <= 0xdbff &&
      text.charCodeAt(0) >= 0xdc00 &&
      text.charCodeAt(0) <= 0xdfff
    )
      this.bytes -= 2
    this.lastCodeUnit = text.charCodeAt(text.length - 1)
    if (this.bytes > this.maxBufferedBytes) {
      this.parts = []
      this.bytes = 0
      this.lastCodeUnit = 0
      throw new LfLineTooLongError(this.maxBufferedBytes)
    }
    this.parts.push(text)
  }

  private take(): string {
    const line = this.parts.join('')
    this.parts = []
    this.bytes = 0
    this.lastCodeUnit = 0
    return line
  }

  /** Scan only new text: neither newline search nor byte accounting revisits a pending record. */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const lines: string[] = []
    let start = 0
    let newline: number
    while ((newline = text.indexOf('\n', start)) !== -1) {
      this.append(text.slice(start, newline))
      lines.push(this.take())
      start = newline + 1
    }
    this.append(text.slice(start))
    return lines
  }

  end(): string | null {
    this.append(this.decoder.end())
    return this.take() || null
  }
}
