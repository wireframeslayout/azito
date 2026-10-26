import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { Client as Ssh2Client } from 'ssh2';
import type { SshClient } from '../ssh/SshClient';
import { assertPosixHost, type HostProfile } from '../../../shared/os/hostProfile';
import type { IServerTransport } from '../transport/ServerTransport';
import { harnessLocation, homeDirOf } from './harnessLocation';
import { buildNodeSetupInvocation, sendHarnessDirectory } from './harnessNodeSetup';
import { pathApiFor } from '../../../shared/os/hostPath';
import { shellQuote } from '../../../shared/shellQuote';
import { collectTreeEntries, modeByShebang, packTarGz } from '../../../shared/fs/tarGz';

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

interface HarnessSetupBase {
  /**
   * The target server's OS (`TransportFactory.hostProfileFor`; null = a Unix agent registered before the OS was recorded). A Unix
   * host is set up with `setup.sh` (over SSH, or locally); a win32 one with `setup.mjs` (`installOnAgent` / `installLocal`), and the
   * SSH route refuses it with `unsupported_os` before anything is sent.
   */
  hostProfile: HostProfile | null;
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
  /** Written to the remote VERSION file after a successful install for staleness detection. */
  version?: string;
}

/** An install: `azitoUrl` is required, since without it setup.sh / setup.mjs skip writing azitoctl's env without saying so (#498). */
export interface HarnessInstallOptions extends HarnessSetupBase {
  /** The hub URL the server's azitoctl / hooks reach it by. */
  azitoUrl: string;
}

/**
 * Removing the operator token from a server just declared isolated (`attemptIsolationCleanup`). It carries no hub URL and
 * passes no `--azito-url`: it must not rewrite the azitoctl env an earlier install wrote, nor create one where there was none.
 */
export interface HarnessOperatorTokenPurgeOptions extends HarnessSetupBase {
  isolationIntent: true;
  azitoUrl?: undefined;
}

const SETUP_TIMEOUT_MS = 120_000;
const SETUP_MAX_OUTPUT_BYTES = 1024 * 1024;
const VALID_PREFIX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function validatePrefix(prefix: string): void {
  if (!VALID_PREFIX.test(prefix)) {
    throw new Error(`Invalid harness prefix: "${prefix}" (allowed: a-z, 0-9, hyphen)`);
  }
}

/** `~/.azito/harness[-<prefix>]` on a POSIX host: the same `harnessLocation` the worker's prompt path (`resolveAzitoctlPath`) is built from. */
export function remoteHarnessDir(prefix?: string): string {
  return harnessLocation('linux', '~', prefix).harnessDir;
}

export class HarnessInstaller {
  constructor(private sshClient: SshClient) {}

  async install(
    sshHost: string,
    options: HarnessInstallOptions | HarnessOperatorTokenPurgeOptions,
    onProgress?: (p: HarnessInstallProgress) => void,
  ): Promise<HarnessInstallResult> {
    const steps: HarnessInstallProgress[] = [];
    const report = (step: HarnessInstallStep, status: HarnessInstallProgress['status'], message: string) => {
      const p: HarnessInstallProgress = { step, status, message };
      steps.push(p);
      onProgress?.(p);
    };

    assertPosixHost(options.hostProfile, 'this server', 'installing the harness (setup.sh)');
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

    if (options.version) {
      try {
        await this.sshClient.execIsolated(sshHost, `echo ${shellQuote(options.version)} > ${harnessDir}/VERSION`);
      } catch {
        // VERSION write failure is non-fatal; the next auto-update cycle will retry.
      }
    }

    return { success: true, steps };
  }

