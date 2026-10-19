const DTP_UNSAFE_PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g

/**
 * DTP treats "$" in unresolved placeholders specially. Phase 6 keeps
 * ${...} internally for keyword matching, but executable artifacts should
 * expose the same placeholder without "$".
 */
export function sanitizeDtpExecutablePlaceholders(text: string): string {
  return text.replace(DTP_UNSAFE_PLACEHOLDER_PATTERN, "{$1}")
}

export function sanitizeDtpExecutableValue<T>(value: T): T | string {
  if (typeof value !== "string") return value
  return sanitizeDtpExecutablePlaceholders(value)
}
