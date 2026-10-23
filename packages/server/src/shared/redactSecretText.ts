const REDACTED = '[REDACTED]';

/** `NAME=value` / `NAME: value` / `$env:NAME = 'value'` where NAME contains TOKEN, SECRET, PASSWORD, PASSWD or KEY. */
const SECRET_ASSIGNMENT = /([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY)[A-Za-z0-9_.-]*['"]?\s*[=:]\s*)(?:'[^']*'|"[^"]*"|\S+)/gi;
const BEARER = /(Bearer\s+)\S+/gi;
/** Well-known token shapes (GitHub, Slack, AWS, OpenAI/Anthropic style) and any 32+ character hex / base64url run. */
const TOKEN_LIKE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9_-]{40,}\b/g;

/**
 * Hides what looks like a secret in text that is shown to a person or logged (e.g. the start of a remote shell's stderr, where a
 * login script may have echoed a token assignment). It is a minimal guard, not a parser: an assignment to a name with
 * TOKEN / SECRET / PASSWORD / KEY in it, a Bearer value, and token-shaped strings are replaced by `[REDACTED]`.
 */
export function redactSecretText(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT, (_m, head: string) => `${head}${REDACTED}`)
    .replace(BEARER, (_m, head: string) => `${head}${REDACTED}`)
    .replace(TOKEN_LIKE, REDACTED);
}
