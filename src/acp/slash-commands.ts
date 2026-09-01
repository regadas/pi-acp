/** Parse adapter built-in arguments with simple single/double quote support. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const char of argsString) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") quote = char
    else if (/\s/.test(char)) {
      if (current) args.push(current)
      current = ''
    } else current += char
  }
  if (current) args.push(current)
  return args
}
