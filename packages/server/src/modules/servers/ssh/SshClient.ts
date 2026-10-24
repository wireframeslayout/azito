import { Client, ClientChannel } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import SSHConfig from 'ssh-config';
import type { ExecResult } from '../transport/ServerTransport';
import { resolveSshAgent, windowsNamedPipeExists } from './sshAgentSocket';

// ─── Types ───

interface ResolvedHost {
  host: string;
  port: number;
  username: string;
  identityFile: string | null;
  /** Unix socket path, Windows pipe name or `pageant` for ssh2's `agent` option; null when there is no agent to ask. */
  agent: string | null;
  /** Why `agent` is null (null when there is one). */
  agentUnavailableReason: string | null;
}

/**
 * What the hub process knows about its own machine, resolved once at startup (the boundary) and handed in: the home directory
 * that holds `.ssh`, and the two environment values SSH looks at. The client never reads process.env itself, so a Windows hub
 * (USERNAME, no HOME / USER, a named-pipe agent) and a Unix one go through the same code.
 */
export interface SshClientEnv {
  homeDir: string;
  platform: NodeJS.Platform;
  /** `SSH_AUTH_SOCK`. */
  authSock: string | undefined;
  /** The OS user's name: the SSH user for a host whose `user@host` and ssh config both leave it out. */
  defaultUser: string | undefined;
}

interface ParsedHost {
  host: string;
  port: number;
  username: string;
  portExplicit: boolean;
}

interface PendingCommand {
  resolve: (output: string) => void;
  reject: (err: Error) => void;
}

interface PersistentShell {
  stream: ClientChannel;
  conn: Client;
  closed: boolean;
  buffer: string;
  pending: Map<number, PendingCommand>;
  cmdId: number;
}

// ─── Helpers ───

function parseHostString(hostStr: string): ParsedHost | null {
  const atIdx = hostStr.indexOf('@');
  if (atIdx === -1) return null;

  const username = hostStr.substring(0, atIdx);
  let rest = hostStr.substring(atIdx + 1);
  let port = 22;
  let portExplicit = false;

  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx !== -1) {
    const maybePort = parseInt(rest.substring(colonIdx + 1), 10);
    if (!isNaN(maybePort) && maybePort > 0 && maybePort <= 65535) {
      port = maybePort;
      portExplicit = true;
      rest = rest.substring(0, colonIdx);
    }
  }

  return { host: rest, port, username, portExplicit };
}

