export class QuotaGateError extends Error {
  constructor(code, message = code, options = {}) {
    super(message);
    this.name = 'QuotaGateError';
    this.code = code;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/g, 'Bearer [REDACTED]')
    .replace(/(accessToken|refreshToken|access_token|refresh_token|token)(["'=:\s]+)([^"'\s,}]+)/gi, '$1$2[REDACTED]');
}
