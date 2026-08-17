// ─── AZITO_TASK_TOKEN wire format ───
//
// `azt.task.<taskId>.<secret>` — secret is `crypto.randomBytes(32).hex`
// (64 lowercase hex chars, design v3 §2). The DB only ever stores
// sha256(secret); the plaintext token is returned once at issuance
// (SqliteTaskTokenRepository.issue) and never persisted.

// Bounded to 15 digits (Number.MAX_SAFE_INTEGER has 16 digits, so 15 digits
// is always representable exactly as a JS number) — an unbounded `\d+`
// would let a huge digit string through the regex, `Number(...)` it into an
// unsafe/overflowed value, and hand that to better-sqlite3, which throws
// (500) rather than the clean 401 an unrecognized token should produce
// (Issue #28 third-party review finding 4).
const TASK_TOKEN_PATTERN = /^azt\.task\.(\d{1,15})\.([0-9a-f]{64})$/;

export interface ParsedTaskToken {
  taskId: number;
  secret: string;
}

/**
 * Parses a `Bearer azt.task.<taskId>.<secret>` Authorization header. Returns
 * null for any other shape (including a UI token) — including a
 * syntactically-matching but semantically invalid taskId (non-safe-integer,
 * zero, or negative), so a malformed token always fails closed as 401
 * rather than reaching the DB layer with a value it can't bind.
 */
export function parseTaskTokenHeader(authHeader: string | undefined): ParsedTaskToken | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  const match = TASK_TOKEN_PATTERN.exec(parts[1]);
  if (!match) return null;
  const taskId = Number(match[1]);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return null;
  return { taskId, secret: match[2] };
}

export function formatTaskToken(taskId: number, secret: string): string {
  return `azt.task.${taskId}.${secret}`;
}
