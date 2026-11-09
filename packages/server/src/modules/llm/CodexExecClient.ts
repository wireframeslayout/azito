import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ILlmClient } from './ILlmClient';
import { buildAllowedEnv } from './execEnv';
import { logExecFailure } from './execLog';

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
