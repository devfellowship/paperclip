/**
 * Credential scrubber for blocker notification messages.
 * Applies the same patterns as feedback-redaction to strip secrets
 * before posting to Telegram.
 */

const CREDENTIAL_PATTERNS: { regex: RegExp; replacement: string | ((match: string, ...args: string[]) => string) }[] = [
  {
    regex: /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g,
    replacement: "[REDACTED_PEM_BLOCK]",
  },
  {
    regex: /\b(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)\s*[:=]\s*([^\s,;]+)/gi,
    replacement: (_match: string, key: string) => `${key}=[REDACTED]`,
  },
  {
    regex: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|kafka|nats|mssql):\/\/[^\s<>'")]+/gi,
    replacement: "[REDACTED_CONNECTION_STRING]",
  },
];

export function scrubCredentials(text: string): string {
  let output = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    output = output.replace(pattern.regex, pattern.replacement as never);
    pattern.regex.lastIndex = 0;
  }
  return output;
}
