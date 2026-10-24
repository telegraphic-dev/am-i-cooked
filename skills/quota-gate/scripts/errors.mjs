export class QuotaGateError extends Error {
  constructor(code, message = code, options = {}) {
    super(message);
    this.name = 'QuotaGateError';
    this.code = code;
    this.status = options.status;
    this.cause = options.cause;
    this.hint = options.hint;
  }
}

export function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/g, 'Bearer [REDACTED]')
    .replace(/WorkosCursorSessionToken=[^;\s]+/gi, 'WorkosCursorSessionToken=[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, '[REDACTED]')
    .replace(/(accessToken|refreshToken|access_token|refresh_token|token)(["'=:\s]+)([^"'\s,}]+)/gi, '$1$2[REDACTED]');
}
