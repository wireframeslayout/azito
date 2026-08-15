import * as fs from 'fs';
import * as path from 'path';
import { Client as Ssh2Client } from 'ssh2';
import type { SshClient } from '../ssh/SshClient';

export type HarnessInstallStep = 'transfer' | 'setup';

export interface HarnessInstallProgress {
  step: HarnessInstallStep;
  status: 'running' | 'ok' | 'error';
  message: string;
}

export interface HarnessInstallResult {
  success: boolean;
  steps: HarnessInstallProgress[];
  error?: string;
}

import { resolveRoot } from '../../../shared/releaseInfo';

const HARNESS_DIR = path.join(resolveRoot(), 'harness');

export interface HarnessInstallOptions {
  azitoUrl?: string;
  webhookToken?: string;
  uiToken?: string;
  serverName?: string;
  prefix?: string;
  /**
   * Issue #29 design v2, 層3「遮断」: when the target server has declared
   * isolation_intent (isolation_intent=1), `--ui-token` is withheld from
   * setup.sh so the fixed UI token is never distributed to a server meant to
   * hold no credentials (setup.sh itself already tolerates a missing
   * `--ui-token` — Issue #28). `--webhook-token` is deliberately still
   * passed: it authenticates the runtime signal (hook/activity) channel, not
   * a task credential, so it's correct to distribute at this level
   * regardless of isolation.
   */
  isolationIntent?: boolean;
}

const VALID_PREFIX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function validatePrefix(prefix: string): void {
  if (!VALID_PREFIX.test(prefix)) {
    throw new Error(`Invalid harness prefix: "${prefix}" (allowed: a-z, 0-9, hyphen)`);
  }
}

function remoteHarnessDir(prefix?: string): string {
  return `~/.azito/harness${prefix ? `-${prefix}` : ''}`;
}

