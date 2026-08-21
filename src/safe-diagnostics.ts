const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/(\b(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|connection[_-]?string)\b\s*[:=]\s*)(["'`])[^"'`\r\n]*\2/gi, '$1$2[REDACTED]$2'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[REDACTED]'],
  [/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----/g, '[REDACTED PEM HEADER]'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1[REDACTED]:[REDACTED]@'],
]

const HOST_PATH = /(?:^|[\s"'`(=,:])(?:\/(?:Users|home|private|tmp|var|opt|workspace|runner|github\/workspace)\/[^\s"'`),;]*)/g
const WINDOWS_HOST_PATH = /\b[A-Za-z]:\\[^\s"'`),;]*/g
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export const MAX_SAFE_DIAGNOSTIC_CHARACTERS = 4_096
export const MAX_SAFE_STDERR_CHARACTERS = 2_048

export interface SafeText {
  text: string
  redactions: number
  truncated: boolean
}

export function sanitizeText(value: string, maximum = MAX_SAFE_DIAGNOSTIC_CHARACTERS): SafeText {
  let text = value
  let redactions = 0
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const matches = text.match(pattern)
    if (!matches) continue
    redactions += matches.length
    text = text.replace(pattern, replacement)
  }
  text = text.replace(HOST_PATH, (match) => {
    redactions += 1
    const prefix = /^[\s"'`(=,:]/.test(match) ? match[0] : ''
    return `${prefix}[REDACTED_PATH]`
  })
  text = text.replace(WINDOWS_HOST_PATH, () => {
    redactions += 1
    return '[REDACTED_PATH]'
  })
  text = text.replace(CONTROL_CHARACTERS, () => {
    redactions += 1
    return '�'
  })
  const truncated = text.length > maximum
  return {
    text: truncated ? `${text.slice(0, Math.max(0, maximum - 1))}…` : text,
    redactions,
    truncated,
  }
}

export function safeReason(error: unknown, fallback: string): string {
  const reason = error instanceof Error ? error.message : fallback
  return sanitizeText(reason, 240).text || fallback
}

export function isSensitiveCandidatePath(path: string): boolean {
  const normalized = path.toLowerCase()
  const segments = normalized.split('/')
  const basename = segments.at(-1) ?? ''
  return basename === '.env'
    || basename.startsWith('.env.')
    || /(?:^|[._-])(?:secret|credential|private[-_]?key)(?:[._-]|$)/.test(basename)
    || /\.(?:pem|key|p12|pfx)$/i.test(basename)
    || segments.includes('.git')
}
