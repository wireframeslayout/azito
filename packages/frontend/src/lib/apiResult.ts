/**
 * `api()` resolves with the response body whatever the HTTP status, so a failed mutation arrives as `{ error, message? }`.
 * Returns the text to show for such a body, or null when the body is not an error.
 */
export function errorMessageOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof error !== 'string') return null;
  return typeof message === 'string' && message ? message : error;
}
