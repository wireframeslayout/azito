import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ILlmClient } from './ILlmClient';

// codex exec には未信頼テキスト（エージェントのペイン出力、Issueタイトル等）がそのまま渡る。
// ハブの全環境変数を継承すると AZITO_UI_TOKEN 等の秘密情報が子プロセスへ漏れるため、
// codex の動作に必要な最小限のキーだけを明示的に許可する（AZITO_* は1つも通さない不変条件）。
//
// この対策で塞げるのは「環境変数経由の秘密漏洩」まで。--sandbox read-only は書き込みを
// 禁じるだけで読み取りは許すため、プロンプトインジェクションで絶対パスを指定されれば
// data.db や ~/.azito/azitoctl.env 等を読み取ることは依然として可能（実測で確認済み）。
// 認証のため HOME / CODEX_HOME を渡さざるを得ず、この env allowlist と cwd 分離では
// 読み取りの遮断は達成できない。読み取り遮断には OS レベルの隔離（専用ユーザー/コンテナ）
// が別途必要（未対応）。
const ALLOWED_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  // codex --help: --ignore-user-config を付けても auth 情報は CODEX_HOME を見に行く。
  // 落とすと CODEX_HOME を使う構成で認証が失敗する。
  'CODEX_HOME',
  // 環境変数ベースの認証で使われる（非対話実行時の CODEX_API_KEY、
  // 標準的な OPENAI_API_KEY、`codex login --with-api-key` 系の CODEX_ACCESS_TOKEN）
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  // 独自 TLS ルートを使う環境向け
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CODEX_CA_CERTIFICATE',
  // プロキシ経由でしか外部到達できない環境向け（大文字/小文字の両方を尊重する慣習に合わせる）
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

function buildAllowedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

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
function logExecFailure(reason: string, code: number | null, stderr: string): void {
  const sanitizedStderr = sanitizeStderrForLog(stderr);
  console.warn(
    `[CodexExecClient] codex exec failed (${reason}, code=${code ?? 'null'}): ${sanitizedStderr}`,
  );
}

export class CodexExecClient implements ILlmClient {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 120000) {
    this.timeoutMs = timeoutMs;
  }

  async exec(prompt: string): Promise<string> {
    // ハブの作業ディレクトリには data.db / .env が置かれているため、
    // codex exec は空の一時ディレクトリを cwd にして実行する（実行後に削除）。
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exec-'));

    return new Promise<string>((resolve, reject) => {
      const outFile = path.join(workDir, 'out.txt');

      const cleanupWorkDir = () => {
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch {
          // cleanup best-effort
        }
      };

      const proc = spawn(
        'codex',
        [
          'exec',
          '--sandbox',
          'read-only',
          // 未信頼テキストを扱う実行に config.toml のユーザー設定（MCPサーバー・フック・
          // サンドボックス上書き）を効かせないための意図的な指定。維持する（外さない）。
          // 代償として config.toml のカスタムプロバイダ設定等はこの実行に適用されず、
          // 該当構成では認証・実行が失敗しうるが、その失敗は logExecFailure() の警告ログで
          // 可視化される（呼び出し側が握りつぶして完全に不可視、ではない）。
          '--ignore-user-config',
          // workDir は意図的に git リポジトリ外の空一時ディレクトリ。codex-cli 0.146.0 では
          // このフラグなしでも非 git ディレクトリで問題なく動作することを確認済み（不具合修正ではない）。
          // 意図を明示し、非 git ディレクトリでの実行を拒否する構成や将来バージョンに対する保険として付与する。
          '--skip-git-repo-check',
          '-o',
          outFile,
          '--ephemeral',
          '-',
        ],
        {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: this.timeoutMs,
          env: buildAllowedEnv(),
        },
      );

      // Feed prompt via stdin and close. prompt is already in memory and goes over
      // stdin (not argv), so writing it directly avoids E2BIG without needing a temp
      // file — sidestepping the async-open ENOENT-on-spawn-failure hazard a
      // createReadStream(...).pipe(proc.stdin) would have.
      // On spawn failure the stdin stream can itself emit 'error' independently of
      // proc.on('error'); an unhandled listener there would crash the hub, so no-op it
      // (proc.on('error') below still performs the actual cleanup/reject).
      proc.stdin.on('error', () => {});
      proc.stdin.end(prompt);

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      // Node emits 'error' and then still emits 'close' for an actual spawn failure
      // (e.g. ENOENT). Guard so cleanup/log/reject each run exactly once instead of
      // once per event.
      let settled = false;

      proc.on('close', (code: number | null) => {
        if (settled) {
          return;
        }
        settled = true;

        let output = '';
        try {
          output = fs.readFileSync(outFile, 'utf8');
        } catch {
          // output file may not exist
        }
        cleanupWorkDir();
        if (code !== 0 && !output) {
          logExecFailure('non-zero exit with empty output', code, stderr);
          return reject(new Error(`codex exec failed (code ${code}): ${stderr}`));
        }
        resolve(output);
      });

      proc.on('error', (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;

        cleanupWorkDir();
        logExecFailure('spawn error', null, err.message);
        reject(err);
      });
    });
  }
}