  async installLocal(options: HarnessInstallOptions): Promise<HarnessInstallResult> {
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

  /**
   * Installs the harness on a Windows agent: the files go through the agent's IFileOps, `node setup.mjs` runs through its
   * `run` (a program with arguments, no shell). The home directory is the agent's own (`~`); no SSH is involved.
   */
  async installOnAgent(
    transport: Pick<IServerTransport, 'files' | 'run'>,
    options: HarnessInstallOptions,
    onProgress?: (p: HarnessInstallProgress) => void,
  ): Promise<HarnessInstallResult> {
    const steps: HarnessInstallProgress[] = [];
    const report = (step: HarnessInstallStep, status: HarnessInstallProgress['status'], message: string) => {
      const p: HarnessInstallProgress = { step, status, message };
      steps.push(p);
      onProgress?.(p);
    };
    if (options.hostProfile?.platform !== 'win32') {
      throw new Error('installOnAgent is the Windows route; a Unix agent is installed over SSH (install)');
    }
    if (options.prefix) validatePrefix(options.prefix);

    const files = transport.files();
    let location: ReturnType<typeof harnessLocation>;
    report('transfer', 'running', 'Transferring harness to the agent...');
    try {
      location = harnessLocation(files.platform, await homeDirOf(files), options.prefix);
      if (!fs.existsSync(HARNESS_DIR)) throw new Error(`Harness directory not found: ${HARNESS_DIR}`);
      await sendHarnessDirectory(files, HARNESS_DIR, location, Date.now());
      report('transfer', 'ok', `Harness transferred to ${location.harnessDir}`);
    } catch (err) {
      const msg = (err as Error).message;
      report('transfer', 'error', msg);
      return { success: false, steps, error: msg };
    }

    report('setup', 'running', 'Running harness setup on the agent...');
    try {
      const { args, env } = buildNodeSetupInvocation(options);
      const result = await transport.run({
        file: 'node',
        args: [pathApiFor(files.platform).join(location.harnessDir, 'setup.mjs'), ...args],
        env,
        timeoutMs: SETUP_TIMEOUT_MS,
        maxOutputBytes: SETUP_MAX_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0) throw new Error(`setup.mjs failed (exit ${result.exitCode}): ${result.stderr}`);
      report('setup', 'ok', 'Harness setup complete');
    } catch (err) {
      const msg = (err as Error).message;
      report('setup', 'error', msg);
      return { success: false, steps, error: msg };
    }

    if (options.version) {
      try {
        await files.write(location.versionFile, Buffer.from(`${options.version}\n`));
      } catch {
        // VERSION write failure is non-fatal; the next auto-update cycle will retry.
      }
    }
    return { success: true, steps };
  }

  private async transferHarness(sshHost: string, prefix?: string): Promise<void> {
    if (!fs.existsSync(HARNESS_DIR)) {
      throw new Error(`Harness directory not found: ${HARNESS_DIR}`);
    }

    // Packed in Node, not with the hub's `tar`: the harness goes to a Linux / macOS host, and a Windows hub's file system
    // has no execute bit for `tar` to copy, so the scripts' modes are decided here (`#!` files are executable).
    const tarball = packTarGz(
      collectTreeEntries(HARNESS_DIR, {
        prefix: path.basename(HARNESS_DIR),
        exclude: (name) => name === 'node_modules' || name === '.git',
        fileMode: (_rel, data) => modeByShebang(data),
        directoryMode: 0o755,
      }),
      Math.floor(Date.now() / 1000),
    );

    const remoteTmp = `/tmp/azito-harness-${Date.now()}.tar.gz`;
    await this.sftpWrite(sshHost, tarball, remoteTmp);

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
  }

  private async runSetup(sshHost: string, options: HarnessInstallOptions | HarnessOperatorTokenPurgeOptions): Promise<void> {
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
    if (options.hostProfile?.platform === 'win32') return this.runNodeSetupLocal(options);
    const setupScript = path.join(HARNESS_DIR, 'setup.sh');
    if (!fs.existsSync(setupScript)) {
      throw new Error(`setup.sh not found: ${setupScript}`);
    }

    const { azitoUrl, webhookToken, uiToken, serverName, prefix, isolationIntent } = options;
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const args: string[] = [setupScript];
    args.push('--azito-url', azitoUrl);
    if (webhookToken) args.push('--webhook-token', webhookToken);
    // Issue #29 review, Important finding 2: mirrors runSetup()'s handling
    // above — withhold --ui-token and force --purge-operator-token when the
    // caller declared isolationIntent. `local`-type servers can never
    // actually reach isolationIntent: true today (PUT /api/servers/:name
    // rejects isolationIntent for any effective type other than 'agent', and
    // installLocal() is only ever invoked for a local-type server's own
    // harness), so this branch is currently unreachable in production — but
    // runSetupLocal previously ignored isolationIntent entirely, silently
    // violating HarnessInstallOptions.isolationIntent's contract for local
    // installs. Kept in sync defensively so the interface's guarantee holds
    // regardless of caller, and so a future caller that DOES construct an
    // isolated local install doesn't quietly leak --ui-token the way the
    // remote path once could have.
    if (uiToken && !isolationIntent) args.push('--ui-token', uiToken);
    if (serverName) args.push('--server-name', serverName);
    if (prefix) args.push('--prefix', prefix);
    if (isolationIntent) args.push('--purge-operator-token');

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

  /** The hub's own Windows host: `setup.mjs` run by the hub's node, the tokens in its environment (not in the argument list). */
  private async runNodeSetupLocal(options: HarnessInstallOptions): Promise<void> {
    const setupScript = path.join(HARNESS_DIR, 'setup.mjs');
    if (!fs.existsSync(setupScript)) throw new Error(`setup.mjs not found: ${setupScript}`);
    const { args, env } = buildNodeSetupInvocation(options);
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    await promisify(execFile)(process.execPath, [setupScript, ...args], {
      env: { ...process.env, ...env },
      timeout: SETUP_TIMEOUT_MS,
      windowsHide: true,
    }).catch((err: { message: string; stderr?: string }) => {
      throw new Error(`setup.mjs failed: ${err.stderr || err.message}`);
    });
  }

  private sftpWrite(sshHost: string, data: Buffer, remotePath: string): Promise<void> {
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
          const readStream = Readable.from([data]);
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