function findDefaultKey(home: string): string | null {
  const candidates = ['id_ed25519', 'id_rsa', 'id_ecdsa'];
  for (const name of candidates) {
    const p = path.join(home, '.ssh', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadSSHConfig(configPath: string): ReturnType<typeof SSHConfig.parse> {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return SSHConfig.parse(raw);
  } catch {
    return SSHConfig.parse('');
  }
}

function configMtimeMs(configPath: string): number | null {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch {
    return null;
  }
}

export interface FingerprintStore {
  getFingerprint(host: string, port: number): string | null;
  saveFingerprint(host: string, port: number, fingerprint: string): void;
}

// ─── SshClient ───

const BEGIN_MARKER = '\x02AGENTMGR_B';
const END_MARKER = '\x02AGENTMGR_E';

export class SshClient {
  private shellPool: Map<string, PersistentShell> = new Map();
  private parsedConfig: ReturnType<typeof SSHConfig.parse> | null = null;
  private configMtime: number | null = null;
  private configPath: string;

  private readonly reportedNoAgent = new Set<string>();

  constructor(private env: SshClientEnv, private fingerprintStore?: FingerprintStore, configPath?: string) {
    this.configPath = configPath ?? path.join(env.homeDir, '.ssh', 'config');
  }

  private resolveIdentityFile(configured: unknown): string | null {
    // ssh-config's compute() returns IdentityFile as a list; like ssh, the first one that exists is used (the first one listed when none does,
    // so the missing file is what a failed authentication points at).
    const listed = (Array.isArray(configured) ? configured : [configured]).filter((f): f is string => typeof f === 'string' && f !== '');
    if (listed.length === 0) return findDefaultKey(this.env.homeDir);
    // ssh_config writes `~/.ssh/key` (or a Windows path); `~` is this user's home, whichever separator follows it.
    const expanded = listed.map((f) => f.replace(/^~(?=$|[\\/])/, this.env.homeDir));
    return expanded.find((f) => fs.existsSync(f)) ?? expanded[0];
  }

  private resolveAgent(): Pick<ResolvedHost, 'agent' | 'agentUnavailableReason'> {
    const resolution = resolveSshAgent(this.env.platform, this.env.authSock, windowsNamedPipeExists);
    return { agent: resolution.socket, agentUnavailableReason: resolution.unavailableReason };
  }

  private getConfig(): ReturnType<typeof SSHConfig.parse> {
    const mtime = configMtimeMs(this.configPath);
    if (this.parsedConfig && mtime === this.configMtime) return this.parsedConfig;
    this.parsedConfig = loadSSHConfig(this.configPath);
    this.configMtime = mtime;
    return this.parsedConfig;
  }

  resolveHost(hostStr: string): ResolvedHost {
    const direct = parseHostString(hostStr);
    const config = this.getConfig();
    if (direct) {
      const computed = config.compute(direct.host);
      return {
        host: (computed.HostName as string) || direct.host,
        port: direct.portExplicit ? direct.port : parseInt((computed.Port as string) || '22', 10),
        username: direct.username,
        identityFile: this.resolveIdentityFile(computed.IdentityFile),
        ...this.resolveAgent(),
      };
    }

    const computed = config.compute(hostStr);
    const username = (computed.User as string) || this.env.defaultUser;
    if (!username) {
      throw new Error(`No SSH user for "${hostStr}": write the server as user@host, or set User for it in ${this.configPath}`);
    }
    return {
      host: (computed.HostName as string) || hostStr,
      port: parseInt((computed.Port as string) || '22', 10),
      username,
      identityFile: this.resolveIdentityFile(computed.IdentityFile),
      ...this.resolveAgent(),
    };
  }

  buildConnectOpts(resolved: ResolvedHost): Record<string, unknown> {
    const connectOpts: Record<string, unknown> = {
      host: resolved.host,
      port: resolved.port,
      username: resolved.username,
      readyTimeout: 10000,
      hostHash: 'sha256',
      hostVerifier: (hashedKey: Buffer | string) => {
        const keyStr = typeof hashedKey === 'string' ? hashedKey : hashedKey.toString('hex');
        return this.verifyHostKey(resolved, keyStr);
      },
    };

    let privateKey: Buffer | null = null;
    if (resolved.identityFile) {
      try {
        privateKey = fs.readFileSync(resolved.identityFile);
      } catch {
        // ignore missing key file
      }
    }

    const authMethods: Array<Record<string, unknown>> = [];
    authMethods.push({ type: 'none', username: resolved.username });
    if (resolved.agent) {
      authMethods.push({ type: 'agent', username: resolved.username, agent: resolved.agent });
    } else if (resolved.agentUnavailableReason && !this.reportedNoAgent.has(resolved.agentUnavailableReason)) {
      this.reportedNoAgent.add(resolved.agentUnavailableReason);
      console.log(`[SSH] no ssh-agent for ${resolved.host}: ${resolved.agentUnavailableReason}`);
    }
    if (privateKey) {
      authMethods.push({ type: 'publickey', username: resolved.username, key: privateKey });
    }

    let authIdx = 0;
    connectOpts.authHandler = (
      _methodsLeft: string[],
      _partialSuccess: boolean,
      cb: (auth: Record<string, unknown> | false) => void,
    ) => {
      if (authIdx >= authMethods.length) return cb(false);
      cb(authMethods[authIdx++]);
    };

    return connectOpts;
  }

  private getShell(hostAlias: string): Promise<PersistentShell> {
    const existing = this.shellPool.get(hostAlias);
    if (existing && !existing.closed) return Promise.resolve(existing);

    return new Promise<PersistentShell>((resolve, reject) => {
      const resolved = this.resolveHost(hostAlias);
      const conn = new Client();
      const connectOpts = this.buildConnectOpts(resolved);

      conn.on('ready', () => {
        conn.shell({ term: false } as Record<string, unknown>, (err: Error | undefined, stream: ClientChannel) => {
          if (err) return reject(err);

          const shell: PersistentShell = {
            stream,
            conn,
            closed: false,
            buffer: '',
            pending: new Map(),
            cmdId: 0,
          };

          stream.on('data', (data: Buffer) => {
            shell.buffer += data.toString();
            this.drainBuffer(shell);
          });

          stream.on('close', () => {
            shell.closed = true;
            this.shellPool.delete(hostAlias);
            for (const [, p] of shell.pending) {
              p.reject(new Error('Shell closed'));
            }
            shell.pending.clear();
          });

          setTimeout(() => {
            stream.write('stty -echo 2>/dev/null; export PS1="" PS2="" PROMPT_COMMAND=""\n');
            setTimeout(() => {
              shell.buffer = '';
              this.shellPool.set(hostAlias, shell);
              resolve(shell);
            }, 500);
          }, 500);
        });
      });

      conn.on('error', (err: Error) => {
        this.shellPool.delete(hostAlias);
        reject(err);
      });

      conn.on('close', () => {
        const s = this.shellPool.get(hostAlias);
        if (s) s.closed = true;
        this.shellPool.delete(hostAlias);
      });

      conn.connect(connectOpts);
    });
  }

  private drainBuffer(shell: PersistentShell): void {
    while (true) {
      const beginTag = new RegExp(`${BEGIN_MARKER}_(\\d+)_`);
      const beginMatch = beginTag.exec(shell.buffer);
      if (!beginMatch) break;

      const id = parseInt(beginMatch[1], 10);
      const endTag = `${END_MARKER}_${id}_`;
      const endIdx = shell.buffer.indexOf(endTag);
      if (endIdx === -1) break;

      const beginEnd = beginMatch.index + beginMatch[0].length;
      let output = shell.buffer.substring(beginEnd, endIdx);
      shell.buffer = shell.buffer.substring(endIdx + endTag.length);

      // Strip \r\n / \r / \n at boundaries
      output = output.replace(/^\r?\n/, '').replace(/\r?\n$/, '').replace(/\r$/, '');
      // Normalize \r\n to \n
      output = output.replace(/\r\n/g, '\n');

      const pending = shell.pending.get(id);
      if (pending) {
        shell.pending.delete(id);
        pending.resolve(output);
      }
    }
  }

  async execRemote(hostAlias: string, command: string): Promise<ExecResult> {
    const shell = await this.getShell(hostAlias);
    const id = ++shell.cmdId;

    return new Promise<ExecResult>((resolve, reject) => {
      shell.pending.set(id, {
        resolve: (output: string) => {
          resolve({ stdout: output, stderr: '', code: 0 });
        },
        reject,
      });

      const beginStr = `\\x02AGENTMGR_B_${id}_`;
      const endStr = `\\x02AGENTMGR_E_${id}_`;
      shell.stream.write(`printf '${beginStr}\\n'; ${command}; printf '${endStr}\\n'\n`);

      setTimeout(() => {
        if (shell.pending.has(id)) {
          shell.pending.delete(id);
          // Command body deliberately omitted from the message: callers may
          // embed secrets (e.g. HarnessInstaller's --webhook-token/--ui-token)
          // in `command`, and this Error's message can end up persisted
          // verbatim (isolation_report / audit_log) by downstream catch
          // blocks — see execIsolated's identical comment below.
          reject(new Error('Command timed out'));
        }
      }, 15000);
    });
  }

  /** `timeoutMs` bounds the whole call (connect + command); the default suits a quick probe, a long step (extracting a bundle on Windows) passes more. */
  async execIsolated(hostAlias: string, command: string, timeoutMs = 15000): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const resolved = this.resolveHost(hostAlias);
      const conn = new Client();
      const connectOpts = this.buildConnectOpts(resolved);

      const timeout = setTimeout(() => {
        conn.end();
        // Command body deliberately omitted from the message (see
        // execRemote's identical comment above) — HarnessInstaller.runSetup
        // builds `command` with plaintext --webhook-token/--ui-token, and
        // this rejection propagates into HarnessInstaller.install()'s catch
        // -> attemptIsolationCleanup's `report.error` -> isolation_report /
        // audit_log (servers/routes.ts). Redacting here is defense-in-depth
        // alongside the redaction applied there.
        reject(new Error('Isolated exec timed out'));
      }, timeoutMs);

      conn.on('ready', () => {
        conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
          if (err) { clearTimeout(timeout); conn.end(); return reject(err); }
          let stdout = '';
          let stderr = '';
          stream.on('data', (data: Buffer) => { stdout += data.toString(); });
          stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
          stream.on('close', (code: number) => {
            clearTimeout(timeout);
            conn.end();
            resolve({ stdout, stderr, code: code || 0 });
          });
        });
      });

      conn.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
      conn.connect(connectOpts);
    });
  }

  shellRemote(hostAlias: string, cols: number, rows: number): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      const resolved = this.resolveHost(hostAlias);
      const conn = new Client();
      const connectOpts = this.buildConnectOpts(resolved);

      conn.on('ready', () => {
        conn.shell(
          { term: 'xterm-256color', cols, rows } as Record<string, unknown>,
          (err: Error | undefined, stream: ClientChannel) => {
            if (err) return reject(err);
            (stream as unknown as Record<string, unknown>)._sshConn = conn;
            resolve(stream);
          },
        );
      });

      conn.on('error', reject);
      conn.connect(connectOpts);
    });
  }

  private verifyHostKey(resolved: ResolvedHost, hashedKey: string): boolean {
    if (!this.fingerprintStore) return true;
    const stored = this.fingerprintStore.getFingerprint(resolved.host, resolved.port);
    if (!stored) {
      this.fingerprintStore.saveFingerprint(resolved.host, resolved.port, hashedKey);
      console.log('[SSH] TOFU: saved fingerprint for ' + resolved.host + ':' + resolved.port);
      return true;
    }
    if (stored === hashedKey) return true;
    console.error('[SSH] Host key mismatch for ' + resolved.host + ':' + resolved.port);
    return false;
  }

  /** Close all persistent shell connections */
  closeAll(): void {
    for (const [hostAlias, shell] of this.shellPool) {
      try {
        shell.stream.end();
        shell.conn.end();
      } catch {
        // ignore cleanup errors
      }
      this.shellPool.delete(hostAlias);
    }
  }
}
