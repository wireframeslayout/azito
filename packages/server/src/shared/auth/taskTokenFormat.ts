// ─── AZITO_TASK_TOKEN wire format ───
//
// `azt.task.<taskId>.<secret>` — secret is `crypto.randomBytes(32).hex`
// (64 lowercase hex chars, design v3 §2). The DB only ever stores
// sha256(secret); the plaintext token is returned once at issuance
// (SqliteTaskTokenRepository.issue) and never persisted.

const TASK_TOKEN_PATTERN = /^azt\.task\.(\d+)\.([0-9a-f]{64})$/;

export interface ParsedTaskToken {
  taskId: number;
  secret: string;
}

/** Parses a `Bearer azt.task.<taskId>.<secret>` Authorization header. Returns null for any other shape (including a UI token). */
export function parseTaskTokenHeader(authHeader: string | undefined): ParsedTaskToken | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  const match = TASK_TOKEN_PATTERN.exec(parts[1]);
  if (!match) return null;
  return { taskId: Number(match[1]), secret: match[2] };
}

export function formatTaskToken(taskId: number, secret: string): string {
  return `azt.task.${taskId}.${secret}`;
}
