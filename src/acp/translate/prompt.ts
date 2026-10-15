import { RequestError, type ContentBlock } from '@agentclientprotocol/sdk'

export type PiImage = {
  type: 'image'
  mimeType: string
  data: string
}

function validatedImage(mimeType: unknown, data: unknown, label: string): PiImage {
  if (typeof mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    throw RequestError.invalidParams({}, `${label} must use a valid image/* MIME type`)
  }
  if (typeof data !== 'string' || !isValidBase64(data)) {
    throw RequestError.invalidParams({}, `${label} contains malformed base64 data`)
  }
  return { type: 'image', mimeType, data }
}

/** Same rules as /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/
 * (length a multiple of 4, alphabet before optional '=' / '==' padding), but a
 * linear scan: the regex backtracks per 4-char group and overflows the stack
 * on multi-megabyte images. */
function isValidBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false
  let end = data.length
  if (data.endsWith('==')) end -= 2
  else if (data.endsWith('=')) end -= 1
  for (let index = 0; index < end; index++) {
    const code = data.charCodeAt(index)
    const inAlphabet =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    if (!inAlphabet) return false
  }
  return true
}

/** Validate the complete prompt before returning anything that can be sent to pi. */
export function promptToPiMessage(blocks: ContentBlock[]): {
  message: string
  images: PiImage[]
} {
  const text: string[] = []
  const images: PiImage[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text.push(block.text)
        break
      case 'resource_link':
        text.push(`\n[Context] ${block.uri}\n`)
        break
      case 'image':
        images.push(validatedImage(block.mimeType, block.data, 'Image block'))
        break
      case 'resource': {
        const resource = block.resource
        if ('text' in resource) {
          const mime = resource.mimeType ?? 'text/plain'
          text.push(`\n[Embedded Context] ${resource.uri} (${mime})\n${resource.text}\n`)
          break
        }
        const mime = resource.mimeType ?? 'application/octet-stream'
        if (!mime.toLowerCase().startsWith('image/')) {
          throw RequestError.invalidParams({}, `Unsupported embedded binary MIME type: ${mime}`)
        }
        images.push(validatedImage(mime, resource.blob, `Embedded resource ${resource.uri}`))
        break
      }
      case 'audio':
        throw RequestError.invalidParams({}, `Audio prompt content is unsupported: ${block.mimeType}`)
      default:
        throw RequestError.invalidParams({}, `Unsupported prompt content block: ${(block as { type?: unknown }).type}`)
    }
  }

  return { message: text.join(''), images }
}
