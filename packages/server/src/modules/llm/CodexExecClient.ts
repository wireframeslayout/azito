import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ILlmClient } from './ILlmClient';

export class CodexExecClient implements ILlmClient {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 120000) {
    this.timeoutMs = timeoutMs;
  }

  async exec(prompt: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const outFile = path.join(
        os.tmpdir(),
        `codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );

      // Use stdin for prompt to avoid E2BIG when prompt is large
      const promptFile = outFile + '.prompt';
      fs.writeFileSync(promptFile, prompt);

      const proc = spawn('codex', ['exec', '-o', outFile, '--ephemeral', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.timeoutMs,
        env: { ...process.env },
      });

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
        try {
          fs.unlinkSync(outFile);
        } catch {
          // cleanup best-effort
        }
        if (code !== 0 && !output) {
          return reject(new Error(`codex exec failed (code ${code}): ${stderr}`));
        }
        resolve(output);
      });

      proc.on('error', (err: Error) => reject(err));
    });
  }
}
