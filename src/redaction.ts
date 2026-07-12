/**
 * Redaction primitives for operator error/log surfaces.
 * Ports sanitize patterns from wazuh-mcp `safe-error.ts` as pure functions.
 */

/** Injectable redact hook compatible with HttpContext.redact. */
export type RedactFn = (value: string) => string;

const SECRET_PATTERNS = [
  /(authorization:\s*)(basic|bearer)\s+[a-z0-9._~+/=-]+/gi,
  /\b(basic|bearer)\s+[a-z0-9._~+/=-]+/gi,
  /(authorization:\s*)(?:token|digest|hawk|oauth|apikey)\s+\S+/gi,
  /(x-n8n-api-key|x-auth-token|x-emby-token|x-api-key)\s*:\s*\S+/gi,
  /(https?:\/\/)([^@\s/]+)@/gi,
  /([?&](?:access_token|refresh_token|client_secret|id_token|x-api-key|\w+_(?:token|secret)|password|token|secret|api[_-]?key|key)=)[^&\s]+/gi,
  /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
] as const;

const MAX_LENGTH = 500;

/**
 * Redact secrets from a string: explicit secret list, bearer/basic auth,
 * Authorization and consumer API headers, URL userinfo (including token-only
 * username forms), sensitive query params, JWT-shaped tokens, then 500-char cap.
 */
export const redactString = (message: string, secrets: string[] = []): string => {
  let sanitized = message;

  for (const secret of secrets) {
    if (secret) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }

  sanitized = sanitized
    .replace(SECRET_PATTERNS[0], "$1$2 [REDACTED]")
    .replace(SECRET_PATTERNS[1], "$1 [REDACTED]")
    .replace(SECRET_PATTERNS[2], "$1[REDACTED]")
    .replace(SECRET_PATTERNS[3], "$1: [REDACTED]")
    .replace(SECRET_PATTERNS[4], "$1[REDACTED]@")
    .replace(SECRET_PATTERNS[5], "$1[REDACTED]")
    .replace(SECRET_PATTERNS[6], "[REDACTED]");

  return sanitized.length > MAX_LENGTH
    ? `${sanitized.slice(0, MAX_LENGTH)}...`
    : sanitized;
};

/** Default redact hook: same as `redactString` with no extra secrets. */
export const defaultRedact: RedactFn = (value) => redactString(value);
