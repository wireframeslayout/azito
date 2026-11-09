const STDERR_LOG_LIMIT = 200;
const REDACTED = '[REDACTED]';

// ALLOWED_ENV_KEYS のうち、子プロセスへ転送する値そのものを秘密として扱うキー。
// これらの値は buildAllowedEnv() で組み立てた実際の値と完全一致すれば必ず伏せられる
// （パターンに合致しない形式でも漏れない）。PATH / HOME / LANG 等の非秘密は含めない。
const SECRET_ENV_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'] as const;

// codex は未信頼テキスト（エージェントのペイン出力、Issueタイトル等）を処理した直後の
// プロセスであり、その stderr には秘密情報が紛れ込み得る。ログへ出す前に必ずこの関数を
// 通し、既知の資格情報パターンを伏せる。切り詰めだけでは秘密情報の露出は防げないため、
// 「マスキング」と「長さ制限」は別工程として両方必須。
//
// なお stderr をログへ出すこと自体は意図的な判断（呼び出し側が失敗を catch {} で
// 握りつぶすため、出さないと失敗が完全に不可視になる）。転送した認証情報は完全一致で、
// 既知の形式はパターンで伏せるが、未知の形式の秘密が混じる可能性は残る。根本的な
// 解決には OS レベルの隔離が必要で、それは別途対応する。
function maskAllowedSecretValues(text: string): string {
  let result = text;
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (!value) {
      continue;
    }
    result = result.split(value).join(REDACTED);
  }
  return result;
}

const CREDENTIAL_REPLACERS: Array<(text: string) => string> = [
  // Authorization: Bearer <token>
  (text) => text.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`),
  // OpenAI/Codex 系 API キー（sk-...）
  (text) => text.replace(/\bsk-[A-Za-z0-9_-]+/g, REDACTED),
  // GitHub 系トークン（personal access token / oauth / server-to-server）
  (text) => text.replace(/\b(?:ghp|gho|ghs)_[A-Za-z0-9]+/g, REDACTED),
  // GitLab personal access token
  (text) => text.replace(/\bglpat-[A-Za-z0-9_-]+/g, REDACTED),
  // token=xxx / key=xxx / secret=xxx / password=xxx 形式のクエリ文字列・KV
  (text) => text.replace(/\b(token|key|secret|password)\s*=\s*[^\s&]+/gi, `$1=${REDACTED}`),
  // URL の userinfo 部（scheme://user:pass@host）
  (text) => text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`),
];

function maskCredentials(text: string): string {
  return CREDENTIAL_REPLACERS.reduce((acc, replace) => replace(acc), text);
}

// ログ行偽造（log forging）対策: 改行・タブ等の制御文字を除去して必ず1行に収める。
function collapseControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}

function sanitizeStderrForLog(stderr: string): string {
  const singleLine = collapseControlChars(stderr);
  const exactMasked = maskAllowedSecretValues(singleLine);
  const masked = maskCredentials(exactMasked);
  return masked.length > STDERR_LOG_LIMIT
    ? `${masked.slice(0, STDERR_LOG_LIMIT)}...(truncated)`
    : masked;
}

// 呼び出し側（PaneClassifier / LlmContentExtractor）は codex exec の失敗を
// すべて catch {} で握りつぶし null / 空配列 / 既定値にフォールバックするため、
// ここでログを出さない限り「codex バイナリが無い」「認証切れ」「古い codex が
// フラグを知らず拒否する」といった失敗が運用者から一切見えなくなる。
// プロンプト本文は出さず、stderr は sanitizeStderrForLog() で改行除去・資格情報
// マスキング・長さ制限を通してから出す。
export function logExecFailure(reason: string, code: number | null, stderr: string): void {
  const sanitizedStderr = sanitizeStderrForLog(stderr);
  console.warn(
    `[CodexExecClient] codex exec failed (${reason}, code=${code ?? 'null'}): ${sanitizedStderr}`,
  );
}