/** Single-quote a value for safe interpolation into a remote shell command string. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class HarnessInstaller {
  constructor(private sshClient: SshClient) {}

  async install(
    sshHost: string,
    options: HarnessInstallOptions = {},
    onProgress?: (p: HarnessInstallProgress) => void,
  ): Promise<HarnessInstallResult> {
    const steps: HarnessInstallProgress[] = [];
    const report = (step: HarnessInstallStep, status: HarnessInstallProgress['status'], message: string) => {
      const p: HarnessInstallProgress = { step, status, message };
      steps.push(p);
      onProgress?.(p);
    };

    if (options.prefix) validatePrefix(options.prefix);
    const harnessDir = remoteHarnessDir(options.prefix);

    // ── Transfer harness directory ──
    report('transfer', 'running', 'Transferring harness to remote...');
    try {
      await this.transferHarness(sshHost, options.prefix);
      report('transfer', 'ok', `Harness transferred to ${harnessDir}`);
    } catch (err) {
      const msg = (err as Error).message;
      report('transfer', 'error', msg);
      return { success: false, steps, error: msg };
    }

    // ── Run setup.sh on remote ──
    report('setup', 'running', 'Running harness setup on remote...');
    try {
      await this.runSetup(sshHost, options);
      report('setup', 'ok', 'Harness setup complete');
    } catch (err) {
      const msg = (err as Error).message;
      report('setup', 'error', msg);
      return { success: false, steps, error: msg };
    }

    return { success: true, steps };
  }

  async installLocal(options: HarnessInstallOptions = {}): Promise<HarnessInstallResult> {
    const steps: HarnessInstallProgress[] = [];
    const report = (step: HarnessInstallStep, status: HarnessInstallProgress['status'], message: string) => {
      const p: HarnessInstallProgress = { step, status, message };
      steps.push(p);
    };

    if (options.prefix) validatePrefix(options.prefix);

    report('transfer', 'ok', 'Local install — harness already at ' + HARNESS_DIR);

    report('setup', 'running', 'Running harness setup locally...');
    try {
      await this.runSetupLocal(options);
      report('setup', 'ok', 'Harness setup complete');
    } catch (err) {
      const msg = (err as Error).message;
      report('setup', 'error', msg);
      return { success: false, steps, error: msg };
    }

    return { success: true, steps };
  }

  private async transferHarness(sshHost: string, prefix?: string): Promise<void> {
    if (!fs.existsSync(HARNESS_DIR)) {
      throw new Error(`Harness directory not found: ${HARNESS_DIR}`);
    }

    // Create tarball in a temp file
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const os = await import('os');

    const tmpTar = path.join(os.tmpdir(), `azito-harness-${Date.now()}.tar.gz`);
    try {
      await execFileAsync('tar', [
        'czf', tmpTar,
        '--exclude=node_modules',
        '--exclude=.git',
        '-C', path.dirname(HARNESS_DIR),
        path.basename(HARNESS_DIR),
      ]);

      const remoteTmp = `/tmp/azito-harness-${Date.now()}.tar.gz`;
      await this.sftpUpload(sshHost, tmpTar, remoteTmp);

      const harnessDir = remoteHarnessDir(prefix);
      const deployCmd = [
        `mkdir -p ${harnessDir}`,
        `&& tar xzf ${remoteTmp} -C ${harnessDir} --strip-components=1`,
        `&& rm -f ${remoteTmp}`,
        `&& chmod +x ${harnessDir}/setup.sh`,
      ].join(' ');

      const result = await this.sshClient.execIsolated(sshHost, deployCmd);
      if (result.code !== 0) {
        throw new Error(`Deploy failed: ${result.stderr}`);
      }
    } finally {
      try { fs.unlinkSync(tmpTar); } catch { /* ignore */ }
    }
  }

  private async runSetup(sshHost: string, options: HarnessInstallOptions): Promise<void> {
    const { azitoUrl, webhookToken, uiToken, serverName, prefix, isolationIntent } = options;
    const harnessDir = remoteHarnessDir(prefix);
    let cmd = `bash ${harnessDir}/setup.sh`;
    if (azitoUrl) cmd += ` --azito-url ${shellQuote(azitoUrl)}`;
    if (webhookToken) cmd += ` --webhook-token ${shellQuote(webhookToken)}`;
    // Withhold --ui-token for an isolation-intent server (see this option's
    // doc comment on HarnessInstallOptions.isolationIntent) — the one place
    // this class distributes it.
    if (uiToken && !isolationIntent) cmd += ` --ui-token ${shellQuote(uiToken)}`;
    if (serverName) cmd += ` --server-name ${shellQuote(serverName)}`;
    if (prefix) cmd += ` --prefix ${shellQuote(prefix)}`;
    // Issue #29 review, Critical finding 3: withholding --ui-token above
    // only stops a NEW token from being distributed — it does not remove an
    // ALREADY-distributed one from a previous (pre-isolation) setup.sh run.
    // setup.sh's own default (--ui-token omitted -> keep whatever operator.env
    // / Claude settings.json / Codex MCP config already has) exists so that
    // an ordinary re-run without --ui-token doesn't erase a working
    // configuration — but that same default is exactly wrong for a server
    // that has just been declared isolated, so --purge-operator-token
    // overrides it here.
    if (isolationIntent) cmd += ' --purge-operator-token';

    const result = await this.sshClient.execIsolated(sshHost, cmd);
    if (result.code !== 0) {
      throw new Error(`setup.sh failed (exit ${result.code}): ${result.stderr}`);
    }
  }

  private async runSetupLocal(options: HarnessInstallOptions): Promise<void> {
    const setupScript = path.join(HARNESS_DIR, 'setup.sh');
    if (!fs.existsSync(setupScript)) {
      throw new Error(`setup.sh not found: ${setupScript}`);
    }

    const { azitoUrl, webhookToken, uiToken, serverName, prefix } = options;
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const args: string[] = [setupScript];
    if (azitoUrl) args.push('--azito-url', azitoUrl);
    if (webhookToken) args.push('--webhook-token', webhookToken);
    if (uiToken) args.push('--ui-token', uiToken);
    if (serverName) args.push('--server-name', serverName);
    if (prefix) args.push('--prefix', prefix);

    // Local install: execFile takes an argv array, so no shell-quoting is
    // needed (each arg is passed to the child process verbatim); the CLI
    // flags above are setup.sh's sole source of truth here.
    const { stderr } = await execFileAsync('bash', args, {
      env: process.env,
    }).catch((err: { message: string; stderr?: string }) => {
      throw new Error(`setup.sh failed: ${err.stderr || err.message}`);
    });

    if (stderr) {
      // setup.sh may write warnings to stderr; not fatal
    }
  }

  private sftpUpload(sshHost: string, localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const resolved = this.sshClient.resolveHost(sshHost);
      const conn = new Ssh2Client();
      const connectOpts = this.sshClient.buildConnectOpts(resolved);

      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SFTP transfer timed out'));
      }, 120000);

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { clearTimeout(timeout); conn.end(); return reject(err); }
          const readStream = fs.createReadStream(localPath);
          const writeStream = sftp.createWriteStream(remotePath);
          writeStream.on('close', () => {
            clearTimeout(timeout);
            conn.end();
            resolve();
          });
          writeStream.on('error', (e: Error) => {
            clearTimeout(timeout);
            conn.end();
            reject(new Error(`SFTP write failed: ${e.message}`));
          });
          readStream.pipe(writeStream);
        });
      });

      conn.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
      conn.connect(connectOpts);
    });
  }
}
