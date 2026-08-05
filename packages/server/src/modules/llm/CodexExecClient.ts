import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ILlmClient } from './ILlmClient';

// codex exec には未信頼テキスト（エージェントのペイン出力、Issueタイトル等）がそのまま渡る。
// ハブの全環境変数を継承すると AZITO_UI_TOKEN 等の秘密情報が子プロセスへ漏れるため、
// codex の動作に必要な最小限のキーだけを明示的に許可する。
const ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'] as const;

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

      // Use stdin for prompt to avoid E2BIG when prompt is large
      const promptFile = outFile + '.prompt';
      fs.writeFileSync(promptFile, prompt);

      const cleanupWorkDir = () => {
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch {
          // cleanup best-effort
        }
      };

      const proc = spawn(
        'codex',
        ['exec', '--sandbox', 'read-only', '--ignore-user-config', '-o', outFile, '--ephemeral', '-'],
        {
          cwd: workDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: this.timeoutMs,
          env: buildAllowedEnv(),
        },
      );

      // Feed prompt via stdin and close
      const promptStream = fs.createReadStream(promptFile);
      promptStream.pipe(proc.stdin);
      promptStream.on('end', () => {
        try { fs.unlinkSync(promptFile); } catch {}
      });

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on('close', (code: number | null) => {
        let output = '';
        try {
          output = fs.readFileSync(outFile, 'utf8');
        } catch {
          // output file may not exist
        }
        cleanupWorkDir();
        if (code !== 0 && !output) {
          return reject(new Error(`codex exec failed (code ${code}): ${stderr}`));
        }
        resolve(output);
      });

      proc.on('error', (err: Error) => {
        cleanupWorkDir();
        reject(err);
      });
    });
  }
}
